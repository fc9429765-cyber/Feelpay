"use client"

/**
 * components/pagos-mapa-ruta.tsx
 * ---------------------------------------------------------------------------
 * LA PESTAÑA "MAPA" DE PAGOS: la ruta entera en el orden de visita de
 * "Ordenar Ruta" (`loans.ordenvisita`), con un mapa de la ubicación de cada
 * cliente y la línea del recorrido, y debajo la lista numerada.
 *
 * Entran TODOS los préstamos activos de la ruta que tiene la pantalla —los
 * por visitar y los ya gestionados hoy—, uno por renglón, igual que las demás
 * pestañas. Los que no tienen ubicación guardada se listan (en gris, "sin
 * ubicación") pero no van al mapa: la ubicación se guarda en la venta o en la
 * primera gestión con GPS.
 *
 * Se monta solo con la pestaña abierta: Leaflet no sabe medir un mapa oculto.
 */

import { useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import { Loader2, MapPin, MapPinOff, Navigation } from "lucide-react"
import { obtenerUbicacion } from "@/lib/geo"
import type { PuntoRuta } from "@/components/mapa-ruta-clientes"

const MapaRutaClientes = dynamic(() => import("@/components/mapa-ruta-clientes"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Cargando mapa…
    </div>
  ),
})

export interface ClienteMapa {
  loanId: string
  nombre: string
  detalle: string
  ordenvisita: number
  lat: number | null
  lng: number | null
  gestionado: boolean
}

export function PagosMapaRuta({ clientes }: { clientes: ClienteMapa[] }) {
  const [aqui, setAqui] = useState<{ lat: number; lng: number } | null>(null)
  const [enfocado, setEnfocado] = useState<string | null>(null)

  // Dónde está el cobrador, para el punto azul. Si no hay GPS, el mapa sale igual.
  useEffect(() => {
    let vigente = true
    obtenerUbicacion()
      .then((p) => { if (vigente) setAqui({ lat: p.latitud, lng: p.longitud }) })
      .catch(() => { /* sin GPS: solo los clientes */ })
    return () => { vigente = false }
  }, [])

  // El orden de "Ordenar Ruta"; los que no tienen número van al final.
  const ordenados = useMemo(() => {
    const unicos = new Map<string, ClienteMapa>()
    for (const c of clientes) if (!unicos.has(c.loanId)) unicos.set(c.loanId, c)
    return [...unicos.values()].sort((a, b) => {
      const oa = a.ordenvisita > 0 ? a.ordenvisita : 99999
      const ob = b.ordenvisita > 0 ? b.ordenvisita : 99999
      return oa - ob || a.nombre.localeCompare(b.nombre)
    })
  }, [clientes])

  const puntos: PuntoRuta[] = useMemo(
    () =>
      ordenados.flatMap((c, i) =>
        c.lat != null && c.lng != null
          ? [{ id: c.loanId, orden: i + 1, lat: c.lat, lng: c.lng, nombre: c.nombre, detalle: c.detalle, gestionado: c.gestionado }]
          : [],
      ),
    [ordenados],
  )
  const sinUbicacion = ordenados.length - puntos.length

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground md:text-xs">
        <span><b className="text-foreground">{ordenados.length}</b> en la ruta</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-[#1f6fe0]" /> Por visitar</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-[#16a34a]" /> Gestionado hoy</span>
        {sinUbicacion > 0 && <span className="flex items-center gap-1"><MapPinOff className="h-3 w-3" /> {sinUbicacion} sin ubicación</span>}
      </div>

      <div className="h-[340px] overflow-hidden rounded-xl border shadow-sm md:h-[460px]">
        {puntos.length > 0 || aqui ? (
          <MapaRutaClientes puntos={puntos} aqui={aqui} enfocado={enfocado} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <MapPinOff className="h-6 w-6" />
            Ningún cliente de esta ruta tiene ubicación guardada todavía.
          </div>
        )}
      </div>

      {/* La lista en el orden de visita. Tocar un cliente lo centra en el mapa. */}
      <div className="divide-y rounded-xl border">
        {ordenados.map((c, i) => {
          const ubicado = c.lat != null && c.lng != null
          return (
            <button
              key={c.loanId}
              type="button"
              disabled={!ubicado}
              onClick={() => { setEnfocado(null); requestAnimationFrame(() => setEnfocado(c.loanId)) }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                  !ubicado ? "bg-muted-foreground/40" : c.gestionado ? "bg-[#16a34a]" : "bg-[#1f6fe0]"
                }`}
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{c.nombre}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {c.detalle}{c.gestionado ? " · gestionado hoy" : ""}
                </span>
              </span>
              {ubicado ? (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold text-brand hover:bg-brand/10"
                  title="Cómo llegar"
                >
                  <Navigation className="h-3 w-3" /> Ir
                </a>
              ) : (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <MapPin className="h-3 w-3" /> sin ubicación
                </span>
              )}
            </button>
          )
        })}
        {ordenados.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">No hay clientes activos en esta ruta.</p>
        )}
      </div>
    </div>
  )
}
