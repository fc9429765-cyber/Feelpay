"use server"

import { getSupabaseServer } from "@/lib/supabase/server"
import { put } from "@vercel/blob"

interface SaveTransactionParams {
  concepto: string
  limite: number | null
  valor: number
  observacion: string
  foto: string | null
  tipo: "Ingreso" | "Gasto" | "Retiro"
  ruta: number
  adminid: number
  requiresApproval?: boolean
  /**
   * Llave generada en el dispositivo. Si la peticion se reintenta (o se
   * sincroniza dos veces desde la cola offline), la segunda vez no inserta
   * nada y devuelve el resultado original. Sin esto, un reintento por mala
   * senal duplicaba el movimiento de caja.
   */
  idempotencyKey?: string
  /**
   * Momento real de captura en el dispositivo (ISO). Necesario para la cola
   * offline: sin esto un gasto registrado a las 3pm sin senal quedaria con la
   * hora en que se sincronizo, cayendo en el dia equivocado.
   */
  fechaCaptura?: string
  /**
   * Nombre de la secretaria que ya aprobo el movimiento en la cola de
   * Movimientos en Revision. Cuando viene, el movimiento no se le vuelve a
   * pedir a secretaria: si ademas supera el limite del item, queda esperando
   * SOLO al admin.
   */
  aprobadoPorSecretaria?: string
  /**
   * El ADMIN aprobo la solicitud en Movimientos en Revision: el movimiento
   * entra con la firma de secretaria pendiente (`estadosecre = 'por aprobar'`)
   * para que ella tambien lo revise (06-oct-2026).
   */
  esperaSecretaria?: boolean
}

// La tabla operaciones_procesadas se creo en scripts/030 y todavia no esta en
// los tipos generados de Supabase; el cast evita que TS la resuelva a `never`.
type TablaSinTipos = {
  insert: (row: Record<string, unknown>) => Promise<{ error: { code?: string } | null }>
  delete: () => { eq: (col: string, val: string) => Promise<unknown> }
}

export async function saveTransaction(params: SaveTransactionParams) {
  const supabase = await getSupabaseServer()

  // Si algo falla despues de reservar la llave, se libera para que el
  // reintento pueda entrar; si no, el movimiento quedaria bloqueado para
  // siempre sin haberse registrado.
  let llaveReservada = false
  const liberarLlave = async () => {
    if (!llaveReservada || !params.idempotencyKey) return
    llaveReservada = false
    try {
      await (supabase.from("operaciones_procesadas") as unknown as TablaSinTipos)
        .delete()
        .eq("id", params.idempotencyKey)
    } catch (e) {
      console.error("[v0] No se pudo liberar la llave de idempotencia:", e)
    }
  }

  try {
    // Hora de captura en el dispositivo; si no viene, ahora (comportamiento
    // anterior). La visualizacion usa zona Colombia al leer.
    const fechahorasol = params.fechaCaptura ?? new Date().toISOString()

    // ── Idempotencia ──────────────────────────────────────────────────
    // Se RESERVA la llave antes de hacer nada, apoyandose en la llave
    // primaria de la tabla. Antes se consultaba primero y se insertaba al
    // final, con la subida de la foto en el medio: dos envios simultaneos
    // no veian nada y ambos registraban el movimiento. Ademas el insert
    // final no revisaba su error, asi que si fallaba el reintento duplicaba.
    if (params.idempotencyKey) {
      const { error: reservaErr } = await (supabase.from("operaciones_procesadas") as unknown as TablaSinTipos).insert({
        id: params.idempotencyKey,
        tipo: `transaccion_${params.tipo.toLowerCase()}`,
        user_id: params.adminid,
        ruta_id: params.ruta,
        resultado: {},
      })
      if (reservaErr) {
        // 23505 = la llave ya existe: este movimiento ya se proceso.
        if (reservaErr.code === "23505") {
          return { success: true, data: null, duplicado: true }
        }
        // Se devuelve el error REAL de la base, no un mensaje generico: esto
        // corre en el servidor, asi que un console.error aca no lo ve nadie
        // desde el telefono y el cobrador se queda con un "no se pudo" que no
        // dice nada.
        console.error("[v0] Error reservando llave de idempotencia:", reservaErr)
        const detalle = (reservaErr as { message?: string }).message ?? JSON.stringify(reservaErr)
        return { success: false, error: `No se pudo registrar el movimiento: ${detalle}` }
      }
      llaveReservada = true
    }

    let fotoUrl: string | null = null

    // Upload photo if exists - directly use Vercel Blob
    if (params.foto) {
      try {
        // Convert base64 to Buffer
        const base64Data = params.foto.split(",")[1]
        const buffer = Buffer.from(base64Data, "base64")
        
        const filename = `gastos/${params.tipo.toLowerCase()}_${Date.now()}.jpg`
        
        const blob = await put(filename, buffer, {
          access: "public",
          contentType: "image/jpeg",
        })
        
        fotoUrl = blob.url
        console.log("[v0] Photo uploaded successfully:", fotoUrl)
      } catch (photoError) {
        console.error("[v0] Error processing photo:", photoError)
      }
    }

    // Determine status based on limit and amount
    let estadoadmin: string = "NA"
    let estadosecre: string = "NA"

    // `!= null` y no `params.limite &&`: con `&&`, un tope de CERO se leia
    // como "sin tope" y el movimiento pasaba directo. Un tope en cero
    // configurado a mano significa lo contrario — que todo pase por
    // aprobacion — y el cliente ya lo entiende asi. Con la version vieja los
    // dos lados decidian distinto sobre el mismo dato, que es la clase de
    // desacuerdo que no deja rastro en ningun lado.
    if (params.limite != null && params.valor > params.limite) {
      if (params.requiresApproval) {
        estadoadmin = "por aprobar"
      } else {
        await liberarLlave()
        return {
          success: false,
          error: "limit_exceeded",
          requiresApproval: true,
        }
      }
    }

    // Movimiento que ya paso por la cola de revision de secretaria: se deja
    // registrada su aprobacion para no volver a pedirsela. Si tambien supera
    // el limite del item, sigue esperando al admin — antes esta rama guardaba
    // el movimiento con limite null y el admin nunca se enteraba.
    const extra: Record<string, unknown> = {}
    if (params.aprobadoPorSecretaria) {
      extra.secretariaaprobo = params.aprobadoPorSecretaria
      extra.fechahoraaprobosecretaria = new Date().toISOString()
      // OJO: `estadosecre` solo se pone en 'aprobado' si el movimiento NO
      // queda esperando al admin.
      //
      // La vista resumen_pagos_diarios suma los movimientos que cumplen
      // `estadosecre = 'aprobado' OR estadoadmin = 'NA'`. Marcarlo aprobado
      // mientras el admin todavia no firma lo haria entrar al Resumen del
      // Dia como plata ya autorizada. La firma de secretaria queda igual
      // registrada en `secretariaaprobo`, y approveTransaction la lee de ahi
      // para no volver a pedirsela cuando el admin apruebe.
      if (estadoadmin !== "por aprobar") estadosecre = "aprobado"
    } else if (params.esperaSecretaria && estadoadmin !== "por aprobar") {
      // Si ademas supera el limite, approveTransaction le pide la firma a
      // secretaria cuando el admin apruebe ese segundo paso.
      estadosecre = "por aprobar"
    }

    // Insert transaction record
    const { data, error } = await supabase.from("gastosregistros").insert({
      fechahorasol,
      adminid: params.adminid,
      ruta: params.ruta,
      concepto: params.concepto,
      limite: params.limite,
      valor: params.valor,
      observacion: params.observacion,
      foto: fotoUrl,
      tipo: params.tipo,
      estadoadmin,
      estadosecre,
      ...extra,
    })

    if (error) {
      console.error("[v0] Error saving transaction:", error)
      await liberarLlave()
      return {
        success: false,
        error: error.message,
      }
    }

    return {
      success: true,
      data,
    }
  } catch (error) {
    console.error("[v0] Error in saveTransaction:", error)
    await liberarLlave()
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error desconocido",
    }
  }
}
