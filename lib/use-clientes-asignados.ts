"use client"

/**
 * CLIENTES ASIGNADOS A UNA RUTA: cuántos clientes tienen al menos un préstamo
 * ACTIVO en ella. Un recuento dinámico, no un número guardado: sale de
 * `loans` cada vez, así que sube con cada venta y baja con cada cancelación.
 *
 * Se cuentan CLIENTES distintos, no préstamos: un cliente con dos créditos
 * activos es un solo cliente asignado.
 *
 * Lo usan el Resumen del Día (en la barra de arriba, junto a la unidad) y el
 * Detalle de Ruta (junto al título). Una sola definición para los dos.
 *
 * Se vuelve a contar al volver a la app, al recuperar la señal y cada 2
 * minutos. Sin señal se queda con el último número conocido.
 */

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"

export async function contarClientesAsignados(rutaId: number): Promise<number> {
  const sb = createClient()
  const clientes = new Set<string>()
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb
      .from("loans")
      .select("client_id")
      .eq("ruta", rutaId)
      .eq("estado", "activo")
      .range(desde, desde + 999)
    if (error) throw error
    for (const l of (data ?? []) as { client_id: string | null }[]) {
      if (l.client_id) clientes.add(l.client_id)
    }
    if (!data || data.length < 1000) break
  }
  return clientes.size
}

export function useClientesAsignados(rutaId: number | null | undefined): number | null {
  const [cantidad, setCantidad] = useState<number | null>(null)

  useEffect(() => {
    if (rutaId == null) {
      setCantidad(null)
      return
    }
    let vigente = true
    const clave = `clientesAsignados:${rutaId}`
    // Lo último conocido, para que el número aparezca al instante y sin señal.
    try {
      const guardado = localStorage.getItem(clave)
      setCantidad(guardado != null ? Number(guardado) : null)
    } catch {
      setCantidad(null)
    }

    const contar = async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) return
      try {
        const n = await contarClientesAsignados(rutaId)
        if (!vigente) return
        setCantidad(n)
        try { localStorage.setItem(clave, String(n)) } catch { /* modo privado */ }
      } catch (err) {
        console.warn("[v0] No se pudieron contar los clientes asignados:", err)
      }
    }
    void contar()

    const alVolver = () => { if (document.visibilityState === "visible") void contar() }
    const alConectar = () => { void contar() }
    document.addEventListener("visibilitychange", alVolver)
    window.addEventListener("online", alConectar)
    const reloj = setInterval(contar, 120_000)
    return () => {
      vigente = false
      document.removeEventListener("visibilitychange", alVolver)
      window.removeEventListener("online", alConectar)
      clearInterval(reloj)
    }
  }, [rutaId])

  return cantidad
}
