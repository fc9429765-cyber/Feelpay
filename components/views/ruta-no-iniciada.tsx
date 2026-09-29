"use client"

/**
 * El guard de "Ruta no iniciada" y el botón que la abre.
 *
 * Vive acá y no dentro de una pantalla porque ahora lo usan dos: el módulo de
 * pagos (que además exige la ruta ABIERTA para poder cobrar) y el bloqueo
 * global de los vendedores, que no pueden entrar a ningún módulo antes de
 * iniciar la jornada. Dos copias de esta lógica terminarían discrepando en
 * cuándo se considera abierta una ruta.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AlertCircle, Loader2, Play, MessageSquare } from "lucide-react"
import { getSupabaseSafe } from "@/lib/api-helper"
import { useToast } from "@/hooks/use-toast"
import { todayColombia } from "@/lib/colombia-date"
import { encolar } from "@/lib/offline-queue"
import { esErrorDeRed } from "@/lib/credenciales-offline"

export type EstadoRuta = "abierta" | "cerrada" | null

interface Props {
  rutaId: number
  /** false = el padre todavía no sabe el estado: se muestra un spinner. */
  resuelto: boolean
  estado: EstadoRuta
  onEstadoChange?: (estado: EstadoRuta) => void
  /** Qué se está bloqueando, para que el mensaje diga algo concreto. */
  mensaje: string
  /** Si viene, se ofrece el atajo al Resumen del Día. */
  onIrAResumen?: () => void
  /** Si viene, se ofrece el atajo al chat, que queda abierto con la ruta cerrada. */
  onIrAlChat?: () => void
}

export function RutaNoIniciada({
  rutaId, resuelto, estado, onEstadoChange, mensaje, onIrAResumen, onIrAlChat,
}: Props) {
  const { toast } = useToast()
  const [iniciando, setIniciando] = useState(false)

  /**
   * Abrir la jornada. Es idempotente: si la fila ya existe (otra pestaña, otro
   * dispositivo, o el Resumen del Día) recupera el estado real con un SELECT y
   * sincroniza el guard, en vez de fallarle al usuario.
   */
  const iniciarRuta = async () => {
    if (iniciando) return

    // SIN SEÑAL LA RUTA SE ABRE IGUAL. Antes esto pedía conexión y un
    // cobrador que arrancaba el día en una zona sin cobertura no podía cobrar
    // nada. Ahora la apertura entra a la cola —primera de todas, porque se
    // captura antes que cualquier cobro— y se sube al volver la señal. Es
    // idempotente: si otro teléfono ya la había abierto, no se duplica.
    const abrirSinSenal = async () => {
      await encolar({
        tipo: "iniciar_ruta",
        payload: { fecha: todayColombia() },
        descripcion: "Inicio de ruta",
        id: crypto.randomUUID(),
      })
      onEstadoChange?.("abierta")
      toast({
        title: "Ruta iniciada sin señal",
        description: "Ya puedes trabajar. El inicio se sube solo cuando vuelva la conexión.",
      })
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      try {
        setIniciando(true)
        await abrirSinSenal()
      } finally {
        setIniciando(false)
      }
      return
    }

    try {
      setIniciando(true)
      const supabase = await getSupabaseSafe()
      const fechaHoy = todayColombia()

      // 1) ¿Ya existe una fila para hoy?
      const { data: existente, error: errorSelect } = await supabase
        .from("rutas_diarias")
        .select("id, estado")
        .eq("ruta_id", rutaId)
        .eq("fecha", fechaHoy)
        .maybeSingle()

      if (errorSelect) {
        console.error("[v0] Error consultando rutas_diarias:", errorSelect.message)
        // "Tengo red" pero no contesta: supabase DEVUELVE el error, no lo
        // lanza, así que el catch de abajo nunca se enteraba.
        if (esErrorDeRed(errorSelect)) {
          await abrirSinSenal()
          return
        }
      }

      if (existente) {
        const estadoExistente = (existente as { estado: string | null }).estado as EstadoRuta
        if (estadoExistente === "abierta") {
          onEstadoChange?.("abierta")
          toast({ title: "Ruta ya iniciada", description: "La ruta ya estaba abierta para hoy. Sincronizando..." })
          return
        }
        if (estadoExistente === "cerrada") {
          onEstadoChange?.("cerrada")
          toast({
            title: "La ruta del día está cerrada",
            description: "Contacta al administrador para reabrir la ruta.",
            variant: "destructive",
          })
          return
        }
      }

      // 2) No existe — insertar.
      const { data, error } = await supabase
        .from("rutas_diarias")
        .insert({ ruta_id: rutaId, fecha: fechaHoy, estado: "abierta" })
        .select("id, estado")
        .single()

      if (error) {
        // 23505 = otra petición la creó entre nuestro SELECT y nuestro INSERT.
        const esDuplicado =
          (error as { code?: string }).code === "23505" ||
          /unique_ruta_por_dia|duplicate key/i.test(error.message)

        if (esDuplicado) {
          const { data: refetch } = await supabase
            .from("rutas_diarias")
            .select("estado")
            .eq("ruta_id", rutaId)
            .eq("fecha", fechaHoy)
            .maybeSingle()
          const e = ((refetch as { estado: string | null } | null)?.estado ?? null) as EstadoRuta
          if (e) onEstadoChange?.(e)
          toast({
            title: e === "abierta" ? "Ruta ya iniciada" : "Sincronizando estado de ruta",
            description:
              e === "abierta"
                ? "La ruta ya estaba abierta para hoy."
                : "Se actualizó el estado actual de la ruta.",
          })
          return
        }

        console.error("[v0] Error iniciando ruta:", error.message)
        if (esErrorDeRed(error)) {
          await abrirSinSenal()
          return
        }
        toast({ title: "No se pudo iniciar la ruta", description: error.message, variant: "destructive" })
        return
      }

      if (data) {
        onEstadoChange?.("abierta")
        toast({ title: "Ruta iniciada", description: "Ya puedes trabajar normalmente." })
      }
    } catch (err) {
      console.error("[v0] Unexpected error iniciando ruta:", err)
      // La red se cayó a mitad de camino: se abre sin señal.
      if (esErrorDeRed(err)) await abrirSinSenal()
    } finally {
      setIniciando(false)
    }
  }

  // Mientras el padre no haya resuelto el estado se muestra un spinner neutro
  // y no el guard: si no, cada recarga hace un flash de "Ruta no iniciada"
  // sobre una ruta que sí está abierta.
  if (!resuelto && estado === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-steel">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Verificando estado de la ruta...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-steel">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-warning/10 ring-4 ring-warning/20">
        <AlertCircle className="h-8 w-8 text-warning" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-xl font-bold text-foreground">
          {estado === "cerrada" ? "Jornada cerrada" : "Ruta no iniciada"}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
          {estado === "cerrada"
            ? "La caja de hoy ya se cuadró y se cerró. No se pueden registrar más movimientos hasta mañana, cuando inicies la ruta de nuevo. Si necesitas reabrir el día, contacta al administrador."
            : mensaje}
        </p>
        {/* SE DICE que el chat sigue abierto, no se deja que lo descubran.
            Cerrar la caja bloquea la app entera y lo último del día es
            justamente mandar el reporte: sin este renglón, el cobrador ve una
            pantalla que dice "no se puede nada" y no se le ocurre buscar el
            chat en el menú. */}
        {onIrAlChat && (
          <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
            El chat sigue disponible para que termines de enviar tus reportes.
          </p>
        )}
      </div>
      {onIrAlChat && (
        <Button size="lg" variant="outline" className="gap-2" onClick={onIrAlChat}>
          <MessageSquare className="h-4 w-4" />
          Ir al chat
        </Button>
      )}
      {estado !== "cerrada" && (
        <div className="flex flex-col items-center gap-2 sm:flex-row">
          <Button
            size="lg"
            className="gap-2 bg-success text-success-foreground hover:bg-success/90"
            onClick={iniciarRuta}
            disabled={iniciando}
          >
            {iniciando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {iniciando ? "Iniciando..." : "Iniciar Ruta"}
          </Button>
          {onIrAResumen && (
            <Button size="lg" variant="outline" className="gap-2" onClick={onIrAResumen} disabled={iniciando}>
              Ir a Resumen del Día
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
