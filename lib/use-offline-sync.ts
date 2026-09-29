"use client"

/**
 * lib/use-offline-sync.ts
 * ---------------------------------------------------------------------------
 * Estado de conexion + sincronizacion automatica de la cola offline.
 *
 * Se monta UNA sola vez (en el indicador del header). Dispara el drenado:
 *   - al recuperar la conexion (`online`)
 *   - al abrir la app, si quedaron pendientes de una sesion anterior
 *   - cada 30s mientras la app este abierta, y al volver a la app
 *
 * `navigator.onLine` solo dice si hay interfaz de red, no si internet responde
 * de verdad. Por eso el drenado tambien se dispara periodicamente: si el
 * telefono cree estar conectado pero no llega al servidor, el envio falla por
 * red, el item vuelve a la cola y se reintenta al siguiente ciclo.
 */

import { useCallback, useEffect, useState } from "react"
import {
  contarFallidos,
  contarPendientes,
  drenarCola,
  suscribirCola,
  type ResultadoSync,
} from "@/lib/offline-queue"

export function useOfflineSync() {
  const [online, setOnline] = useState(true)
  const [pendientes, setPendientes] = useState(0)
  const [fallidos, setFallidos] = useState(0)
  const [sincronizando, setSincronizando] = useState(false)
  const [ultimoResultado, setUltimoResultado] = useState<ResultadoSync | null>(null)

  const refrescarConteo = useCallback(async () => {
    try {
      setPendientes(await contarPendientes())
      setFallidos(await contarFallidos())
    } catch (err) {
      console.error("[v0] Error leyendo la cola offline:", err)
    }
  }, [])

  const sincronizar = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return
    setSincronizando(true)
    try {
      const res = await drenarCola()
      if (res.sincronizados > 0 || res.enRevision > 0 || res.fallidos > 0) {
        setUltimoResultado(res)
      }
    } finally {
      setSincronizando(false)
      void refrescarConteo()
    }
  }, [refrescarConteo])

  // Estado de conexion
  useEffect(() => {
    if (typeof window === "undefined") return
    setOnline(navigator.onLine)

    const alConectar = () => {
      setOnline(true)
      void sincronizar()
    }
    const alDesconectar = () => setOnline(false)

    window.addEventListener("online", alConectar)
    window.addEventListener("offline", alDesconectar)
    return () => {
      window.removeEventListener("online", alConectar)
      window.removeEventListener("offline", alDesconectar)
    }
  }, [sincronizar])

  // Conteo inicial + suscripcion a cambios de la cola
  useEffect(() => {
    void refrescarConteo()
    return suscribirCola(() => void refrescarConteo())
  }, [refrescarConteo])

  // Drenado al abrir la app, cada 30s si quedan pendientes, y al VOLVER a la
  // app (desbloquear el teléfono, cambiar de aplicación). En la calle la señal
  // casi nunca "vuelve" con un evento `online`: el teléfono dice que tiene red
  // todo el tiempo y lo que cambia es si responde.
  useEffect(() => {
    void sincronizar()
    const t = setInterval(() => {
      if (typeof navigator !== "undefined" && navigator.onLine) void sincronizar()
    }, 30_000)
    const alVolver = () => {
      if (document.visibilityState === "visible") void sincronizar()
    }
    document.addEventListener("visibilitychange", alVolver)
    return () => {
      clearInterval(t)
      document.removeEventListener("visibilitychange", alVolver)
    }
  }, [sincronizar])

  return {
    online,
    pendientes,
    fallidos,
    sincronizando,
    ultimoResultado,
    limpiarResultado: () => setUltimoResultado(null),
    sincronizar,
    refrescarConteo,
  }
}
