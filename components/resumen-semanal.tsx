"use client"

/**
 * components/resumen-semanal.tsx
 * ---------------------------------------------------------------------------
 * EL RESUMEN SEMANAL, abajo del Resumen del Día.
 *
 * Solo aparece en las rutas que lo tienen encendido
 * (`ruta_config_umbrales.resumen_semanal`, scripts/121). En las demás, o si
 * el script todavía no se corrió, no pinta nada: no es un error, es una
 * opción apagada.
 *
 * LA SEMANA EMPIEZA EL LUNES y llega hasta el día del resumen, no hasta el
 * domingo: un miércoles muestra lunes + martes + miércoles. El rango del
 * encabezado sí muestra la semana entera (lunes a domingo) para que se lea
 * de qué semana se habla.
 *
 * LOS NÚMEROS SON LA SUMA DE LOS DÍAS de `resumen_diario_v2`, la misma fuente
 * del Resumen del Día. Así la semana nunca puede contradecir a sus días:
 *
 *   Total recaudado   Σ valor_pago
 *   Total pagos       Σ cantidad_pagos       (clientes que pagaron, día a día)
 *   Total no pagos    Σ cantidad_no_pagos
 *   Efectivo          Σ pago_efectivo
 *   Transferencias    Σ pago_transferencia
 *   Cumplimiento      Σ valor_pago / Σ meta_pagos
 *   Total ventas      Σ valor_ventas y Σ cantidad_ventas (homologadas incluidas,
 *                     igual que la barra de Ventas del Resumen del Día)
 *
 * La meta semanal es la suma de las metas diarias: cada día pone las cuotas
 * que vencen ese día (el atraso solo se suma al día de HOY, scripts/112), así
 * que no se cuenta dos veces.
 */

import { useEffect, useState } from "react"
import {
  ArrowLeftRight, BarChart3, Banknote, CalendarDays, CheckCircle2, ChevronDown, Eye, ShoppingBag, ShoppingCart, XCircle,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { createClient } from "@/lib/supabase/client"
import { sumarDias } from "@/lib/gestion-core"
import { formatearMoneda } from "@/lib/monedas"
import { DetalleSemanal } from "@/components/detalle-semanal"

interface Props {
  rutaId: number
  /** El día de negocio del resumen ("YYYY-MM-DD"). */
  fecha: string
  /** Código ISO de la moneda de la ruta. */
  moneda: string | null
}

interface Semana {
  recaudado: number
  pagos: number
  noPagos: number
  efectivo: number
  transferencia: number
  meta: number
  ventas: number
  cantidadVentas: number
}

/** El lunes de la semana de `fecha`, sin pasar por la zona horaria local. */
function lunesDe(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = domingo
  return sumarDias(fecha, dow === 0 ? -6 : 1 - dow)
}

/** "21/09 – 27/09/2026" */
function rango(lunes: string, domingo: string): string {
  const [, lm, ld] = lunes.split("-")
  const [dy, dm, dd] = domingo.split("-")
  return `${ld}/${lm} – ${dd}/${dm}/${dy}`
}

export function ResumenSemanal({ rutaId, fecha, moneda }: Props) {
  const [habilitado, setHabilitado] = useState(false)
  const [nombreRuta, setNombreRuta] = useState("")
  const [semana, setSemana] = useState<Semana | null>(null)
  /** El detalle (días y pagos por cliente) que abre el ojito. */
  const [verDetalle, setVerDetalle] = useState(false)
  /**
   * PLEGADO, como acordeón. Se recuerda por ruta en el teléfono. Arranca
   * desplegado y el guardado se lee en un efecto (no en el estado inicial),
   * igual que el encabezado plegado de Pagos, para no romper la hidratación.
   */
  const clavePlegado = `resumenSemanalPlegado:${rutaId}`
  const [plegado, setPlegado] = useState(false)
  useEffect(() => {
    try { setPlegado(localStorage.getItem(clavePlegado) === "1") } catch { /* modo privado */ }
  }, [clavePlegado])
  const alternarPlegado = () =>
    setPlegado((prev) => {
      const siguiente = !prev
      try { localStorage.setItem(clavePlegado, siguiente ? "1" : "0") } catch { /* modo privado */ }
      return siguiente
    })

  const lunes = lunesDe(fecha)
  const domingo = sumarDias(lunes, 6)

  useEffect(() => {
    let cancelado = false
    const cargar = async () => {
      if (!rutaId) return
      const sb = createClient()
      // ¿Esta ruta tiene el cuadro encendido? Sin el script 121 la columna no
      // existe y la consulta falla: se toma como apagado y no se pinta nada.
      const [resCfg, resRuta] = await Promise.all([
        sb.from("ruta_config_umbrales").select("resumen_semanal").eq("ruta_id", rutaId).maybeSingle(),
        sb.from("rutas").select("nombre").eq("id", rutaId).maybeSingle(),
      ])
      const on = !resCfg.error && (resCfg.data as { resumen_semanal?: boolean } | null)?.resumen_semanal === true
      if (cancelado) return
      setHabilitado(on)
      setNombreRuta((resRuta.data as { nombre?: string } | null)?.nombre ?? "")
      if (!on) return

      const { data, error } = await sb
        .from("resumen_diario_v2")
        .select("valor_pago, cantidad_pagos, cantidad_no_pagos, pago_efectivo, pago_transferencia, meta_pagos, valor_ventas, cantidad_ventas")
        .eq("ruta", rutaId)
        .gte("fecha_pago", lunes)
        .lte("fecha_pago", fecha)
      if (error) {
        console.error("[v0] Resumen semanal:", error.message)
        return
      }
      const n = (v: unknown) => Number(v) || 0
      const s: Semana = { recaudado: 0, pagos: 0, noPagos: 0, efectivo: 0, transferencia: 0, meta: 0, ventas: 0, cantidadVentas: 0 }
      for (const f of (data ?? []) as Record<string, unknown>[]) {
        s.recaudado += n(f.valor_pago)
        s.pagos += n(f.cantidad_pagos)
        s.noPagos += n(f.cantidad_no_pagos)
        s.efectivo += n(f.pago_efectivo)
        s.transferencia += n(f.pago_transferencia)
        s.meta += n(f.meta_pagos)
        s.ventas += n(f.valor_ventas)
        s.cantidadVentas += n(f.cantidad_ventas)
      }
      if (!cancelado) setSemana(s)
    }
    void cargar()
    return () => { cancelado = true }
  }, [rutaId, fecha, lunes])

  if (!habilitado) return null

  const s = semana ?? { recaudado: 0, pagos: 0, noPagos: 0, efectivo: 0, transferencia: 0, meta: 0, ventas: 0, cantidadVentas: 0 }
  const plata = (v: number) => formatearMoneda(v, moneda)
  const cumplimiento = s.meta > 0 ? Math.round((s.recaudado / s.meta) * 100) : 0

  const casillas: { label: string; valor: string; icono: React.ReactNode }[] = [
    {
      label: "Total Recaudado", valor: plata(s.recaudado),
      icono: <CheckCircle2 className="h-full w-full fill-success text-white" strokeWidth={2} />,
    },
    { label: "Total Pagos", valor: String(s.pagos), icono: <ShoppingCart className="h-full w-full text-info" /> },
    { label: "Total No Pagos", valor: String(s.noPagos), icono: <XCircle className="h-full w-full text-destructive" /> },
    { label: "Efectivo", valor: plata(s.efectivo), icono: <Banknote className="h-full w-full text-info" /> },
    { label: "Transferencias", valor: plata(s.transferencia), icono: <ArrowLeftRight className="h-full w-full text-info" /> },
    { label: "Cumplimiento de la meta", valor: `${cumplimiento}%`, icono: <BarChart3 className="h-full w-full text-info" /> },
  ]

  return (
    <Card className="bg-card shadow-sm border-0">
      <CardContent className="px-2 py-2.5">
        {/* Si no cabe todo en una línea, el rango baja al renglón de abajo
            en vez de recortar el nombre de la ruta. */}
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 ${plegado ? "" : "mb-2"}`}>
          {/* EL TÍTULO ES EL BOTÓN DEL ACORDEÓN: pliega y despliega las
              cifras. El ojito queda afuera y abre el detalle igual. */}
          <button
            type="button"
            onClick={alternarPlegado}
            aria-expanded={!plegado}
            className="flex min-w-0 items-center gap-2 text-left"
            title={plegado ? "Mostrar el resumen semanal" : "Ocultar el resumen semanal"}
          >
            <CalendarDays className="h-5 w-5 shrink-0 text-info" />
            <span className="min-w-0 text-[clamp(12px,3.8vw,14px)] font-bold leading-tight text-foreground">
              Resumen Semanal{nombreRuta ? ` (${nombreRuta})` : ""}
            </span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${plegado ? "-rotate-90" : ""}`}
            />
          </button>
          {/* EL OJITO: el detalle día por día, y de ahí los pagos de un día. */}
          <button
            type="button"
            onClick={() => setVerDetalle(true)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted"
            title="Ver el detalle de la semana"
            aria-label="Ver el detalle de la semana"
          >
            <Eye className="h-4 w-4" />
          </button>
          <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {rango(lunes, domingo)}
          </span>
        </div>
        {/* NADA SE SALE DE SU CASILLA. La etiqueta va arriba a todo el ancho
            y el icono chico junto al monto: con el icono al lado de la
            etiqueta, "Transferencias" y "Cumplimiento" no cabían en un
            teléfono y se salían del borde. La letra se ajusta al ancho de la
            pantalla (clamp): en un teléfono chico se achica en vez de
            salirse, y en uno grande no pasa del tamaño normal. */}
        {!plegado && (<>
        <div className="grid grid-cols-3 gap-1">
          {casillas.map((c) => (
            <div key={c.label} className="min-w-0 rounded-xl border border-border px-1 py-1.5">
              <p className="text-[clamp(9px,2.7vw,11px)] font-medium leading-tight text-foreground [overflow-wrap:anywhere]">
                {c.label}
              </p>
              <div className="mt-0.5 flex min-w-0 items-center gap-0.5">
                <span className="h-3.5 w-3.5 shrink-0">{c.icono}</span>
                <p className="min-w-0 whitespace-nowrap text-[clamp(9px,3.1vw,14px)] font-bold leading-tight tabular-nums text-foreground">
                  {c.valor}
                </p>
              </div>
            </div>
          ))}
        </div>
        {/* TOTAL VENTAS, a lo ancho debajo de las seis casillas: una séptima
            en la rejilla de tres quedaba sola en su renglón. Lleva el monto y
            cuántas ventas fueron. */}
        <div className="mt-1 flex min-w-0 items-center gap-1.5 rounded-xl border border-border px-2 py-1.5">
          <ShoppingBag className="h-4 w-4 shrink-0 text-info" />
          <p className="min-w-0 flex-1 text-[clamp(10px,3vw,12px)] font-medium leading-tight text-foreground">
            Total Ventas
            <span className="ml-1 text-muted-foreground">
              ({s.cantidadVentas} {s.cantidadVentas === 1 ? "venta" : "ventas"})
            </span>
          </p>
          <p className="shrink-0 whitespace-nowrap text-[clamp(11px,3.4vw,14px)] font-bold leading-tight tabular-nums text-foreground">
            {plata(s.ventas)}
          </p>
        </div>
        </>)}
      </CardContent>
      {verDetalle && (
        <DetalleSemanal
          rutaId={rutaId}
          unidad={`UNID ${rutaId}`}
          lunes={lunes}
          fecha={fecha}
          moneda={moneda}
          onClose={() => setVerDetalle(false)}
        />
      )}
    </Card>
  )
}
