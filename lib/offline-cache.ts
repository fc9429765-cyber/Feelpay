"use client"

/**
 * lib/offline-cache.ts
 * ---------------------------------------------------------------------------
 * Cache de LECTURA para trabajar sin señal.
 *
 * La cola (`lib/offline-queue.ts`) resuelve las escrituras. Esto resuelve lo
 * otro: que el cobrador pueda cerrar y reabrir la app sin conexión y seguir
 * viendo su ruta del día.
 *
 * QUÉ SE GUARDA Y POR QUÉ
 * -----------------------
 *   - Clientes del día con su plan de pagos: es lo que la pantalla de pagos
 *     necesita para trabajar.
 *   - Catálogos de ingresos/gastos/retiros: sin ellos no se puede registrar
 *     un movimiento de caja offline.
 *   - Estado de la ruta del día: sin esto la app muestra el muro de "Ruta no
 *     iniciada" aunque la ruta esté abierta.
 *
 * Los umbrales por ruta se cachean aparte, en `lib/ruta-umbrales.ts`, porque
 * ahí es donde se leen.
 *
 * INVALIDACIÓN
 * ------------
 * Cada entrada guarda la fecha (zona Colombia) y la ruta. Al leer se
 * descartan los datos de otro día u otra ruta — mismo criterio que ya usaba
 * el caché de ruta activa en `app/page.tsx`. Nunca se sirve un dato de ayer
 * como si fuera de hoy.
 *
 * Se usa IndexedDB y no localStorage porque el plan de pagos de una ruta
 * completa supera con facilidad el límite de ~5 MB de localStorage.
 */

import { openDB, type IDBPDatabase } from "idb"
import { todayColombia } from "@/lib/colombia-date"

const DB_NAME = "feelpay-cache"
const DB_VERSION = 1
const STORE = "datos"

export type ClaveCache = "dashboard-pagos" | "catalogos" | "ruta-activa" | "resumen-dia"

interface EntradaCache<T> {
  clave: string
  rutaId: number
  fecha: string
  guardadoEn: string
  datos: T
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "clave" })
        }
      },
    })
  }
  return dbPromise
}

function claveDe(clave: ClaveCache, rutaId: number): string {
  return `${clave}:${rutaId}`
}

/** Guarda datos frescos traídos del servidor. */
export async function guardarCache<T>(clave: ClaveCache, rutaId: number, datos: T): Promise<void> {
  try {
    const db = await getDB()
    const entrada: EntradaCache<T> = {
      clave: claveDe(clave, rutaId),
      rutaId,
      fecha: todayColombia(),
      guardadoEn: new Date().toISOString(),
      datos,
    }
    await db.put(STORE, entrada)
  } catch (err) {
    // Un fallo de cache nunca debe romper la operación normal.
    console.warn("[v0] No se pudo guardar en cache offline:", err)
  }
}

/**
 * Devuelve los datos cacheados si son de HOY y de la misma ruta. Si son de
 * otro día se descartan: es preferible una pantalla vacía a mostrarle al
 * cobrador la ruta de ayer como si fuera la de hoy.
 */
export async function leerCache<T>(
  clave: ClaveCache,
  rutaId: number,
): Promise<{ datos: T; guardadoEn: string } | null> {
  try {
    const db = await getDB()
    const entrada: EntradaCache<T> | undefined = await db.get(STORE, claveDe(clave, rutaId))
    if (!entrada) return null
    if (entrada.rutaId !== rutaId || entrada.fecha !== todayColombia()) {
      await db.delete(STORE, claveDe(clave, rutaId))
      return null
    }
    return { datos: entrada.datos, guardadoEn: entrada.guardadoEn }
  } catch (err) {
    console.warn("[v0] No se pudo leer el cache offline:", err)
    return null
  }
}

/**
 * Modifica en el sitio los datos ya cacheados, conservando su fecha y su
 * marca de "traído del servidor en...".
 *
 * PARA QUÉ: cuando el cobrador registra un pago SIN SEÑAL, la operación se
 * encola pero el cache sigue teniendo la foto del servidor — donde el cliente
 * aún aparece pendiente. Si cerraba y reabría la app, el cliente volvía a la
 * lista y podía cobrársele dos veces, cada captura con su propia llave de
 * idempotencia (el servidor no puede detectar eso: son dos operaciones
 * distintas). Parchando el cache al encolar, el cliente ya no reaparece.
 *
 * Si no hay nada cacheado no hace nada: no inventa una entrada, porque una
 * entrada parcial se leería después como si fuera la ruta completa.
 */
export async function parcharCache<T>(
  clave: ClaveCache,
  rutaId: number,
  fn: (datos: T) => T,
): Promise<void> {
  try {
    const db = await getDB()
    const entrada: EntradaCache<T> | undefined = await db.get(STORE, claveDe(clave, rutaId))
    if (!entrada) return
    if (entrada.rutaId !== rutaId || entrada.fecha !== todayColombia()) return
    await db.put(STORE, { ...entrada, datos: fn(entrada.datos) })
  } catch (err) {
    console.warn("[v0] No se pudo parchar el cache offline:", err)
  }
}

/** Borra todo el cache (al cerrar sesión). */
export async function limpiarCache(): Promise<void> {
  try {
    const db = await getDB()
    await db.clear(STORE)
  } catch (err) {
    console.warn("[v0] No se pudo limpiar el cache offline:", err)
  }
}
