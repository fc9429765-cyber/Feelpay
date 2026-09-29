/**
 * lib/credenciales-offline.ts
 * ---------------------------------------------------------------------------
 * ENTRAR Y DESBLOQUEAR SIN SEÑAL.
 *
 * El usuario y el PIN se verifican en el servidor (`login_usuario`,
 * `verificar_pin`). Sin señal eso no existe, y un cobrador en una zona sin
 * cobertura quedaba afuera de la app a los 5 minutos de no tocarla (el PIN) o
 * al cambiar el día (el login) — justo cuando más la necesita.
 *
 * LO QUE SE GUARDA: una HUELLA, no la clave. Después de cada entrada EXITOSA
 * con señal se guarda en el teléfono un PBKDF2-SHA256 de la contraseña (y del
 * PIN) con una sal al azar. Sin señal se calcula la misma huella con lo que se
 * teclea y se compara. La contraseña nunca queda escrita en el aparato.
 *
 * LOS LÍMITES
 *   * Solo sirve para quien YA entró con señal en ese teléfono.
 *   * Vence a los 14 días sin una entrada con señal: pasado eso hay que
 *     conectarse. Un teléfono perdido no queda abierto para siempre.
 *   * Con señal manda SIEMPRE el servidor: si la clave cambió, la próxima
 *     entrada con red actualiza la huella; la vieja deja de servir.
 *   * El PIN offline tiene su propio contador de intentos. Al pasarse, hay
 *     que entrar con usuario y contraseña.
 */

import type { AuthenticatedUser } from "@/components/views/login-view"

const VIGENCIA_MS = 14 * 24 * 60 * 60 * 1000
const ITERACIONES = 150_000
const PREFIJO_CRED = "credOffline:"
const PREFIJO_PIN = "pinOffline:"
const PREFIJO_RUTAS = "rutasOffline:"
export const INTENTOS_PIN_OFFLINE = 5

interface Huella {
  sal: string
  hash: string
  guardada: number
}
interface CredencialGuardada extends Huella {
  user: AuthenticatedUser
}
interface PinGuardado extends Huella {
  fallos: number
}

const b64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function derivar(secreto: string, sal: Uint8Array): Promise<string> {
  const clave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secreto), "PBKDF2", false, ["deriveBits"],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: ITERACIONES },
    clave, 256,
  )
  return b64(bits)
}

async function nuevaHuella(secreto: string): Promise<Huella> {
  const sal = crypto.getRandomValues(new Uint8Array(16))
  return { sal: b64(sal), hash: await derivar(secreto, sal), guardada: Date.now() }
}

async function coincide(secreto: string, h: Huella): Promise<boolean> {
  return (await derivar(secreto, deB64(h.sal))) === h.hash
}

const leer = <T,>(k: string): T | null => {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
const escribir = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* modo privado */ }
}

const llaveUsuario = (usuario: string) => PREFIJO_CRED + usuario.trim().toLowerCase()

/** ¿Hay red? Un `navigator.onLine` en false es seguro; en true no garantiza. */
export function sinSenal(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

/** ¿El error es de red (no de clave equivocada)? */
export function esErrorDeRed(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? "").toLowerCase()
  return sinSenal() || /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout/.test(msg)
}

// ── Usuario y contraseña ───────────────────────────────────────────────────

/** Tras una entrada CON SEÑAL: guarda la huella para la próxima sin señal. */
export async function guardarCredencialOffline(usuario: string, password: string, user: AuthenticatedUser) {
  try {
    const h = await nuevaHuella(password)
    escribir(llaveUsuario(usuario), { ...h, user } satisfies CredencialGuardada)
  } catch (err) {
    console.warn("[v0] No se pudo guardar la credencial offline:", err)
  }
}

/**
 * Sin señal: ¿la clave coincide con la huella guardada? Devuelve el usuario
 * o un motivo para decírselo a la persona.
 */
export async function entrarSinSenal(
  usuario: string,
  password: string,
): Promise<{ user: AuthenticatedUser } | { motivo: string }> {
  const c = leer<CredencialGuardada>(llaveUsuario(usuario))
  if (!c) {
    return { motivo: "Sin señal, y este usuario nunca entró con señal en este teléfono. Conéctate para la primera entrada." }
  }
  if (Date.now() - c.guardada > VIGENCIA_MS) {
    return { motivo: "Sin señal, y pasaron más de 14 días desde la última entrada con señal. Conéctate para entrar." }
  }
  if (!(await coincide(password, c))) {
    return { motivo: "Usuario o contraseña incorrectos" }
  }
  return { user: c.user }
}

// ── Las rutas del usuario (para elegir ruta sin señal) ─────────────────────

export function guardarRutasOffline(userId: number | string, rutas: unknown[]) {
  escribir(PREFIJO_RUTAS + userId, rutas)
}
export function leerRutasOffline<T>(userId: number | string): T[] {
  return leer<T[]>(PREFIJO_RUTAS + userId) ?? []
}

// ── El PIN ─────────────────────────────────────────────────────────────────

/** Tras un desbloqueo CON SEÑAL: guarda la huella del PIN. */
export async function guardarPinOffline(userId: number | string, pin: string) {
  try {
    const h = await nuevaHuella(pin)
    escribir(PREFIJO_PIN + userId, { ...h, fallos: 0 } satisfies PinGuardado)
  } catch (err) {
    console.warn("[v0] No se pudo guardar el PIN offline:", err)
  }
}

/**
 * Sin señal: ¿el PIN coincide? `null` = no hay huella (nunca desbloqueó con
 * señal en este teléfono) o venció: no se puede verificar.
 */
export async function verificarPinSinSenal(
  userId: number | string,
  pin: string,
): Promise<{ ok: boolean; bloqueado: boolean; restantes: number } | null> {
  const k = PREFIJO_PIN + userId
  const p = leer<PinGuardado>(k)
  if (!p || Date.now() - p.guardada > VIGENCIA_MS) return null
  if (p.fallos >= INTENTOS_PIN_OFFLINE) return { ok: false, bloqueado: true, restantes: 0 }
  if (await coincide(pin, p)) {
    escribir(k, { ...p, fallos: 0 })
    return { ok: true, bloqueado: false, restantes: INTENTOS_PIN_OFFLINE }
  }
  const fallos = p.fallos + 1
  escribir(k, { ...p, fallos })
  return { ok: false, bloqueado: fallos >= INTENTOS_PIN_OFFLINE, restantes: Math.max(0, INTENTOS_PIN_OFFLINE - fallos) }
}
