"use client"

/**
 * lib/sesion-diaria.ts
 * ---------------------------------------------------------------------------
 * CUÁNDO CADUCA LA SESIÓN. Son dos reglas, y basta con que se cumpla una:
 *
 *   1. CAMBIÓ EL DÍA. Al cambiar el día de Colombia hay que volver a entrar,
 *      se haya cerrado sesión a mano o no.
 *   2. DOS HORAS SIN TOCAR NADA. Un teléfono abierto encima de un mostrador
 *      queda a mano de cualquiera, y la regla del día sola no lo tapa: a las
 *      tres de la tarde todavía es hoy.
 *
 * Las dos terminan en lo mismo —el login principal, con usuario y contraseña—
 * y las dos dejan intacta la cola de escrituras pendientes.
 *
 * POR QUÉ EXISTE
 * La sesión vive en localStorage y no caduca: un teléfono que no se cierra
 * queda abierto para siempre, y con él la ruta, la plata y los permisos de esa
 * persona. Quien lo tome al día siguiente entra sin que nadie le pregunte
 * nada. El PIN (`lib/pin-lock.ts`) tapa el rato que el teléfono está en el
 * bolsillo; esto tapa el día siguiente, y son cosas distintas: el PIN son
 * cuatro dígitos que el equipo comparte, la contraseña no.
 *
 * EL DÍA ES EL DE COLOMBIA, NO EL DEL TELÉFONO
 * Todo el negocio se cuenta en día de Colombia —el recaudo, la caja, el
 * cronograma— y la sesión tiene que caducar cuando cambia ESE día. Con el día
 * local, un teléfono con la zona horaria corrida caducaría a una hora que no
 * le corresponde a ninguna jornada.
 *
 * CUALQUIER CAMBIO CADUCA, no solo el avance
 * Si el día guardado no es exactamente el de hoy, se pide login. Un día
 * GUARDADO EN EL FUTURO no es normal —significa que el reloj del aparato
 * estaba mal cuando se entró— y ante eso lo prudente es preguntar de nuevo,
 * no confiar.
 *
 * SIN DÍA GUARDADO TAMBIÉN CADUCA
 * Es el caso de las sesiones que ya estaban abiertas cuando esto se
 * desplegó: no hay forma de saber de qué día son. Todo el mundo entra una vez
 * más y de ahí en adelante la marca ya existe.
 *
 * LO QUE **NO** SE PIERDE
 * El cierre de sesión borra `localStorage` y el cache de lectura
 * (`feelpay-cache`). La cola de escrituras pendientes vive en OTRA base
 * (`feelpay-offline`) y no se toca: los pagos capturados sin señal siguen ahí
 * y se envían solos cuando la persona vuelva a entrar.
 */

import { todayColombia } from "@/lib/colombia-date"

const CLAVE = "sesionDia"
const CLAVE_ACTIVIDAD = "sesionUltimaActividad"

/**
 * Cuánto se puede dejar la app quieta antes de tener que volver a entrar.
 *
 * Dos horas: cubre el almuerzo de un cobrador sin sacarlo de la ruta, y no
 * deja un teléfono abierto toda una tarde. Está acá arriba y con nombre porque
 * es un número que se va a mover — se cambia este y ya, no hay una segunda
 * copia en ningún sitio.
 */
export const INACTIVIDAD_MS = 2 * 60 * 60 * 1000

/** Deja marcado el día en que se entró. Se llama justo después del login. */
export function marcarDiaDeSesion(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(CLAVE, todayColombia())
  } catch (err) {
    // Sin marca, la sesión caduca en la siguiente comprobación. Es el lado
    // seguro del error: se pide contraseña de más, nunca de menos.
    console.warn("[v0] No se pudo marcar el día de la sesión:", err)
  }
}

/** El día en que se entró, o null si no hay marca. */
export function diaDeSesion(): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(CLAVE)
  } catch {
    return null
  }
}

export function limpiarDiaDeSesion(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(CLAVE)
    localStorage.removeItem(CLAVE_ACTIVIDAD)
  } catch {
    /* modo privado o cuota llena: no es crítico */
  }
}

/**
 * "Sigo acá". Se llama con cada toque, tecla o scroll.
 *
 * Va en `localStorage` y no en memoria porque la cuenta tiene que sobrevivir a
 * que la app se cierre y se vuelva a abrir: un teléfono que se apaga a las 8 y
 * se enciende a las 11 estuvo tres horas quieto, aunque la página sea nueva.
 */
export function marcarActividad(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(CLAVE_ACTIVIDAD, String(Date.now()))
  } catch {
    /* modo privado */
  }
}

/** Cuántos milisegundos lleva la sesión sin actividad. `null` si no hay marca. */
export function inactividad(): number | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(CLAVE_ACTIVIDAD)
    if (!raw) return null
    const t = Number(raw)
    if (!Number.isFinite(t) || t <= 0) return null
    // Un reloj que se corrió hacia atrás daría un negativo; se trata como
    // "recién activo" en vez de como caducada, que sería sacar a alguien de
    // la app por un problema del aparato.
    return Math.max(0, Date.now() - t)
  } catch {
    return null
  }
}

/**
 * ¿La sesión guardada es de otro día?
 *
 * Devuelve `false` cuando no hay ninguna sesión que caducar — no tiene sentido
 * anunciarle a nadie que su sesión venció si no había entrado.
 */
export function sesionVencioPorDia(haySesion: boolean): boolean {
  if (!haySesion) return false
  return diaDeSesion() !== todayColombia()
}

/** ¿Se pasó de las dos horas sin tocar nada? */
export function sesionVencioPorInactividad(haySesion: boolean): boolean {
  if (!haySesion) return false
  const quieta = inactividad()
  // Sin marca NO caduca por acá: es una sesión de antes de que esto
  // existiera, y la regla del día ya la va a sacar igual. Caducar las dos por
  // lo mismo sería sacar a la gente dos veces por un solo motivo.
  if (quieta === null) return false
  return quieta > INACTIVIDAD_MS
}

/**
 * LAS SECRETARIAS NO CADUCAN (06-oct-2026, a pedido del dueño). Trabajan en
 * la oficina con el Monitoreo de Rutas abierto en pantalla, mirando sin tocar:
 * ni el cambio de día ni las dos horas quietas tienen sentido ahí. Salen solo
 * cuando tocan "Cerrar sesión".
 */
const ROLES_SIN_CADUCIDAD = new Set(["secretaria", "secretario"])
export function sesionSinCaducidad(rol: string | null | undefined): boolean {
  return ROLES_SIN_CADUCIDAD.has((rol ?? "").toLowerCase().trim())
}

/** El motivo por el que hay que volver a entrar, o `null` si no hace falta. */
export function motivoDeCaducidad(haySesion: boolean, rol?: string | null): "dia" | "inactividad" | null {
  if (haySesion && sesionSinCaducidad(rol)) return null
  if (sesionVencioPorDia(haySesion)) return "dia"
  if (sesionVencioPorInactividad(haySesion)) return "inactividad"
  return null
}

/** El aviso que se le muestra a la persona en la pantalla de entrada. */
export const MENSAJE_SESION_DIARIA =
  "Tu sesión se cerró porque cambió el día. Vuelve a entrar con tu usuario y contraseña para trabajar la jornada de hoy."

export const MENSAJE_SESION_INACTIVA =
  "Tu sesión se cerró por inactividad. Vuelve a entrar con tu usuario y contraseña para seguir trabajando."

export function mensajeDeCaducidad(motivo: "dia" | "inactividad"): string {
  return motivo === "dia" ? MENSAJE_SESION_DIARIA : MENSAJE_SESION_INACTIVA
}
