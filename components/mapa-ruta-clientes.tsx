"use client"

/**
 * components/mapa-ruta-clientes.tsx
 * ---------------------------------------------------------------------------
 * EL MAPA DE LA RUTA en la pestaña "Mapa" de Pagos: cada cliente en su
 * ubicación guardada (`clients.latitud/longitud`), numerado con el orden de
 * visita de "Ordenar Ruta" (`loans.ordenvisita`), y la línea del recorrido en
 * ese orden. El punto azul es dónde está el cobrador ahora.
 *
 * Leaflet a mano y no `react-leaflet`: el proyecto no trae los tipos de
 * Leaflet y los componentes de react-leaflet no compilan limpios sin ellos.
 * Así además se controla cuándo recentrar (al tocar un cliente de la lista).
 *
 * Se carga con `next/dynamic` (ssr:false): Leaflet toca `window` al importarse.
 */

import { useEffect, useRef } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

export interface PuntoRuta {
  id: string
  orden: number
  lat: number
  lng: number
  nombre: string
  detalle: string
  gestionado: boolean
}

interface Props {
  puntos: PuntoRuta[]
  /** Dónde está el cobrador ahora (punto azul). */
  aqui: { lat: number; lng: number } | null
  /** Cliente a centrar (al tocarlo en la lista). */
  enfocado: string | null
}

// Sin `@types/leaflet` (ver types/leaflet.d.ts) los objetos de Leaflet son `any`.
type LObj = ReturnType<typeof L.map>

const VERDE = "#16a34a"
const AZUL = "#1f6fe0"

function icono(n: number, color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="width:28px;height:28px;border-radius:50%;background:${color};color:#fff;font:700 12px/1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)">${n}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  })
}

const escapar = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export default function MapaRutaClientes({ puntos, aqui, enfocado }: Props) {
  const divRef = useRef<HTMLDivElement | null>(null)
  const mapaRef = useRef<LObj | null>(null)
  const capaRef = useRef<LObj | null>(null)
  const aquiRef = useRef<LObj | null>(null)
  const marcadores = useRef(new Map<string, LObj>())

  // El mapa se crea una sola vez.
  useEffect(() => {
    if (!divRef.current || mapaRef.current) return
    const mapa = L.map(divRef.current, { zoomControl: true }).setView([4.711, -74.0721], 13)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(mapa)
    capaRef.current = L.layerGroup().addTo(mapa)
    mapaRef.current = mapa
    // El contenedor puede terminar de medirse después del primer pintado.
    setTimeout(() => mapa.invalidateSize(), 150)
    return () => {
      mapa.remove()
      mapaRef.current = null
    }
  }, [])

  // Los clientes y el recorrido.
  useEffect(() => {
    const mapa = mapaRef.current
    const capa = capaRef.current
    if (!mapa || !capa) return
    capa.clearLayers()
    marcadores.current.clear()
    const linea: [number, number][] = []
    for (const p of puntos) {
      linea.push([p.lat, p.lng])
      const m = L.marker([p.lat, p.lng], { icon: icono(p.orden, p.gestionado ? VERDE : AZUL) })
        .bindPopup(
          `<div style="font:13px/1.35 system-ui,sans-serif;min-width:160px">
            <b>${p.orden}. ${escapar(p.nombre)}</b><br/>
            <span style="color:#4a5878">${escapar(p.detalle)}</span><br/>
            <span style="color:${p.gestionado ? VERDE : AZUL};font-weight:700">${p.gestionado ? "Gestionado hoy" : "Por visitar"}</span><br/>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noreferrer">Cómo llegar</a>
          </div>`,
        )
        .addTo(capa)
      marcadores.current.set(p.id, m)
    }
    if (linea.length > 1) {
      L.polyline(linea, { color: "#2f6690", weight: 4, opacity: 0.7, dashArray: "6, 8" }).addTo(capa)
    }
    const todos = aqui ? [...linea, [aqui.lat, aqui.lng] as [number, number]] : linea
    if (todos.length > 0) mapa.fitBounds(L.latLngBounds(todos), { padding: [32, 32], maxZoom: 16 })
  }, [puntos, aqui])

  // Dónde está el cobrador.
  useEffect(() => {
    const mapa = mapaRef.current
    if (!mapa) return
    aquiRef.current?.remove()
    aquiRef.current = aqui
      ? L.circleMarker([aqui.lat, aqui.lng], {
          radius: 9, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1,
        }).bindTooltip("Estás aquí").addTo(mapa)
      : null
  }, [aqui])

  // Centrar en el cliente tocado en la lista.
  useEffect(() => {
    if (!enfocado) return
    const m = marcadores.current.get(enfocado)
    if (!m || !mapaRef.current) return
    mapaRef.current.setView(m.getLatLng(), Math.max(mapaRef.current.getZoom(), 16))
    m.openPopup()
  }, [enfocado])

  return <div ref={divRef} className="h-full w-full" />
}
