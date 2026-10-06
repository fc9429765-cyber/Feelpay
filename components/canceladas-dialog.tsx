"use client"

/**
 * components/canceladas-dialog.tsx
 * ---------------------------------------------------------------------------
 * "CRÉDITOS CANCELADOS HOY", el ojito de Canceladas del Resumen del Día, con
 * el formato que pidió el dueño (06-oct-2026): una tarjeta por crédito con
 *
 *   izquierda   alias · documento · fecha de venta · cuotas X/Y · último pago
 *   centro      cómo venía: "Al día" o "Mora N"
 *   derecha     cuánto CANCELÓ ese día y el saldo final
 *   abajo       el total cancelado (= la cifra de Canceladas del resumen)
 *
 * DE DÓNDE SALE CADA DATO — del libro de eventos (aplicados):
 *
 *   Canceló        lo neto que el cliente pagó ESE día (pagos − reversas),
 *                  sin homologación: la misma cifra de `resumen_diario_v2`
 *   Último pago    el último pago ANTERIOR a ese día (el de ese día es el que
 *                  canceló)
 *   Mora           cuántas cuotas tenía vencidas sin cubrir al llegar a pagar:
 *                  las cuotas con vencimiento antes de ese día que no
 *                  alcanzaba a cubrir lo pagado antes de ese día (la misma
 *                  cascada de la plata sobre las cuotas, de la más vieja a la
 *                  más nueva). Con el crédito ya en cero la mora de hoy es 0;
 *                  lo que interesa es cómo terminó de pagar.
 *   Cuotas X/Y     las cuotas del plan cubiertas sobre el total
 *   Saldo final    el saldo del crédito (`v_loan_financiero`)
 */

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { formatearMoneda } from "@/lib/monedas"
import "./canceladas-dialog.css"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  loanIds: string[]
  /** El día del resumen ("YYYY-MM-DD"). */
  fecha: string
  moneda: string | null
}

interface Fila {
  id: string
  nombre: string
  documento: string
  venta: string | null
  cuotasCubiertas: number
  cuotasTotales: number
  ultimoPago: string | null
  mora: number
  cancelo: number
  saldo: number
}

const ddmmaaaa = (f: string | null) => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : "—")
const diaCO = (ts: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(ts))

export function CanceladasDialog({ open, onOpenChange, loanIds, fecha, moneda }: Props) {
  const [filas, setFilas] = useState<Fila[] | null>(null)
  const plata = (v: number) => formatearMoneda(v, moneda)

  useEffect(() => {
    if (!open) return
    let vigente = true
    setFilas(null)
    void (async () => {
      if (loanIds.length === 0) { if (vigente) setFilas([]); return }
      const sb = createClient()
      const [rl, rf, rp, rg] = await Promise.all([
        sb.from("loans")
          .select("id, fecha_creacion, apodo_elegido, clients(nombre_completo, apodo, apodo_2, documento)")
          .in("id", loanIds),
        sb.from("v_loan_financiero").select("loan_id, saldo, cuotas_cubiertas, cuotas_totales").in("loan_id", loanIds),
        sb.from("payment_plan").select("loan_id, numero_cuota, fecha_pago, valor_cuota").in("loan_id", loanIds),
        sb.from("gestiones")
          .select("loan_id, tipo, monto, fecha_gestion, origen")
          .in("loan_id", loanIds)
          .eq("estado", "aplicada")
          .in("tipo", ["pago", "cancelacion", "abono_venta", "reversa"]),
      ])
      if (!vigente) return

      const fin = new Map(((rf.data ?? []) as { loan_id: string; saldo: number | null; cuotas_cubiertas: number | null; cuotas_totales: number | null }[])
        .map((f) => [f.loan_id, f]))
      const plan = new Map<string, { fecha_pago: string; numero_cuota: number; valor_cuota: number }[]>()
      for (const p of (rp.data ?? []) as { loan_id: string; numero_cuota: number; fecha_pago: string; valor_cuota: number }[]) {
        const l = plan.get(p.loan_id) ?? []
        l.push(p)
        plan.set(p.loan_id, l)
      }
      // Se guardan TODOS los eventos, también los homologados (los pagos que
      // vinieron del sistema anterior): cubren cuotas igual que cualquier
      // pago, así que cuentan para la mora y el último pago. Solo "Canceló"
      // los deja afuera, como el resumen del día.
      const eventos = new Map<string, { tipo: string; monto: number; fecha_gestion: string; origen: string | null }[]>()
      for (const g of (rg.data ?? []) as { loan_id: string; tipo: string; monto: number; fecha_gestion: string; origen: string | null }[]) {
        const l = eventos.get(g.loan_id) ?? []
        l.push(g)
        eventos.set(g.loan_id, l)
      }

      const lista: Fila[] = ((rl.data ?? []) as unknown as {
        id: string; fecha_creacion: string; apodo_elegido: number | null
        clients: { nombre_completo?: string | null; apodo?: string | null; apodo_2?: string | null; documento?: string | null } | null
      }[]).map((l) => {
        const c = l.clients
        const evs = eventos.get(l.id) ?? []
        const neto = (e: { tipo: string; monto: number }) => (e.tipo === "reversa" ? -1 : 1) * (Number(e.monto) || 0)
        const cancelo = evs.filter((e) => e.fecha_gestion === fecha && e.origen !== "homologacion").reduce((a, e) => a + neto(e), 0)
        const pagadoAntes = evs.filter((e) => e.fecha_gestion < fecha).reduce((a, e) => a + neto(e), 0)
        const ultimoPago = evs
          .filter((e) => e.fecha_gestion < fecha && e.tipo !== "reversa" && (Number(e.monto) || 0) > 0)
          .map((e) => e.fecha_gestion).sort().pop() ?? null

        // La mora al llegar a pagar: la cascada de lo pagado ANTES de ese día
        // sobre las cuotas en orden, contra las que ya habían vencido.
        const cuotas = [...(plan.get(l.id) ?? [])].sort((a, b) => a.fecha_pago.localeCompare(b.fecha_pago) || a.numero_cuota - b.numero_cuota)
        let acumulado = 0
        let mora = 0
        for (const q of cuotas) {
          acumulado += Number(q.valor_cuota) || 0
          if (q.fecha_pago < fecha && acumulado > pagadoAntes + 0.5) mora += 1
        }

        const f = fin.get(l.id)
        return {
          id: l.id,
          nombre: ((l.apodo_elegido === 2 ? c?.apodo_2 : null) || c?.apodo || c?.nombre_completo || "—").trim().toUpperCase(),
          documento: (c?.documento ?? "").trim() || "—",
          venta: l.fecha_creacion ? diaCO(l.fecha_creacion) : null,
          cuotasCubiertas: Number(f?.cuotas_cubiertas) || 0,
          cuotasTotales: Number(f?.cuotas_totales) || cuotas.length,
          ultimoPago,
          mora,
          cancelo,
          saldo: Number(f?.saldo) || 0,
        }
      })
      lista.sort((a, b) => b.cancelo - a.cancelo || a.nombre.localeCompare(b.nombre))
      setFilas(lista)
    })().catch((err) => {
      console.error("[v0] Créditos cancelados:", err)
      if (vigente) setFilas([])
    })
    return () => { vigente = false }
  }, [open, loanIds, fecha])

  const total = (filas ?? []).reduce((a, f) => a + f.cancelo, 0)
  const n = filas?.length ?? loanIds.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-xl overflow-y-auto rounded-3xl border-0 bg-[#f6f9fd] p-3 sm:p-6"
        style={{ fontFamily: "var(--font-nunito-sans), 'Nunito Sans', sans-serif", color: "#14205a" }}
      >
        <div className="cd-wrap"><div className="cd-frame">
        <div className="pt-2 text-center">
          <DialogTitle className="text-[24px] font-extrabold tracking-tight">Créditos cancelados hoy</DialogTitle>
          <DialogDescription className="mt-1 text-base text-[#3d4a6b]">
            {n} {n === 1 ? "crédito" : "créditos"}
          </DialogDescription>
        </div>

        {filas === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[#3d4a6b]">
            <Loader2 className="h-5 w-5 animate-spin" /> Cargando…
          </div>
        ) : filas.length === 0 ? (
          <p className="py-10 text-center text-[#3d4a6b]">Hoy no se canceló ningún crédito.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {filas.map((f) => (
              <div
                key={f.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center rounded-2xl border border-[#e3eaf3] bg-white px-3 py-3"
              >
                <div className="min-w-0 pr-3">
                  <p className="truncate text-base font-extrabold leading-tight" title={f.nombre}>{f.nombre}</p>
                  <p className="mt-1 whitespace-nowrap text-[13px] text-[#2b3a63]">
                    {f.documento} · venta {ddmmaaaa(f.venta)}
                  </p>
                  <p className="mt-1 whitespace-nowrap text-[13px] text-[#2b3a63]">
                    Cuotas {f.cuotasCubiertas}/{f.cuotasTotales} · último pago {ddmmaaaa(f.ultimoPago)}
                  </p>
                </div>
                <div className="flex h-full items-center border-l border-[#dbe5f1] px-3">
                  <span className="whitespace-nowrap rounded-full bg-[#ddf4e6] px-3 py-1.5 text-[13px] font-bold text-[#0f7a3a]">
                    {f.mora > 0 ? `Mora ${f.mora}` : "Al día"}
                  </span>
                </div>
                <div className="flex h-full flex-col justify-center border-l border-[#dbe5f1] pl-3">
                  <div className="rounded-xl bg-[#e6f6ec] px-3 py-1.5">
                    <p className="text-[12px] text-[#2b3a63]">Canceló</p>
                    <p className="whitespace-nowrap text-[19px] font-extrabold leading-tight">{plata(f.cancelo)}</p>
                  </div>
                  <p className="mt-1 whitespace-nowrap px-3 text-[12px] text-[#2b3a63]">Saldo final {plata(f.saldo)}</p>
                </div>
              </div>
            ))}

            <div className="flex justify-end border-t border-[#dbe5f1] pt-3">
              <div className="text-right">
                <p className="text-sm text-[#2b3a63]">Total cancelado</p>
                <p className="text-2xl font-extrabold leading-tight">{plata(total)}</p>
              </div>
            </div>
          </div>
        )}
        </div></div>
      </DialogContent>
    </Dialog>
  )
}
