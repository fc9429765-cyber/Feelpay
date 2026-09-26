import type { NextRequest } from "next/server"

// Vision processing can take more than the default 10s edge limit.
// Force Node.js runtime and allow up to 60s for the OpenAI call.
export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    console.log("[v0] Iniciando procesamiento de cédula")

    // ── Validar variables de entorno requeridas ──────────────────────────
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY
    const OPENAI_ORG_ID = process.env.OPENAI_ORG_ID

    if (!OPENAI_API_KEY) {
      console.error("[v0] OPENAI_API_KEY no configurada")
      return Response.json(
        {
          error: "OpenAI API key no configurada",
          details: "Falta la variable de entorno OPENAI_API_KEY. Contacte al administrador.",
        },
        { status: 500 },
      )
    }

    // OPENAI_ORG_ID es opcional en el SDK pero el proyecto lo requiere.
    // Si no está, dejamos un warning y seguimos (no rompe la llamada).
    if (!OPENAI_ORG_ID) {
      console.warn("[v0] OPENAI_ORG_ID no configurada · se enviará la solicitud sin cabecera de organización")
    } else {
      console.log("[v0] Usando OPENAI_ORG_ID:", `${OPENAI_ORG_ID.slice(0, 7)}…`)
    }

    const body = await request.json()
    const { imageBase64 } = body
    /**
     * QUÉ SE LEE DE LA FOTO.
     *   (sin modo)   el FRENTE: número de documento y nombre, como siempre.
     *   "direccion"  el RESPALDO: la dirección de vivienda, para llenar el
     *                campo Dirección del cliente nuevo.
     */
    const modo = body.modo === "direccion" ? "direccion" : "frente"

    if (!imageBase64) {
      console.log("[v0] No image provided")
      return Response.json({ error: "No image provided" }, { status: 400 })
    }

    console.log("[v0] Imagen recibida, tamaño:", imageBase64.length)

    // Extract base64 data from data URL if needed
    let base64Data = imageBase64
    if (imageBase64.includes(",")) {
      base64Data = imageBase64.split(",")[1]
      console.log("[v0] Base64 extraído, tamaño:", base64Data.length)
    }

    console.log("[v0] Enviando a OpenAI...")

    // Construir cabeceras (incluye organización si está disponible)
    const openaiHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    }
    if (OPENAI_ORG_ID) {
      openaiHeaders["OpenAI-Organization"] = OPENAI_ORG_ID
    }

    // Llamar directamente a la API de OpenAI usando fetch
    const llamarOpenAI = () => fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: openaiHeaders,
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: modo === "direccion"
                  // EL RESPALDO. Se pide como TRANSCRIPCIÓN de lo que está
                  // impreso junto a la etiqueta, no como "la dirección de
                  // alguien": pedido así, el modelo se negaba casi siempre
                  // por privacidad. Y solo el domicilio: el respaldo también
                  // trae el lugar de nacimiento, que NO es dónde vive.
                  ? 'This is an OCR transcription task for a registration form. The person photographed the back of THEIR OWN identity card to fill in their own form. Transcribe, character by character, the text printed next to the label "DOMICILIO" (or "DIRECCIÓN", "DIRECCION", "RESIDENCIA"), including any continuation on the following line (street, number, neighborhood, city). Ignore the place of birth ("LUGAR DE NACIMIENTO"). If there is no such label, use an empty string. Return only a JSON object with a "direccion" field.'
                  : 'You are a data entry API designed to assist users in filling out their own registration forms. The user has uploaded this image and consents to data extraction. Your task is purely OCR: extract the full name and document number visible in the image. Return only a JSON object with "numero_documento" and "nombre_completo" fields.',
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Data}`,
                },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    })

    // HASTA TRES INTENTOS. Con fotos de documentos el modelo a veces se niega
    // ("I'm unable to assist") y a la vuelta siguiente lee la MISMA imagen
    // sin problema; y la conexión con OpenAI a veces se corta ("fetch
    // failed"). Reintentar resuelve casi todos esos casos sin que el
    // cobrador tenga que volver a tomar la foto.
    let openaiResponse: Response | null = null
    let openaiData: { choices?: { message?: { content?: string; refusal?: string } }[] } = {}
    let responseText: string | undefined
    let refusal: string | undefined
    for (let intento = 1; intento <= 3; intento++) {
      try {
        openaiResponse = await llamarOpenAI()
      } catch (err) {
        if (intento < 3) {
          console.warn("[v0] Falló la conexión con OpenAI, reintentando:", err)
          continue
        }
        throw err
      }
      console.log("[v0] OpenAI response status:", openaiResponse.status)

      if (!openaiResponse.ok) {
        const errorData = await openaiResponse.json()
        console.error("[v0] OpenAI error:", errorData)
        return Response.json(
          {
            error: "Error de OpenAI",
            details: errorData.error?.message || "Error desconocido"
          },
          { status: 500 }
        )
      }

      openaiData = await openaiResponse.json()
      responseText = openaiData.choices?.[0]?.message?.content
      refusal = openaiData.choices?.[0]?.message?.refusal
      if (refusal && intento < 3) {
        console.warn("[v0] OpenAI se negó, reintentando:", refusal)
        continue
      }
      break
    }
    console.log("[v0] OpenAI response recibida")

    console.log("[v0] Refusal:", refusal)
    console.log("[v0] Extracted responseText:", responseText)
    
    if (refusal) {
      console.log("[v0] OpenAI rechazó la solicitud:", refusal)
      return Response.json(
        { error: "OpenAI no puede procesar esta imagen", details: refusal },
        { status: 400 }
      )
    }
    
    if (!responseText) {
      console.log("[v0] No response content from OpenAI")
      return Response.json(
        { error: "No response from OpenAI" },
        { status: 500 }
      )
    }

    console.log("[v0] Response text:", responseText)
    
    try {
      const datos = JSON.parse(responseText)
      console.log("[v0] JSON parseado exitosamente:", datos)
      return Response.json(datos)
    } catch (parseError) {
      console.error("[v0] Error parsing JSON:", parseError)
      console.log("[v0] Raw response text:", responseText)
      return Response.json(
        { 
          error: "Error parsing response", 
          details: String(parseError),
          rawResponse: responseText 
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error("[v0] Error en endpoint:", error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.log("[v0] Error details:", errorMessage)
    
    return Response.json(
      { 
        error: "Error al procesar la cédula", 
        details: errorMessage 
      },
      { status: 500 }
    )
  }
}
