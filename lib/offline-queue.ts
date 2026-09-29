"use client"

/**
 * lib/offline-queue.ts
 * ---------------------------------------------------------------------------
 * Cola de escrituras para trabajar sin internet.
 *
 * Los cobradores trabajan en campo con senal intermitente. Cuando una
 * operacion no se puede enviar, queda guardada en el dispositivo (IndexedDB)
 * y se sincroniza sola al recuperar conexion.
 *
 * POR QUE ESTO ES SEGURO
 * ----------------------
 * Encolar plata solo es seguro si el servidor reconoce un reintento y si la
 * operacion no puede ser rechazada al llegar tarde. Con el nucleo nuevo
 * (scripts 041-049) las dos cosas se cumplen por construccion:
 *   - Cada gestion lleva un `id` generado AL CAPTURARLA, que es la llave
 *     primaria de la tabla `gestiones`. Reenviarla no puede duplicar nada.
 *   - La cuota es solo una PISTA: si al sincronizar ya no aplica, el servidor
 *     asigna la plata a la cuota mas antigua sin cubrir. Se acabo el conflicto
 *     "esa cuota ya fue gestionada".
 *   - Si algo no cuadra (prestamo cancelado, fecha muy vieja, monto sobre el
 *     umbral), el evento entra igual como 'en_revision': la plata queda
 *     registrada y espera el visto bueno de secretaria, no se pierde.
 *
 * LA IDENTIDAD SE CONGELA AL ENCOLAR
 * ----------------------------------
 * `getSessionIdentity()` se resuelve normalmente al momento de llamar. Si el
 * usuario cambia de ruta antes de que la cola drene, las operaciones viejas
 * quedarian atribuidas a la ruta equivocada. Por eso cada item guarda la
 * identidad que tenia cuando se capturo.
 */

import { openDB, type IDBPDatabase } from "idb"
import { createClient } from "@/lib/supabase/client"
import { getSessionIdentity, NetworkUnavailableError, type AtomicRpcResult } from "@/lib/api-helper"
import { todayColombia, tsToColombiaDate } from "@/lib/colombia-date"

const DB_NAME = "feelpay-offline"
const DB_VERSION = 1
const STORE = "cola"

// "gestion"  = un evento del libro (pago, no pago, cancelacion, reversa). Es
//              el camino nuevo: el payload YA trae su `id`, que es la misma
//              llave de idempotencia con la que se guarda en la cola, asi que
//              reintentar nunca duplica.
// "rpc"      = cualquier otra funcion atomica del nucleo (editar venta,
//              ajustar cronograma, corregir gestion). Viaja con el nombre de
//              la funcion adentro para no multiplicar tipos de cola.
// "pago"/"no_pago" = camino VIEJO. Se conservan para drenar colas capturadas
//              antes del corte: el servidor las traduce con el adapter
//              `registrar_pago_atomico` (script 044).
// "revision" = una fila para solicitudes_revision (un movimiento que supero
//              el umbral de su ruta y necesita el visto bueno de secretaria).
// "iniciar_ruta" = abrir la jornada (fila de rutas_diarias) SIN SEÑAL. Va
//              primero en la cola por construccion —se captura antes que
//              cualquier cobro del dia— y es idempotente: si al llegar ya hay
//              fila para ese dia (otro telefono la abrio), no hace nada.
/**
 * EL DÍA AL QUE PERTENECE UNA VENTA QUE ESTUVO EN LA COLA.
 *
 * Una venta capturada sin señal el lunes y sincronizada el miércoles caía en
 * el MIÉRCOLES: el servidor la fechaba con su propio NOW(). Su abono inicial,
 * en cambio, ya caía en el lunes —viaja con `fecha_dispositivo` desde el
 * script 040—, así que la misma venta quedaba partida en dos días: el capital
 * saliendo de una caja y la plata que el cliente entregó entrando en otra.
 *
 * Se manda `fecha_venta` (script 078) con el MISMO día que ya fecha el abono,
 * y las dos mitades vuelven a coincidir por construcción.
 *
 * NO se manda si:
 *   · ya trae `fecha_venta` — Control Total eligió el día y ese manda;
 *   · el día es hoy — el caso normal, no hay nada que aclarar;
 *   · pasaron más de 30 días — un reloj muy corrido o un item olvidado en la
 *     cola. El servidor rechaza más de 60 y una venta rechazada se PIERDE;
 *     antes que eso, que caiga en hoy como caía siempre.
 */
function diaDeLaVentaEncolada(
  p_loan: Record<string, unknown>,
  capturadoEn: string,
): string | null {
  if (p_loan.fecha_venta) return null
  // `fecha_dispositivo` primero: es literalmente el día con el que se fecha el
  // abono de esta misma venta. `capturadoEn` es el respaldo para payloads de
  // versiones que no lo mandaban.
  const dia =
    typeof p_loan.fecha_dispositivo === "string" && p_loan.fecha_dispositivo
      ? p_loan.fecha_dispositivo
      : tsToColombiaDate(capturadoEn)
  const hoy = todayColombia()
  if (!dia || dia >= hoy) return null
  const diasAtras = Math.round((Date.parse(hoy) - Date.parse(dia)) / 86_400_000)
  return diasAtras > 30 ? null : dia
}

export type TipoOperacion =
  | "gestion" | "rpc" | "pago" | "no_pago" | "transaccion" | "venta" | "revision" | "iniciar_ruta"

export type EstadoItem = "pendiente" | "enviando" | "fallido"

export interface ItemCola {
  /** Es tambien la llave de idempotencia que viaja al servidor. */
  id: string
  tipo: TipoOperacion
  /** Payload listo para enviar, tal cual lo arma la pantalla. */
  payload: Record<string, unknown>
  /** Identidad congelada al capturar (ver nota arriba). */
  identidad: { user_id: number; ruta_id: number; rol: string | null }
  /** Momento real en que el cobrador registro la operacion. */
  capturadoEn: string
  /** Descripcion corta para mostrar en la bandeja ("Pago — Juan Pérez"). */
  descripcion: string
  estado: EstadoItem
  intentos: number
  ultimoError?: string
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" })
          store.createIndex("capturadoEn", "capturadoEn")
        }
      },
    })
  }
  return dbPromise
}

// ── Notificacion de cambios ────────────────────────────────────────────────
// La UI (indicador de pendientes) se suscribe para refrescarse sola.

type Listener = () => void
const listeners = new Set<Listener>()

export function suscribirCola(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notificar() {
  listeners.forEach((fn) => fn())
}

// ── Operaciones basicas ────────────────────────────────────────────────────

export async function encolar(args: {
  tipo: TipoOperacion
  payload: Record<string, unknown>
  descripcion: string
  /** Llave ya generada por el caller (debe ser la misma que viaja al servidor). */
  id: string
  /** Ver `enviarOEncolar`. */
  rutaId?: number
}): Promise<void> {
  const identidad = { ...getSessionIdentity(), ...(args.rutaId ? { ruta_id: args.rutaId } : {}) }
  const item: ItemCola = {
    id: args.id,
    tipo: args.tipo,
    payload: args.payload,
    identidad,
    capturadoEn: new Date().toISOString(),
    descripcion: args.descripcion,
    estado: "pendiente",
    intentos: 0,
  }
  const db = await getDB()
  await db.put(STORE, item)
  console.log("[v0] Operacion encolada offline:", item.tipo, item.descripcion)
  notificar()
}

export async function listarCola(): Promise<ItemCola[]> {
  const db = await getDB()
  const items: ItemCola[] = await db.getAllFromIndex(STORE, "capturadoEn")
  return items
}

export async function contarPendientes(): Promise<number> {
  const items = await listarCola()
  return items.filter((i) => i.estado !== "fallido").length
}

export async function contarFallidos(): Promise<number> {
  const items = await listarCola()
  return items.filter((i) => i.estado === "fallido").length
}

async function quitar(id: string) {
  const db = await getDB()
  await db.delete(STORE, id)
  notificar()
}

async function marcar(item: ItemCola, cambios: Partial<ItemCola>) {
  const db = await getDB()
  await db.put(STORE, { ...item, ...cambios })
  notificar()
}

/** Descarta un item fallido (accion manual del usuario desde la bandeja). */
export async function descartar(id: string): Promise<void> {
  await quitar(id)
}

/** Devuelve un item fallido a la cola para reintentarlo. */
export async function reintentar(id: string): Promise<void> {
  const db = await getDB()
  const item: ItemCola | undefined = await db.get(STORE, id)
  if (!item) return
  await db.put(STORE, { ...item, estado: "pendiente", intentos: 0, ultimoError: undefined })
  notificar()
}

// ── Envio ──────────────────────────────────────────────────────────────────

/**
 * Envia UN item. La identidad se toma del item (congelada al capturar), no de
 * la sesion actual.
 */
async function enviarItem(item: ItemCola): Promise<AtomicRpcResult> {
  const supabase = createClient()

  // LAS FOTOS TOMADAS SIN SEÑAL SUBEN PRIMERO (ver lib/foto-offline.ts). La
  // venta viaja con la URL real, nunca con la foto en `data:`. El payload ya
  // subido se guarda de inmediato: si lo que falla después es la venta, el
  // reintento no vuelve a subir las fotos.
  if (item.tipo === "venta" || item.tipo === "revision" || item.tipo === "gestion") {
    const { subirFotosPendientes } = await import("@/lib/foto-offline")
    let r: { payload: Record<string, unknown>; cambio: boolean }
    try {
      r = await subirFotosPendientes(item.payload, item.identidad.ruta_id)
    } catch (err) {
      // Sin red: el item espera entero, con su foto.
      if (esErrorDeRed(err) || item.tipo !== "gestion") throw err
      // UN PAGO NO SE PIERDE POR SU FOTO. Si la subida falla por otra cosa
      // (el almacenamiento rechazó el archivo), el evento sigue sin ella: la
      // plata es lo que importa y la foto es respaldo.
      console.error("[v0] La foto del pago no se pudo subir; el pago sigue sin ella:", err)
      const { foto_url: _descartada, ...resto } = item.payload
      r = { payload: resto, cambio: true }
    }
    if (r.cambio) {
      item.payload = r.payload
      const db = await getDB()
      if (await db.get(STORE, item.id)) await db.put(STORE, item)
    }
  }

  if (item.tipo === "gestion") {
    // El `id` del item ES el id del evento en el libro. La tabla `gestiones`
    // lo tiene como llave primaria, asi que un reenvio no puede duplicar la
    // plata ni aunque el servidor haya alcanzado a aplicarlo la primera vez.
    const { data, error } = await supabase.rpc("registrar_gestion", {
      p_user_id: item.identidad.user_id,
      p_ruta_id: item.identidad.ruta_id,
      p_rol: item.identidad.rol,
      p_payload: { ...item.payload, id: item.id },
    })
    if (error) throw error
    return (data ?? { ok: true }) as AtomicRpcResult
  }

  if (item.tipo === "rpc") {
    const { fn, payload } = item.payload as { fn: string; payload: Record<string, unknown> }
    const { data, error } = await supabase.rpc(fn, {
      p_user_id: item.identidad.user_id,
      p_ruta_id: item.identidad.ruta_id,
      p_rol: item.identidad.rol,
      p_payload: { ...payload, idempotency_key: item.id },
    })
    if (error) throw error
    return (data ?? { ok: true }) as AtomicRpcResult
  }

  if (item.tipo === "pago" || item.tipo === "no_pago") {
    const { data, error } = await supabase.rpc("registrar_pago_atomico", {
      p_user_id: item.identidad.user_id,
      p_ruta_id: item.identidad.ruta_id,
      p_rol: item.identidad.rol,
      p_payload: { ...item.payload, idempotency_key: item.id },
    })
    if (error) throw error
    return (data ?? { ok: true }) as AtomicRpcResult
  }

  if (item.tipo === "venta") {
    // La llave viaja dentro de p_loan (ver scripts/031-idempotencia-ventas.sql:
    // se metio ahi para no cambiar la firma de la funcion, que ya tiene otros
    // callers). Las fechas del plan NO se recalculan: son las que se pactaron
    // con el cliente al hacer la venta.
    //
    // Va por `registrar_venta` y NO por `crear_venta_atomica`: es el servidor
    // el que decide si la venta necesita revision de secretaria. Antes lo
    // decidia el telefono ANTES de encolar, con la config que tuviera en
    // cache; una venta capturada sin senal en un telefono que nunca alcanzo a
    // leer los umbrales entraba directo sin pasar por nadie.
    const p = item.payload as { p_cliente: unknown; p_loan: Record<string, unknown>; p_payment_plan: unknown }
    // La venta se cuenta en el día en que se hizo, no en el que alcanzó señal.
    const diaVenta = diaDeLaVentaEncolada(p.p_loan, item.capturadoEn)
    if (diaVenta) {
      console.log(`[v0] Venta encolada el ${diaVenta}: se cuenta en ese día, no en hoy.`)
    }
    const args = {
      p_user_id: item.identidad.user_id,
      p_ruta_id: item.identidad.ruta_id,
      p_rol: item.identidad.rol,
      p_cliente: p.p_cliente,
      p_loan: {
        ...p.p_loan,
        idempotency_key: item.id,
        ...(diaVenta ? { fecha_venta: diaVenta } : {}),
      },
      p_payment_plan: p.p_payment_plan,
    }
    const { data, error } = await supabase.rpc("registrar_venta", args)

    // Si el script 061 todavia no se corrio, `registrar_venta` no existe.
    // PGRST202 = PostgREST no encontro la funcion. En ese caso se vende por el
    // camino de siempre: que a un cobrador se le caigan TODAS las ventas en la
    // calle es mucho peor que seguir un dia mas con la decision en el telefono
    // (que es exactamente como funcionaba hasta ahora).
    if (error && (error as { code?: string }).code === "PGRST202") {
      console.error(
        "[v0] `registrar_venta` no existe — corre scripts/061. La venta se crea SIN el chequeo de umbral del servidor.",
      )
      const alterno = await supabase.rpc("crear_venta_atomica", args)
      if (alterno.error) throw alterno.error
      return (alterno.data ?? { ok: true }) as AtomicRpcResult
    }

    if (error) throw error
    return (data ?? { ok: true }) as AtomicRpcResult
  }

  if (item.tipo === "revision") {
    // La llave de idempotencia se usa como id de la fila: si el envio se
    // repite, la llave primaria rechaza el duplicado y no entran dos
    // solicitudes por el mismo movimiento.
    const { error } = await supabase.from("solicitudes_revision").insert({
      id: item.id,
      ...(item.payload as Record<string, unknown>),
      ruta_id: item.identidad.ruta_id,
      solicitado_por: item.identidad.user_id,
      created_at: item.capturadoEn,
    })
    // `enviado_a_revision` para que el drenado AVISE a quien aprueba: una
    // solicitud que llega horas después, desde la cola, no tiene formulario
    // abierto que mande el aviso.
    if (error) {
      // 23505 = ya se habia insertado en un intento anterior.
      if ((error as { code?: string }).code === "23505") return { ok: true } as AtomicRpcResult
      throw error
    }
    return { ok: true, enviado_a_revision: true } as AtomicRpcResult
  }

  if (item.tipo === "iniciar_ruta") {
    const fecha = String((item.payload as { fecha?: string }).fecha ?? tsToColombiaDate(item.capturadoEn))
    const rutaId = item.identidad.ruta_id
    const { data: existente, error: errSel } = await supabase
      .from("rutas_diarias").select("id").eq("ruta_id", rutaId).eq("fecha", fecha).maybeSingle()
    if (errSel) throw errSel
    // Ya estaba (abierta o cerrada): lo que diga el servidor manda.
    if (existente) return { ok: true } as AtomicRpcResult
    const { error } = await supabase
      .from("rutas_diarias")
      .insert({ ruta_id: rutaId, fecha, estado: "abierta", hora_inicio: item.capturadoEn })
    if (error) {
      if ((error as { code?: string }).code === "23505") return { ok: true } as AtomicRpcResult
      // Una base sin la columna hora_inicio: se abre igual sin ella.
      if (/hora_inicio/.test(error.message)) {
        const r = await supabase.from("rutas_diarias").insert({ ruta_id: rutaId, fecha, estado: "abierta" })
        if (r.error && (r.error as { code?: string }).code !== "23505") throw r.error
        return { ok: true } as AtomicRpcResult
      }
      throw error
    }
    return { ok: true } as AtomicRpcResult
  }

  if (item.tipo === "transaccion") {
    // Las transacciones (gasto/ingreso/retiro) pasan por un server action.
    const { saveTransaction } = await import("@/lib/actions/save-transaction")
    // EL `fechaCaptura` DEL PAYLOAD MANDA SOBRE `capturadoEn`.
    //
    // `capturadoEn` es el instante en que el item entro a la cola, y sirve
    // para lo que fue puesto: un gasto capturado a las 3pm sin senal que se
    // sincroniza a las 6pm tiene que quedar a las 3pm, no a las 6.
    //
    // Pero se estaba escribiendo DESPUES del spread, asi que pisaba tambien
    // el `fechaCaptura` que la pantalla manda a proposito cuando se esta
    // cerrando una jornada atrasada. Resultado: el gasto del dia que se
    // cierra caia igual en el dia de hoy, aunque la pantalla dijera —bien—
    // "esto queda registrado el 05/09". Pasa online tambien: todo movimiento
    // entra por esta cola.
    //
    // Ahora `capturadoEn` es el RESPALDO, no el que pisa.
    const payloadTx = item.payload as unknown as Parameters<typeof saveTransaction>[0]
    const res = await saveTransaction({
      ...payloadTx,
      idempotencyKey: item.id,
      fechaCaptura: payloadTx.fechaCaptura ?? item.capturadoEn,
    })
    if (!res.success && res.error !== "limit_exceeded") {
      throw new Error(res.error ?? "No se pudo guardar el movimiento")
    }
    return { ok: true } as AtomicRpcResult
  }

  throw new Error(`Tipo de operacion no soportado en la cola: ${item.tipo}`)
}

/**
 * ¿Este teléfono abrió la jornada de esa ruta y ese día SIN SEÑAL y todavía no
 * la subió? Mientras sea así, que el servidor diga "no hay fila" no significa
 * que la ruta no se inició: significa que la cola todavía no llegó.
 */
export async function hayInicioDeRutaPendiente(rutaId: number, fecha: string): Promise<boolean> {
  try {
    const items = await listarCola()
    return items.some(
      (i) =>
        i.tipo === "iniciar_ruta" &&
        i.identidad.ruta_id === rutaId &&
        (i.payload as { fecha?: string }).fecha === fecha,
    )
  } catch {
    return false
  }
}

function esErrorDeRed(err: unknown): boolean {
  if (err instanceof NetworkUnavailableError) return true
  // Los errores de supabase-js pueden llegar como objeto plano con `message`
  // ("TypeError: Failed to fetch"), no como Error: sin leerlo, un corte de red
  // contaba como error de negocio y el item terminaba "fallido".
  const msg =
    err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err)
  return (
    msg.includes("NetworkError") ||
    msg.includes("Failed to fetch") ||
    msg.includes("network") ||
    msg.includes("fetch")
  )
}

export interface ResultadoSync {
  sincronizados: number
  enRevision: number
  fallidos: number
  /** true si se corto por falta de red (quedan items pendientes). */
  interrumpido: boolean
}

const MAX_INTENTOS = 5
let drenando = false

/**
 * Envia las operaciones pendientes en ORDEN DE CAPTURA y una a una. No en
 * paralelo: varias operaciones pueden tocar el mismo prestamo y el orden
 * importa (p.ej. un pago y luego su reverso).
 *
 * Un error de RED corta el drenado y deja todo pendiente para el proximo
 * intento. Un error de NEGOCIO no se reintenta indefinidamente: tras varios
 * intentos el item queda marcado como fallido y visible para el usuario.
 */
export async function drenarCola(): Promise<ResultadoSync> {
  const vacio: ResultadoSync = { sincronizados: 0, enRevision: 0, fallidos: 0, interrumpido: false }
  if (drenando) return vacio
  if (typeof navigator !== "undefined" && !navigator.onLine) return vacio

  drenando = true
  const res: ResultadoSync = { ...vacio }

  try {
    const items = (await listarCola()).filter((i) => i.estado !== "fallido")
    for (const item of items) {
      await marcar(item, { estado: "enviando" })
      try {
        const r = await enviarItem(item)
        if (r.enviado_a_revision) {
          res.enRevision += 1
          // Quien aprueba tiene que enterarse AHORA, no cuando abra la app.
          // Antes esto no hacia falta porque la decision la tomaba el telefono
          // antes de encolar y el aviso salia desde el formulario. Ahora la
          // decide el servidor al recibirla, con el formulario cerrado hace
          // horas: si el aviso no sale de aca, no sale de ningun lado.
          const { avisarSolicitudPendiente } = await import("@/lib/avisos-revision")
          void avisarSolicitudPendiente({
            etiqueta: item.tipo === "venta" ? "Venta" : "Movimiento",
            detalle: item.descripcion,
            rutaId: item.identidad.ruta_id,
          })
        } else {
          res.sincronizados += 1
        }
        await quitar(item.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (esErrorDeRed(err)) {
          // Sin red: devolvemos el item a pendiente y paramos. Se reintenta
          // completo la proxima vez que haya conexion.
          await marcar(item, { estado: "pendiente", ultimoError: msg })
          res.interrumpido = true
          break
        }
        // Error de negocio: reintentar unas veces y luego dejarlo visible.
        const intentos = item.intentos + 1
        if (intentos >= MAX_INTENTOS) {
          await marcar(item, { estado: "fallido", intentos, ultimoError: msg })
          res.fallidos += 1
          console.error("[v0] Operacion offline fallida definitivamente:", item.descripcion, msg)
        } else {
          await marcar(item, { estado: "pendiente", intentos, ultimoError: msg })
        }
      }
    }
  } finally {
    drenando = false
    notificar()
  }

  return res
}

/**
 * Intenta enviar directo; si no hay red, encola y devuelve `encolado: true`.
 * Es el punto unico por el que pasan las escrituras de campo.
 */
export async function enviarOEncolar(args: {
  tipo: TipoOperacion
  payload: Record<string, unknown>
  descripcion: string
  /**
   * Llave ya generada por quien captura. Las gestiones la necesitan porque
   * el mismo id viaja DENTRO del payload (es el id del evento en el libro),
   * y tiene que ser idéntico al de la cola para que el reintento deduplique.
   */
  id?: string
  /**
   * LA RUTA EN LA QUE SE REGISTRA, cuando NO es la de la sesión.
   *
   * La identidad de una operación sale de `localStorage` —usuario, ruta, rol—
   * y para el cobrador en la calle eso es exactamente lo correcto: la ruta que
   * tiene abierta ES la ruta de lo que registra.
   *
   * Secretaría desde Control Total hace otra cosa: elige la ruta en la
   * pantalla. Sin esta llave, `p_ruta_id` se armaba con la ruta de la sesión y
   * la venta caía en la ruta equivocada — y el formulario ni se enteraba,
   * porque el `p_ruta_id` que calculaba nunca llegaba a viajar.
   *
   * Se guarda en el ITEM, no solo en el envío: una venta capturada sin señal
   * tiene que llegar a la misma ruta cuando se reenvíe mañana.
   */
  rutaId?: number
}): Promise<{ encolado: boolean; resultado?: AtomicRpcResult; id: string }> {
  // La llave se genera AL CAPTURAR, y es la misma que se use ahora o dentro
  // de dos horas: es lo que permite al servidor reconocer el reintento.
  const id = args.id ?? crypto.randomUUID()
  const item: ItemCola = {
    id,
    tipo: args.tipo,
    payload: args.payload,
    identidad: { ...getSessionIdentity(), ...(args.rutaId ? { ruta_id: args.rutaId } : {}) },
    capturadoEn: new Date().toISOString(),
    descripcion: args.descripcion,
    estado: "pendiente",
    intentos: 0,
  }

  const sinRed = typeof navigator !== "undefined" && !navigator.onLine
  if (sinRed) {
    await encolar({ tipo: args.tipo, payload: args.payload, descripcion: args.descripcion, id, rutaId: args.rutaId })
    return { encolado: true, id }
  }

  try {
    const resultado = await enviarItem(item)
    return { encolado: false, resultado, id }
  } catch (err) {
    if (esErrorDeRed(err)) {
      await encolar({ tipo: args.tipo, payload: args.payload, descripcion: args.descripcion, id, rutaId: args.rutaId })
      return { encolado: true, id }
    }
    throw err
  }
}
