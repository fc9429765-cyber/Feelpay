"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Bandera } from "@/components/bandera"
import { formatearMoneda } from "@/lib/monedas"
import { getResumenDiaRutas } from "@/lib/resumen-dia"
import { todayColombia } from "@/lib/gestion-core"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Loader2, RefreshCw, AlertCircle,
  TrendingUp,
  CheckCircle, XCircle,
  Clock, Coins, Bike, ChevronRight,
} from "lucide-react"

type RutaInfo = { id: number; nombre: string; ciudad: string | null; pais?: string | null; moneda?: string | null }

type ResumenRow = {
  ruta: number
  ruta_nombre: string
  ciudad: string | null
  efectivo: number
  valor_pago: number
  meta_pagos: number
  cantidad_pagos: number
  cantidad_no_pagos: number
  cantidad_canceladas: number
  valor_gastos: number
  valor_retiros: number
  valor_ingresos: number
  hora_ultimo_movimiento: string | null
  pais?: string | null
  moneda?: string | null
}

interface AdminDashboardProps {
  currentUserId?: number | string | null
  /** Para el botón que abre el resumen de todas las rutas. */
  onVerResumenRutas?: () => void
}

const fmt = (n: number) => `$${Math.round(n).toLocaleString("es-CO")}`

/**
 * El pais de una ruta, escrito para leerse.
 *
 * Dos cosas: en `rutas` conviven "ARGENTINA" y "Argentina", y la 204 tiene
 * `pais` y `ciudad` al reves. Lo segundo se resuelve igual que en el resumen
 * y en `lib/monedas.ts`: si el "pais" resulta ser una ciudad conocida, se usa
 * la otra columna.
 */
function capitalizarPais(pais?: string | null, ciudad?: string | null): string {
  const p = (pais ?? "").trim()
  const c = (ciudad ?? "").trim()
  const pareceCiudad = /buenos aires|la plata|chaco|cuenca|quito|asunci|cali|ibarra|rioamba/i.test(p)
  const bueno = pareceCiudad ? c : p
  return bueno
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => x[0].toUpperCase() + x.slice(1))
    .join(" ")
}
const pctFmt = (val: number, meta: number) =>
  meta > 0 ? `${Math.round((val / meta) * 100)}%` : "—"


// La fecha de hoy en Colombia sale de `todayColombia()` (@/lib/gestion-core):
// una sola definicion para toda la app.

export function AdminDashboard({ currentUserId, onVerResumenRutas }: AdminDashboardProps) {
  const [fecha, setFecha] = useState(todayColombia)

  const [rutasDisponibles, setRutasDisponibles] = useState<RutaInfo[]>([])
  const [rows, setRows] = useState<ResumenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Las tasas que regian ESE dia, por moneda. Ver scripts/119. */
  const [tasas, setTasas] = useState<Map<string, number>>(new Map())
  /** Cuantas unidades abrieron y cuantas cerraron ese dia. */
  const [estadosDia, setEstadosDia] = useState<{ abiertas: number; cerradas: number }>({ abiertas: 0, cerradas: 0 })
  /** Solo el primer nombre, para el saludo. */
  const [nombreUsuario, setNombreUsuario] = useState("")

  // Sale de localStorage, asi que se lee en el cliente: en el render del
  // servidor no existe.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("currentUser")
      const n = raw ? String((JSON.parse(raw) as { nombre?: string }).nombre ?? "").trim() : ""
      setNombreUsuario(n ? n.split(/\s+/)[0] : "")
    } catch {
      /* sesion ilegible: se queda con el saludo generico */
    }
  }, [])

  // ── Cargar rutas accesibles ────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const supabase = createClient()
      try {
        if (currentUserId) {
          const { data } = await supabase
            .from("usuario_rutas")
            .select("rutas:ruta_id(id, nombre, ciudad, pais, moneda)")
            .eq("usuario_id", currentUserId)
          const rutas = (data ?? [])
            .map((r: any) => r.rutas)
            .filter(Boolean)
            .sort((a: any, b: any) => a.id - b.id) as RutaInfo[]
          setRutasDisponibles(rutas)
        } else {
          const { data } = await supabase
            .from("rutas")
            .select("id, nombre, ciudad, pais, moneda")
            .order("id", { ascending: true })
          setRutasDisponibles((data ?? []) as RutaInfo[])
        }
      } catch (e) {
        console.error("[v0] AdminDashboard rutas error:", e)
      }
    }
    load()
  }, [currentUserId])

  // ── Cargar resumen_diario_v2 ──────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (rutasDisponibles.length === 0) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const rutaIds = rutasDisponibles.map((r) => r.id)
      const rutaInfoMap = new Map(rutasDisponibles.map((r) => [r.id, r]))

      // `getResumenDiaRutas` resuelve el arrastre de la caja. Antes, una ruta
      // sin movimiento ese dia NO traia fila y simplemente desaparecia del
      // tablero: un domingo el admin veia la lista vacia, sin forma de saber
      // si es que nadie trabajo o si algo se habia roto. Ahora todas las rutas
      // aparecen siempre, con su efectivo acumulado y los conteos del dia en
      // cero.
      // ── Las tasas de ESE dia y el estado de cada unidad ────────────────
      // Las dos consultas van en paralelo con el resumen: ninguna depende de
      // la otra y esperar en fila alargaria la carga sin motivo.
      //
      // La TASA es la del dia del tablero, no la de hoy: mirando el 3 de
      // agosto hay que convertir con el dolar del 3 de agosto. Misma regla
      // que `tasa_vigente()` en scripts/119.
      const [porRuta, resTasas, resEstados] = await Promise.all([
        getResumenDiaRutas(supabase, rutaIds, fecha),
        supabase
          .from("tasas_cambio")
          .select("moneda, tasa, vigente_desde, vigente_hasta")
          .lte("vigente_desde", fecha),
        supabase
          .from("rutas_diarias")
          .select("ruta_id, estado")
          .eq("fecha", fecha)
          .in("ruta_id", rutaIds),
      ])

      // Sin el script 119 la tabla no existe: se queda sin tasas y la tarjeta
      // de dolares no se muestra, en vez de tumbar el tablero entero.
      const mapaTasas = new Map<string, number>()
      if (!resTasas.error) {
        // Se queda la MAS RECIENTE que siga cubriendo la fecha. Quedarse con
        // la primera que llegue es quedarse con la que el servidor devuelva
        // primero, que puede ser una vieja: con dos tasas cargadas para la
        // misma moneda se estaria convirtiendo con la cotizacion equivocada.
        const desdePorMoneda = new Map<string, string>()
        for (const t of (resTasas.data ?? []) as unknown as {
          moneda: string; tasa: number; vigente_desde: string; vigente_hasta: string | null
        }[]) {
          // El rango tiene que CONTENER la fecha. Una tasa cerrada antes de
          // ese dia no sirve: estirarla seria inventar una cotizacion.
          if (t.vigente_hasta !== null && t.vigente_hasta < fecha) continue
          const mejor = desdePorMoneda.get(t.moneda)
          if (mejor === undefined || t.vigente_desde > mejor) {
            desdePorMoneda.set(t.moneda, t.vigente_desde)
            mapaTasas.set(t.moneda, Number(t.tasa))
          }
        }
      }
      setTasas(mapaTasas)

      const est = { abiertas: 0, cerradas: 0 }
      for (const e of (resEstados.data ?? []) as unknown as { estado: string }[]) {
        if (e.estado === "abierta") est.abiertas += 1
        else if (e.estado === "cerrada") est.cerradas += 1
      }
      setEstadosDia(est)
      const data = rutaIds.map((id) => {
        const r = porRuta.get(id)
        return { ...(r?.fila ?? {}), ruta: id, sin_movimiento: r?.sinMovimiento ?? true }
      })

      setRows(
        data.map((d: any) => {
          const info = rutaInfoMap.get(d.ruta)
          return {
            ruta: d.ruta,
            ruta_nombre: info?.nombre ?? `Ruta ${d.ruta}`,
            ciudad: info?.ciudad ?? null,
            efectivo: d.efectivo ?? 0,
            valor_pago: d.valor_pago ?? 0,
            meta_pagos: d.meta_pagos ?? 0,
            cantidad_pagos: d.cantidad_pagos ?? 0,
            cantidad_no_pagos: d.cantidad_no_pagos ?? 0,
            cantidad_canceladas: d.cantidad_canceladas ?? 0,
            valor_gastos: d.valor_gastos ?? 0,
            valor_retiros: d.valor_retiros ?? 0,
            valor_ingresos: d.valor_ingresos ?? 0,
            hora_ultimo_movimiento: d.hora_ultimo_movimiento ?? null,
            pais: info?.pais ?? null,
            moneda: info?.moneda ?? null,
          }
        }),
      )
    } catch (e) {
      const msg = (e as any)?.message ?? String(e)
      console.error("[v0] AdminDashboard fetch error:", msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [fecha, rutasDisponibles])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Filtrado local ─────────────────────────────────────────────────────────
  // Ya no hay filtros de ruta ni de ciudad en pantalla: el tablero se lee
  // por pais. Se conserva el nombre para no tocar todo lo que lo usa.
  const filteredRows = rows


  // ── Totales ────────────────────────────────────────────────────────────────
  const totals = filteredRows.reduce(
    (acc, r) => ({
      efectivo:          acc.efectivo          + r.efectivo,
      valor_pago:        acc.valor_pago        + r.valor_pago,
      meta_pagos:        acc.meta_pagos        + r.meta_pagos,
      cantidad_pagos:    acc.cantidad_pagos    + r.cantidad_pagos,
      cantidad_no_pagos: acc.cantidad_no_pagos + r.cantidad_no_pagos,
      cantidad_canceladas: acc.cantidad_canceladas + r.cantidad_canceladas,
      valor_gastos:      acc.valor_gastos      + r.valor_gastos,
      valor_retiros:     acc.valor_retiros     + r.valor_retiros,
      valor_ingresos:    acc.valor_ingresos    + r.valor_ingresos,
    }),
    { efectivo: 0, valor_pago: 0, meta_pagos: 0, cantidad_pagos: 0,
      cantidad_no_pagos: 0, cantidad_canceladas: 0, valor_gastos: 0,
      valor_retiros: 0, valor_ingresos: 0 },
  )

  // ── EL RESUMEN POR PAIS ────────────────────────────────────────────────────
  //
  // LOS TOTALES DE ARRIBA SUMAN PESOS ARGENTINOS CON DOLARES Y GUARANIES.
  // Eso no es un detalle de presentacion: 511.975 ARS + 1.280 USD no da
  // nada que signifique algo, y el numero resultante se lee como plata.
  //
  // Aca la plata se agrupa POR MONEDA y se muestra cada una por su lado, con
  // su propia meta. Es lo que se pidio en el mockup —"Montos por pais, no se
  // suman entre si"— y es la unica forma correcta de mirarlo mientras no haya
  // una conversion a dolares de por medio.
  const porPais = (() => {
    const m = new Map<string, {
      pais: string
      moneda: string
      recaudo: number
      meta: number
      rutas: number
      /** Cada ruta de ese país, para el detalle debajo de la tarjeta. */
      detalle: { ruta: number; nombre: string; recaudo: number; meta: number }[]
    }>()
    for (const r of filteredRows) {
      const moneda = (r.moneda ?? "").trim().toUpperCase() || "—"
      const pais = capitalizarPais(r.pais, r.ciudad) || moneda
      const clave = moneda
      const acc = m.get(clave) ?? { pais, moneda, recaudo: 0, meta: 0, rutas: 0, detalle: [] }
      acc.recaudo += r.valor_pago
      acc.meta += r.meta_pagos
      acc.rutas += 1
      acc.detalle.push({ ruta: r.ruta, nombre: r.ruta_nombre, recaudo: r.valor_pago, meta: r.meta_pagos })
      m.set(clave, acc)
    }
    return [...m.values()].sort((a, b) => a.pais.localeCompare(b.pais))
  })()

  // ── La equivalencia global en dolares ──────────────────────────────────────
  //
  // ESTA es la unica suma honesta entre paises: cada moneda se pasa a dolares
  // con la tasa de SU dia y despues se suman los dolares. Sumar los numeros
  // en bruto —lo que hacen las tarjetas de abajo— junta pesos con guaranies.
  //
  // `completa` dice si alcanzo para TODAS las monedas. Si a una le falta la
  // tasa, el total seria menor de lo real y se veria como una caida del
  // recaudo: hay que decirlo, no mostrar el numero a secas.
  const globalUsd = (() => {
    let total = 0
    const sinTasa: string[] = []
    for (const p of porPais) {
      const tasa = p.moneda === "USD" ? 1 : tasas.get(p.moneda)
      if (!tasa || tasa <= 0) {
        if (p.recaudo > 0) sinTasa.push(p.moneda)
        continue
      }
      total += p.recaudo / tasa
    }
    return { total, sinTasa, completa: sinTasa.length === 0 }
  })()

  // ── Las unidades y su estado ───────────────────────────────────────────────
  // "Sin iniciar" no sale de `rutas_diarias`: una unidad que no arranco NO
  // tiene fila ese dia. Es el resto, y por eso se calcula restando.
  const unidades = {
    total: filteredRows.length,
    abiertas: estadosDia.abiertas,
    cerradas: estadosDia.cerradas,
    sinIniciar: Math.max(filteredRows.length - estadosDia.abiertas - estadosDia.cerradas, 0),
  }

  // ── Tarjetas de resumen ────────────────────────────────────────────────────


  return (
    <div className="flex flex-col gap-3 md:gap-4">

      {/* ── El saludo ────────────────────────────────────────────────────────
          Como el mockup: quien entro, su perfil y la fecha. La fecha sigue
          siendo EDITABLE —es el filtro que manda sobre todo lo de abajo— pero
          va aca, junto al saludo, en vez de en una tarjeta de filtros aparte.

          Los filtros de ruta y ciudad salieron: el tablero ahora se lee POR
          PAIS, y filtrar por una sola ruta dejaba el resumen multimoneda con
          una sola tarjeta, que es justo lo que este tablero no quiere ser.
          Para mirar una unidad esta el Resumen de Rutas. */}
      <div className="flex items-center gap-2 px-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-bold leading-tight text-foreground">
            Hola {nombreUsuario || "Administrador"}
          </p>
          <p className="truncate text-[11px] leading-tight text-muted-foreground">
            Perfil: Administrador
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="h-8 w-[136px] border-border bg-background text-xs"
          />
          <Button
            size="icon"
            variant="outline"
            onClick={fetchData}
            disabled={loading}
            title="Actualizar"
            className="h-8 w-8 shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* ── Resumen multimoneda ──────────────────────────────────────────────
          Una tarjeta por pais con SU plata y SU meta, y debajo CADA RUTA con
          la suya.

          SALE SIEMPRE, aunque haya una sola moneda. Antes solo aparecia con
          dos o mas, y un administrador con todas sus rutas en un mismo pais
          —GerenciaDV: 151, 196 y 205, las tres en pesos argentinos— se quedaba
          sin el analisis, que era justo lo que buscaba. */}
      {porPais.length > 0 && (
        <Card className="bg-card shadow-sm border-0">
          <CardContent className="px-3 py-2">
            <div className="mb-2">
              <p className="text-sm font-bold text-foreground">Resumen multimoneda</p>
              <p className="text-[11px] leading-tight text-muted-foreground">
                Montos por país — no se suman entre sí
              </p>
            </div>

            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {porPais.map((p) => {
                const pct = p.meta > 0 ? Math.round((p.recaudo / p.meta) * 100) : null
                const tono =
                  pct === null ? "bg-muted-foreground"
                    : pct >= 90 ? "bg-success"
                      : pct >= 60 ? "bg-warning"
                        : "bg-destructive"
                return (
                  <div
                    key={p.moneda}
                    className="rounded-lg border border-border bg-muted/20 px-2 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <Bandera moneda={p.moneda} pais={p.pais} size={30} className="shadow-sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-bold leading-tight text-foreground">
                          {p.pais}
                        </p>
                        <p className="text-[10px] leading-tight text-muted-foreground">
                          {p.moneda} · {p.rutas} {p.rutas === 1 ? "unidad" : "unidades"}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-bold tabular-nums text-foreground">
                        {formatearMoneda(p.recaudo, p.moneda)}
                      </p>
                    </div>

                    {/* La barra y el porcentaje son CONTRA SU PROPIA META, no
                        contra las otras: comparar el recaudo argentino con el
                        paraguayo en bruto no dice nada. */}
                    <div className="mt-1 flex items-center gap-1.5">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${tono}`}
                          style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                        />
                      </div>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {pct === null ? "sin meta" : `${pct}% de su meta`}
                      </span>
                    </div>

                    {/* CADA RUTA DE ESE PAÍS: su recaudo contra su meta, en
                        su moneda. Es el análisis "de cada ruta" que se pidió. */}
                    <div className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5">
                      {[...p.detalle].sort((a, b) => a.ruta - b.ruta).map((d) => {
                        const pr = d.meta > 0 ? Math.round((d.recaudo / d.meta) * 100) : null
                        const tr =
                          pr === null ? "bg-muted-foreground"
                            : pr >= 90 ? "bg-success"
                              : pr >= 60 ? "bg-warning"
                                : "bg-destructive"
                        return (
                          <div key={d.ruta} className="flex items-center gap-1.5 text-[11px]">
                            <span className="w-16 shrink-0 truncate font-semibold text-foreground" title={d.nombre}>
                              {d.nombre}
                            </span>
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                              <div className={`h-full rounded-full ${tr}`} style={{ width: `${Math.min(pr ?? 0, 100)}%` }} />
                            </div>
                            <span className="shrink-0 tabular-nums text-foreground">
                              {formatearMoneda(d.recaudo, p.moneda)}
                            </span>
                            <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                              {pr === null ? "sin meta" : `${pr}% de ${formatearMoneda(d.meta, p.moneda)}`}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Equivalencia global en USD ───────────────────────────────────────
          La unica suma honesta entre paises: cada moneda pasa a dolares con
          la tasa de SU dia y despues se suman los dolares. */}
      {/* Con una sola moneda tambien sirve: dice cuanto es en dolares. */}
      {porPais.length > 0 && globalUsd.total > 0 && (
        <Card className="border-0 bg-gradient-to-br from-sky-50 to-blue-50 shadow-sm dark:from-sky-950/40 dark:to-blue-950/40">
          <CardContent className="flex items-center gap-3 px-3 py-2.5">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-blue-600/10">
              <Coins className="h-5 w-5 text-blue-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold leading-tight text-foreground">
                Equivalencia global en USD
              </p>
              <p className="text-2xl font-bold leading-tight tabular-nums text-blue-700 dark:text-blue-300">
                USD {globalUsd.total.toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </p>
              <p className="text-[10px] leading-tight text-muted-foreground">
                Valor equivalente de todo lo recaudado · tasas del{" "}
                {fecha.split("-").reverse().join("/")}
              </p>
              {/* Si a una moneda le falta tasa, el total sale CORTO y parece
                  una caida del recaudo. Se dice cual falta. */}
              {!globalUsd.completa && (
                <p className="mt-0.5 text-[10px] font-semibold leading-tight text-amber-600">
                  No incluye {globalUsd.sinTasa.join(", ")}: sin tasa para ese día.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Unidades operativas ──────────────────────────────────────────────
          Cuantas unidades hay y en que estado arrancaron el dia. */}
      <Card className="bg-card shadow-sm border-0">
        <CardContent className="px-3 py-2">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Bike className="h-4 w-4 shrink-0 text-brand" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold leading-tight text-foreground">
                Unidades operativas
              </p>
              <p className="text-[10px] leading-tight text-muted-foreground">
                Estado de las unidades de recaudo
              </p>
            </div>
            {/* Va AQUI y no suelto arriba: es el detalle de este mismo
                bloque —las unidades— asi que se toca donde se estan mirando
                los numeros que resume. */}
            {onVerResumenRutas && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onVerResumenRutas}
                className="h-7 shrink-0 gap-0.5 px-2 text-[11px] text-brand"
              >
                Ver todas
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {[
              { label: "Total de unidades", valor: unidades.total, icono: Bike, tono: "text-info", fondo: "bg-info-light" },
              { label: "Unidades abiertas", valor: unidades.abiertas, icono: CheckCircle, tono: "text-success", fondo: "bg-success-light" },
              // Las que no arrancaron se muestran aparte y NO se cuentan como
              // cerradas: son cosas distintas —una cerro su caja, la otra
              // todavia no empezo— y juntarlas taparia justo lo que el admin
              // necesita ver.
              { label: unidades.sinIniciar > 0 ? "Sin iniciar" : "Unidades cerradas",
                valor: unidades.sinIniciar > 0 ? unidades.sinIniciar : unidades.cerradas,
                icono: unidades.sinIniciar > 0 ? Clock : XCircle,
                tono: unidades.sinIniciar > 0 ? "text-warning" : "text-destructive",
                fondo: unidades.sinIniciar > 0 ? "bg-warning-light" : "bg-destructive/10" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-border bg-muted/20 px-2 py-1.5 text-center">
                <div className={`mx-auto mb-0.5 grid h-7 w-7 place-items-center rounded-full ${c.fondo}`}>
                  <c.icono className={`h-4 w-4 ${c.tono}`} />
                </div>
                <p className="text-[10px] leading-tight text-muted-foreground">{c.label}</p>
                <p className={`text-lg font-bold leading-tight tabular-nums ${c.tono}`}>{c.valor}</p>
              </div>
            ))}
          </div>

          {/* Cuando hay de las dos, la tercera caja muestra "sin iniciar" y
              las cerradas quedarian invisibles. Se dicen aparte. */}
          {unidades.sinIniciar > 0 && unidades.cerradas > 0 && (
            <p className="mt-1 text-center text-[10px] text-muted-foreground">
              {unidades.cerradas} {unidades.cerradas === 1 ? "unidad ya cerró" : "unidades ya cerraron"} su caja.
            </p>
          )}
        </CardContent>
      </Card>

    </div>
  )
}
