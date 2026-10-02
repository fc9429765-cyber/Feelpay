"use client"

/**
 * Detalle de Ruta — la pantalla del diseño (base 810px, tablet vertical).
 *
 * El armado, los tokens y las medidas son los de PROMPT_Detalle_de_Ruta.md
 * y viven en `detalle-ruta.css` (todo con prefijo `.dr-`). Este archivo
 * pone los DATOS REALES en cada hueco del diseño:
 *
 *   Ruta, país, ciudad, moneda       → `rutas`
 *   Estado, inicio y fin de jornada  → `rutas_diarias` (hora real, no un
 *                                      horario planificado que nadie guarda)
 *   Moto: placa, foto, logo          → `ruta_config_umbrales` (script 120)
 *   Cobrador                         → `usuario_rutas` + `usuarios` (rol vendedor)
 *   Tarjetero y Supervisor           → no existen esos roles en el sistema:
 *                                      se muestran "Sin asignar" (TODO)
 *   Debido, cobrado y los 6 contadores → `resumen_diario_v2` vía getResumenDia
 *   Clientes del día                 → `payment_plan` (el cronograma) cruzado
 *                                      con los eventos de `gestiones`
 *   Movimientos                      → `gestiones` + `gastosregistros`, por hora
 *   Mapa                             → el GPS de cada gestión del día
 *   Notas                            → `rutas_diarias.observacion` (script 086)
 *   Finalizar ruta                   → el mismo UPDATE del Cierre de Caja
 *   Exportar                         → el informe Excel de ese día y esa ruta
 *
 * LA PLATA VA EN LA MONEDA DE LA RUTA y el título lo dice: "Resumen de la
 * ruta (PYG)". Con cuatro países, un `$` sin apellido no dice nada.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import {
  Bike, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheckBig,
  ClipboardList, Clock, DollarSign, FileText, Filter, LayoutGrid, MapPin,
  MessageSquare, MoreVertical, Navigation, Phone, RefreshCw, Search, X,
  SlidersHorizontal, Smartphone, User, UserCheck, Users,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { getResumenDia } from "@/lib/resumen-dia"
import { todayColombia, montoEfectivo, apodoSiAporta, colorMora, etiquetaMora } from "@/lib/gestion-core"
import { formatearMoneda, monedaPorPais } from "@/lib/monedas"
import { generarInformeExcel } from "@/lib/informe-excel"
import { Bandera } from "@/components/bandera"
import { useToast } from "@/hooks/use-toast"
import type { MapPoint } from "./admin-route-monitor-map"
import "./detalle-ruta.css"
import { useClientesAsignados } from "@/lib/use-clientes-asignados"

/** El mismo mapa del Monitoreo de Rutas, que ya dibuja el recorrido en orden. */
const MapaRuta = dynamic(() => import("./admin-route-monitor-map"), {
  ssr: false,
  loading: () => <div className="dr-map-loading">Cargando mapa…</div>,
})

/** Lucide, stroke 1.5, 20px por defecto — como pide el diseño. */
const IC = { strokeWidth: 1.5, size: 20 } as const

type Pestana = "clientes" | "mapa" | "movimientos" | "gastos" | "notas"
type EstadoCliente = "pago" | "no_pago" | "pendiente"
type FiltroEstado = "todos" | EstadoCliente
type EstadoJornada = "abierta" | "cerrada" | null
type Menu = null | "rutas-buscar" | "rutas-titulo" | "filtros" | "filtros-tabla" | "mas"

interface Props {
  currentUserId?: number | string | null
  currentUserNombre?: string | null
  /** Ruta con la que abrir, cuando se llega desde el Resumen de Rutas. */
  rutaInicial?: number | null
  onVolver?: () => void
  onNavegar?: (view: string) => void
}

interface RutaInfo {
  id: number
  nombre: string
  ciudad: string | null
  pais: string | null
  moneda: string | null
  placa: string | null
  fotoMoto: string | null
  logo: string | null
  cobradorNombre: string | null
  cobradorUsuario: string | null
}

interface ClienteDia {
  loanId: string
  nombre: string
  /** Solo si dice algo que el nombre no dice (ver `apodoSiAporta`). */
  apodo: string | null
  /** El orden de la ruta: `loans.ordenvisita`, el que se arma en Ordenar Ruta. */
  orden: number | null
  /** Cuotas vencidas sin cubrir y su plata, de `v_loan_financiero`. */
  cuotasMora: number
  saldoMora: number
  direccion: string
  zona: string
  telefono: string
  cuota: number
  /** Lo que pagó ese día: neto de sus gestiones (pagos menos reversas). */
  pagado: number
  estado: EstadoCliente
}

interface Movimiento {
  id: string
  ts: string
  hora: string
  titulo: string
  detalle: string
  monto: number
  tono: "ok" | "bad" | "muted"
}

/** Las seis tarjetas del resumen, que ahora abren su detalle abajo. */
type KpiId = "pagos" | "noPagos" | "ventas" | "gastos" | "ingresos" | "retiros"

/** Una fila del detalle de una tarjeta. */
interface FilaKpi {
  id: string
  ts: string
  hora: string
  titulo: string
  sub: string | null
  detalle: string
  monto: number | null
}

interface Gasto {
  id: number
  hora: string
  concepto: string
  valor: number
}

const TABS: { id: Pestana; label: string }[] = [
  { id: "clientes", label: "Clientes" },
  { id: "mapa", label: "Mapa" },
  { id: "movimientos", label: "Movimientos" },
  { id: "gastos", label: "Gastos" },
  { id: "notas", label: "Notas" },
]

/** La barra de abajo del diseño, cableada a los módulos reales del admin. */
const NAV: { view: string; label: string; icono: React.ElementType }[] = [
  { view: "admin-dashboard", label: "Dashboard", icono: LayoutGrid },
  { view: "admin-route-detail", label: "Rutas", icono: ClipboardList },
  { view: "pending-authorizations", label: "Autorizaciones", icono: CircleCheckBig },
  { view: "chat", label: "Chat", icono: MessageSquare },
]

const FILTROS: { id: FiltroEstado; label: string }[] = [
  { id: "todos", label: "Todos los clientes" },
  { id: "pago", label: "Solo los que pagaron" },
  { id: "no_pago", label: "Solo los que no pagaron" },
  { id: "pendiente", label: "Solo pendientes" },
]

const TIPO_GESTION: Record<string, string> = {
  pago: "Pago", no_pago: "No pagó", cancelacion: "Cancelación", abono_venta: "Abono a venta",
  extension: "Extensión", ajuste: "Ajuste", reversa: "Reversa",
}

const MESES_CORTOS = ["Ene.", "Feb.", "Mar.", "Abr.", "May.", "Jun.", "Jul.", "Ago.", "Sep.", "Oct.", "Nov.", "Dic."]

// ── Formatos ────────────────────────────────────────────────────────────────

function capitalizar(t: string): string {
  return t.toLowerCase().split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" ")
}

/** Resuelve el caso de la 204, que tiene `pais` y `ciudad` al revés. */
function paisYCiudad(pais: string | null, ciudad: string | null) {
  const p = (pais ?? "").trim()
  const c = (ciudad ?? "").trim()
  const pareceCiudad =
    /buenos aires|la plata|chaco|cuenca|quito|asunci|cali|ibarra|rioamba|cordoba|rosario/i.test(p)
  return { pais: capitalizar(pareceCiudad ? c : p), ciudad: capitalizar(pareceCiudad ? p : c) }
}

/** "20 de Sep. 2026" — la pill del header y el selector de fecha. */
function fechaCorta(f: string): string {
  const [y, m, d] = f.split("-").map(Number)
  if (!y || !m || !d) return f
  return `${d} de ${MESES_CORTOS[m - 1]} ${y}`
}

/** "20 de septiembre de 2026" — la tarjeta de la ruta. Sin pasar por `Date`
 *  local: una fecha DATE es el día y ya, y en Argentina (UTC-3) se correría. */
function fechaLarga(f: string): string {
  const [y, m, d] = f.split("-").map(Number)
  if (!y || !m || !d) return f
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)))
}

/** "HH:MM" en hora Colombia, que es la hora de toda la app. */
function hhmm(ts: string | null | undefined): string {
  if (!ts) return ""
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ts))
}

/** El número de la unidad: "UNID 202" → "202". Sin dígitos, el nombre tal cual. */
function numeroRuta(nombre: string): string {
  const m = nombre.match(/(\d+)\s*$/)
  return m ? m[1] : nombre.replace(/^\s*ruta\s*/i, "").trim()
}

function tituloRuta(nombre: string): string {
  return `Ruta ${numeroRuta(nombre)}`
}

// ── Piezas del diseño ───────────────────────────────────────────────────────

function Pill({ variant, label, sm }: { variant: "success" | "danger" | "neutral"; label: string; sm?: boolean }) {
  return (
    <span className={`dr-pill dr-pill--${variant}${sm ? " dr-pill--sm" : ""}`}>
      <span className="dr-pill-dot" />{label}
    </span>
  )
}

function PersonCard({
  icon: Icon, kicker, title, children, onClick,
}: {
  icon: React.ElementType; kicker: string; title: string; children?: React.ReactNode; onClick?: () => void
}) {
  const Tag = onClick ? "button" : "div"
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} className={`dr-card dr-person${onClick ? "" : " dr-person--static"}`}>
      <span className="dr-iconbox"><Icon {...IC} /></span>
      <span className="dr-person-body">
        <span className="dr-kicker">{kicker}</span>
        <span className="dr-person-title">{title}</span>
        {children}
      </span>
      {onClick && <ChevronRight {...IC} size={16} className="dr-person-chevron" />}
    </Tag>
  )
}

function Metric({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`dr-box dr-metric${full ? " dr-metric--full" : ""}`}>
      <div className="dr-metric-lbl">{label}</div>
      {children}
    </div>
  )
}

function Modal({ title, children, actions, onClose }: {
  title: string; children: React.ReactNode; actions: React.ReactNode; onClose: () => void
}) {
  return (
    <div className="dr-backdrop" onClick={onClose}>
      <div className="dr-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="dr-modal-title">{title}</div>
        <div className="dr-modal-body">{children}</div>
        <div className="dr-modal-actions">{actions}</div>
      </div>
    </div>
  )
}

// ── La pantalla ─────────────────────────────────────────────────────────────

export function DetalleRuta({ currentUserId, currentUserNombre, rutaInicial, onVolver, onNavegar }: Props) {
  const { toast } = useToast()

  const [fecha, setFecha] = useState(todayColombia)
  const [rutaId, setRutaId] = useState<number | null>(rutaInicial ?? null)
  const [rutas, setRutas] = useState<RutaInfo[]>([])
  const [pestana, setPestana] = useState<Pestana>("clientes")
  const [busquedaRuta, setBusquedaRuta] = useState("")
  const [busquedaCliente, setBusquedaCliente] = useState("")
  const [filtro, setFiltro] = useState<FiltroEstado>("todos")
  const [menu, setMenu] = useState<Menu>(null)
  const [cargando, setCargando] = useState(true)
  const [cargadoUnaVez, setCargadoUnaVez] = useState(false)

  // La jornada
  const [estado, setEstado] = useState<EstadoJornada>(null)
  const [hayJornada, setHayJornada] = useState(false)
  const [horaInicio, setHoraInicio] = useState<string | null>(null)
  const [horaFin, setHoraFin] = useState<string | null>(null)
  const [observacion, setObservacion] = useState("")
  const [nota, setNota] = useState("")
  const [guardandoNota, setGuardandoNota] = useState(false)

  // Plata y contadores
  const [debido, setDebido] = useState(0)
  const [cobrado, setCobrado] = useState(0)
  const [cont, setCont] = useState({ pagos: 0, noPagos: 0, ventas: 0, gastos: 0, ingresos: 0, retiros: 0 })
  /**
   * LA PLATA DE CADA TARJETA, debajo del contador. Sale de la misma fila de
   * `resumen_diario_v2` que los contadores, así que cuenta lo mismo (gastos,
   * ingresos y retiros: solo los aprobados). Los no pagos no mueven plata:
   * su valor es lo que se dejó de cobrar, la cuota del día de esos clientes.
   */
  const [valores, setValores] = useState({ pagos: 0, noPagos: 0, ventas: 0, gastos: 0, ingresos: 0, retiros: 0 })

  // Las listas
  const [clientesDia, setClientesDia] = useState<ClienteDia[]>([])
  const [movimientos, setMovimientos] = useState<Movimiento[]>([])
  const [gastos, setGastos] = useState<Gasto[]>([])
  const [puntos, setPuntos] = useState<MapPoint[]>([])
  /** El detalle de cada tarjeta, armado con LAS MISMAS reglas del contador. */
  const [filasKpi, setFilasKpi] = useState<Record<KpiId, FilaKpi[]>>({
    pagos: [], noPagos: [], ventas: [], gastos: [], ingresos: [], retiros: [],
  })
  const [detalleKpi, setDetalleKpi] = useState<KpiId | null>(null)

  // Modales y acciones
  const [confirmar, setConfirmar] = useState(false)
  const [finalizando, setFinalizando] = useState(false)
  const [clienteAbierto, setClienteAbierto] = useState<ClienteDia | null>(null)
  const [exportando, setExportando] = useState(false)

  const tabsRef = useRef<HTMLElement | null>(null)

  const ruta = useMemo(() => rutas.find((r) => r.id === rutaId) ?? null, [rutas, rutaId])
  const pc = useMemo(() => paisYCiudad(ruta?.pais ?? null, ruta?.ciudad ?? null), [ruta])
  const moneda = useMemo(
    () => (ruta?.moneda ?? "").trim().toUpperCase() || monedaPorPais(ruta?.pais, ruta?.ciudad) || "",
    [ruta],
  )
  const money = useCallback((v: number) => formatearMoneda(v, moneda), [moneda])
  const nombreRuta = ruta ? tituloRuta(ruta.nombre) : rutaId != null ? `Ruta ${rutaId}` : "Ruta"
  const clientesAsignados = useClientesAsignados(rutaId)

  // Cerrar cualquier menú al tocar afuera.
  useEffect(() => {
    if (!menu) return
    const cerrar = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.("[data-dr-menu]")) setMenu(null)
    }
    document.addEventListener("mousedown", cerrar)
    return () => document.removeEventListener("mousedown", cerrar)
  }, [menu])

  // ── Las rutas que este usuario puede ver, con su gente y su moto ──────────
  useEffect(() => {
    const cargar = async () => {
      const sb = createClient()
      type Base = { id: number; nombre: string; ciudad: string | null; pais: string | null; moneda: string | null }
      let lista: Base[] = []
      if (currentUserId) {
        const { data } = await sb
          .from("usuario_rutas")
          .select("rutas:ruta_id(id, nombre, ciudad, pais, moneda)")
          .eq("usuario_id", currentUserId)
        lista = ((data ?? []) as unknown as { rutas: Base }[]).map((r) => r.rutas).filter(Boolean)
      }
      if (lista.length === 0) {
        const { data } = await sb.from("rutas").select("id, nombre, ciudad, pais, moneda").order("id")
        lista = (data ?? []) as unknown as Base[]
      }
      lista.sort((a, b) => a.id - b.id)
      const ids = lista.map((r) => r.id)

      // La moto y el logo salen de scripts/120 y 032; si no se corrieron,
      // se sigue sin ellos en vez de romper la pantalla.
      const leerConfig = async () => {
        type Cfg = { ruta_id: number; moto_placa?: string | null; moto_foto_url?: string | null; logo_url?: string | null }
        let r = await sb.from("ruta_config_umbrales").select("ruta_id, moto_placa, moto_foto_url, logo_url").in("ruta_id", ids)
        if (r.error) r = await sb.from("ruta_config_umbrales").select("ruta_id, logo_url").in("ruta_id", ids)
        if (r.error) return new Map<number, Cfg>()
        return new Map(((r.data ?? []) as unknown as Cfg[]).map((c) => [c.ruta_id, c]))
      }

      const [resAsign, resUsuarios, cfg] = await Promise.all([
        ids.length ? sb.from("usuario_rutas").select("usuario_id, ruta_id").in("ruta_id", ids) : Promise.resolve({ data: [] }),
        sb.from("usuarios").select("id, nombre, usuario, rol"),
        leerConfig(),
      ])
      const usuarios = new Map(
        ((resUsuarios.data ?? []) as unknown as { id: number; nombre: string | null; usuario: string | null; rol: string | null }[])
          .map((u) => [u.id, u]),
      )
      // EL COBRADOR: el usuario con rol vendedor asignado a la ruta.
      const cobradorPorRuta = new Map<number, { nombre: string | null; usuario: string | null }>()
      for (const a of (resAsign.data ?? []) as unknown as { usuario_id: number; ruta_id: number }[]) {
        if (cobradorPorRuta.has(a.ruta_id)) continue
        const u = usuarios.get(a.usuario_id)
        if ((u?.rol ?? "").toLowerCase() === "vendedor") cobradorPorRuta.set(a.ruta_id, { nombre: u?.nombre ?? null, usuario: u?.usuario ?? null })
      }

      setRutas(lista.map((r) => {
        const c = cfg.get(r.id)
        const cob = cobradorPorRuta.get(r.id)
        return {
          ...r,
          placa: c?.moto_placa ?? null,
          fotoMoto: c?.moto_foto_url ?? null,
          logo: c?.logo_url ?? null,
          cobradorNombre: cob?.nombre ?? null,
          cobradorUsuario: cob?.usuario ?? null,
        }
      }))
      // Sin ruta elegida se abre con la primera: esta pantalla es de UNA
      // unidad, así que no tiene un estado "todas" que mostrar.
      setRutaId((prev) => prev ?? lista[0]?.id ?? null)
    }
    void cargar()
  }, [currentUserId])

  // ── Todo lo de la unidad y el día ──────────────────────────────────────────
  const cargar = useCallback(async () => {
    if (rutaId == null) return
    setCargando(true)
    try {
      const sb = createClient()

      // `observacion` es del script 086; si no corrió, se lee sin ella.
      const leerDia = async () => {
        const q = (cols: string) => sb.from("rutas_diarias").select(cols).eq("ruta_id", rutaId).eq("fecha", fecha).maybeSingle()
        let r = await q("id, estado, hora_inicio, hora_fin, observacion")
        if (r.error && (r.error as { code?: string }).code === "42703") r = await q("id, estado, hora_inicio, hora_fin")
        return r
      }

      const dayStart = `${fecha}T00:00:00-05:00`
      const dayEnd = `${fecha}T23:59:59-05:00`
      const [resResumen, resDia, resPlan, resGest, resGastos, resVentas] = await Promise.all([
        getResumenDia(sb, rutaId, fecha),
        leerDia(),
        // CLIENTES: sale del CRONOGRAMA, no de los pagos. La pregunta es "a
        // quién había que cobrarle", así que los que NO pagaron aparecen.
        sb.from("payment_plan")
          .select("loan_id, valor_cuota, loans!inner(ruta, estado, ordenvisita, clients(nombre_completo, apodo, direccion, sector, telefono))")
          .eq("fecha_pago", fecha)
          .eq("loans.ruta", rutaId)
          .neq("loans.estado", "anulado"),
        sb.from("gestiones")
          .select("id, loan_id, tipo, monto, fecha_hora, latitud, longitud, metodo_pago, observacion, detalle, loans:loans(clients:clients(nombre_completo, apodo))")
          .eq("ruta", rutaId)
          .eq("fecha_gestion", fecha)
          .eq("estado", "aplicada")
          .neq("origen", "homologacion")
          .order("fecha_hora", { ascending: true }),
        sb.from("gastosregistros")
          .select("id, tipo, concepto, valor, fechahorasol, estadosecre, estadoadmin")
          .eq("ruta", rutaId)
          .gte("fechahorasol", dayStart)
          .lte("fechahorasol", dayEnd)
          .in("tipo", ["Gasto", "Ingreso", "Retiro"])
          .order("fechahorasol", { ascending: true }),
        // VENTAS: los préstamos creados ese día en la ruta, igual que
        // `cantidad_ventas` del resumen (incluye homologadas).
        sb.from("loans")
          .select("id, valor, origen, estado, fecha_creacion, clients(nombre_completo, apodo)")
          .eq("ruta", rutaId)
          .gte("fecha_creacion", dayStart)
          .lte("fecha_creacion", dayEnd)
          .order("fecha_creacion", { ascending: true }),
      ])

      const dia = (resDia.data ?? null) as unknown as
        { id?: unknown; estado?: string; hora_inicio?: string | null; hora_fin?: string | null; observacion?: string | null } | null
      setHayJornada(!!dia)
      setEstado(dia?.estado === "abierta" || dia?.estado === "cerrada" ? dia.estado : null)
      setHoraInicio(dia?.hora_inicio ?? null)
      setHoraFin(dia?.hora_fin ?? null)
      setObservacion(dia?.observacion ?? "")
      setNota(dia?.observacion ?? "")

      const f = (resResumen.fila ?? {}) as unknown as Record<string, unknown>
      const n = (v: unknown) => Number(v) || 0
      setDebido(n(f.meta_pagos))
      setCobrado(n(f.valor_pago))
      setCont({
        pagos: n(f.cantidad_pagos), noPagos: n(f.cantidad_no_pagos), ventas: n(f.cantidad_ventas),
        gastos: n(f.cantidad_gastos), ingresos: n(f.cantidad_ingresos), retiros: n(f.cantidad_retiros),
      })
      const valoresDia = {
        pagos: n(f.valor_pago), noPagos: 0, ventas: n(f.valor_ventas),
        gastos: n(f.valor_gastos), ingresos: n(f.valor_ingresos), retiros: n(f.valor_retiros),
      }

      const pagado = new Map<string, number>()
      const visitado = new Set<string>()
      const movs: Movimiento[] = []
      const pts: MapPoint[] = []
      for (const g of (resGest.data ?? []) as unknown as {
        id: string; loan_id: string; tipo: string; monto: number | null; fecha_hora: string
        latitud: number | null; longitud: number | null
        detalle?: Record<string, unknown> | null
        loans?: { clients?: { nombre_completo?: string | null } | null } | null
      }[]) {
        const m = montoEfectivo(g as never)
        const cliente = g.loans?.clients?.nombre_completo ?? "—"
        // UNA RENOVACIÓN (scripts/123) es un `ajuste` de monto 0 en el libro,
        // pero es plata que SALIÓ de la caja: se muestra como tal.
        if (g.tipo === "ajuste" && g.detalle?.clase === "renovacion") {
          const entregado = Number(g.detalle.valor_entregado) || 0
          movs.push({
            id: `g-${g.id}`, ts: g.fecha_hora, hora: hhmm(g.fecha_hora) || "—",
            titulo: cliente, detalle: "Renovación", monto: entregado, tono: "bad",
          })
          continue
        }
        if (g.loan_id) {
          visitado.add(g.loan_id)
          if (m !== 0) pagado.set(g.loan_id, (pagado.get(g.loan_id) ?? 0) + m)
        }
        movs.push({
          id: `g-${g.id}`, ts: g.fecha_hora, hora: hhmm(g.fecha_hora) || "—",
          titulo: cliente, detalle: TIPO_GESTION[g.tipo] ?? g.tipo,
          monto: m, tono: m > 0 ? "ok" : m < 0 ? "bad" : "muted",
        })
        // EL RECORRIDO SALE DE DONDE SE REGISTRÓ CADA GESTIÓN, no de la
        // dirección del cliente. Sin coordenadas no se pinta punto.
        if (g.latitud != null && g.longitud != null) {
          pts.push({
            id: g.id, lat: Number(g.latitud), lng: Number(g.longitud),
            estado: m > 0 ? "pagado" : "no_pago", cliente, monto: m,
            hora: hhmm(g.fecha_hora) || "—", orden: pts.length + 1,
          })
        }
      }

      const caja = ((resGastos.data ?? []) as unknown as { id: number; tipo: string; concepto: string; valor: number; fechahorasol: string }[])
      for (const g of caja) {
        movs.push({
          id: `x-${g.id}`, ts: g.fechahorasol, hora: hhmm(g.fechahorasol) || "—",
          titulo: g.concepto, detalle: g.tipo, monto: Number(g.valor) || 0,
          tono: g.tipo === "Ingreso" ? "ok" : "bad",
        })
      }
      movs.sort((a, b) => a.ts.localeCompare(b.ts))
      setMovimientos(movs)

      // ── EL DETALLE DE LAS SEIS TARJETAS ────────────────────────────────
      // Cada lista sigue la regla exacta de su contador en
      // `resumen_diario_v2` (scripts 112/114), para que "Pagos 20" abra
      // veinte filas y no otra cosa.
      //
      // PAGOS y NO PAGOS cuentan CLIENTES, no visitas: se agrupa por
      // préstamo. Neto = pago + cancelación + abono a venta − reversas.
      // Pagó si el neto es > 0; no pagó si el neto es ≤ 0 y hubo un no_pago.
      type Gx = {
        id: string; loan_id: string; tipo: string; monto: number | null; fecha_hora: string
        metodo_pago?: string | null; observacion?: string | null
        loans?: { clients?: { nombre_completo?: string | null; apodo?: string | null } | null } | null
      }
      const porLoan = new Map<string, { g: Gx[]; neto: number; noPago: boolean; ultima: string }>()
      for (const g of (resGest.data ?? []) as unknown as Gx[]) {
        if (!g.loan_id || !["pago", "no_pago", "cancelacion", "abono_venta", "reversa"].includes(g.tipo)) continue
        const e = porLoan.get(g.loan_id) ?? { g: [], neto: 0, noPago: false, ultima: g.fecha_hora }
        const monto = Number(g.monto) || 0
        if (g.tipo === "reversa") e.neto -= monto
        else if (g.tipo !== "no_pago") e.neto += monto
        if (g.tipo === "no_pago") e.noPago = true
        if (g.fecha_hora > e.ultima) e.ultima = g.fecha_hora
        e.g.push(g)
        porLoan.set(g.loan_id, e)
      }
      const cliente = (g: Gx) => g.loans?.clients?.nombre_completo ?? "—"
      const apodo = (g: Gx) => apodoSiAporta(g.loans?.clients?.nombre_completo, g.loans?.clients?.apodo)
      const METODO: Record<string, string> = { efectivo: "Efectivo", transferencia: "Transferencia" }
      const fPagos: FilaKpi[] = []
      const fNoPagos: FilaKpi[] = []
      for (const [loanId, e] of porLoan) {
        const g0 = e.g[0]
        const base = { id: loanId, ts: e.ultima, hora: hhmm(e.ultima) || "—", titulo: cliente(g0), sub: apodo(g0) }
        if (e.neto > 0) {
          const tipos = [...new Set(e.g.filter((g) => g.tipo !== "no_pago").map((g) => TIPO_GESTION[g.tipo] ?? g.tipo))]
          const metodos = [...new Set(e.g.map((g) => METODO[(g.metodo_pago ?? "").toLowerCase()] ?? g.metodo_pago).filter(Boolean))]
          fPagos.push({ ...base, detalle: [tipos.join(", "), metodos.join(", ")].filter(Boolean).join(" · "), monto: e.neto })
        } else if (e.noPago) {
          const motivo = e.g.find((g) => g.tipo === "no_pago" && g.observacion)?.observacion
          fNoPagos.push({ ...base, detalle: motivo || "Sin motivo registrado", monto: null })
        }
      }

      // GASTOS, INGRESOS y RETIROS: solo los que el resumen cuenta, o sea
      // los aprobados por secretaría o los que no necesitaban aprobación.
      type Cx = { id: number; tipo: string; concepto: string; valor: number; fechahorasol: string; estadosecre?: string | null; estadoadmin?: string | null }
      const cajaCuenta = ((resGastos.data ?? []) as unknown as Cx[])
        .filter((g) => g.estadosecre === "aprobado" || g.estadoadmin === "NA")
      const filaCaja = (g: Cx): FilaKpi => ({
        id: String(g.id), ts: g.fechahorasol, hora: hhmm(g.fechahorasol) || "—",
        titulo: g.concepto || g.tipo, sub: null,
        detalle: g.estadosecre === "aprobado" ? "Aprobado" : "Sin aprobación requerida",
        monto: Number(g.valor) || 0,
      })

      type Vx = { id: string; valor: number | null; origen: string | null; estado: string | null; fecha_creacion: string; clients?: { nombre_completo?: string | null; apodo?: string | null } | null }
      const fVentas: FilaKpi[] = ((resVentas.data ?? []) as unknown as Vx[]).map((v) => ({
        id: v.id, ts: v.fecha_creacion, hora: hhmm(v.fecha_creacion) || "—",
        titulo: v.clients?.nombre_completo ?? "—",
        sub: apodoSiAporta(v.clients?.nombre_completo, v.clients?.apodo),
        detalle: [
          (v.origen ?? "normal") === "homologado" ? "Homologada" : "Venta nueva",
          (v.estado ?? "") === "anulado" ? "Anulada" : null,
        ].filter(Boolean).join(" · "),
        monto: Number(v.valor) || 0,
      }))
      // Las RENOVACIONES también son ventas: el resumen del día las cuenta
      // así desde el script 123, y la lista tiene que dar el mismo número que
      // la tarjeta.
      type Rx = { id: string; fecha_hora: string; tipo: string; detalle?: Record<string, unknown> | null } & Gx
      for (const g of (resGest.data ?? []) as unknown as Rx[]) {
        if (g.tipo !== "ajuste" || g.detalle?.clase !== "renovacion") continue
        fVentas.push({
          id: `r-${g.id}`, ts: g.fecha_hora, hora: hhmm(g.fecha_hora) || "—",
          titulo: cliente(g), sub: apodo(g),
          detalle: `Renovación · ${Number(g.detalle.cuotas_nuevas) || 0} cuotas`,
          monto: Number(g.detalle.valor_entregado) || 0,
        })
      }

      const porHora = (a: FilaKpi, b: FilaKpi) => a.ts.localeCompare(b.ts)
      setFilasKpi({
        pagos: fPagos.sort(porHora),
        noPagos: fNoPagos.sort(porHora),
        ventas: fVentas.sort(porHora),
        gastos: cajaCuenta.filter((g) => g.tipo === "Gasto").map(filaCaja),
        ingresos: cajaCuenta.filter((g) => g.tipo === "Ingreso").map(filaCaja),
        retiros: cajaCuenta.filter((g) => g.tipo === "Retiro").map(filaCaja),
      })
      setPuntos(pts)
      setGastos(caja.filter((g) => g.tipo === "Gasto").map((g) => ({
        id: g.id, hora: hhmm(g.fechahorasol) || "—", concepto: g.concepto, valor: Number(g.valor) || 0,
      })))

      const plan = (resPlan.data ?? []) as unknown as {
        loan_id: string; valor_cuota: number | null
        loans?: {
          ordenvisita?: number | null
          clients?: { nombre_completo?: string | null; apodo?: string | null; direccion?: string | null; sector?: string | null; telefono?: string | null } | null
        } | null
      }[]

      // LA MORA sale del estado derivado (`v_loan_financiero`), nunca de
      // `payment_plan.estado`. Es la mora de HOY: la vista no se puede pedir
      // "a tal fecha", así que en un día pasado muestra la situación actual.
      // Lo que se dejó de cobrar: la cuota del día de cada cliente que no pagó.
      const cuotaDelDia = new Map(plan.map((p) => [p.loan_id, Number(p.valor_cuota) || 0]))
      valoresDia.noPagos = fNoPagos.reduce((t, fila) => t + (cuotaDelDia.get(fila.id) ?? 0), 0)
      setValores(valoresDia)

      const loanIds = [...new Set(plan.map((p) => p.loan_id))]
      const mora = new Map<string, { cuotas: number; saldo: number }>()
      if (loanIds.length) {
        const { data: fin, error: errFin } = await sb
          .from("v_loan_financiero").select("loan_id, cuotas_mora, saldo_en_mora").in("loan_id", loanIds)
        if (errFin) console.error("[v0] Detalle de ruta, mora:", errFin.message)
        for (const f of (fin ?? []) as unknown as { loan_id: string; cuotas_mora: number | null; saldo_en_mora: number | null }[]) {
          mora.set(f.loan_id, { cuotas: Number(f.cuotas_mora) || 0, saldo: Number(f.saldo_en_mora) || 0 })
        }
      }

      setClientesDia(
        plan
          .map((p) => ({
            loanId: p.loan_id,
            nombre: p.loans?.clients?.nombre_completo ?? "—",
            apodo: apodoSiAporta(p.loans?.clients?.nombre_completo, p.loans?.clients?.apodo),
            orden: p.loans?.ordenvisita ?? null,
            cuotasMora: mora.get(p.loan_id)?.cuotas ?? 0,
            saldoMora: mora.get(p.loan_id)?.saldo ?? 0,
            direccion: p.loans?.clients?.direccion ?? "",
            zona: p.loans?.clients?.sector ?? "",
            telefono: p.loans?.clients?.telefono ?? "",
            cuota: Number(p.valor_cuota) || 0,
            pagado: Math.max(0, pagado.get(p.loan_id) ?? 0),
            estado: (pagado.get(p.loan_id) ?? 0) > 0
              ? ("pago" as const)
              : visitado.has(p.loan_id) ? ("no_pago" as const) : ("pendiente" as const),
          }))
          // EL ORDEN DE LA RUTA, el mismo que ve el cobrador en la calle
          // (Ordenar Ruta). Los que no tienen número van al final, por nombre.
          .sort((a, b) =>
            (a.orden ?? Number.MAX_SAFE_INTEGER) - (b.orden ?? Number.MAX_SAFE_INTEGER) ||
            a.nombre.localeCompare(b.nombre)),
      )
    } catch (err) {
      console.error("[v0] Detalle de ruta:", err)
    } finally {
      setCargando(false)
      setCargadoUnaVez(true)
    }
  }, [rutaId, fecha])

  useEffect(() => { void cargar() }, [cargar])

  // ── Derivados ──────────────────────────────────────────────────────────────
  const pct = debido > 0 ? Math.round((cobrado / debido) * 100) : 0

  /** La zona de la ruta no existe como dato: se arma con los sectores de los
   *  clientes del día (los dos más frecuentes). */
  const zona = useMemo(() => {
    const cuenta = new Map<string, number>()
    for (const c of clientesDia) if (c.zona) cuenta.set(c.zona, (cuenta.get(c.zona) ?? 0) + 1)
    const top = [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([z]) => capitalizar(z))
    return top.length ? top.join(" · ") : "—"
  }, [clientesDia])

  const qCliente = busquedaCliente.trim().toLowerCase()
  const clientesFiltrados = useMemo(
    () => clientesDia.filter((c) =>
      (filtro === "todos" || c.estado === filtro) &&
      (!qCliente || `${c.nombre} ${c.apodo ?? ""} ${c.direccion} ${c.zona}`.toLowerCase().includes(qCliente)),
    ),
    [clientesDia, qCliente, filtro],
  )

  const qRuta = busquedaRuta.trim().toLowerCase()
  const rutasFiltradas = useMemo(
    () => rutas.filter((r) => !qRuta ||
      `${tituloRuta(r.nombre)} ${r.placa ?? ""} ${r.cobradorNombre ?? ""} ${r.cobradorUsuario ?? ""} ${r.pais ?? ""} ${r.ciudad ?? ""}`
        .toLowerCase().includes(qRuta)),
    [rutas, qRuta],
  )

  const kpis: { id: KpiId; label: string; valor: number; monto: number; color: string }[] = [
    { id: "pagos", label: "Pagos", valor: cont.pagos, monto: valores.pagos, color: "var(--dr-success)" },
    { id: "noPagos", label: "No pagos", valor: cont.noPagos, monto: valores.noPagos, color: "var(--dr-danger)" },
    { id: "ventas", label: "Ventas", valor: cont.ventas, monto: valores.ventas, color: "var(--dr-primary)" },
    { id: "gastos", label: "Gastos", valor: cont.gastos, monto: valores.gastos, color: "var(--dr-danger)" },
    { id: "ingresos", label: "Ingresos", valor: cont.ingresos, monto: valores.ingresos, color: "var(--dr-teal)" },
    { id: "retiros", label: "Retiros", valor: cont.retiros, monto: valores.retiros, color: "var(--dr-purple)" },
  ]
  const kpiSel = kpis.find((k) => k.id === detalleKpi) ?? null
  const filasSel = detalleKpi ? filasKpi[detalleKpi] : []
  const totalSel = filasSel.reduce((t, f) => t + (f.monto ?? 0), 0)

  const cerrada = estado === "cerrada"
  const estadoPill = estado === "abierta"
    ? { variant: "success" as const, label: "Abierta" }
    : cerrada ? { variant: "neutral" as const, label: "Finalizada" }
      : { variant: "neutral" as const, label: "Sin iniciar" }

  // ── Acciones ───────────────────────────────────────────────────────────────
  const elegirRuta = (id: number) => {
    setRutaId(id)
    setBusquedaRuta("")
    setMenu(null)
  }

  /** Tocar una tarjeta abre su detalle abajo; tocarla otra vez lo cierra. */
  const abrirKpi = (id: KpiId) => {
    const abrir = detalleKpi !== id
    setDetalleKpi(abrir ? id : null)
    if (abrir) tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const irAlMapa = () => {
    setDetalleKpi(null)
    setPestana("mapa")
    tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  /** Finalizar la jornada: el mismo UPDATE que hace el Cierre de Caja. */
  const finalizar = async () => {
    if (rutaId == null || finalizando) return
    setFinalizando(true)
    try {
      const sb = createClient()
      const ahora = new Date().toISOString()
      const cerrar = (campos: Record<string, unknown>) =>
        sb.from("rutas_diarias").update(campos)
          .eq("ruta_id", rutaId).eq("fecha", fecha).eq("estado", "abierta").select("id")
      const quien = currentUserNombre ? ` por ${currentUserNombre}` : ""
      const marca = `Finalizada desde Detalle de Ruta${quien} (${hhmm(ahora)}).`
      let { data, error } = await cerrar({
        estado: "cerrada", hora_fin: ahora,
        observacion: observacion ? `${observacion} · ${marca}` : marca,
      })
      // 42703 = la columna no existe (script 086 sin correr): se cierra igual.
      if (error && (error as { code?: string }).code === "42703") {
        ;({ data, error } = await cerrar({ estado: "cerrada", hora_fin: ahora }))
      }
      if (error) {
        console.error("[v0] Finalizar ruta:", error.message)
        toast({ title: "No se pudo finalizar la ruta", description: error.message, variant: "destructive" })
        return
      }
      if ((data ?? []).length === 0) {
        console.warn("[v0] La jornada", fecha, "de la ruta", rutaId, "ya estaba cerrada")
      }
      setConfirmar(false)
      toast({ title: `${nombreRuta} finalizada`, description: `Jornada del ${fechaLarga(fecha)} cerrada.` })
      await cargar()
    } catch (err) {
      console.error("[v0] Finalizar ruta:", err)
      toast({ title: "No se pudo finalizar la ruta", variant: "destructive" })
    } finally {
      setFinalizando(false)
    }
  }

  /** Las notas viven en `rutas_diarias.observacion`: el texto libre del día. */
  const guardarNota = async () => {
    if (rutaId == null || !hayJornada || guardandoNota) return
    setGuardandoNota(true)
    try {
      const { error } = await createClient()
        .from("rutas_diarias").update({ observacion: nota.trim() || null })
        .eq("ruta_id", rutaId).eq("fecha", fecha)
      if (error) throw new Error(error.message)
      setObservacion(nota.trim())
      toast({ title: "Nota guardada" })
    } catch (err) {
      console.error("[v0] Guardar nota de ruta:", err)
      toast({ title: "No se pudo guardar la nota", variant: "destructive" })
    } finally {
      setGuardandoNota(false)
    }
  }

  /** El informe Excel de ese día para esa ruta, el mismo de Descargar Informe. */
  const exportar = async () => {
    if (rutaId == null || exportando) return
    setExportando(true)
    setMenu(null)
    try {
      const { blob, nombre } = await generarInformeExcel({ desde: fecha, hasta: fecha, rutaIds: [rutaId] })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = nombre
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: "Informe descargado", description: nombre })
    } catch (err) {
      console.error("[v0] Exportar detalle de ruta:", err)
      toast({ title: "No se pudo exportar", variant: "destructive" })
    } finally {
      setExportando(false)
    }
  }

  // ── Piezas repetidas ───────────────────────────────────────────────────────
  const menuRutas = (
    <div className="dr-menu dr-menu--wide" data-dr-menu role="listbox">
      {rutasFiltradas.length === 0
        ? <div className="dr-menu-empty">Sin rutas para “{busquedaRuta}”</div>
        : rutasFiltradas.map((r) => (
          <button
            key={r.id} type="button" role="option" aria-selected={r.id === rutaId}
            className={`dr-menu-item${r.id === rutaId ? " dr-menu-item--on" : ""}`}
            onClick={() => elegirRuta(r.id)}
          >
            <Bandera moneda={(r.moneda ?? "").trim().toUpperCase() || monedaPorPais(r.pais, r.ciudad)} pais={paisYCiudad(r.pais, r.ciudad).pais} size={20} />
            <span className="dr-menu-item-text">
              <b>{tituloRuta(r.nombre)}</b>
              <span className="dr-ellipsis">
                {[r.cobradorNombre, r.placa ? `Patente ${r.placa}` : null, paisYCiudad(r.pais, r.ciudad).pais].filter(Boolean).join(" · ") || "—"}
              </span>
            </span>
            {r.id === rutaId && <Check {...IC} size={16} />}
          </button>
        ))}
    </div>
  )

  const menuFiltros = (
    <div className="dr-menu dr-menu--right" data-dr-menu role="menu">
      {FILTROS.map((f) => (
        <button
          key={f.id} type="button" role="menuitemradio" aria-checked={filtro === f.id}
          className={`dr-menu-item${filtro === f.id ? " dr-menu-item--on" : ""}`}
          onClick={() => { setFiltro(f.id); setMenu(null); setPestana("clientes") }}
        >
          <span className="dr-menu-item-text">{f.label}</span>
          {filtro === f.id && <Check {...IC} size={16} />}
        </button>
      ))}
    </div>
  )

  const filtroActivo = filtro !== "todos"

  return (
    <div className="dr-root">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="dr-header">
        <div className="dr-frame dr-header-in">
          <button type="button" className="dr-ghost dr-ghost--text dr-icon-btn" onClick={onVolver} aria-label="Volver">
            <ChevronLeft {...IC} size={24} />
          </button>
          <div className="dr-brand">
            <div className="dr-logo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={ruta?.logo || "/opad-logo.png"} alt="OPAD" />
            </div>
            <div className="dr-brand-text">
              <div className="dr-brand-name">OPAD</div>
              <div className="dr-brand-sub">Sistema de Gestión de Cartera</div>
            </div>
          </div>
          <div className="dr-vdivider" />
          <div className="dr-title">
            <h1 className="dr-h">Detalle de Ruta</h1>
            <p>Información y seguimiento</p>
          </div>
          <div className="dr-btn dr-datepill"><Calendar {...IC} />{fechaCorta(fecha)}</div>
          <div className="dr-anchor" data-dr-menu>
            <button type="button" className="dr-ghost dr-ghost--text dr-icon-btn" aria-label="Más" onClick={() => setMenu(menu === "mas" ? null : "mas")}>
              <MoreVertical {...IC} />
            </button>
            {menu === "mas" && (
              <div className="dr-menu dr-menu--right" role="menu">
                <button type="button" className="dr-menu-item" onClick={() => { setMenu(null); void cargar() }}>
                  <RefreshCw {...IC} size={18} /><span className="dr-menu-item-text">Actualizar</span>
                </button>
                <button type="button" className="dr-menu-item" onClick={() => void exportar()} disabled={exportando}>
                  <FileText {...IC} size={18} /><span className="dr-menu-item-text">Exportar informe del día</span>
                </button>
                <button type="button" className="dr-menu-item" onClick={() => { setMenu(null); onNavegar?.("resumen-rutas") }}>
                  <ClipboardList {...IC} size={18} /><span className="dr-menu-item-text">Resumen de todas las rutas</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={`dr-frame dr-main${cargando && cargadoUnaVez ? " dr-busy" : ""}`} aria-busy={cargando}>
        {/* ── Filtros ───────────────────────────────────────────────────── */}
        <div className="dr-filters">
          <label className="dr-btn dr-btn--white dr-datebtn">
            <Calendar {...IC} />
            <span className="dr-datebtn-text">
              <span className="dr-kicker">Fecha</span>
              <span className="dr-datebtn-val">{fechaCorta(fecha)}</span>
            </span>
            <ChevronDown {...IC} size={16} />
            <input
              type="date" value={fecha} max={todayColombia()} aria-label="Fecha"
              className="dr-date-hidden"
              onChange={(e) => { if (e.target.value) setFecha(e.target.value) }}
            />
          </label>
          <div className="dr-search dr-anchor" data-dr-menu>
            <Search {...IC} />
            <input
              className="dr-input" placeholder="Buscar ruta, unidad o cobrador…"
              value={busquedaRuta}
              onFocus={() => setMenu("rutas-buscar")}
              onChange={(e) => { setBusquedaRuta(e.target.value); setMenu("rutas-buscar") }}
            />
            {menu === "rutas-buscar" && menuRutas}
          </div>
          <div className="dr-anchor" data-dr-menu>
            <button
              type="button"
              className={`dr-btn dr-btn--white${filtroActivo ? " dr-sqbtn--on" : ""}`}
              style={{ fontWeight: 600 }}
              onClick={() => setMenu(menu === "filtros" ? null : "filtros")}
            >
              <SlidersHorizontal {...IC} />Filtros<ChevronDown {...IC} size={16} />
            </button>
            {menu === "filtros" && menuFiltros}
          </div>
        </div>

        {!cargadoUnaVez ? (
          <div className="dr-card dr-loading">Cargando la ruta…</div>
        ) : (
          <>
            {/* ── Tarjeta de ruta ─────────────────────────────────────────── */}
            <section className="dr-card dr-hero">
              {ruta?.fotoMoto ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={ruta.fotoMoto} alt={`Moto de ${nombreRuta}`} className="dr-hero-photo"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
                />
              ) : (
                <div className="dr-hero-photo"><Bike {...IC} size={40} /></div>
              )}
              <div className="dr-hero-center">
                <div className="dr-hero-titlerow">
                  <h2 className="dr-h">{nombreRuta}</h2>
                  <div className="dr-anchor" data-dr-menu>
                    <button
                      type="button" className="dr-ghost dr-icon-btn" aria-label="Cambiar de ruta"
                      style={{ color: "var(--dr-p800)" }}
                      onClick={() => setMenu(menu === "rutas-titulo" ? null : "rutas-titulo")}
                    >
                      <ChevronDown {...IC} />
                    </button>
                    {menu === "rutas-titulo" && menuRutas}
                  </div>
                  <Pill variant={estadoPill.variant} label={estadoPill.label} />
                </div>
                <div className="dr-hero-line">
                  <Bandera moneda={moneda} pais={pc.pais} size={18} />
                  <b className="dr-nowrap">{pc.pais || "—"}</b>
                  {pc.ciudad && <span className="dr-muted dr-ellipsis">· {pc.ciudad}</span>}
                </div>
                <div className="dr-hero-line"><MapPin {...IC} /><span className="dr-ellipsis">{zona}</span></div>
                <div className="dr-hero-line"><Calendar {...IC} /><span className="dr-nowrap">{fechaLarga(fecha)}</span></div>
              </div>
              <div className="dr-hero-right">
                <div className="dr-box dr-hero-stat">
                  <Users {...IC} size={24} />
                  <div>
                    {/* CLIENTES ASIGNADOS = los que tienen préstamo ACTIVO en la
                        ruta, contados en el momento (lib/use-clientes-asignados).
                        Antes contaba TODAS las fichas de la ruta, incluidas las
                        de clientes que ya terminaron de pagar: la 151 decía 48
                        con 27 activos. */}
                    <div className="dr-hero-stat-num">{clientesAsignados ?? "—"}</div>
                    <div className="dr-hero-stat-lbl">Clientes asignados</div>
                  </div>
                </div>
                <div className="dr-box dr-hero-stat">
                  <Clock {...IC} size={24} />
                  {/* LA HORA ES LA REAL: cuando el cobrador tocó Iniciar y Cerrar. */}
                  <div className="dr-hero-hours">
                    <b>Inicio: {horaInicio ? hhmm(horaInicio) : "—"}</b>
                    <span>
                      {horaFin ? `Finalizada: ${hhmm(horaFin)}`
                        : estado === "abierta" ? "Fin estimado: en curso"
                          : "Fin estimado: —"}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Personal ────────────────────────────────────────────────── */}
            <div className="dr-people">
              <PersonCard icon={Bike} kicker="Unidad / Moto" title={ruta?.nombre ? `Moto ${numeroRuta(ruta.nombre)}` : "Moto"}>
                <span>
                  {ruta?.placa
                    ? <Pill variant="success" label="Activa" sm />
                    : <Pill variant="neutral" label="Sin moto" sm />}
                </span>
                <span className="dr-person-line dr-person-line--muted">Patente: {ruta?.placa ?? "—"}</span>
              </PersonCard>
              <PersonCard icon={User} kicker="Cobrador" title={ruta?.cobradorNombre ?? "Sin asignar"}>
                {/* El usuario de login es un correo largo: va entero en el title. */}
                <span className="dr-person-line" title={ruta?.cobradorUsuario ?? undefined}>{ruta?.cobradorNombre ? "Vendedor" : "—"}</span>
                {/* TODO: `usuarios` no tiene teléfono todavía. */}
                <span className="dr-person-phone"><Phone {...IC} size={12} />—</span>
              </PersonCard>
              {/* TODO: no existe el rol tarjetero en el sistema. */}
              <PersonCard icon={Smartphone} kicker="Tarjetero" title="Sin asignar">
                <span className="dr-person-line dr-person-line--muted">—</span>
              </PersonCard>
              {/* TODO: no existe el rol supervisor en el sistema. Las cuatro
                  tarjetas van sin acceso directo por ahora. */}
              <PersonCard icon={UserCheck} kicker="Supervisor" title="Sin asignar">
                <span className="dr-person-line dr-person-line--muted">—</span>
              </PersonCard>
            </div>

            {/* ── Resumen de la ruta ──────────────────────────────────────── */}
            <section className="dr-card dr-summary">
              <div className="dr-summary-head">
                <span className="dr-summary-icon"><DollarSign {...IC} /></span>
                <h3 className="dr-h dr-ellipsis">Resumen de la ruta{moneda ? ` (${moneda})` : ""}</h3>
                <button type="button" className="dr-ghost" style={{ fontSize: 13, fontWeight: 600 }} onClick={() => onNavegar?.("resumen-rutas")}>
                  Ver más detalles<ChevronRight {...IC} size={16} />
                </button>
              </div>
              <div className="dr-metrics">
                <Metric label="Debido cobrar"><div className="dr-metric-val dr-metric-val--due">{money(debido)}</div></Metric>
                <Metric label="Cobrado"><div className="dr-metric-val dr-metric-val--ok">{money(cobrado)}</div></Metric>
                <Metric label="Avance" full>
                  <div className="dr-progress-row">
                    <span className="dr-metric-val">{pct}%</span>
                    <span className="dr-progress-track">
                      <span className="dr-progress-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
                    </span>
                  </div>
                </Metric>
              </div>
              <div className="dr-kpis">
                {kpis.map((k) => (
                  <button
                    key={k.id} type="button" aria-pressed={detalleKpi === k.id}
                    className={`dr-box dr-kpi dr-kpi--btn${detalleKpi === k.id ? " dr-kpi--on" : ""}`}
                    style={{ ["--kc" as string]: k.color }}
                    onClick={() => abrirKpi(k.id)}
                  >
                    <div className="dr-kpi-lbl"><span className="dr-kpi-dot" style={{ background: k.color }} />{k.label}</div>
                    <div className="dr-kpi-val" style={{ color: k.color }}>{k.valor}</div>
                    <div className="dr-kpi-monto" title={money(k.monto)}>{money(k.monto)}</div>
                  </button>
                ))}
              </div>
            </section>

            {/* ── Pestañas ────────────────────────────────────────────────── */}
            <section className="dr-card dr-tabs-card" ref={tabsRef}>
              <div className="dr-tabs" role="tablist">
                {TABS.map((t) => (
                  <button
                    key={t.id} type="button" role="tab" aria-selected={!detalleKpi && pestana === t.id}
                    className={`dr-tab${!detalleKpi && pestana === t.id ? " dr-tab--active" : ""}`}
                    onClick={() => { setDetalleKpi(null); setPestana(t.id) }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {kpiSel && (
                <div className="dr-tab-panel">
                  <div className="dr-tab-head">
                    <span className="dr-kpi-dot" style={{ background: kpiSel.color, width: 12, height: 12 }} />
                    <h3 className="dr-h">{kpiSel.label} del día ({filasSel.length})</h3>
                    <button type="button" className="dr-btn" onClick={() => setDetalleKpi(null)}>
                      <X {...IC} size={16} />Cerrar
                    </button>
                  </div>
                  <div className="dr-box dr-table">
                    <div className="dr-krow dr-thead">
                      <span>#</span><span>Hora</span>
                      <span>{["gastos", "ingresos", "retiros"].includes(kpiSel.id) ? "Concepto" : "Cliente"}</span>
                      <span>{kpiSel.id === "noPagos" ? "Motivo" : "Detalle"}</span>
                      <span className="dr-right">{kpiSel.id === "noPagos" ? "" : "Monto"}</span>
                    </div>
                    {filasSel.map((f, i) => (
                      <div key={f.id} className="dr-krow dr-trow--body">
                        <span className="dr-muted">{i + 1}</span>
                        <span className="dr-nowrap">{f.hora}</span>
                        <span className="dr-td-name" title={f.sub ? `${f.titulo} · ${f.sub}` : f.titulo}>
                          {f.titulo}
                          {f.sub && <small className="dr-td-apodo">{f.sub}</small>}
                        </span>
                        <span className="dr-td-detalle" title={f.detalle}>{f.detalle}</span>
                        <span className="dr-right dr-nowrap" style={{ color: kpiSel.color }}>
                          {f.monto == null ? "" : money(f.monto)}
                        </span>
                      </div>
                    ))}
                    {filasSel.length === 0 && (
                      <div className="dr-empty">Sin {kpiSel.label.toLowerCase()} registrados ese día.</div>
                    )}
                    {filasSel.length > 0 && kpiSel.id !== "noPagos" && (
                      <div className="dr-krow dr-ktotal">
                        <span /><span /><span>Total</span><span />
                        <span className="dr-right dr-nowrap" style={{ color: kpiSel.color }}>{money(totalSel)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!detalleKpi && pestana === "clientes" && (
                <div className="dr-tab-panel">
                  <div className="dr-tab-head">
                    <h3 className="dr-h">Clientes de la ruta ({clientesFiltrados.length})</h3>
                    <label className="dr-search dr-search--sm">
                      <Search {...IC} size={16} />
                      <input
                        className="dr-input dr-input--sm" placeholder="Buscar cliente…"
                        value={busquedaCliente} onChange={(e) => setBusquedaCliente(e.target.value)}
                      />
                    </label>
                    <div className="dr-anchor" data-dr-menu>
                      <button
                        type="button" aria-label="Filtrar"
                        className={`dr-btn dr-sqbtn${filtroActivo ? " dr-sqbtn--on" : ""}`}
                        onClick={() => setMenu(menu === "filtros-tabla" ? null : "filtros-tabla")}
                      >
                        <Filter {...IC} size={18} />
                      </button>
                      {menu === "filtros-tabla" && menuFiltros}
                    </div>
                  </div>
                  <div className="dr-table-scroll">
                    <div className="dr-box dr-table">
                      <div className="dr-trow dr-thead">
                        <span>#</span><span>Cliente</span><span>Mora</span><span>Cuota</span><span>Pagado</span><span>Estado</span><span className="dr-td-actions">Acciones</span>
                      </div>
                      {clientesFiltrados.map((c, i) => (
                        <div key={c.loanId} className="dr-trow dr-trow--body" onClick={() => setClienteAbierto(c)}>
                          {/* El número es el de la ruta, no la posición en la lista:
                              con un filtro puesto sigue diciendo cuál es en la ruta. */}
                          <span className="dr-muted">{c.orden ?? i + 1}</span>
                          <span className="dr-td-name" title={c.apodo ? `${c.nombre} · ${c.apodo}` : c.nombre}>
                            {c.nombre}
                            {c.apodo && <small className="dr-td-apodo">{c.apodo}</small>}
                          </span>
                          <span className={`dr-td-mora dr-td-mora--${c.cuotasMora > 0 ? colorMora(c.cuotasMora) : "ok"}`}>
                            {c.cuotasMora > 0 ? etiquetaMora(c.cuotasMora) : "Al día"}
                            {c.saldoMora > 0 && <small>{money(c.saldoMora)}</small>}
                          </span>
                          <span className="dr-nowrap">{money(c.cuota)}</span>
                          <span className={`dr-td-pagado${c.pagado > 0 ? "" : " dr-td-pagado--cero"}`}>
                            {c.pagado > 0 ? money(c.pagado) : "—"}
                          </span>
                          <span>
                            <Pill
                              sm
                              variant={c.estado === "pago" ? "success" : c.estado === "no_pago" ? "danger" : "neutral"}
                              label={c.estado === "pago" ? "Pagó" : c.estado === "no_pago" ? "No pagó" : "Pendiente"}
                            />
                          </span>
                          <span className="dr-td-actions" onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="dr-btn dr-btn--xs" onClick={() => setClienteAbierto(c)}>Ver</button>
                            <button type="button" className="dr-ghost dr-ghost--text dr-icon-btn" aria-label="Más" onClick={() => setClienteAbierto(c)}>
                              <MoreVertical {...IC} size={16} />
                            </button>
                          </span>
                        </div>
                      ))}
                      {clientesFiltrados.length === 0 && (
                        <div className="dr-empty">
                          {qCliente ? <>Sin resultados para “{busquedaCliente.trim()}”</>
                            : filtroActivo ? "Ningún cliente con ese estado."
                              : "Nadie tenía cuota ese día en esta ruta."}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {!detalleKpi && pestana === "mapa" && (
                <div className="dr-tab-panel--map">
                  <div className="dr-box dr-map">
                    {puntos.length === 0 ? (
                      <div className="dr-map-empty">
                        Sin ubicaciones registradas ese día. El recorrido se dibuja con el GPS de cada gestión.
                      </div>
                    ) : (
                      <div className="dr-map-inner"><MapaRuta points={puntos} /></div>
                    )}
                  </div>
                </div>
              )}

              {!detalleKpi && pestana === "movimientos" && (
                <div className="dr-tab-panel--list">
                  {movimientos.length === 0 ? (
                    <div className="dr-empty dr-empty--tall">Sin movimientos ese día.</div>
                  ) : movimientos.map((m) => (
                    <div key={m.id} className="dr-mov">
                      <span className="dr-muted dr-nowrap">{m.hora}</span>
                      <span className="dr-mov-desc">
                        <span className="dr-ellipsis" style={{ display: "block" }}>{m.titulo}</span>
                        <small>{m.detalle}</small>
                      </span>
                      <b className={`dr-mov-amt dr-mov-amt--${m.tono}`}>{m.monto === 0 ? "—" : money(m.monto)}</b>
                    </div>
                  ))}
                </div>
              )}

              {!detalleKpi && pestana === "gastos" && (
                gastos.length === 0 ? (
                  <div className="dr-empty dr-empty--tall">Sin gastos registrados en esta ruta.</div>
                ) : (
                  <div className="dr-tab-panel--list">
                    {gastos.map((g) => (
                      <div key={g.id} className="dr-gasto">
                        <span className="dr-ellipsis"><span className="dr-muted">{g.hora}</span>&nbsp;&nbsp;{g.concepto}</span>
                        <b className="dr-mov-amt dr-mov-amt--bad">{money(g.valor)}</b>
                      </div>
                    ))}
                  </div>
                )
              )}

              {!detalleKpi && pestana === "notas" && (
                <div className="dr-notes">
                  <textarea
                    rows={6}
                    placeholder={hayJornada ? "Agregar una nota para esta ruta…" : "La jornada de este día no se ha iniciado: no hay dónde guardar una nota."}
                    value={nota} disabled={!hayJornada}
                    onChange={(e) => setNota(e.target.value)}
                  />
                  <div className="dr-notes-foot">
                    <small>Queda en la observación de la jornada del {fechaLarga(fecha)}.</small>
                    <button
                      type="button" className="dr-btn dr-btn--primary"
                      disabled={!hayJornada || guardandoNota || nota.trim() === observacion.trim()}
                      onClick={() => void guardarNota()}
                    >
                      {guardandoNota ? "Guardando…" : "Guardar nota"}
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* ── Acciones ────────────────────────────────────────────────── */}
            <div className="dr-actions">
              <button
                type="button" className="dr-btn dr-action dr-action--danger"
                disabled={estado !== "abierta"} onClick={() => setConfirmar(true)}
              >
                <span className="dr-action-square" />
                {cerrada ? "Ruta finalizada" : estado === "abierta" ? "Finalizar ruta" : "Ruta sin iniciar"}
              </button>
              <button type="button" className="dr-btn dr-action dr-action--primary" onClick={irAlMapa}>
                <Navigation {...IC} />Ver en mapa
              </button>
              <button type="button" className="dr-btn dr-action dr-action--soft" onClick={() => void exportar()} disabled={exportando}>
                <FileText {...IC} />{exportando ? "Exportando…" : "Exportar"}
              </button>
            </div>
          </>
        )}
      </main>

      {/* ── Nav inferior (desde tablet; en teléfono está la del shell) ───── */}
      <nav className="dr-nav">
        <div className="dr-frame dr-nav-in">
          {NAV.map((n) => {
            const activo = n.view === "admin-route-detail"
            return (
              <button
                key={n.view} type="button"
                className={`dr-nav-item${activo ? " dr-nav-item--active" : ""}`}
                onClick={() => { if (!activo) onNavegar?.(n.view) }}
              >
                <n.icono {...IC} size={24} />{n.label}
              </button>
            )
          })}
        </div>
      </nav>

      {/* ── Modales ─────────────────────────────────────────────────────── */}
      {confirmar && (
        <Modal
          title={`¿Finalizar ${nombreRuta}?`}
          onClose={() => !finalizando && setConfirmar(false)}
          actions={
            <>
              <button type="button" className="dr-btn" onClick={() => setConfirmar(false)} disabled={finalizando}>Cancelar</button>
              <button type="button" className="dr-btn dr-btn--primary" onClick={() => void finalizar()} disabled={finalizando}>
                {finalizando ? "Finalizando…" : "Finalizar ruta"}
              </button>
            </>
          }
        >
          Se registrará el cierre de la jornada del {fechaLarga(fecha)} con <b>{money(cobrado)}</b> cobrados
          ({pct}% de avance). El cobrador no podrá registrar más movimientos ese día.
        </Modal>
      )}
      {clienteAbierto && (
        <Modal
          title={clienteAbierto.nombre}
          onClose={() => setClienteAbierto(null)}
          actions={<button type="button" className="dr-btn dr-btn--primary" onClick={() => setClienteAbierto(null)}>Cerrar</button>}
        >
          <div className="dr-modal-grid">
            <span>Dirección</span><b>{clienteAbierto.direccion || "—"}</b>
            <span>Zona</span><b>{clienteAbierto.zona ? capitalizar(clienteAbierto.zona) : "—"}</b>
            <span>Apodo</span><b>{clienteAbierto.apodo ?? "—"}</b>
            <span>Mora</span>
            <b>{clienteAbierto.cuotasMora > 0 ? `${etiquetaMora(clienteAbierto.cuotasMora)} · ${money(clienteAbierto.saldoMora)}` : "Al día"}</b>
            <span>Teléfono</span><b className="dr-nowrap">{clienteAbierto.telefono || "—"}</b>
            <span>Cuota</span><b>{money(clienteAbierto.cuota)}</b>
            <span>Pagado</span><b>{clienteAbierto.pagado > 0 ? money(clienteAbierto.pagado) : "—"}</b>
            <span>Estado</span>
            <b>{clienteAbierto.estado === "pago" ? "Pagó" : clienteAbierto.estado === "no_pago" ? "No pagó" : "Pendiente"}</b>
          </div>
        </Modal>
      )}
    </div>
  )
}
