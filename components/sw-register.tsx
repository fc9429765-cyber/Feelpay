"use client"

import { useEffect } from "react"

export function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return

    navigator.serviceWorker
      .register("/sw.js", {
        scope: "/",
        // Nunca usar la versión cacheada del SW — siempre buscar el archivo
        // actualizado en el servidor para que install+activate corran de
        // inmediato y el SW en "waiting" no bloquee las notificaciones push.
        updateViaCache: "none",
      })
      .then((reg) => {
        console.log("[v0] SW registrado, scope:", reg.scope)
        // Forzar update para que sw.js nuevo entre en vigor de inmediato
        reg.update().catch(() => {})
        // QUE LA APP QUEDE GUARDADA DESDE LA PRIMERA VISITA: se le pasa al SW
        // la lista de archivos propios que esta página ya descargó (scripts,
        // estilos, fuentes, imágenes) para que los guarde. Sin esto, la app
        // solo abría sin señal después de una SEGUNDA carga con red.
        const avisar = () => {
          const urls = [
            "/",
            ...performance
              .getEntriesByType("resource")
              .map((e) => e.name)
              .filter((u) => u.startsWith(location.origin) && !u.includes("/api/")),
          ]
          const sw = navigator.serviceWorker.controller ?? reg.active ?? reg.installing ?? reg.waiting
          sw?.postMessage({ tipo: "precache", urls })
        }
        if (document.readyState === "complete") setTimeout(avisar, 1500)
        else window.addEventListener("load", () => setTimeout(avisar, 1500), { once: true })
        navigator.serviceWorker.ready.then(() => setTimeout(avisar, 3000)).catch(() => {})
      })
      .catch((err) => console.error("[v0] SW register error:", err))
  }, [])

  return null
}
