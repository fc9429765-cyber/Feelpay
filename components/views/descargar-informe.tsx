"use client"

/**
 * Descargar informe.
 *
 * Genera el MISMO Excel que la empresa venía bajando del sistema anterior:
 * siete hojas (Pagos, No Pagos, Ventas, Gastos, Ingresos, Retiros y Resumen) con las
 * columnas letra por letra. Ver `lib/informe-excel.ts`, donde está el detalle
 * de cada hoja y de dónde sale cada dato.
 *
 * Se elige un administrador —o todos—, las unidades y un día o un rango, y se
 * baja el archivo.
 *
 * EL ADMINISTRADOR NO ES UN FILTRO MÁS: al elegirlo, la lista de unidades se
 * reduce a las suyas. Es la forma en que se pidió ("seleccionar un
 * administrador, una ruta etc") y evita el error de bajar un informe con
 * rutas de otro.
 *
 * Es de SOLO LECTURA.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Download, FileSpreadsheet, Loader2 } from "lucide-react"
import { getSupabaseSafe } from "@/lib/api-helper"
import { todayColombia } from "@/lib/colombia-date"
import { useToast } from "@/hooks/use-toast"
import { generarInformeExcel } from "@/lib/informe-excel"

const TODOS = "__todos"

interface Ruta {
  id: number
  nombre: string
  ciudad: string | null
  pais: string | null
}

export function DescargarInforme() {
  const { toast } = useToast()
  const hoy = todayColombia()

  const [desde, setDesde] = useState(hoy)
  const [hasta, setHasta] = useState(hoy)
  const [admin, setAdmin] = useState(TODOS)
  const [seleccionadas, setSeleccionadas] = useState<Set<number>>(new Set())

  const [rutas, setRutas] = useState<Ruta[]>([])
  const [admins, setAdmins] = useState<{ id: number; nombre: string }[]>([])
  const [rutasPorAdmin, setRutasPorAdmin] = useState<Map<number, number[]>>(new Map())
  const [cargando, setCargando] = useState(true)
  const [bajando, setBajando] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const sb = await getSupabaseSafe()
        const [rRutas, rUsuarios, rAsign] = await Promise.all([
          sb.from("rutas").select("id, nombre, ciudad, pais").order("id"),
          sb.from("usuarios").select("id, nombre, rol"),
          sb.from("usuario_rutas").select("usuario_id, ruta_id"),
        ])

        setRutas((rRutas.data ?? []) as unknown as Ruta[])

        // El administrador de una ruta es el usuario con rol admin que la
        // tenga asignada — la misma regla del Reporte Gerencial.
        const us = new Map(
          ((rUsuarios.data ?? []) as unknown as {
            id: number
            nombre: string | null
            rol: string | null
          }[]).map((u) => [u.id, u]),
        )
        const porAdmin = new Map<number, number[]>()
        const lista: { id: number; nombre: string }[] = []
        for (const a of (rAsign.data ?? []) as unknown as {
          usuario_id: number
          ruta_id: number
        }[]) {
          const u = us.get(a.usuario_id)
          const rol = (u?.rol ?? "").toLowerCase()
          if (rol !== "admin" && rol !== "administrador") continue
          const prev = porAdmin.get(a.usuario_id)
          if (prev) prev.push(a.ruta_id)
          else {
            porAdmin.set(a.usuario_id, [a.ruta_id])
            lista.push({ id: a.usuario_id, nombre: u?.nombre ?? `#${a.usuario_id}` })
          }
        }
        setRutasPorAdmin(porAdmin)
        setAdmins(lista.sort((x, y) => x.nombre.localeCompare(y.nombre)))
      } catch (err) {
        console.error("[v0] Descargar informe, catálogos:", err)
        toast({
          title: "Error",
          description: "No se pudieron cargar las unidades",
          variant: "destructive",
        })
      } finally {
        setCargando(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Las unidades que se pueden elegir con el administrador actual. */
  const disponibles = useMemo(() => {
    if (admin === TODOS) return rutas
    const suyas = new Set(rutasPorAdmin.get(Number(admin)) ?? [])
    return rutas.filter((r) => suyas.has(r.id))
  }, [rutas, admin, rutasPorAdmin])

  // Al cambiar de administrador se sueltan las unidades que ya no son suyas:
  // si no, quedarían marcadas sin verse y el informe saldría con rutas que la
  // pantalla no muestra.
  useEffect(() => {
    setSeleccionadas((prev) => {
      const validas = new Set(disponibles.map((r) => r.id))
      const filtrado = new Set([...prev].filter((id) => validas.has(id)))
      return filtrado.size === prev.size ? prev : filtrado
    })
  }, [disponibles])

  const alternar = (id: number) =>
    setSeleccionadas((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })

  const todas = () => setSeleccionadas(new Set(disponibles.map((r) => r.id)))
  const ninguna = () => setSeleccionadas(new Set())

  const descargar = async () => {
    if (desde > hasta) {
      toast({
        title: "Rango al revés",
        description: "La fecha inicial es posterior a la final.",
        variant: "destructive",
      })
      return
    }
    setBajando(true)
    try {
      const { blob, nombre, conteos } = await generarInformeExcel({
        desde,
        hasta,
        // Vacío = todas las disponibles. Si hay un administrador elegido se
        // mandan las suyas, no una lista vacía que traería todo el país.
        rutaIds:
          seleccionadas.size > 0
            ? [...seleccionadas]
            : admin === TODOS
              ? []
              : disponibles.map((r) => r.id),
      })

      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = nombre
      a.click()
      URL.revokeObjectURL(url)

      const total = Object.values(conteos).reduce((s, n) => s + n, 0)
      toast({
        title: "Informe descargado",
        description:
          total === 0
            ? "No hubo movimiento en ese rango con esos filtros."
            : `${conteos.Pagos} pagos · ${conteos["No Pagos"]} no pagos · ${conteos.Ventas} ventas · ${conteos.Gastos} gastos · ${conteos.Ingresos} ingresos · ${conteos.Retiros ?? 0} retiros.`,
      })
    } catch (err) {
      console.error("[v0] Descargar informe:", err)
      toast({
        title: "No se pudo generar",
        description: err instanceof Error ? err.message : "Intenta de nuevo",
        variant: "destructive",
      })
    } finally {
      setBajando(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-start gap-2">
            <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Genera el informe en Excel con siete hojas:{" "}
              <strong>Pagos</strong>, <strong>No Pagos</strong>,{" "}
              <strong>Ventas</strong>, <strong>Gastos</strong>,{" "}
              <strong>Ingresos</strong>, <strong>Retiros</strong> y <strong>Resumen</strong>.
            </p>
          </div>

          {/* ── Fechas ────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-2 md:max-w-md">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Desde</Label>
              <Input
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Hasta</Label>
              <Input
                type="date"
                value={hasta}
                onChange={(e) => setHasta(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
          </div>

          {/* ── Administrador ─────────────────────────────────────────────── */}
          <div className="space-y-1 md:max-w-md">
            <Label className="text-[11px] text-muted-foreground">Administrador</Label>
            <Select value={admin} onValueChange={setAdmin}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS} className="text-xs">
                  Todos los administradores
                </SelectItem>
                {admins.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)} className="text-xs">
                    {a.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── Unidades ──────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-[11px] text-muted-foreground">
                Unidades
                {seleccionadas.size > 0 && (
                  <span className="ml-1 font-semibold text-foreground">
                    ({seleccionadas.size} de {disponibles.length})
                  </span>
                )}
              </Label>
              <Button variant="outline" size="sm" onClick={todas} className="h-7 text-[11px]">
                Todas
              </Button>
              <Button variant="outline" size="sm" onClick={ninguna} className="h-7 text-[11px]">
                Ninguna
              </Button>
            </div>

            {cargando ? (
              <p className="py-4 text-center text-[11px] text-muted-foreground">
                Cargando unidades…
              </p>
            ) : disponibles.length === 0 ? (
              <p className="py-4 text-center text-[11px] text-muted-foreground">
                Ese administrador no tiene unidades asignadas.
              </p>
            ) : (
              <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto rounded-md border p-2 md:grid-cols-3 lg:grid-cols-4">
                {disponibles.map((r) => (
                  <label
                    key={r.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={seleccionadas.has(r.id)}
                      onCheckedChange={() => alternar(r.id)}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="truncate" title={`${r.nombre} · ${r.ciudad ?? ""}`}>
                      {r.nombre}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {/* Sin nada marcado se bajan TODAS las de la lista. Se dice, para
                que nadie crea que el informe salió vacío por eso. */}
            {seleccionadas.size === 0 && disponibles.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Sin marcar ninguna se incluyen las {disponibles.length} unidades de la lista.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button
              onClick={() => void descargar()}
              disabled={bajando || cargando}
              className="gap-2"
            >
              {bajando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {bajando ? "Generando…" : "Descargar informe"}
            </Button>
            <Badge variant="secondary" className="text-[11px]">
              {desde === hasta ? desde : `${desde} → ${hasta}`}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
