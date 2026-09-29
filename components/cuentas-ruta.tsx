"use client"

/**
 * LAS CUENTAS PARA TRANSFERENCIAS DE UNA RUTA (Configuración → Rutas).
 *
 * De acá salen los selectores de "Registrar Pago" y de "Crear Venta"
 * (`/api/cuentas`). Antes la tabla `cuentas` solo se podía cargar a mano en
 * Supabase y el módulo de pagos mostraba una lista de ejemplo.
 *
 * Cada cambio se guarda AL MOMENTO, no con el "Guardar" del diálogo: una
 * cuenta es una fila propia, y perder las cuentas cargadas por cancelar el
 * diálogo sería peor que tenerlas guardadas antes de tiempo.
 *
 * NO SE BORRAN: una cuenta tiene pagos y ventas apuntándole. Se desactiva, deja
 * de salir en los selectores, y lo recibido queda visible (scripts/126).
 *
 * LA TRAZABILIDAD: debajo de cada cuenta, lo que entró en los últimos 30 días
 * (`v_pagos_por_cuenta`: pagos aplicados menos sus reversas) y el detalle de
 * cada pago —fecha, cliente, monto, foto— al abrirla.
 */

import { useCallback, useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Landmark, Loader2, Pencil, Plus, Save, X, ChevronDown, ChevronUp, ImageIcon } from "lucide-react"
import { todayColombia } from "@/lib/colombia-date"

type Cuenta = {
  id: number
  ruta: number
  nombre: string | null
  cuenta: string | null
  titular?: string | null
  activa?: boolean | null
}

type PagoCuenta = {
  gestion_id: string
  cuenta_id: number
  fecha_gestion: string
  fecha_hora: string | null
  tipo: string
  monto: number
  apodo: string | null
  nombre_completo: string | null
  foto_url: string | null
  observacion: string | null
}

const DIAS_TRAZA = 30

const fmt = (n: number) => `$${Math.round(n).toLocaleString("es-CO")}`
const fmtFecha = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-")
  return `${d}/${m}/${y.slice(2)}`
}
const hace = (dias: number) => {
  const d = new Date(`${todayColombia()}T12:00:00`)
  d.setDate(d.getDate() - dias)
  return d.toISOString().slice(0, 10)
}

export function CuentasRuta({ rutaId }: { rutaId: number }) {
  const { toast } = useToast()
  const [cuentas, setCuentas] = useState<Cuenta[]>([])
  const [pagos, setPagos] = useState<PagoCuenta[]>([])
  /** false = el script 126 no corrió: no hay vista de trazabilidad. */
  const [hayTraza, setHayTraza] = useState(true)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  // El formulario sirve para agregar (id = null) y para editar.
  const [formAbierto, setFormAbierto] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [fNombre, setFNombre] = useState("")
  const [fCuenta, setFCuenta] = useState("")
  const [fTitular, setFTitular] = useState("")
  const [abierta, setAbierta] = useState<number | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const sb = createClient()
      const { data, error } = await sb.from("cuentas").select("*").eq("ruta", rutaId).order("nombre")
      if (error) throw error
      const lista = (data ?? []) as Cuenta[]
      setCuentas(lista)
      if (lista.length) {
        const r = await sb
          .from("v_pagos_por_cuenta")
          .select("gestion_id, cuenta_id, fecha_gestion, fecha_hora, tipo, monto, apodo, nombre_completo, foto_url, observacion")
          .in("cuenta_id", lista.map((c) => c.id))
          .gte("fecha_gestion", hace(DIAS_TRAZA))
          .order("fecha_hora", { ascending: false })
          .limit(500)
        if (r.error) {
          console.warn("[v0] v_pagos_por_cuenta no disponible (falta scripts/126):", r.error.message)
          setHayTraza(false)
          setPagos([])
        } else {
          setHayTraza(true)
          setPagos((r.data ?? []) as PagoCuenta[])
        }
      } else {
        setPagos([])
      }
    } catch (err) {
      console.error("[v0] Cuentas de la ruta:", err)
      toast({ title: "No se pudieron cargar las cuentas", description: String((err as Error)?.message ?? err), variant: "destructive" })
    } finally {
      setCargando(false)
    }
  }, [rutaId, toast])

  useEffect(() => { void cargar() }, [cargar])

  const abrirForm = (c?: Cuenta) => {
    setEditId(c?.id ?? null)
    setFNombre(c?.nombre ?? "")
    setFCuenta(c?.cuenta ?? "")
    setFTitular(c?.titular ?? "")
    setFormAbierto(true)
  }

  const guardar = async () => {
    const nombre = fNombre.trim()
    const cuenta = fCuenta.trim()
    if (!nombre || !cuenta) {
      toast({ title: "Faltan datos", description: "Escribe el banco o billetera y el número de cuenta.", variant: "destructive" })
      return
    }
    // El mismo número dos veces en la ruta confunde al cobrador al elegir.
    const repetida = cuentas.find((c) => c.id !== editId && (c.cuenta ?? "").replace(/\D/g, "") === cuenta.replace(/\D/g, ""))
    if (repetida) {
      toast({ title: "Esa cuenta ya está", description: `El número ya está cargado como "${repetida.nombre}".`, variant: "destructive" })
      return
    }
    setGuardando(true)
    try {
      const sb = createClient()
      const fila: Record<string, unknown> = { nombre, cuenta, titular: fTitular.trim() || null }
      let { error } = editId
        ? await sb.from("cuentas").update(fila).eq("id", editId).eq("ruta", rutaId)
        : await sb.from("cuentas").insert({ ...fila, ruta: rutaId })
      // Sin el script 126 no existe `titular`: se guarda sin él.
      if (error && /titular/.test(error.message)) {
        delete fila.titular
        ;({ error } = editId
          ? await sb.from("cuentas").update(fila).eq("id", editId).eq("ruta", rutaId)
          : await sb.from("cuentas").insert({ ...fila, ruta: rutaId }))
      }
      if (error) {
        // 23502 = id nulo: la tabla todavía no genera el id sola.
        const msg = (error as { code?: string }).code === "23502"
          ? "La tabla de cuentas todavía no genera el id sola: corre el script 126 en Supabase."
          : error.message
        throw new Error(msg)
      }
      toast({ title: editId ? "Cuenta actualizada" : "Cuenta agregada", description: `${nombre} · ${cuenta}` })
      setFormAbierto(false)
      await cargar()
    } catch (err) {
      toast({ title: "No se pudo guardar la cuenta", description: String((err as Error)?.message ?? err), variant: "destructive" })
    } finally {
      setGuardando(false)
    }
  }

  const cambiarActiva = async (c: Cuenta, activa: boolean) => {
    setCuentas((prev) => prev.map((x) => (x.id === c.id ? { ...x, activa } : x)))
    const { error } = await createClient().from("cuentas").update({ activa }).eq("id", c.id).eq("ruta", rutaId)
    if (error) {
      setCuentas((prev) => prev.map((x) => (x.id === c.id ? { ...x, activa: !activa } : x)))
      toast({
        title: "No se pudo cambiar",
        description: /activa/.test(error.message) ? "Falta correr el script 126 en Supabase." : error.message,
        variant: "destructive",
      })
      return
    }
    toast({ title: activa ? "Cuenta activada" : "Cuenta desactivada", description: activa ? "Vuelve a salir en los selectores." : "Ya no sale en pagos ni ventas. Lo recibido queda." })
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
          <Label className="text-sm">Cuentas para transferencias</Label>
        </div>
        {!formAbierto && (
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => abrirForm()}>
            <Plus className="h-3.5 w-3.5" /> Agregar
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Son las que el cobrador elige al registrar un pago o una venta por transferencia. Debajo de cada una
        queda lo que entró en los últimos {DIAS_TRAZA} días.
      </p>

      {formAbierto && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Banco o billetera <span className="text-destructive">*</span></Label>
              <Input value={fNombre} onChange={(e) => setFNombre(e.target.value)} placeholder="Bancolombia" className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Número de cuenta <span className="text-destructive">*</span></Label>
              <Input value={fCuenta} onChange={(e) => setFCuenta(e.target.value)} placeholder="123-456789-00" inputMode="numeric" className="h-8 text-sm" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Titular (opcional)</Label>
            <Input value={fTitular} onChange={(e) => setFTitular(e.target.value)} placeholder="A nombre de quién está" className="h-8 text-sm" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setFormAbierto(false)} disabled={guardando}>
              <X className="h-3.5 w-3.5" /> Cancelar
            </Button>
            <Button type="button" size="sm" className="h-7 gap-1 text-xs" onClick={guardar} disabled={guardando}>
              {guardando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {editId ? "Guardar cambios" : "Agregar cuenta"}
            </Button>
          </div>
        </div>
      )}

      {cargando ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando cuentas…
        </div>
      ) : cuentas.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Esta ruta no tiene cuentas. Mientras no tenga, el cobrador puede registrar transferencias sin elegir cuenta.
        </p>
      ) : (
        <div className="space-y-1.5">
          {cuentas.map((c) => {
            const activa = c.activa !== false
            const suyos = pagos.filter((p) => Number(p.cuenta_id) === c.id)
            const total = suyos.reduce((s, p) => s + Number(p.monto || 0), 0)
            const ultimo = suyos[0]?.fecha_gestion
            const verDetalle = abierta === c.id
            return (
              <div key={c.id} className={`rounded-md border p-2 ${activa ? "" : "opacity-60"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <span className="truncate">{c.nombre || "Cuenta"}</span>
                      {!activa && <Badge variant="outline" className="h-4 px-1 text-[10px]">Inactiva</Badge>}
                    </p>
                    <p className="font-mono text-xs">{c.cuenta || "—"}</p>
                    {c.titular && <p className="text-[11px] text-muted-foreground">{c.titular}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Editar cuenta" onClick={() => abrirForm(c)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Switch checked={activa} onCheckedChange={(v) => cambiarActiva(c, v)} aria-label="Cuenta activa" />
                  </div>
                </div>
                {hayTraza && (
                  <button
                    type="button"
                    className="mt-1.5 flex w-full items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-left text-[11px]"
                    onClick={() => setAbierta(verDetalle ? null : c.id)}
                    disabled={suyos.length === 0}
                  >
                    <span>
                      {suyos.length === 0
                        ? `Sin pagos en los últimos ${DIAS_TRAZA} días`
                        : <>Recibido: <b>{fmt(total)}</b> en {suyos.length} pago{suyos.length === 1 ? "" : "s"} · último {fmtFecha(ultimo!)}</>}
                    </span>
                    {suyos.length > 0 && (verDetalle ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)}
                  </button>
                )}
                {verDetalle && (
                  <div className="mt-1 max-h-56 overflow-y-auto rounded border">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-muted">
                        <tr>
                          <th className="px-1.5 py-1 text-left font-semibold">Fecha</th>
                          <th className="px-1.5 py-1 text-left font-semibold">Cliente</th>
                          <th className="px-1.5 py-1 text-right font-semibold">Monto</th>
                          <th className="w-6" />
                        </tr>
                      </thead>
                      <tbody>
                        {suyos.map((p) => (
                          <tr key={p.gestion_id} className="border-t" title={p.observacion ?? undefined}>
                            <td className="px-1.5 py-1 whitespace-nowrap">{fmtFecha(p.fecha_gestion)}</td>
                            <td className="px-1.5 py-1 truncate max-w-[9rem]">
                              {(p.apodo || p.nombre_completo || "—").toUpperCase()}
                              {p.tipo === "reversa" && <span className="ml-1 text-destructive">(reversa)</span>}
                            </td>
                            <td className={`px-1.5 py-1 text-right font-semibold ${p.monto < 0 ? "text-destructive" : ""}`}>{fmt(p.monto)}</td>
                            <td className="px-1 py-1 text-center">
                              {p.foto_url && (
                                <a href={p.foto_url} target="_blank" rel="noreferrer" aria-label="Ver foto del pago">
                                  <ImageIcon className="inline h-3.5 w-3.5 text-primary" />
                                </a>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {!hayTraza && cuentas.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Para ver lo recibido por cuenta hay que correr el script 126 en Supabase.
        </p>
      )}
    </div>
  )
}
