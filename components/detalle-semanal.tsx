"use client"

/**
 * components/detalle-semanal.tsx
 * ---------------------------------------------------------------------------
 * EL DETALLE DEL RESUMEN SEMANAL, y debajo, EL DETALLE DE UN DÍA.
 * (PROMPT_Detalle_Semanal.md + PROMPT_Detalle_Dia.md, DetalleSemanal.jsx y
 * DetalleDia.jsx.) Se abre con el ojito del Resumen Semanal.
 *
 * Una sola pantalla encima de todo (portal al `body`: el Resumen del Día vive
 * dentro de una tarjeta que gira, y un `position: fixed` adentro de un
 * elemento con `transform` queda pegado a la tarjeta y no a la pantalla).
 *
 * DE DÓNDE SALE CADA NÚMERO — la misma fuente que el resumen, así nunca se
 * contradicen:
 *
 *   Semana, por día     `resumen_diario_v2`: pago_efectivo / pago_transferencia
 *   Ventas              los préstamos creados en la semana + las renovaciones
 *                       (la misma `fuente_ventas` del resumen, scripts/123)
 *   Día, por cliente    los eventos del libro de ese día y esa ruta, con la
 *                       MISMA regla del resumen para partir efectivo y
 *                       transferencia (la reversa toma la forma de pago del
 *                       pago que reversa). La suma de los clientes da el
 *                       monto del día de la lista semanal.
 *
 * La semana va de lunes a domingo, pero el TOTAL cuenta hasta el día del
 * resumen, igual que la tarjeta: los días que todavía no llegaron salen en $0.
 *
 * DOS PANTALLAS MÁS, de destino:
 *   Tocar un pago   → el pago: los movimientos de ese cliente ese día (hora,
 *                     forma de pago, cuenta, nota, foto, quién cobró) y la
 *                     ficha del crédito.
 *   Tocar una venta → la venta: cuánto, cómo se entregó, la evidencia y la
 *                     ficha del crédito. Una renovación muestra el antes y el
 *                     después del crédito.
 *
 * Es de SOLO LECTURA.
 */

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  ArrowLeftRight, Banknote, Calendar, CalendarX, ChevronLeft, ChevronRight, Clock, RefreshCw,
  ShoppingCart, Undo2, XCircle,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { sumarDias, cuotasConDecimal } from "@/lib/gestion-core"
import { formatearMoneda } from "@/lib/monedas"
import "./detalle-semanal.css"

type Medio = "cash" | "transfer"

interface Dia { fecha: string; cash: number; transfer: number }
interface Venta { id: string; loanId: string; fecha: string; cliente: string; monto: number; renovacion: boolean }
interface Pago { id: string; cliente: string; hora: string; cuota: string; monto: number; saldo: number }

interface Props {
  rutaId: number
  /** Número de la unidad para el encabezado ("UNID 202"). */
  unidad: string
  /** Lunes de la semana y día del resumen ("YYYY-MM-DD"). */
  lunes: string
  fecha: string
  moneda: string | null
  onClose: () => void
}

const IC = { strokeWidth: 1.9 }
const DOW = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]
const DIA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]

const dow = (f: string) => {
  const [y, m, d] = f.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`
const ddmmaaaa = (f: string) => `${ddmm(f)}/${f.slice(0, 4)}`
const iniciales = (n: string) =>
  n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?"
const hora = (ts: string | null) =>
  ts
    ? new Intl.DateTimeFormat("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Bogota" }).format(new Date(ts))
    : "—"
/** Inicio del día `f` en Colombia, en UTC (para filtrar timestamps). */
const inicioDia = (f: string) => new Date(`${f}T00:00:00-05:00`).toISOString()

export function DetalleSemanal({ rutaId, unidad, lunes, fecha, moneda, onClose }: Props) {
  const plata = (v: number) => formatearMoneda(v, moneda)
  const domingo = sumarDias(lunes, 6)
  const semana = Array.from({ length: 7 }, (_, i) => sumarDias(lunes, i))

  // La pestaña y el día abierto viven acá: al volver del día se conserva la
  // pestaña, y el scroll se restaura a mano.
  const [tab, setTab] = useState<Medio>("cash")
  const [diaIdx, setDiaIdx] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scrollSemana = useRef(0)

  /** La pantalla de destino abierta encima de la semana o del día. */
  const [foco, setFoco] = useState<
    | { tipo: "pago"; loanId: string; fecha: string; cliente: string }
    | { tipo: "venta"; venta: Venta }
    | null
  >(null)
  const scrollAntes = useRef(0)

  const [dias, setDias] = useState<Dia[] | null>(null)
  const [ventas, setVentas] = useState<Venta[]>([])

  // Cerrar con la tecla atrás del navegador / Escape.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (foco) setFoco(null)
      else if (diaIdx === null) onClose()
      else setDiaIdx(null)
    }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  }, [diaIdx, foco, onClose])

  // ── La semana ──────────────────────────────────────────────────────────
  useEffect(() => {
    let vigente = true
    void (async () => {
      const sb = createClient()
      const [resDias, resLoans, resRenov] = await Promise.all([
        sb.from("resumen_diario_v2")
          .select("fecha_pago, pago_efectivo, pago_transferencia")
          .eq("ruta", rutaId).gte("fecha_pago", lunes).lte("fecha_pago", fecha),
        sb.from("loans")
          .select("id, valor, origen, fecha_creacion, apodo_elegido, clients(nombre_completo, apodo, apodo_2)")
          .eq("ruta", rutaId)
          .gte("fecha_creacion", inicioDia(lunes))
          .lt("fecha_creacion", inicioDia(sumarDias(fecha, 1)))
          .order("fecha_creacion"),
        sb.from("gestiones")
          .select("id, loan_id, fecha_gestion, detalle, loans(apodo_elegido, clients(nombre_completo, apodo, apodo_2))")
          .eq("ruta", rutaId).eq("tipo", "ajuste").eq("estado", "aplicada")
          .gte("fecha_gestion", lunes).lte("fecha_gestion", fecha),
      ])
      if (!vigente) return
      const porFecha = new Map(
        ((resDias.data ?? []) as Record<string, unknown>[]).map((r) => [
          String(r.fecha_pago).slice(0, 10),
          { cash: Number(r.pago_efectivo) || 0, transfer: Number(r.pago_transferencia) || 0 },
        ]),
      )
      setDias(semana.map((f) => ({ fecha: f, ...(porFecha.get(f) ?? { cash: 0, transfer: 0 }) })))

      type Cli = { nombre_completo?: string | null; apodo?: string | null; apodo_2?: string | null } | null
      const nombre = (c: Cli, elegido?: number | null) =>
        ((elegido === 2 ? c?.apodo_2 : null) || c?.apodo || c?.nombre_completo || "—").trim()
      const lista: Venta[] = []
      for (const l of (resLoans.data ?? []) as unknown as {
        id: string; valor: number; fecha_creacion: string; apodo_elegido: number | null; clients: Cli
      }[]) {
        lista.push({
          id: l.id,
          loanId: l.id,
          fecha: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(l.fecha_creacion)),
          cliente: nombre(l.clients, l.apodo_elegido),
          monto: Number(l.valor) || 0,
          renovacion: false,
        })
      }
      // Las renovaciones también son venta (scripts/123): plata nueva que sale.
      for (const g of (resRenov.data ?? []) as unknown as {
        id: string; loan_id: string; fecha_gestion: string; detalle: Record<string, unknown> | null
        loans: { apodo_elegido: number | null; clients: Cli } | null
      }[]) {
        if (g.detalle?.clase !== "renovacion") continue
        lista.push({
          id: g.id,
          loanId: g.loan_id,
          fecha: g.fecha_gestion,
          cliente: nombre(g.loans?.clients ?? null, g.loans?.apodo_elegido),
          monto: Number(g.detalle?.valor_entregado) || 0,
          renovacion: true,
        })
      }
      lista.sort((a, b) => a.fecha.localeCompare(b.fecha))
      setVentas(lista)
    })().catch((err) => console.error("[v0] Detalle semanal:", err))
    return () => { vigente = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rutaId, lunes, fecha])

  const abrirDia = (i: number) => {
    scrollSemana.current = scrollRef.current?.scrollTop ?? 0
    setDiaIdx(i)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const volver = () => {
    setDiaIdx(null)
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollSemana.current }))
  }

  // Abrir una pantalla de destino guarda dónde estaba la lista; volver la
  // deja en el mismo lugar.
  const abrirFoco = (f: NonNullable<typeof foco>) => {
    scrollAntes.current = scrollRef.current?.scrollTop ?? 0
    setFoco(f)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const cerrarFoco = () => {
    setFoco(null)
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollAntes.current }))
  }

  const contenido =
    foco?.tipo === "pago" ? (
      <VistaPago loanId={foco.loanId} fecha={foco.fecha} cliente={foco.cliente} plata={plata} onBack={cerrarFoco} />
    ) : foco?.tipo === "venta" ? (
      <VistaVenta venta={foco.venta} plata={plata} onBack={cerrarFoco} />
    ) : diaIdx === null ? (
      <VistaSemana
        unidad={unidad} rango={`${ddmm(lunes)} – ${ddmmaaaa(domingo)}`} dias={dias} ventas={ventas}
        tab={tab} setTab={setTab} plata={plata} onBack={onClose} onDia={abrirDia}
        onVenta={(v) => abrirFoco({ tipo: "venta", venta: v })}
      />
    ) : (
      <VistaDia
        rutaId={rutaId} unidad={unidad} fecha={semana[diaIdx]} medio={tab} plata={plata}
        hasPrev={diaIdx > 0} hasNext={diaIdx < 6}
        onPrev={() => setDiaIdx((i) => (i ?? 1) - 1)} onNext={() => setDiaIdx((i) => (i ?? 0) + 1)}
        onBack={volver}
        onPago={(p) => abrirFoco({ tipo: "pago", loanId: p.id, fecha: semana[diaIdx], cliente: p.cliente })}
      />
    )

  return createPortal(
    <div className="ds-root" ref={scrollRef} role="dialog" aria-modal="true">
      <div className="ds-frame">{contenido}</div>
    </div>,
    document.body,
  )
}

// ── La semana ────────────────────────────────────────────────────────────────

function VistaSemana({
  unidad, rango, dias, ventas, tab, setTab, plata, onBack, onDia, onVenta,
}: {
  unidad: string; rango: string; dias: Dia[] | null; ventas: Venta[]
  tab: Medio; setTab: (t: Medio) => void; plata: (v: number) => string
  onBack: () => void; onDia: (i: number) => void; onVenta: (v: Venta) => void
}) {
  const lista = dias ?? []
  const cash = lista.reduce((a, d) => a + d.cash, 0)
  const transfer = lista.reduce((a, d) => a + d.transfer, 0)
  const total = cash + transfer
  const pct = (v: number) => (total ? (v / total) * 100 : 0).toFixed(1) + "%"
  const totalVentas = ventas.reduce((a, s) => a + s.monto, 0)

  return (
    <>
      <header className="ds-header">
        <button type="button" className="ds-back" onClick={onBack} aria-label="Volver"><ChevronLeft size={26} {...IC} /></button>
        <div>
          <h1 className="ds-title">Detalle – Resumen semanal</h1>
          <div className="ds-sub">{unidad} · {rango}</div>
        </div>
      </header>

      <div className="ds-body">
        <section className="ds-card ds-card--hi ds-total">
          <span className="ds-circle" style={{ width: 64, height: 64, background: "var(--ds-green-circle)", color: "var(--ds-green-icon)" }}>
            <Banknote size={30} {...IC} />
          </span>
          <div>
            <div className="ds-total-lbl">Total recaudado</div>
            <div className="ds-total-val">{plata(total)}</div>
          </div>
        </section>

        <section className="ds-card ds-split">
          {([["Efectivo", cash, Banknote], null, ["Transferencias", transfer, ArrowLeftRight]] as const).map((x, i) => {
            if (!x) return <span key={i} className="ds-split-sep" />
            const [label, valor, Icono] = x
            return (
              <div key={i} className="ds-split-item">
                <span className="ds-circle" style={{ width: 38, height: 38, background: "var(--ds-blue-circle)", color: "var(--ds-blue)" }}>
                  <Icono size={20} {...IC} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="ds-split-lbl">{label}</div>
                  <div className="ds-split-val">{plata(valor)}</div>
                  <div className="ds-split-pct">{pct(valor)}</div>
                </div>
              </div>
            )
          })}
        </section>

        <section className="ds-card ds-section">
          <h2 className="ds-h2">Movimiento del recaudo</h2>
          <div role="tablist" className="ds-seg">
            {([["cash", "Efectivo"], ["transfer", "Transferencias"]] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {dias === null ? (
            <div className="ds-loading">Cargando…</div>
          ) : (
            <div className="ds-list">
              {lista.map((d, k) => (
                <button key={d.fecha} type="button" className="ds-row ds-day" onClick={() => onDia(k)}>
                  <span className="ds-day-chip"><small>{DOW[dow(d.fecha)]}</small><b>{Number(d.fecha.slice(8, 10))}</b></span>
                  <span className="ds-day-val">{plata(tab === "cash" ? d.cash : d.transfer)}</span>
                  <ChevronRight size={18} color="var(--ds-sub)" {...IC} />
                </button>
              ))}
              <div className="ds-foot">
                <span>{tab === "cash" ? "Total efectivo" : "Total transferencias"}</span>
                <b>{plata(tab === "cash" ? cash : transfer)}</b>
              </div>
            </div>
          )}
        </section>

        <section className="ds-card ds-section" style={{ padding: 12 }}>
          <div className="ds-sales-head">
            <span className="ds-sales-ico"><ShoppingCart size={26} {...IC} /></span>
            <h2>Detalle de ventas</h2>
            <div>
              <div className="ds-sales-lbl">Total ventas</div>
              <div className="ds-sales-val">{plata(totalVentas)}</div>
            </div>
            <span className="ds-sales-n">{ventas.length} {ventas.length === 1 ? "venta" : "ventas"}</span>
          </div>
          {ventas.length > 0 && (
            <div className="ds-list ds-sales-list">
              {ventas.map((s) => (
                <button key={s.id} type="button" className="ds-row ds-sale" onClick={() => onVenta(s)}>
                  <Calendar size={17} color="var(--ds-sub)" {...IC} />
                  <span>{ddmm(s.fecha)}</span>
                  <span className="ds-sale-cli">
                    {s.cliente}
                    {s.renovacion && <span className="ds-sale-tag">(renovación)</span>}
                  </span>
                  <b>{plata(s.monto)}</b>
                  <ChevronRight size={16} color="var(--ds-sub)" {...IC} />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

// ── Un día ───────────────────────────────────────────────────────────────────

function VistaDia({
  rutaId, unidad, fecha, medio, plata, hasPrev, hasNext, onPrev, onNext, onBack, onPago,
}: {
  rutaId: number; unidad: string; fecha: string; medio: Medio; plata: (v: number) => string
  hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void; onBack: () => void
  onPago: (p: Pago) => void
}) {
  const [pagos, setPagos] = useState<Pago[] | null>(null)
  const esEfectivo = medio === "cash"
  const Icono = esEfectivo ? Banknote : ArrowLeftRight

  useEffect(() => {
    let vigente = true
    setPagos(null)
    void (async () => {
      const sb = createClient()
      // Los eventos de plata del día en esta ruta: la misma selección que
      // `resumen_diario_v2` (aplicados, sin homologación).
      const { data, error } = await sb
        .from("gestiones")
        .select("id, loan_id, tipo, monto, metodo_pago, fecha_hora, referencia_gestion_id, origen")
        .eq("ruta", rutaId).eq("fecha_gestion", fecha).eq("estado", "aplicada")
        .in("tipo", ["pago", "cancelacion", "abono_venta", "reversa"])
      if (error) throw error
      const ev = ((data ?? []) as {
        id: string; loan_id: string; tipo: string; monto: number; metodo_pago: string | null
        fecha_hora: string | null; referencia_gestion_id: string | null; origen: string | null
      }[]).filter((g) => g.origen !== "homologacion")

      // La reversa no trae forma de pago: toma la del pago que reversa.
      const refIds = [...new Set(ev.filter((g) => g.tipo === "reversa" && g.referencia_gestion_id).map((g) => g.referencia_gestion_id!))]
      const metodoRef = new Map<string, string | null>()
      if (refIds.length) {
        const r = await sb.from("gestiones").select("id, metodo_pago").in("id", refIds)
        for (const x of (r.data ?? []) as { id: string; metodo_pago: string | null }[]) metodoRef.set(x.id, x.metodo_pago)
      }
      const esTransf = (g: (typeof ev)[number]) =>
        ((g.metodo_pago || (g.referencia_gestion_id ? metodoRef.get(g.referencia_gestion_id) : null) || "efectivo").toLowerCase() === "transferencia")

      // Por cliente (préstamo): lo neto de ESTE medio, y la hora del último.
      const porLoan = new Map<string, { monto: number; ultimo: string | null }>()
      for (const g of ev) {
        if (esTransf(g) !== !esEfectivo) continue
        const signo = g.tipo === "reversa" ? -1 : 1
        const acc = porLoan.get(g.loan_id) ?? { monto: 0, ultimo: null }
        acc.monto += signo * (Number(g.monto) || 0)
        if (!acc.ultimo || (g.fecha_hora && g.fecha_hora > acc.ultimo)) acc.ultimo = g.fecha_hora
        porLoan.set(g.loan_id, acc)
      }
      const ids = [...porLoan.entries()].filter(([, v]) => Math.abs(v.monto) > 0.005).map(([k]) => k)

      const [rl, rf] = ids.length
        ? await Promise.all([
            sb.from("loans").select("id, valor_cuota, apodo_elegido, clients(nombre_completo, apodo, apodo_2)").in("id", ids),
            sb.from("v_loan_financiero").select("loan_id, saldo, total_pagado, cuotas_totales").in("loan_id", ids),
          ])
        : [{ data: [] }, { data: [] }]
      const loans = new Map(((rl.data ?? []) as unknown as {
        id: string; valor_cuota: number; apodo_elegido: number | null
        clients: { nombre_completo?: string | null; apodo?: string | null; apodo_2?: string | null } | null
      }[]).map((l) => [l.id, l]))
      const fin = new Map(((rf.data ?? []) as {
        loan_id: string; saldo: number; total_pagado: number; cuotas_totales: number
      }[]).map((f) => [f.loan_id, f]))

      const lista: Pago[] = ids.map((id) => {
        const l = loans.get(id)
        const f = fin.get(id)
        const c = l?.clients
        const v = porLoan.get(id)!
        return {
          id,
          cliente: ((l?.apodo_elegido === 2 ? c?.apodo_2 : null) || c?.apodo || c?.nombre_completo || "—").trim(),
          hora: hora(v.ultimo),
          cuota: `${cuotasConDecimal(f?.total_pagado, l?.valor_cuota, f?.cuotas_totales)}/${f?.cuotas_totales ?? "—"}`,
          monto: v.monto,
          saldo: Number(f?.saldo) || 0,
        }
      })
      lista.sort((a, b) => a.hora.localeCompare(b.hora))
      if (vigente) setPagos(lista)
    })().catch((err) => {
      console.error("[v0] Detalle del día:", err)
      if (vigente) setPagos([])
    })
    return () => { vigente = false }
  }, [rutaId, fecha, esEfectivo])

  const total = (pagos ?? []).reduce((a, p) => a + p.monto, 0)
  const n = pagos?.length ?? 0

  return (
    <>
      <header className="ds-header">
        <button type="button" className="ds-back" onClick={onBack} aria-label="Volver"><ChevronLeft size={26} {...IC} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="ds-title">{DIA[dow(fecha)]} {ddmm(fecha)}</h1>
          <div className="ds-sub">{unidad} · {esEfectivo ? "Pagos en efectivo" : "Pagos por transferencia"}</div>
        </div>
        <div className="ds-nav">
          <button type="button" className="ds-nav-btn" aria-label="Día anterior" disabled={!hasPrev} onClick={onPrev}><ChevronLeft size={18} {...IC} /></button>
          <button type="button" className="ds-nav-btn" aria-label="Día siguiente" disabled={!hasNext} onClick={onNext}><ChevronRight size={18} {...IC} /></button>
        </div>
      </header>

      <div className="ds-body">
        <section className="ds-card ds-card--hi ds-daytot">
          <span className="ds-circle" style={{ width: 56, height: 56, background: "var(--ds-blue-circle)", color: "var(--ds-blue)" }}>
            <Icono size={28} {...IC} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="ds-daytot-lbl">{esEfectivo ? "Total efectivo del día" : "Total transferencias del día"}</div>
            <div className="ds-daytot-val">{plata(total)}</div>
          </div>
          <div className="ds-daytot-n"><b>{n}</b><small>{n === 1 ? "pago" : "pagos"}</small></div>
        </section>

        <section className="ds-card ds-section">
          <h2 className="ds-h2">Pagos por cliente</h2>
          {pagos === null ? (
            <div className="ds-loading">Cargando…</div>
          ) : pagos.length ? (
            <div className="ds-list">
              {pagos.map((p) => (
                <button key={p.id} type="button" className="ds-row ds-pay" onClick={() => onPago(p)}>
                  <span className="ds-avatar">{iniciales(p.cliente)}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="ds-pay-name">{p.cliente}</div>
                    <div className="ds-pay-meta"><Clock size={14} {...IC} />{p.hora} · Cuota {p.cuota}</div>
                  </div>
                  <div className="ds-pay-amt"><b>{plata(p.monto)}</b><small>Saldo {plata(p.saldo)}</small></div>
                </button>
              ))}
              <div className="ds-foot"><span>Total del día</span><b>{plata(total)}</b></div>
            </div>
          ) : (
            <div className="ds-empty">
              <span className="ds-empty-ico"><CalendarX size={26} {...IC} /></span>
              <b>Sin pagos este día</b>
              <span>{esEfectivo ? "No se registraron cobros en efectivo." : "No se registraron transferencias."}</span>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

// ── Pantallas de destino ─────────────────────────────────────────────────────

const FREC: Record<string, string> = { daily: "Diaria", weekly: "Semanal", biweekly: "Quincenal", monthly: "Mensual" }
const fechaHora = (ts: string | null | undefined) =>
  ts
    ? new Intl.DateTimeFormat("es-CO", {
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
        timeZone: "America/Bogota",
      }).format(new Date(ts))
    : "—"
const fechaCO = (ts: string | null | undefined) =>
  ts ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(ts)) : null

function Encabezado({ titulo, sub, onBack }: { titulo: string; sub: string; onBack: () => void }) {
  return (
    <header className="ds-header">
      <button type="button" className="ds-back" onClick={onBack} aria-label="Volver"><ChevronLeft size={26} {...IC} /></button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className="ds-title">{titulo}</h1>
        <div className="ds-sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
      </div>
    </header>
  )
}

function Filas({ filas }: { filas: [string, React.ReactNode][] }) {
  return (
    <div className="ds-kv">
      {filas.map(([k, v]) => (
        <div key={k} className="ds-kv-row"><span>{k}</span><b>{v}</b></div>
      ))}
    </div>
  )
}

function Foto({ url, label }: { url: string | null | undefined; label: string }) {
  return url ? (
    <a className="ds-photo" href={url} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={label} />
      {label}
    </a>
  ) : (
    <div className="ds-photo"><div className="ds-photo-none">Sin foto</div>{label}</div>
  )
}

/**
 * LA FICHA DEL CRÉDITO: quién es el cliente y cómo va su crédito HOY. La usan
 * las dos pantallas de destino. El saldo, lo pagado y la mora salen de
 * `v_loan_financiero`, la misma vista de toda la app.
 */
function FichaCredito({ loanId, plata }: { loanId: string; plata: (v: number) => string }) {
  const [d, setD] = useState<{
    l: Record<string, unknown>
    c: Record<string, string | number | null>
    f: Record<string, unknown> | null
    multa: number
  } | null>(null)

  useEffect(() => {
    let vigente = true
    void (async () => {
      const sb = createClient()
      const [rl, rf, rm] = await Promise.all([
        sb.from("loans")
          .select("id, estado, origen, valor, valor_a_pagar, valor_cuota, numero_cuotas, tasa_interes, frecuencia_pago, dia_semana, fecha_creacion, apodo_elegido, clients(nombre_completo, apodo, apodo_2, documento, telefono, direccion, direccion_residencia, tipo_comercio)")
          .eq("id", loanId).maybeSingle(),
        sb.from("v_loan_financiero")
          .select("total_a_pagar, total_pagado, saldo, cuotas_mora, cuotas_cubiertas, cuotas_totales, fecha_ultimo_pago")
          .eq("loan_id", loanId).maybeSingle(),
        sb.from("multas").select("valor").eq("loan_id", loanId).eq("estado", "pendiente"),
      ])
      if (!vigente || !rl.data) return
      const l = rl.data as unknown as Record<string, unknown>
      setD({
        l,
        c: (l.clients ?? {}) as Record<string, string | number | null>,
        f: (rf.data ?? null) as Record<string, unknown> | null,
        multa: ((rm.data ?? []) as { valor: number }[]).reduce((a, m) => a + (Number(m.valor) || 0), 0),
      })
    })().catch((err) => console.error("[v0] Ficha del crédito:", err))
    return () => { vigente = false }
  }, [loanId])

  if (!d) return <section className="ds-card ds-section"><div className="ds-loading">Cargando…</div></section>
  const { l, c, f, multa } = d
  const n = (v: unknown) => Number(v) || 0
  const tel = String(c.telefono ?? "").trim()
  const frec = String(l.frecuencia_pago ?? "daily")
  const estado = String(l.estado ?? "")

  return (
    <>
      <section className="ds-card ds-section">
        <h2 className="ds-h2">Cliente</h2>
        <Filas filas={[
          ["Nombre", String(c.nombre_completo ?? "—")],
          ["Alias", String((n(l.apodo_elegido) === 2 ? c.apodo_2 : null) || c.apodo || "—")],
          ["Documento", String(c.documento ?? "—")],
          ["Teléfono", tel ? <a href={`tel:${tel.replace(/[^\d+]/g, "")}`}>{tel}</a> : "—"],
          ["Establecimiento", String(c.tipo_comercio ?? "—")],
          ["Dirección", String(c.direccion ?? "—")],
          ...(c.direccion_residencia ? [["Residencia", String(c.direccion_residencia)] as [string, string]] : []),
        ]} />
      </section>

      <section className="ds-card ds-section">
        <h2 className="ds-h2">Crédito</h2>
        <Filas filas={[
          ["Estado", <span key="e" className={`ds-tag ${estado === "activo" ? "ds-tag--ok" : estado === "anulado" ? "ds-tag--bad" : ""}`}>{estado || "—"}</span>],
          ["Fecha de venta", fechaCO(String(l.fecha_creacion ?? "")) ? ddmmaaaa(fechaCO(String(l.fecha_creacion))!) : "—"],
          ["Valor prestado", plata(n(l.valor))],
          ["Interés", `${n(l.tasa_interes)}%`],
          ["Total a pagar", plata(n(f?.total_a_pagar) || n(l.valor_a_pagar))],
          ["Cuotas", `${n(l.numero_cuotas)} de ${plata(n(l.valor_cuota))}`],
          ["Frecuencia", `${FREC[frec] ?? frec}${frec !== "daily" && l.dia_semana ? ` (${String(l.dia_semana)})` : ""}`],
          ["Pagado", plata(n(f?.total_pagado))],
          ["Saldo", plata(n(f?.saldo))],
          ["Avance", `${cuotasConDecimal(n(f?.total_pagado), n(l.valor_cuota), n(f?.cuotas_totales))} / ${n(f?.cuotas_totales)} cuotas`],
          ["Cuotas en mora", String(n(f?.cuotas_mora))],
          ...(multa > 0 ? [["Sanción pendiente", plata(multa)] as [string, string]] : []),
          ["Último pago", f?.fecha_ultimo_pago ? ddmmaaaa(String(f.fecha_ultimo_pago).slice(0, 10)) : "—"],
        ]} />
      </section>
    </>
  )
}

/** EL PAGO: todo lo que se registró de ese cliente ese día, y su crédito. */
function VistaPago({
  loanId, fecha, cliente, plata, onBack,
}: { loanId: string; fecha: string; cliente: string; plata: (v: number) => string; onBack: () => void }) {
  type Ev = {
    id: string; tipo: string; monto: number; metodo_pago: string | null; fecha_hora: string | null
    observacion: string | null; detalle: Record<string, unknown> | null; referencia_gestion_id: string | null
    user_id: number | null; estado: string
  }
  const [evs, setEvs] = useState<Ev[] | null>(null)
  const [cuentas, setCuentas] = useState<Map<string, string>>(new Map())
  const [usuarios, setUsuarios] = useState<Map<number, string>>(new Map())

  useEffect(() => {
    let vigente = true
    void (async () => {
      const sb = createClient()
      const { data } = await sb
        .from("gestiones")
        .select("id, tipo, monto, metodo_pago, fecha_hora, observacion, detalle, referencia_gestion_id, user_id, estado")
        .eq("loan_id", loanId).eq("fecha_gestion", fecha)
        .in("tipo", ["pago", "cancelacion", "abono_venta", "reversa", "no_pago"])
        .order("fecha_hora")
      const lista = (data ?? []) as Ev[]
      const ctaIds = [...new Set(lista.map((e) => e.detalle?.cuenta_id).filter(Boolean).map(String))]
      const userIds = [...new Set(lista.map((e) => e.user_id).filter((x): x is number => x != null))]
      const [rc, ru] = await Promise.all([
        ctaIds.length ? sb.from("cuentas").select("id, nombre, cuenta").in("id", ctaIds) : Promise.resolve({ data: [] }),
        userIds.length ? sb.from("usuarios").select("id, nombre").in("id", userIds) : Promise.resolve({ data: [] }),
      ])
      if (!vigente) return
      setCuentas(new Map(((rc.data ?? []) as { id: number; nombre: string | null; cuenta: string | null }[])
        .map((x) => [String(x.id), [x.nombre, x.cuenta].filter(Boolean).join(" · ")])))
      setUsuarios(new Map(((ru.data ?? []) as { id: number; nombre: string | null }[]).map((x) => [x.id, x.nombre ?? `#${x.id}`])))
      setEvs(lista)
    })().catch((err) => {
      console.error("[v0] Detalle del pago:", err)
      if (vigente) setEvs([])
    })
    return () => { vigente = false }
  }, [loanId, fecha])

  const aplicados = (evs ?? []).filter((e) => e.estado === "aplicada")
  const neto = aplicados.reduce((a, e) => a + (e.tipo === "reversa" ? -1 : e.tipo === "no_pago" ? 0 : 1) * (Number(e.monto) || 0), 0)
  const fotos = (evs ?? []).map((e) => e.detalle?.foto_url).filter(Boolean).map(String)
  const titulo = (t: string) =>
    ({ pago: "Pago", cancelacion: "Cancelación", abono_venta: "Abono de la venta", reversa: "Reversa", no_pago: "No pago" } as Record<string, string>)[t] ?? t

  return (
    <>
      <Encabezado titulo="Detalle del pago" sub={`${cliente} · ${DIA[dow(fecha)]} ${ddmm(fecha)}`} onBack={onBack} />
      <div className="ds-body">
        <section className="ds-card ds-card--hi ds-hero">
          <span className="ds-hero-lbl">Pagado ese día</span>
          <span className="ds-hero-val">{plata(neto)}</span>
          <span className="ds-hero-sub">{cliente}</span>
        </section>

        <section className="ds-card ds-section">
          <h2 className="ds-h2">Movimientos del día</h2>
          {evs === null ? (
            <div className="ds-loading">Cargando…</div>
          ) : (
            <div className="ds-list">
              {evs.map((e) => {
                const transf = (e.metodo_pago ?? "").toLowerCase() === "transferencia"
                const cta = e.detalle?.cuenta_id ? cuentas.get(String(e.detalle.cuenta_id)) : null
                const Ic = e.tipo === "reversa" ? Undo2 : e.tipo === "no_pago" ? XCircle : transf ? ArrowLeftRight : Banknote
                const meta = [
                  hora(e.fecha_hora),
                  e.tipo === "no_pago" ? null : e.tipo === "reversa" ? "anula un pago" : transf ? `Transferencia${cta ? ` · ${cta}` : ""}` : "Efectivo",
                  e.user_id != null ? usuarios.get(e.user_id) : null,
                  e.estado !== "aplicada" ? (e.estado === "en_revision" ? "en revisión" : e.estado) : null,
                ].filter(Boolean).join(" · ")
                return (
                  <div key={e.id} className="ds-row ds-mov">
                    <span className={`ds-mov-ico${e.tipo === "reversa" ? " ds-mov-ico--rev" : e.tipo === "no_pago" ? " ds-mov-ico--no" : ""}`}>
                      <Ic size={18} {...IC} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="ds-mov-t">{titulo(e.tipo)}</div>
                      <div className="ds-mov-m">{meta}</div>
                      {e.observacion && <div className="ds-mov-obs">“{e.observacion}”</div>}
                    </div>
                    {e.tipo !== "no_pago" && (
                      <b className={e.tipo === "reversa" ? "ds-neg" : undefined}>
                        {e.tipo === "reversa" ? "−" : ""}{plata(Number(e.monto) || 0)}
                      </b>
                    )}
                  </div>
                )
              })}
              <div className="ds-foot"><span>Neto del día</span><b>{plata(neto)}</b></div>
            </div>
          )}
          {fotos.length > 0 && (
            <div className="ds-photos">
              {fotos.map((u, i) => <Foto key={u} url={u} label={fotos.length > 1 ? `Foto ${i + 1}` : "Foto del pago"} />)}
            </div>
          )}
        </section>

        <FichaCredito loanId={loanId} plata={plata} />
      </div>
    </>
  )
}

/** LA VENTA (o la renovación): cuánto, cómo se entregó, la evidencia y el crédito. */
function VistaVenta({ venta, plata, onBack }: { venta: Venta; plata: (v: number) => string; onBack: () => void }) {
  const [l, setL] = useState<Record<string, unknown> | null>(null)
  const [renov, setRenov] = useState<Record<string, unknown> | null>(null)
  const [cuenta, setCuenta] = useState<string | null>(null)

  useEffect(() => {
    let vigente = true
    void (async () => {
      const sb = createClient()
      const [rl, rg] = await Promise.all([
        sb.from("loans")
          .select("id, valor, fecha_creacion, tipo_venta, venta_efectivo, venta_transferencia, cuenta_id, comprobante_url, origen, estado, motivo_anulacion, clients(foto_local_url)")
          .eq("id", venta.loanId).maybeSingle(),
        venta.renovacion
          ? sb.from("gestiones").select("fecha_hora, detalle, observacion").eq("id", venta.id).maybeSingle()
          : Promise.resolve({ data: null }),
      ])
      const loan = (rl.data ?? null) as Record<string, unknown> | null
      let nombreCta: string | null = null
      if (loan?.cuenta_id && !venta.renovacion) {
        const rc = await sb.from("cuentas").select("nombre, cuenta").eq("id", loan.cuenta_id).maybeSingle()
        const c = rc.data as { nombre: string | null; cuenta: string | null } | null
        nombreCta = c ? [c.nombre, c.cuenta].filter(Boolean).join(" · ") : null
      }
      if (!vigente) return
      setL(loan)
      setRenov((rg.data ?? null) as Record<string, unknown> | null)
      setCuenta(nombreCta)
    })().catch((err) => console.error("[v0] Detalle de la venta:", err))
    return () => { vigente = false }
  }, [venta])

  const n = (v: unknown) => Number(v) || 0
  const tipo = String(l?.tipo_venta ?? "efectivo")
  const det = (renov?.detalle ?? {}) as Record<string, unknown>
  const antes = (det.antes ?? {}) as Record<string, unknown>
  const despues = (det.despues ?? {}) as Record<string, unknown>
  const estado = String(l?.estado ?? "")

  return (
    <>
      <Encabezado
        titulo={venta.renovacion ? "Detalle de la renovación" : "Detalle de la venta"}
        sub={`${venta.cliente} · ${ddmmaaaa(venta.fecha)}`}
        onBack={onBack}
      />
      <div className="ds-body">
        <section className="ds-card ds-card--hi ds-hero">
          <span className="ds-hero-lbl">{venta.renovacion ? "Entregado al renovar" : "Valor de la venta"}</span>
          <span className="ds-hero-val">{plata(venta.monto)}</span>
          <span className="ds-hero-sub">{venta.cliente}</span>
          <div className="ds-tags">
            {venta.renovacion && <span className="ds-tag"><RefreshCw size={14} {...IC} />Renovación</span>}
            {l?.origen === "homologado" && <span className="ds-tag ds-tag--warn">Homologada</span>}
            {estado === "anulado" && <span className="ds-tag ds-tag--bad">Anulada</span>}
          </div>
        </section>

        {l === null ? (
          <section className="ds-card ds-section"><div className="ds-loading">Cargando…</div></section>
        ) : venta.renovacion ? (
          <section className="ds-card ds-section">
            <h2 className="ds-h2">La renovación</h2>
            <Filas filas={[
              ["Fecha y hora", fechaHora(renov?.fecha_hora as string | null)],
              ["Entregado", plata(n(det.valor_entregado))],
              ["Interés", `${n(det.tasa)}%`],
              ["Se suma a la deuda", plata(n(det.total_agregado))],
              ["Cuotas nuevas", `${n(det.cuotas_nuevas)} de ${plata(n(det.valor_cuota_nueva))}`],
              ["Días agregados", String(n(det.dias))],
              ["Total a pagar antes", plata(n(antes.valor_a_pagar))],
              ["Total a pagar después", plata(n(despues.valor_a_pagar))],
              ["Pagado al renovar", plata(n(antes.pagado))],
            ]} />
          </section>
        ) : (
          <section className="ds-card ds-section">
            <h2 className="ds-h2">La entrega</h2>
            <Filas filas={[
              ["Fecha y hora", fechaHora(l.fecha_creacion as string | null)],
              ["Forma de entrega", tipo === "mixto" ? "Mixta" : tipo === "transferencia" ? "Transferencia" : "Efectivo"],
              ...(tipo === "mixto"
                ? [["En efectivo", plata(n(l.venta_efectivo))], ["Por transferencia", plata(n(l.venta_transferencia))]] as [string, string][]
                : []),
              ...(cuenta ? [["Cuenta", cuenta] as [string, string]] : []),
              ...(estado === "anulado" && l.motivo_anulacion ? [["Motivo de anulación", String(l.motivo_anulacion)] as [string, string]] : []),
            ]} />
            <div className="ds-photos">
              <Foto url={l.comprobante_url as string | null} label="Evidencia de entrega" />
              <Foto url={(l.clients as { foto_local_url?: string | null } | null)?.foto_local_url} label="Foto del local" />
            </div>
          </section>
        )}

        <FichaCredito loanId={venta.loanId} plata={plata} />
      </div>
    </>
  )
}
