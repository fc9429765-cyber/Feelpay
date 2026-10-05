"use client"

/**
 * components/camara-en-app.tsx
 * ---------------------------------------------------------------------------
 * LA CÁMARA DENTRO DE LA APP, para que la venta no se pierda al sacar una foto.
 *
 * EL PROBLEMA (05-oct-2026): con `<input type="file" capture>` el teléfono
 * abre SU aplicación de cámara y la app queda en segundo plano. En los
 * celulares con poca memoria Android la CIERRA para darle lugar a la cámara:
 * al volver, la app arranca de cero —pide el PIN y el formulario de la venta
 * está vacío—. Pasaba con la cédula (lectura con IA) y con la evidencia.
 *
 * LA SOLUCIÓN: la foto se saca acá mismo, con `getUserMedia`. La app nunca se
 * va a segundo plano, así que no hay nada que cerrar. La foto sale de un
 * cuadro del video, a 1920 px como máximo (de sobra para leer una cédula y
 * mucho más liviano que la foto de 12-50 MP de la cámara del teléfono).
 *
 * Si el navegador no deja usar la cámara (permiso negado, sin HTTPS, un
 * navegador viejo), se ofrece la cámara del teléfono como antes: el botón es
 * un `<label>` del input original, así el toque del usuario abre el selector.
 */

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Camera, Loader2, RotateCcw, Check, X } from "lucide-react"

interface Props {
  titulo: string
  /** El input de archivo de siempre, para el respaldo (cámara del teléfono). */
  inputId: string
  onFoto: (file: File) => void
  onCerrar: () => void
}

const MAX_LADO = 1920

export function CamaraEnApp({ titulo, inputId, onFoto, onCerrar }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [estado, setEstado] = useState<"abriendo" | "lista" | "error">("abriendo")
  const [error, setError] = useState("")
  const [foto, setFoto] = useState<{ file: File; url: string } | null>(null)

  const apagar = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  useEffect(() => {
    let vigente = true
    const abrir = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setEstado("error")
        setError("Este navegador no permite usar la cámara dentro de la app.")
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        if (!vigente) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => { /* algunos navegadores ya lo reproducen solos */ })
        }
        setEstado("lista")
      } catch (err) {
        console.warn("[v0] Cámara en la app no disponible:", err)
        if (!vigente) return
        setEstado("error")
        const nombre = (err as { name?: string })?.name
        setError(
          nombre === "NotAllowedError"
            ? "No diste permiso para usar la cámara. Actívalo en los permisos del navegador o usa la cámara del teléfono."
            : "No se pudo abrir la cámara dentro de la app.",
        )
      }
    }
    void abrir()
    return () => { vigente = false; apagar() }
  }, [])

  // La vista previa se libera al cambiar o al cerrar.
  useEffect(() => () => { if (foto) URL.revokeObjectURL(foto.url) }, [foto])

  const disparar = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const k = Math.min(1, MAX_LADO / Math.max(v.videoWidth, v.videoHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(v.videoWidth * k)
    canvas.height = Math.round(v.videoHeight * k)
    canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) return
      const file = new File([blob], `foto-${Date.now()}.jpg`, { type: "image/jpeg" })
      setFoto({ file, url: URL.createObjectURL(blob) })
    }, "image/jpeg", 0.85)
  }

  const usar = () => {
    if (!foto) return
    apagar()
    onFoto(foto.file)
    onCerrar()
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      style={{
        position: "fixed", inset: 0, zIndex: 2000, background: "#000", color: "#fff",
        display: "flex", flexDirection: "column", fontFamily: "var(--font-nunito-sans), 'Nunito Sans', sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
        <button
          type="button"
          onClick={() => { apagar(); onCerrar() }}
          aria-label="Cerrar cámara"
          style={{ width: 40, height: 40, borderRadius: 999, border: 0, background: "rgba(255,255,255,.15)", color: "#fff", display: "grid", placeItems: "center" }}
        >
          <X size={22} />
        </button>
        <b style={{ fontSize: 17 }}>{titulo}</b>
      </div>

      <div style={{ flex: 1, position: "relative", display: "grid", placeItems: "center", overflow: "hidden" }}>
        {/* El video sigue montado con la vista previa encima: "Repetir" vuelve
            al instante, sin pedir la cámara otra vez. */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{ width: "100%", height: "100%", objectFit: "contain", display: estado === "lista" && !foto ? "block" : "none" }}
        />
        {foto && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={foto.url} alt="Vista previa" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        )}
        {estado === "abriendo" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 16 }}>
            <Loader2 size={22} className="animate-spin" /> Abriendo la cámara…
          </div>
        )}
        {estado === "error" && (
          <div style={{ maxWidth: 340, textAlign: "center", padding: 20, display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
            <span style={{ fontSize: 15, lineHeight: 1.4 }}>{error}</span>
            {/* Un <label> del input original: el toque del usuario abre la
                cámara del teléfono como siempre. */}
            <label
              htmlFor={inputId}
              onClick={() => setTimeout(onCerrar, 0)}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "12px 20px", borderRadius: 12, background: "#1f6fe0", color: "#fff", fontWeight: 700, cursor: "pointer" }}
            >
              <Camera size={20} /> Usar la cámara del teléfono
            </label>
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 28, padding: "18px 16px 28px" }}>
        {foto ? (
          <>
            <button
              type="button"
              onClick={() => setFoto(null)}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 52, padding: "0 22px", borderRadius: 14, border: "1.5px solid rgba(255,255,255,.5)", background: "transparent", color: "#fff", fontSize: 16, fontWeight: 700 }}
            >
              <RotateCcw size={20} /> Repetir
            </button>
            <button
              type="button"
              onClick={usar}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 52, padding: "0 26px", borderRadius: 14, border: 0, background: "#16a34a", color: "#fff", fontSize: 16, fontWeight: 800 }}
            >
              <Check size={22} /> Usar foto
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={disparar}
            disabled={estado !== "lista"}
            aria-label="Tomar foto"
            style={{ width: 74, height: 74, borderRadius: "50%", border: "5px solid #fff", background: estado === "lista" ? "rgba(255,255,255,.25)" : "rgba(255,255,255,.08)" }}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
