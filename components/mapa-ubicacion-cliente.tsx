"use client"

/**
 * components/mapa-ubicacion-cliente.tsx
 * ---------------------------------------------------------------------------
 * EL PIN DEL CLIENTE en Crear Venta: un mapa de OpenStreetMap con el punto
 * azul de dónde está el vendedor y un pin rojo que es la ubicación que se va
 * a GUARDAR. El pin se arrastra, o se toca el mapa para ponerlo ahí.
 *
 * Leaflet directo (sin react-leaflet): ver components/mapa-ruta-clientes.tsx.
 * Se carga con `next/dynamic` (ssr:false).
 */

import { useEffect, useRef } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

type LObj = ReturnType<typeof L.map>

interface Props {
  /** La ubicación que se va a guardar (el pin). */
  pin: { lat: number; lng: number } | null
  /** Dónde está el vendedor ahora (punto azul). */
  actual: { lat: number; lng: number } | null
  onPin: (lat: number, lng: number) => void
}

const PIN = L.divIcon({
  className: "",
  html: `<div style="position:relative;width:30px;height:42px">
    <svg width="30" height="42" viewBox="0 0 30 42"><path d="M15 0C6.7 0 0 6.6 0 14.8 0 25.9 15 42 15 42s15-16.1 15-27.2C30 6.6 23.3 0 15 0z" fill="#dc2626" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5.5" fill="#fff"/></svg>
  </div>`,
  iconSize: [30, 42],
  iconAnchor: [15, 42],
})

export default function MapaUbicacionCliente({ pin, actual, onPin }: Props) {
  const divRef = useRef<HTMLDivElement | null>(null)
  const mapaRef = useRef<LObj | null>(null)
  const pinRef = useRef<LObj | null>(null)
  const actualRef = useRef<LObj | null>(null)
  const onPinRef = useRef(onPin)
  onPinRef.current = onPin
  const centrado = useRef(false)

  useEffect(() => {
    if (!divRef.current || mapaRef.current) return
    const mapa = L.map(divRef.current, { zoomControl: true }).setView([4.711, -74.0721], 5)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(mapa)
    // Tocar el mapa pone el pin ahí.
    mapa.on("click", (e: { latlng: { lat: number; lng: number } }) => onPinRef.current(e.latlng.lat, e.latlng.lng))
    mapaRef.current = mapa
    setTimeout(() => mapa.invalidateSize(), 150)
    return () => {
      mapa.remove()
      mapaRef.current = null
      pinRef.current = null
      actualRef.current = null
      // Un mapa nuevo (React lo vuelve a montar) tiene que volver a centrarse.
      centrado.current = false
    }
  }, [])

  // El pin (arrastrable).
  useEffect(() => {
    const mapa = mapaRef.current
    if (!mapa) return
    if (!pin) {
      pinRef.current?.remove()
      pinRef.current = null
      return
    }
    if (!pinRef.current) {
      pinRef.current = L.marker([pin.lat, pin.lng], { icon: PIN, draggable: true, autoPan: true })
        .on("dragend", () => {
          const p = pinRef.current.getLatLng()
          onPinRef.current(p.lat, p.lng)
        })
        .addTo(mapa)
    } else {
      pinRef.current.setLatLng([pin.lat, pin.lng])
    }
    // La primera vez que hay pin, el mapa se acerca a él.
    if (!centrado.current) {
      centrado.current = true
      mapa.setView([pin.lat, pin.lng], 17)
    }
  }, [pin])

  // Dónde está el vendedor.
  useEffect(() => {
    const mapa = mapaRef.current
    if (!mapa) return
    actualRef.current?.remove()
    actualRef.current = actual
      ? L.circleMarker([actual.lat, actual.lng], {
          radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1,
        }).bindTooltip("Estás aquí").addTo(mapa)
      : null
    if (actual && !pin && !centrado.current) {
      centrado.current = true
      mapa.setView([actual.lat, actual.lng], 17)
    }
  }, [actual, pin])

  return <div ref={divRef} style={{ width: "100%", height: "100%" }} />
}
