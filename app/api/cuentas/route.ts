import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/server"

/**
 * Las cuentas para transferencias de una ruta. Se cargan en Configuración →
 * Rutas (scripts/126) y de acá salen los selectores de pagos y ventas.
 *
 * `etiqueta` = "Banco · número", que es lo que el cobrador necesita ver para
 * elegir bien. Por defecto solo las ACTIVAS; `?todas=1` trae también las
 * desactivadas (el editor de ventas, que muestra ventas viejas hechas a una
 * cuenta que ya no se usa).
 *
 * Se pide `*` y se filtra acá: antes del script 126 la columna `activa` no
 * existe y pedirla por nombre reventaría la consulta entera.
 */
export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const ruta = searchParams.get("ruta")
    const todas = searchParams.get("todas") === "1"

    let query = supabase.from("cuentas").select("*")

    if (ruta) {
      query = query.eq("ruta", ruta)
    }

    const { data, error } = await query.order("nombre", { ascending: true })

    if (error) {
      console.error("[v0] Error fetching cuentas:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    type Fila = { id: number; nombre: string | null; cuenta: string | null; titular?: string | null; activa?: boolean | null }
    const cuentas = ((data ?? []) as Fila[])
      .filter((c) => todas || c.activa !== false)
      .map((c) => ({
        id: c.id,
        nombre: c.nombre ?? "",
        cuenta: c.cuenta ?? null,
        titular: c.titular ?? null,
        activa: c.activa !== false,
        etiqueta: [c.nombre, c.cuenta].filter(Boolean).join(" · ") || `Cuenta ${c.id}`,
      }))

    return NextResponse.json(cuentas)
  } catch (error) {
    console.error("[v0] Error fetching cuentas:", error)
    return NextResponse.json({ error: "Failed to fetch cuentas" }, { status: 500 })
  }
}
