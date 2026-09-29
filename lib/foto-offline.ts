/**
 * lib/foto-offline.ts
 * ---------------------------------------------------------------------------
 * FOTOS QUE SE TOMAN SIN SEÑAL.
 *
 * La evidencia de entrega es obligatoria para crear una venta, y se subía a
 * `/api/upload-photo` AL ELEGIRLA. Sin señal la subida fallaba, el botón
 * "Crear Venta" no se habilitaba nunca, y la cola de ventas offline quedaba
 * inservible: ninguna venta podía llegar a encolarse.
 *
 * Ahora, si no se puede subir, la foto se COMPRIME y se guarda dentro del
 * payload como `data:` URL. La cola, antes de mandar la venta, sube esas
 * fotos y cambia el `data:` por la URL real (ver `subirFotosPendientes`).
 */

/** Los campos que pueden llevar una foto pendiente, y la carpeta de cada uno. */
const CAMPOS_FOTO: Record<string, string> = {
  comprobante_url: "comprobantes",
  foto_local_url: "locales",
  // La foto del pago (va en el evento del libro, `detalle.foto_url`).
  foto_url: "pagos",
}

/** ¿Es una foto que todavía no subió (vive solo en el teléfono)? */
export function esFotoPendiente(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("data:")
}

const leerComoDataUrl = (blob: Blob) =>
  new Promise<string>((ok, mal) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => mal(r.error)
    r.readAsDataURL(blob)
  })

/**
 * La foto lista para quedarse en la cola: JPEG de 1280 px como máximo. Una
 * foto de cámara pesa 3–5 MB; así queda en ~200 KB y la cola no se infla.
 * Un PDF se guarda tal cual (no se puede achicar), hasta 4 MB.
 */
export async function fotoParaCola(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    if (file.size > 4 * 1024 * 1024) throw new Error("Sin señal solo se puede guardar un PDF de hasta 4 MB. Usa una foto.")
    return leerComoDataUrl(file)
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, mal) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => mal(new Error("No se pudo leer la foto"))
      i.src = url
    })
    const MAX = 1280
    const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(img.naturalWidth * k)
    canvas.height = Math.round(img.naturalHeight * k)
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL("image/jpeg", 0.7)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function subirDataUrl(dataUrl: string, carpeta: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob()
  const ext = blob.type === "application/pdf" ? "pdf" : "jpg"
  const fd = new FormData()
  fd.append("file", new File([blob], `offline.${ext}`, { type: blob.type }))
  fd.append("folder", carpeta)
  // Un "Failed to fetch" acá deja el item de la cola pendiente, como
  // cualquier otro corte de red.
  const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
  const json = (await res.json()) as { success?: boolean; url?: string; error?: string }
  if (!json.success || !json.url) throw new Error(json.error ?? "No se pudo subir la foto guardada sin señal")
  return json.url
}

/**
 * Sube las fotos pendientes que haya en cualquier nivel del payload y
 * devuelve una copia con las URLs reales. `cambio` avisa si hubo que subir
 * algo, para guardar el payload nuevo y no volver a subirlas en un reintento.
 */
export async function subirFotosPendientes<T>(payload: T, rutaId: number): Promise<{ payload: T; cambio: boolean }> {
  let cambio = false
  const recorrer = async (v: unknown): Promise<unknown> => {
    if (Array.isArray(v)) return Promise.all(v.map(recorrer))
    if (!v || typeof v !== "object") return v
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k in CAMPOS_FOTO && esFotoPendiente(val as string)) {
        out[k] = await subirDataUrl(val as string, `${CAMPOS_FOTO[k]}/${rutaId}`)
        cambio = true
      } else {
        out[k] = await recorrer(val)
      }
    }
    return out
  }
  const nuevo = (await recorrer(payload)) as T
  return { payload: nuevo, cambio }
}
