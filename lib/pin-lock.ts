"use client"

/**
 * El candado de la app.
 *
 * UNA SOLA RAZÓN: LA INACTIVIDAD
 * El PIN se pide cuando pasaron 5 minutos sin que nadie tocara la app. Nada
 * más lo dispara: ni minimizar, ni cerrarla, ni actualizar a la versión nueva.
 *
 * Antes eran tres razones y las tres estorbaban. Minimizar armaba el candado
 * al instante, así que abrir la cámara, mirar un WhatsApp o contestar una
 * llamada costaba teclear el PIN — varias veces por cliente. Y abrir la app
 * arrancaba bloqueado siempre, aunque se hubiera cerrado hace diez segundos.
 *
 * EL RELOJ NO SE REINICIA AL CERRAR, y ahí está la parte que importa. La marca
 * de la última actividad vive en `localStorage`, así que el tiempo corre igual
 * con la app cerrada: volver a los diez minutos pide PIN, aunque la app no
 * haya estado abierta ni un segundo de esos diez. Si el reloj viviera en
 * memoria, cerrar y abrir sería la forma de esquivarlo.
 *
 * Dicho al revés: lo que se quitó no es la protección, es el castigo por
 * minimizar. Un teléfono que cambia de manos sigue quedando bloqueado a los
 * cinco minutos, esté la app abierta o cerrada.
 *
 * A QUIEN SE LE PIDE
 * Solo a la gente de calle (`ROLES_CON_PIN`). Secretaría, admin, gerencia,
 * liquidador y socioadmin entran sin PIN: trabajan sentados frente a un
 * computador que no se levanta de una mesa, y el candado les cobraba el mismo
 * peaje sin resolverles el riesgo que lo motivó — un celular desbloqueado en
 * la calle.
 *
 * LO QUE EL CANDADO NO ES
 * No protege los datos: quien tenga el teléfono puede abrir el navegador y
 * leer `localStorage`, y la llave pública de la app deja consultar Supabase
 * igual. Esto detiene a quien levanta un celular desbloqueado y toca el
 * ícono — que es lo que se pidió — no a quien sabe lo que hace.
 */

import { createClient } from "@/lib/supabase/client"
import { esErrorDeRed, guardarPinOffline, sinSenal, verificarPinSinSenal } from "@/lib/credenciales-offline"

/**
 * Los roles a los que se les pide el PIN.
 *
 * Va por lista de quién SÍ, no de quién no. Con la lista invertida, un rol
 * nuevo quedaría con candado sin que nadie lo hubiera decidido, y el dueño se
 * enteraría por una queja. Así, un rol nuevo entra sin PIN hasta que alguien
 * lo agregue a mano, que es una decisión visible.
 *
 * `asesor` va junto a `vendedor` porque el catálogo de módulos los trata como
 * el mismo trabajo (`defaultRoles: ["vendedor", "asesor"]`): los dos salen a
 * la calle con el teléfono.
 */
export const ROLES_CON_PIN = ["vendedor", "asesor"] as const

/** ¿A este rol se le pide el PIN al volver a la app? */
export function requierePin(rol: string | null | undefined): boolean {
  const r = (rol ?? "").toLowerCase().trim()
  return (ROLES_CON_PIN as readonly string[]).includes(r)
}

/** Cuántos intentos seguidos antes de mandar a la persona al login completo. */
export const INTENTOS_MAX = 10

/**
 * Cuánto puede estar la app quieta antes de pedir el PIN.
 *
 * Cinco minutos: corto para que un teléfono que cambia de manos quede
 * protegido, y largo para que nadie lo teclee mientras trabaja. Cualquier
 * toque —un scroll, una tecla— reinicia la cuenta.
 */
export const INACTIVIDAD_PIN_MS = 5 * 60 * 1000

// ── El reloj de la inactividad ──────────────────────────────────────────────
//
// Vive en `localStorage` y no en memoria PORQUE tiene que sobrevivir al cierre
// de la app. Con el reloj en memoria, cerrar y volver a abrir lo pondría en
// cero: bastaría con eso para saltarse el candado siempre.
const CLAVE_ACTIVIDAD = "pinUltimaActividad"

/** "Hay alguien acá". Se llama con cada señal de vida y al entrar. */
export function marcarActividadPin(): void {
  try { localStorage.setItem(CLAVE_ACTIVIDAD, String(Date.now())) } catch { /* modo privado */ }
}

/**
 * Cuántos milisegundos lleva la app sin que nadie la toque.
 *
 * Devuelve 0 cuando no hay marca, y eso es a propósito: sin marca no hay
 * ninguna evidencia de inactividad, y la regla es que SOLO la inactividad
 * arma el candado. Pasa una vez por dispositivo —la primera carga después de
 * este cambio— y bloquear ahí sería exactamente el "pide PIN al actualizar"
 * que se quitó.
 */
export function inactividadPin(): number {
  try {
    const raw = localStorage.getItem(CLAVE_ACTIVIDAD)
    if (!raw) return 0
    const t = Number(raw)
    if (!Number.isFinite(t)) return 0
    return Math.max(0, Date.now() - t)
  } catch {
    return 0
  }
}

/** ¿Estuvo quieta más de la cuenta? Es la ÚNICA pregunta que arma el candado. */
export function pasoElTiempoSinTocar(): boolean {
  return inactividadPin() > INACTIVIDAD_PIN_MS
}

export interface ResultadoPin {
  ok: boolean
  /** Se pasó de intentos: solo sale entrando con usuario y contraseña. */
  bloqueado: boolean
  restantes: number
}

/**
 * Le pregunta al servidor si el PIN es el correcto.
 *
 * El PIN nunca se compara en el teléfono: acá solo se manda y se recibe un
 * sí o un no. El hash no sale de la base — la llave pública ni siquiera
 * tiene permiso de leer esa columna (script 073, paso 5).
 */
export async function verificarPin(userId: number | string, pin: string): Promise<ResultadoPin> {
  // SIN SEÑAL: se compara contra la huella del último desbloqueo con señal
  // (lib/credenciales-offline.ts). Si no hay huella, no se abre: se avisa.
  const sinRed = async (): Promise<ResultadoPin> => {
    const r = await verificarPinSinSenal(userId, pin)
    if (!r) {
      throw new Error("Sin señal y este teléfono todavía no tiene tu PIN guardado. Usa \"Salir\" y entra con tu usuario y contraseña.")
    }
    return r
  }
  if (sinSenal()) return sinRed()

  let data: unknown = null
  let error: { message: string } | null = null
  try {
    const r = await createClient().rpc("verificar_pin", {
      p_user_id: Number(userId),
      p_pin: pin,
    })
    data = r.data
    error = r.error
  } catch (err) {
    if (esErrorDeRed(err)) return sinRed()
    throw err
  }

  if (error && esErrorDeRed(error)) return sinRed()
  if (error) {
    console.error("[v0] verificar_pin error:", error.message)
    // Ante un error de red NO se abre el candado. Se avisa y se deja
    // reintentar: abrirlo "por las dudas" seria justo lo contrario de lo que
    // este archivo existe para hacer.
    throw new Error("No se pudo verificar el PIN. Revisa la conexión.")
  }

  const r = (data ?? {}) as { ok?: boolean; bloqueado?: boolean; restantes?: number }
  // Desbloqueó con señal: se guarda la huella para la próxima sin señal.
  if (r.ok) void guardarPinOffline(userId, pin)
  return {
    ok: !!r.ok,
    bloqueado: !!r.bloqueado,
    restantes: typeof r.restantes === "number" ? r.restantes : INTENTOS_MAX,
  }
}

export async function cambiarPin(
  userId: number | string,
  pinActual: string,
  pinNuevo: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await createClient().rpc("cambiar_pin", {
    p_user_id: Number(userId),
    p_pin_actual: pinActual,
    p_pin_nuevo: pinNuevo,
  })

  if (error) {
    console.error("[v0] cambiar_pin error:", error.message)
    return { ok: false, error: "No se pudo cambiar el PIN. Revisa la conexión." }
  }

  const r = (data ?? {}) as { ok?: boolean; error?: string }
  return { ok: !!r.ok, error: r.error }
}

/**
 * Los PIN de todos, para Usuarios y Rutas.
 *
 * Pide usuario y contraseña de quien consulta y los comprueba EN EL SERVIDOR
 * contra la tabla. No alcanza con decir "soy secretaria": el rol viaja en el
 * teléfono y ahí se puede escribir a mano; una contraseña no.
 *
 * Devuelve un mapa `{ "3": "0000", "7": "4821" }` — id de usuario a PIN.
 */
export async function verPines(
  usuario: string,
  password: string,
): Promise<{ ok: boolean; error?: string; pines: Record<string, string> }> {
  const { data, error } = await createClient().rpc("ver_pines", {
    p_usuario: usuario,
    p_password: password,
  })

  if (error) {
    console.error("[v0] ver_pines error:", error.message)
    return { ok: false, error: "No se pudieron leer los PIN. Revisa la conexión.", pines: {} }
  }

  const r = (data ?? {}) as { ok?: boolean; error?: string; pines?: Record<string, string> }
  return { ok: !!r.ok, error: r.error, pines: r.pines ?? {} }
}

/** ¿Esta persona sigue con el 0000? Para avisárselo, no para bloquearla. */
export async function pinSigueEnDefault(userId: number | string): Promise<boolean> {
  try {
    const { data, error } = await createClient()
      .from("usuarios")
      .select("pin_cambiado")
      .eq("id", Number(userId))
      .maybeSingle()
    if (error) return false
    return (data as { pin_cambiado?: boolean } | null)?.pin_cambiado === false
  } catch {
    return false
  }
}
