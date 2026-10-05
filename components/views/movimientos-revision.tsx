"use client"

/**
 * Movimientos en Revisión
 * -----------------------
 * LA BANDEJA ÚNICA DE APROBACIONES (diseño de PROMPT_Movimientos_Revision.md,
 * MovimientosRevision.jsx). Desde el 05-oct-2026 reemplaza también a
 * "Autorizaciones Admin" y "Autorizaciones Secretaria": todo lo que espera un
 * visto bueno está acá, y cada rol aprueba su paso.
 *
 * Se juntan las dos fuentes que conviven en la app:
 *
 *   · `solicitudes_revision` — lo que superó el UMBRAL DE LA RUTA: ventas
 *     grandes (nuevas y renovaciones), abonos (pagos en revisión del libro) y
 *     gastos/ingresos/retiros. Las aprueba secretaría o el admin.
 *   · `gastosregistros` — la cadena por el LÍMITE DEL ÍTEM: primero el admin y
 *     después secretaría. Solo gastos, ingresos y retiros.
 *
 * Muestra lo pendiente (de cualquier fecha) y lo resuelto de los últimos 60
 * días, para ver en qué terminó cada cosa. Pendiente primero (lo más viejo
 * arriba), después lo resuelto (lo más reciente arriba), de a 50 por página.
 *
 * QUIÉN APRUEBA QUÉ
 *   · Esperando al admin (cadena por ítem): el admin lo aprueba como admin;
 *     secretaría puede hacerlo "en lugar del admin", con confirmación aparte,
 *     y queda marcado así en `adminaprobo`.
 *   · Esperando a secretaría y solicitudes por umbral: secretaría o admin.
 *
 * Las evidencias: la foto del gasto, el comprobante / la cédula / el local de
 * la venta, y la foto del pago (`gestiones.detalle.foto_url`, script 125).
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { callRpcAtomic, getSessionIdentity } from "@/lib/api-helper"
import { getSolicitanteNombre } from "@/lib/ruta-umbrales"
import { saveTransaction } from "@/lib/actions/save-transaction"
import { approveTransaction } from "@/lib/actions/approve-transaction"
import { approveTransactionSecretary } from "@/lib/actions/approve-transaction-secretary"
import { formatearMoneda } from "@/lib/monedas"
import { useToast } from "@/hooks/use-toast"
import {
  AlertTriangle, BarChart3, Camera, Check, ChevronDown, Clock, Eye, List, Loader2, RefreshCw, X,
} from "lucide-react"
import "./movimientos-revision.css"

type Tipo = "gasto" | "venta" | "abono"
/** En qué punto del circuito está el movimiento. */
type EstadoBandeja = "pendiente_mio" | "espera_admin" | "aprobado" | "rechazado"
type Aprobacion = "pendiente" | "aprobado" | "rechazado"

interface Solicitud {
  id: string
  tipo: Tipo
  subtipo: "nueva" | "renovacion" | null
  ruta_id: number
  solicitado_por_nombre: string | null
  monto: number
  descripcion: string | null
  payload: Record<string, unknown>
  estado: string
  revisado_por_nombre: string | null
  revisado_at: string | null
  motivo_rechazo: string | null
  created_at: string
}

interface MovimientoCaja {
  id: number
  ruta: number
  tipo: string
  concepto: string
  valor: number
  limite: number | null
  observacion: string | null
  foto: string | null
  adminid: number | null
  estadoadmin: string
  estadosecre: string
  adminaprobo: string | null
  secretariaaprobo: string | null
  fechahorasol: string
  fechahoraaproboadm: string | null
  fechahoraaprobosecretaria: string | null
}

interface GestionRevision {
  id: string
  loan_id: string | null
  tipo: string
  num_cuotas: number | null
  observacion: string | null
  motivo_revision: string | null
  detalle: Record<string, unknown> | null
}

interface Foto { url: string; label: string }

/** Fila normalizada de la bandeja, venga de donde venga. */
interface ItemBandeja {
  key: string
  origen: "revision" | "caja"
  tipo: Tipo
  /** Lo que dice la columna del evento: Pago, Venta, Gasto, Ingreso, Retiro. */
  etiqueta: string
  rutaId: number
  solicitante: string
  monto: number
  estatus: string
  cuotas: number | null
  mora: number | null
  observacion: string
  fotos: Foto[]
  fecha: string
  estado: EstadoBandeja
  aprobacion: Aprobacion
  /** Cuándo se resolvió (o se pidió, si sigue pendiente). */
  fechaAprobacion: string
  /** Renglones extra para el detalle. */
  detalle: [string, string][]
  solicitud?: Solicitud
  movimiento?: MovimientoCaja
}

const VENTANA_DIAS = 60
const POR_PAGINA = 50
const ROLES_ADMIN = new Set(["admin", "administrador"])

const TIPO_META: Record<Tipo, { bg: string; color: string; glyph?: string }> = {
  abono: { bg: "#0f9f8a", color: "#0f8a74", glyph: "$" },
  venta: { bg: "#1f8ef1", color: "#1f6fe0" },
  gasto: { bg: "#ec2027", color: "#d1191f", glyph: "$" },
}
const ESTATUS_COLOR: Record<string, string> = {
  "Canceló": "#e11d24", "Reconsiderando": "#e11d24", "Rechazado": "#e11d24",
  "Aprobado": "#16a34a", "Nuevo": "#16a34a", "Bajo": "#5a8a1f",
  "Espera admin": "#e8590c", "Espera secretaría": "#e8590c",
}
const AP_META: Record<Aprobacion, { label: string; bg: string; color: string }> = {
  pendiente: { label: "Pendiente", bg: "#fdeedd", color: "#e8590c" },
  aprobado: { label: "Aprobado", bg: "#def5ee", color: "#0f9f8a" },
  rechazado: { label: "Rechazado", bg: "#fde4e4", color: "#e11d24" },
}

const D = "–"
const fmtFecha = (iso: string) =>
  new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(iso)).replace(/\//g, "-")
const fmtHora = (iso: string) =>
  new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: true })
    .format(new Date(iso))
const diasEsperando = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)

const Circle = ({ size, bg, color = "#fff", children }: { size: number; bg: string; color?: string; children: React.ReactNode }) => (
  <span className="mr-circle" style={{ width: size, height: size, background: bg, color, fontSize: size * 0.52 }}>{children}</span>
)
const TypeIcon = ({ tipo, size = 42 }: { tipo: Tipo; size?: number }) => {
  const t = TIPO_META[tipo]
  return <Circle size={size} bg={t.bg}>{t.glyph ?? <BarChart3 size={22} strokeWidth={2.6} />}</Circle>
}
function ApIcon({ ap }: { ap: Aprobacion }) {
  if (ap === "aprobado") return <Circle size={30} bg="#0f9f8a"><Check size={18} strokeWidth={3} /></Circle>
  if (ap === "rechazado") return <Circle size={30} bg="#ec2027"><X size={18} strokeWidth={3} /></Circle>
  return <Clock size={30} color="#e8590c" strokeWidth={1.8} />
}

type Chip = "todas" | "venta" | "abono" | "gasto" | "aprob"
const CHIPS: { id: Chip; label: string; icon: React.ReactNode; iconBg: string; iconColor?: string; bg: string }[] = [
  { id: "todas", label: "Todas", icon: <List size={24} strokeWidth={2.2} />, iconBg: "transparent", iconColor: "#1736b8", bg: "#fff" },
  { id: "venta", label: "Ventas", icon: <BarChart3 size={24} strokeWidth={2.4} />, iconBg: "transparent", iconColor: "#1f8ef1", bg: "#eef4fb" },
  { id: "abono", label: "Abonos", icon: "$", iconBg: "#0f9f8a", bg: "#eef4fb" },
  { id: "gasto", label: "Gastos", icon: "$", iconBg: "#ec2027", bg: "#fde6ea" },
  { id: "aprob", label: "Aprob Admin", icon: <Check size={22} strokeWidth={2.6} />, iconBg: "#c07ef2", bg: "#f2ecfb" },
]

interface RutaInfo { id: number; nombre: string; ciudad: string | null; pais: string | null; moneda: string | null }
const TODOS = "__todos"

export function MovimientosRevision() {
  const { toast } = useToast()
  const rol = (getSessionIdentity().rol ?? "").toLowerCase()
  const esAdmin = ROLES_ADMIN.has(rol)

  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([])
  const [movimientos, setMovimientos] = useState<MovimientoCaja[]>([])
  const [gestiones, setGestiones] = useState<Map<string, GestionRevision>>(new Map())
  const [moraPorLoan, setMoraPorLoan] = useState<Map<string, number>>(new Map())
  const [usuarios, setUsuarios] = useState<Map<number, string>>(new Map())
  const [rutas, setRutas] = useState<Map<number, RutaInfo>>(new Map())
  const [adminsPorRuta, setAdminsPorRuta] = useState<Map<number, string[]>>(new Map())
  const [loading, setLoading] = useState(true)

  const [chip, setChip] = useState<Chip>("todas")
  const [filtros, setFiltros] = useState({ pais: TODOS, ciudad: TODOS, admin: TODOS, unid: TODOS })
  const [pagina, setPagina] = useState(0)
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
  const [aprobandoLote, setAprobandoLote] = useState(false)
  const [actionKey, setActionKey] = useState<string | null>(null)

  const [detalle, setDetalle] = useState<ItemBandeja | null>(null)
  const [rechazo, setRechazo] = useState<ItemBandeja | null>(null)
  const [motivo, setMotivo] = useState("")
  const [enLugarDelAdmin, setEnLugarDelAdmin] = useState<ItemBandeja | null>(null)

  // ── Carga ──────────────────────────────────────────────────────────────
  const fetchTodo = useCallback(async () => {
    setLoading(true)
    try {
      const sb = createClient()
      const desde = new Date(Date.now() - VENTANA_DIAS * 86_400_000).toISOString()
      const colsCaja =
        "id, ruta, tipo, concepto, valor, limite, observacion, foto, adminid, estadoadmin, estadosecre, " +
        "adminaprobo, secretariaaprobo, fechahorasol, fechahoraaproboadm, fechahoraaprobosecretaria"
      const [rSol, rCajaAdm, rCajaSec, rCajaRes, rRutas, rAsig] = await Promise.all([
        sb.from("solicitudes_revision").select("*")
          .or(`estado.eq.pendiente,created_at.gte.${desde}`)
          .order("created_at", { ascending: true }),
        sb.from("gastosregistros").select(colsCaja).eq("estadoadmin", "por aprobar"),
        sb.from("gastosregistros").select(colsCaja).eq("estadosecre", "por aprobar"),
        sb.from("gastosregistros").select(colsCaja)
          .or("estadoadmin.neq.NA,estadosecre.neq.NA").gte("fechahorasol", desde)
          .order("fechahorasol", { ascending: false }).limit(1000),
        sb.from("rutas").select("id, nombre, ciudad, pais, moneda").order("id"),
        sb.from("usuario_rutas").select("ruta_id, usuarios!inner(nombre, rol, activo)").in("usuarios.rol", ["admin", "administrador"]),
      ])
      if (rSol.error) throw rSol.error

      const sols = (rSol.data ?? []) as Solicitud[]
      const caja = new Map<number, MovimientoCaja>()
      for (const r of [rCajaAdm, rCajaSec, rCajaRes]) {
        for (const m of (r.data ?? []) as unknown as MovimientoCaja[]) caja.set(m.id, m)
      }

      // Los pagos en revisión: su gestión trae cuotas, nota, foto y préstamo.
      const gIds = sols
        .filter((s) => s.tipo === "abono")
        .map((s) => String((s.payload as { gestion_id?: string }).gestion_id ?? ""))
        .filter(Boolean)
      const gMap = new Map<string, GestionRevision>()
      for (let i = 0; i < gIds.length; i += 150) {
        const { data } = await sb.from("gestiones")
          .select("id, loan_id, tipo, num_cuotas, observacion, motivo_revision, detalle")
          .in("id", gIds.slice(i, i + 150))
        for (const g of (data ?? []) as GestionRevision[]) gMap.set(g.id, g)
      }
      const loanIds = [...new Set([...gMap.values()].map((g) => g.loan_id).filter((x): x is string => !!x))]
      const mora = new Map<string, number>()
      for (let i = 0; i < loanIds.length; i += 150) {
        const { data } = await sb.from("v_loan_financiero").select("loan_id, cuotas_mora").in("loan_id", loanIds.slice(i, i + 150))
        for (const f of (data ?? []) as { loan_id: string; cuotas_mora: number | null }[]) mora.set(f.loan_id, Number(f.cuotas_mora) || 0)
      }

      // Quién pidió el gasto de caja: `adminid` es un usuario (script 039).
      const uIds = [...new Set([...caja.values()].map((m) => m.adminid).filter((x): x is number => x != null))]
      const uMap = new Map<number, string>()
      if (uIds.length) {
        const { data } = await sb.from("usuarios").select("id, nombre").in("id", uIds)
        for (const u of (data ?? []) as { id: number; nombre: string | null }[]) uMap.set(u.id, u.nombre ?? `#${u.id}`)
      }

      const admins = new Map<number, string[]>()
      for (const a of (rAsig.data ?? []) as unknown as { ruta_id: number; usuarios: { nombre: string | null; activo: boolean | null } | null }[]) {
        const n = a.usuarios?.nombre?.trim()
        if (!n || a.usuarios?.activo === false) continue
        const l = admins.get(Number(a.ruta_id)) ?? []
        if (!l.includes(n)) l.push(n)
        admins.set(Number(a.ruta_id), l)
      }

      setSolicitudes(sols)
      setMovimientos([...caja.values()])
      setGestiones(gMap)
      setMoraPorLoan(mora)
      setUsuarios(uMap)
      setRutas(new Map(((rRutas.data ?? []) as RutaInfo[]).map((r) => [r.id, r])))
      setAdminsPorRuta(admins)
    } catch (err) {
      console.error("[v0] Error cargando la bandeja de revisión:", err)
      toast({ title: "Error", description: "No se pudo cargar la bandeja de movimientos.", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { void fetchTodo() }, [fetchTodo])

  // ── Normalización de las dos fuentes ───────────────────────────────────
  const bandeja = useMemo<ItemBandeja[]>(() => {
    const desdeRevision: ItemBandeja[] = solicitudes
      // Un gasto aprobado ya existe como movimiento real en `gastosregistros`
      // y desde ahí se ve su estado verdadero: mostrar la solicitud lo duplicaría.
      .filter((s) => !(s.tipo === "gasto" && s.estado === "aprobado"))
      .map((s) => {
        const p = s.payload ?? {}
        const aprob: Aprobacion = s.estado === "pendiente" ? "pendiente" : s.estado === "rechazado" ? "rechazado" : "aprobado"
        const base = {
          key: `sr:${s.id}`,
          origen: "revision" as const,
          tipo: s.tipo,
          rutaId: s.ruta_id,
          solicitante: s.solicitado_por_nombre ?? D,
          monto: Number(s.monto ?? 0),
          fecha: s.created_at,
          estado: (s.estado === "pendiente" ? "pendiente_mio" : aprob === "rechazado" ? "rechazado" : "aprobado") as EstadoBandeja,
          aprobacion: aprob,
          fechaAprobacion: s.revisado_at ?? s.created_at,
          solicitud: s,
        }
        const resuelto: [string, string][] = s.estado === "pendiente" ? [] : [
          ["Resuelto por", s.revisado_por_nombre ?? D],
          ...(s.motivo_rechazo ? [["Motivo del rechazo", s.motivo_rechazo] as [string, string]] : []),
        ]
        if (s.tipo === "venta") {
          const loan = (p.p_loan ?? {}) as Record<string, unknown>
          const cli = (p.p_cliente ?? {}) as Record<string, unknown>
          const fotos: Foto[] = [
            ...(loan.comprobante_url ? [{ url: String(loan.comprobante_url), label: "Evidencia de entrega" }] : []),
            ...(cli.cedula_image_url ? [{ url: String(cli.cedula_image_url), label: "Cédula" }] : []),
            ...(cli.foto_local_url ? [{ url: String(cli.foto_local_url), label: "Local" }] : []),
          ]
          return {
            ...base,
            etiqueta: "Venta",
            estatus: s.estado === "rechazado" ? "Rechazado" : s.subtipo === "renovacion" ? "Renovación" : "Nuevo",
            cuotas: Number(loan.numero_cuotas) || null,
            mora: null,
            observacion: s.descripcion ?? "",
            fotos,
            detalle: [
              ["Cuotas", loan.numero_cuotas ? `${loan.numero_cuotas} de ${loan.valor_cuota ?? D}` : D],
              ["Interés", loan.tasa_interes != null ? `${loan.tasa_interes}%` : D],
              ["Entrega", String(loan.tipo_venta ?? "efectivo")],
              ...resuelto,
            ],
          }
        }
        if (s.tipo === "abono") {
          const g = gestiones.get(String((p as { gestion_id?: string }).gestion_id ?? ""))
          const foto = g?.detalle?.foto_url ? [{ url: String(g.detalle.foto_url), label: "Foto del pago" }] : []
          return {
            ...base,
            etiqueta: "Pago",
            estatus: s.estado === "rechazado" ? "Rechazado" : g?.tipo === "cancelacion" ? "Canceló" : s.estado === "pendiente" ? "Reconsiderando" : "Aprobado",
            cuotas: g?.num_cuotas ?? null,
            mora: g?.loan_id ? moraPorLoan.get(g.loan_id) ?? null : null,
            observacion: [g?.motivo_revision, g?.observacion].filter(Boolean).join(" · ") || (s.descripcion ?? ""),
            fotos: foto,
            detalle: [["Detalle", s.descripcion ?? D], ...resuelto],
          }
        }
        // Gasto / ingreso / retiro por el umbral de la ruta.
        const tipoReal = String((p as { tipo?: string }).tipo ?? "Gasto")
        return {
          ...base,
          etiqueta: tipoReal,
          estatus: s.estado === "rechazado" ? "Rechazado" : "Espera secretaría",
          cuotas: null,
          mora: null,
          observacion: [String((p as { concepto?: string }).concepto ?? ""), String((p as { observacion?: string }).observacion ?? "")].filter(Boolean).join(" · "),
          fotos: (p as { foto?: string }).foto ? [{ url: String((p as { foto?: string }).foto), label: "Comprobante" }] : [],
          detalle: [["Concepto", String((p as { concepto?: string }).concepto ?? D)], ...resuelto],
        }
      })

    const desdeCaja: ItemBandeja[] = movimientos.map((m) => {
      const estado: EstadoBandeja =
        m.estadoadmin === "rechazado" || m.estadosecre === "rechazado" ? "rechazado"
        : m.estadoadmin === "por aprobar" ? "espera_admin"
        : m.estadosecre === "por aprobar" ? "pendiente_mio"
        : "aprobado"
      const aprob: Aprobacion = estado === "rechazado" ? "rechazado" : estado === "aprobado" ? "aprobado" : "pendiente"
      return {
        key: `gr:${m.id}`,
        origen: "caja",
        tipo: "gasto",
        etiqueta: m.tipo || "Gasto",
        rutaId: m.ruta,
        solicitante: (m.adminid != null ? usuarios.get(m.adminid) : null) ?? D,
        monto: Number(m.valor ?? 0),
        estatus:
          estado === "espera_admin" ? "Espera admin"
          : estado === "pendiente_mio" ? "Espera secretaría"
          : estado === "rechazado" ? "Rechazado" : "Aprobado",
        cuotas: null,
        mora: null,
        observacion: [m.concepto, m.observacion].filter(Boolean).join(" · "),
        fotos: m.foto ? [{ url: m.foto, label: "Comprobante" }] : [],
        fecha: m.fechahorasol,
        estado,
        aprobacion: aprob,
        fechaAprobacion: m.fechahoraaprobosecretaria ?? m.fechahoraaproboadm ?? m.fechahorasol,
        detalle: [
          ["Concepto", m.concepto],
          ["Límite del ítem", m.limite != null ? String(m.limite) : D],
          ["Admin", m.adminaprobo ? `${m.estadoadmin} · ${m.adminaprobo}` : m.estadoadmin],
          ["Secretaría", m.secretariaaprobo ? `${m.estadosecre} · ${m.secretariaaprobo}` : m.estadosecre],
        ],
        movimiento: m,
      }
    })

    return [...desdeRevision, ...desdeCaja].sort((a, b) => {
      // Lo que necesita acción primero (lo más viejo arriba); después lo
      // resuelto (lo más reciente arriba).
      const pa = a.aprobacion === "pendiente" ? 0 : 1
      const pb = b.aprobacion === "pendiente" ? 0 : 1
      if (pa !== pb) return pa - pb
      return pa === 0 ? a.fecha.localeCompare(b.fecha) : b.fecha.localeCompare(a.fecha)
    })
  }, [solicitudes, movimientos, gestiones, moraPorLoan, usuarios])

  // ── Filtros ────────────────────────────────────────────────────────────
  const ruta = (id: number) => rutas.get(id)
  const opciones = useMemo(() => {
    const ids = [...new Set(bandeja.map((i) => i.rutaId))]
    const info = ids.map((id) => ruta(id)).filter((r): r is RutaInfo => !!r)
    const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))].sort()
    const pasaPais = (r: RutaInfo) => filtros.pais === TODOS || (r.pais ?? "").trim() === filtros.pais
    const pasaCiudad = (r: RutaInfo) => filtros.ciudad === TODOS || (r.ciudad ?? "").trim() === filtros.ciudad
    const pasaAdmin = (r: RutaInfo) => filtros.admin === TODOS || (adminsPorRuta.get(r.id) ?? []).includes(filtros.admin)
    return {
      pais: uniq(info.map((r) => r.pais)),
      ciudad: uniq(info.filter(pasaPais).map((r) => r.ciudad)),
      admin: uniq(info.filter((r) => pasaPais(r) && pasaCiudad(r)).flatMap((r) => adminsPorRuta.get(r.id) ?? [])),
      unid: info.filter((r) => pasaPais(r) && pasaCiudad(r) && pasaAdmin(r)).sort((a, b) => a.id - b.id),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandeja, rutas, adminsPorRuta, filtros])

  const porFiltros = useMemo(() => bandeja.filter((i) => {
    const r = ruta(i.rutaId)
    if (filtros.unid !== TODOS) return String(i.rutaId) === filtros.unid
    if (filtros.pais !== TODOS && (r?.pais ?? "").trim() !== filtros.pais) return false
    if (filtros.ciudad !== TODOS && (r?.ciudad ?? "").trim() !== filtros.ciudad) return false
    if (filtros.admin !== TODOS && !(adminsPorRuta.get(i.rutaId) ?? []).includes(filtros.admin)) return false
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [bandeja, filtros, rutas, adminsPorRuta])

  const conteos: Record<Chip, number> = {
    todas: porFiltros.length,
    venta: porFiltros.filter((i) => i.tipo === "venta").length,
    abono: porFiltros.filter((i) => i.tipo === "abono").length,
    gasto: porFiltros.filter((i) => i.tipo === "gasto").length,
    aprob: porFiltros.filter((i) => i.aprobacion === "aprobado").length,
  }
  const filas = useMemo(
    () => porFiltros.filter((i) => chip === "todas" || (chip === "aprob" ? i.aprobacion === "aprobado" : i.tipo === chip)),
    [porFiltros, chip],
  )
  const paginas = Math.max(1, Math.ceil(filas.length / POR_PAGINA))
  const pag = Math.min(pagina, paginas - 1)
  const visibles = filas.slice(pag * POR_PAGINA, pag * POR_PAGINA + POR_PAGINA)
  const pendientes = porFiltros.filter((i) => i.aprobacion === "pendiente").length

  useEffect(() => { setPagina(0) }, [chip, filtros])

  const cambiarFiltro = (k: keyof typeof filtros, v: string) =>
    setFiltros((f) => {
      // Al cambiar uno de arriba se sueltan los de abajo, que pueden no existir.
      const orden: (keyof typeof filtros)[] = ["pais", "ciudad", "admin", "unid"]
      const n = { ...f, [k]: v }
      for (const x of orden.slice(orden.indexOf(k) + 1)) n[x] = TODOS
      return n
    })

  // ── Acciones (la misma lógica de siempre) ──────────────────────────────
  const accionable = (i: ItemBandeja) => i.estado === "pendiente_mio" || i.estado === "espera_admin"
  /** Lo que se puede aprobar sin confirmación aparte. */
  const directo = (i: ItemBandeja) => accionable(i) && !(i.estado === "espera_admin" && !esAdmin)

  /** Aplica UN item. Lanza si algo falla. */
  const aprobarUno = async (i: ItemBandeja) => {
    const nombre = getSolicitanteNombre() ?? (esAdmin ? "Admin" : "Secretaría")
    if (i.origen === "caja" && i.movimiento) {
      if (i.estado === "espera_admin") {
        // El admin aprueba SU paso. Secretaría lo hace en lugar del admin y
        // queda marcado así en `adminaprobo`, para la auditoría.
        const r = await approveTransaction({ id: i.movimiento.id, status: "aprobado", adminName: nombre, enLugarDelAdmin: !esAdmin })
        if (!r.success) throw new Error(r.error ?? "No se pudo aprobar el movimiento")
      } else {
        const r = await approveTransactionSecretary({ id: i.movimiento.id, status: "aprobado", secretaryName: nombre })
        if (!r.success) throw new Error(r.error ?? "No se pudo aprobar el movimiento")
      }
      return
    }
    const s = i.solicitud!
    if (s.tipo === "gasto") {
      // Se RECLAMA la solicitud antes de aplicarla: el `.eq("estado",
      // "pendiente")` hace que si dos personas aprueban a la vez, solo una
      // se la lleve y el gasto no entre dos veces.
      const identity = getSessionIdentity()
      const sb = createClient()
      const { data: reclamada, error } = await sb
        .from("solicitudes_revision")
        .update({ estado: "aprobado", revisado_por: identity.user_id, revisado_por_nombre: nombre, revisado_at: new Date().toISOString() })
        .eq("id", s.id).eq("estado", "pendiente").select("id")
      if (error) throw error
      if (!reclamada || reclamada.length === 0) throw new Error("Este movimiento ya fue resuelto por otra persona")
      const result = await saveTransaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(s.payload as any),
        idempotencyKey: s.id,
        aprobadoPorSecretaria: nombre,
      })
      if (!result.success) {
        await sb.from("solicitudes_revision")
          .update({ estado: "pendiente", revisado_por: null, revisado_por_nombre: null, revisado_at: null })
          .eq("id", s.id)
        throw new Error(result.error ?? "No se pudo registrar el gasto")
      }
    } else {
      // Venta / abono: RPC atómica (crea el préstamo o aplica el pago).
      await callRpcAtomic("aprobar_solicitud_revision", { solicitud_id: s.id, decision: "aprobado" })
    }
  }

  const aprobar = async (i: ItemBandeja) => {
    setActionKey(i.key)
    try {
      await aprobarUno(i)
      setSeleccion((p) => { const n = new Set(p); n.delete(i.key); return n })
      toast({ title: i.estado === "espera_admin" && !esAdmin ? "Aprobado en lugar del admin" : "Movimiento aprobado" })
      setDetalle(null)
      await fetchTodo()
    } catch (err) {
      console.error("[v0] Error aprobando:", err)
      toast({ title: "Error al aprobar", description: err instanceof Error ? err.message : "No se pudo aprobar", variant: "destructive" })
    } finally {
      setActionKey(null)
      setEnLugarDelAdmin(null)
    }
  }
  const pedirAprobar = (i: ItemBandeja) => (directo(i) ? void aprobar(i) : setEnLugarDelAdmin(i))

  const rechazar = async () => {
    if (!rechazo) return
    const i = rechazo
    setActionKey(i.key)
    try {
      const nombre = getSolicitanteNombre() ?? (esAdmin ? "Admin" : "Secretaría")
      if (i.origen === "caja" && i.movimiento) {
        const r = i.estado === "espera_admin"
          ? await approveTransaction({ id: i.movimiento.id, status: "rechazado", adminName: nombre, enLugarDelAdmin: !esAdmin })
          : await approveTransactionSecretary({ id: i.movimiento.id, status: "rechazado", secretaryName: nombre })
        if (!r.success) throw new Error(r.error ?? "No se pudo rechazar")
      } else if (i.solicitud?.tipo === "gasto") {
        const identity = getSessionIdentity()
        const { error } = await createClient().from("solicitudes_revision")
          .update({
            estado: "rechazado", revisado_por: identity.user_id, revisado_por_nombre: nombre,
            revisado_at: new Date().toISOString(), motivo_rechazo: motivo || null,
          })
          .eq("id", i.solicitud.id).eq("estado", "pendiente")
        if (error) throw error
      } else if (i.solicitud) {
        await callRpcAtomic("aprobar_solicitud_revision", { solicitud_id: i.solicitud.id, decision: "rechazado", motivo_rechazo: motivo || null })
      }
      setSeleccion((p) => { const n = new Set(p); n.delete(i.key); return n })
      toast({ title: "Movimiento rechazado" })
      setDetalle(null)
      await fetchTodo()
    } catch (err) {
      console.error("[v0] Error rechazando:", err)
      toast({ title: "Error al rechazar", description: err instanceof Error ? err.message : "No se pudo rechazar", variant: "destructive" })
    } finally {
      setActionKey(null)
      setRechazo(null)
      setMotivo("")
    }
  }

  /** Aprueba lo seleccionado, en serie (cada uno escribe plata o préstamos). */
  const aprobarLote = async () => {
    const lista = filas.filter((i) => seleccion.has(i.key) && directo(i))
    if (!lista.length) return
    setAprobandoLote(true)
    let ok = 0
    const fallidas: string[] = []
    for (const i of lista) {
      setActionKey(i.key)
      try { await aprobarUno(i); ok += 1 } catch (err) {
        console.error("[v0] Error aprobando en lote:", i.key, err)
        fallidas.push(`${i.etiqueta} ${formatearMoneda(i.monto, ruta(i.rutaId)?.moneda)}`)
      }
    }
    setActionKey(null)
    setAprobandoLote(false)
    setSeleccion(new Set())
    toast({
      title: `${ok} de ${lista.length} aprobados`,
      description: fallidas.length ? `No se pudieron aprobar: ${fallidas.join(", ")}` : undefined,
      variant: fallidas.length ? "destructive" : undefined,
    })
    await fetchTodo()
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const seleccionables = visibles.filter(directo)
  const todosMarcados = seleccionables.length > 0 && seleccionables.every((i) => seleccion.has(i.key))
  const marcarTodos = () =>
    setSeleccion((p) => {
      const n = new Set(p)
      for (const i of seleccionables) (todosMarcados ? n.delete(i.key) : n.add(i.key))
      return n
    })
  const enLote = filas.filter((i) => seleccion.has(i.key) && directo(i)).length
  const plata = (i: ItemBandeja) => formatearMoneda(i.monto, ruta(i.rutaId)?.moneda)
  const ahora = new Date()
  const fechaCabecera = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit",
  }).format(ahora).replace(".", "") + " - " + fmtHora(ahora.toISOString())

  const HEAD: React.ReactNode[] = [
    "Ícono / Evento", "Núm. / Unidad", "Solicitante", "Valor", "Estatus", "Cuotas", "Mora", "Observación",
    <>Adjuntos /<br />Evidencia</>, "Acciones", "Fecha y hora", <>Aprobación<br />Administrativa</>,
  ]
  const FIELDS: [keyof typeof filtros, string][] = [["pais", "País"], ["ciudad", "Ciudad"], ["admin", "Admin"], ["unid", "Unid"]]

  return (
    <div className="mr-root">
      <div className="mr-frame">
        <header className="mr-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="mr-logo" src="/opad-logo.png" alt="OPAD" />
          <div className="mr-divider" />
          <div>
            <h1 className="mr-h1">Movimientos en Revisión</h1>
            <div className="mr-h1-sub">
              Gastos, ventas y abonos, y en qué punto va cada uno
              {pendientes > 0 && <b style={{ color: "#e8590c" }}> · {pendientes} por aprobar</b>}
            </div>
          </div>
          <div className="mr-head-right">
            <span className="mr-date">{fechaCabecera}</span>
            <button type="button" className="mr-refresh" onClick={() => void fetchTodo()} disabled={loading}>
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} /> Actualizar
            </button>
          </div>
        </header>

        <div className="mr-body">
          <div className="mr-filters">
            {FIELDS.map(([k, label]) => (
              <label key={k} className="mr-filter">
                <span>{label}</span>
                <select className="mr-select" value={filtros[k]} onChange={(e) => cambiarFiltro(k, e.target.value)}>
                  <option value={TODOS}>{k === "unid" ? "Todas" : "Todos"}</option>
                  {k === "unid"
                    ? opciones.unid.map((r) => <option key={r.id} value={String(r.id)}>{r.nombre}</option>)
                    : opciones[k].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <ChevronDown size={20} strokeWidth={1.9} />
              </label>
            ))}
          </div>

          <div role="tablist" className="mr-chips">
            {CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={chip === c.id}
                onClick={() => setChip(c.id)}
                className={`mr-chip${c.id === "todas" ? " mr-chip--todas" : ""}`}
                style={{ background: c.bg }}
              >
                <Circle size={40} bg={c.iconBg} color={c.iconColor ?? "#fff"}>
                  <span style={{ fontSize: 21, display: "grid", placeItems: "center" }}>{c.icon}</span>
                </Circle>
                {c.label} ({conteos[c.id]})
              </button>
            ))}
            {enLote > 0 && (
              <div className="mr-lote">
                <span>{enLote} seleccionados</span>
                <button type="button" onClick={() => void aprobarLote()} disabled={aprobandoLote}>
                  {aprobandoLote ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
                  Aprobar seleccionados
                </button>
              </div>
            )}
          </div>

          <div className="mr-table">
            <div className="mr-grid mr-thead">
              <span className="mr-cell">
                <input type="checkbox" className="mr-check" checked={todosMarcados} onChange={marcarTodos}
                  disabled={seleccionables.length === 0} aria-label="Seleccionar todo" />
              </span>
              {HEAD.map((h, i) => <span key={i} className="mr-cell">{h}</span>)}
            </div>

            {loading && bandeja.length === 0 ? (
              <div className="mr-empty"><Loader2 size={22} className="animate-spin" style={{ display: "inline" }} /> Cargando…</div>
            ) : visibles.length === 0 ? (
              <div className="mr-empty">No hay movimientos con estos filtros.</div>
            ) : (
              visibles.map((i) => {
                const t = TIPO_META[i.tipo]
                const ap = AP_META[i.aprobacion]
                const on = seleccion.has(i.key)
                const busy = actionKey === i.key
                const dias = diasEsperando(i.fecha)
                return (
                  <div key={i.key} className={`mr-grid mr-row${on ? " mr-row--sel" : ""}`}>
                    <span className="mr-cell">
                      <input type="checkbox" className="mr-check" checked={on} disabled={!directo(i) || aprobandoLote}
                        onChange={() => setSeleccion((p) => { const n = new Set(p); if (n.has(i.key)) n.delete(i.key); else n.add(i.key); return n })}
                        aria-label="Seleccionar" />
                    </span>
                    <span className="mr-cell mr-cell--evento">
                      <TypeIcon tipo={i.tipo} />
                      <span style={{ fontSize: 17, color: t.color }}>{i.etiqueta}</span>
                    </span>
                    <span className="mr-cell">{ruta(i.rutaId)?.nombre ?? `UNID ${i.rutaId}`}</span>
                    <span className="mr-cell mr-cell--left"><span className="mr-ellipsis" title={i.solicitante}>{i.solicitante}</span></span>
                    <span className="mr-cell mr-num">{plata(i)}</span>
                    <span className="mr-cell" style={{ color: ESTATUS_COLOR[i.estatus] ?? "#14205a" }}>{i.estatus || D}</span>
                    <span className="mr-cell">{i.cuotas ?? D}</span>
                    <span className="mr-cell" style={{ color: (i.mora ?? 0) > 0 ? "#e11d24" : "#14205a" }}>{i.mora ?? D}</span>
                    <span className="mr-cell mr-cell--obs" title={i.observacion}>
                      {i.observacion ? (i.observacion.length > 60 ? `${i.observacion.slice(0, 58)}…` : i.observacion) : D}
                    </span>
                    <span className="mr-cell" style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                      <button type="button" className="mr-icon-btn" onClick={() => setDetalle(i)} aria-label="Ver detalle"><Eye size={22} strokeWidth={1.9} /></button>
                      <button type="button" className="mr-icon-btn" onClick={() => setDetalle(i)} aria-label="Ver evidencia" disabled={i.fotos.length === 0}
                        title={i.fotos.length ? `${i.fotos.length} adjunto(s)` : "Sin evidencia"}><Camera size={22} strokeWidth={1.9} /></button>
                    </span>
                    <span className="mr-cell" style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                      <button type="button" className="mr-round mr-round--rech" disabled={!accionable(i) || busy || aprobandoLote}
                        onClick={() => { setRechazo(i); setMotivo("") }} aria-label="Rechazar"><X size={22} strokeWidth={2.6} /></button>
                      <button type="button" className="mr-round" disabled={!accionable(i) || busy || aprobandoLote}
                        style={{ background: i.aprobacion === "aprobado" ? "#0d6b6b" : "#c4c9d0" }}
                        onClick={() => pedirAprobar(i)} aria-label="Aprobar"
                        title={i.estado === "espera_admin" && !esAdmin ? "Aprobar en lugar del admin" : "Aprobar"}>
                        {busy ? <Loader2 size={20} className="animate-spin" /> : <Check size={22} strokeWidth={2.6} />}
                      </button>
                    </span>
                    <span className="mr-cell mr-cell--2l">
                      <span>{fmtFecha(i.fecha)}</span>
                      <span>{fmtHora(i.fecha)}</span>
                      {i.aprobacion === "pendiente" && dias >= 3 && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: dias >= 15 ? "#e11d24" : "#e8590c" }}>{dias} días</span>
                      )}
                    </span>
                    <span className="mr-cell" style={{ padding: "4px 8px" }}>
                      <span className="mr-ap" style={{ background: ap.bg }}>
                        <ApIcon ap={i.aprobacion} />
                        <span><b style={{ color: ap.color }}>{ap.label}</b><small>{fmtHora(i.fechaAprobacion)}</small></span>
                      </span>
                    </span>
                  </div>
                )
              })
            )}

            {filas.length > POR_PAGINA && (
              <div className="mr-pager">
                <span>{pag * POR_PAGINA + 1}–{Math.min(filas.length, (pag + 1) * POR_PAGINA)} de {filas.length}</span>
                <div>
                  <button type="button" disabled={pag === 0} onClick={() => setPagina(pag - 1)}>Anterior</button>
                  <button type="button" disabled={pag >= paginas - 1} onClick={() => setPagina(pag + 1)}>Siguiente</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Detalle y evidencia ──────────────────────────────────────────── */}
      {detalle && (
        <div className="mr-modal-bg" onClick={() => setDetalle(null)}>
          <div className="mr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mr-modal-head">
              <TypeIcon tipo={detalle.tipo} size={46} />
              <div>
                <div className="mr-modal-title">{detalle.etiqueta} · {detalle.solicitante}</div>
                <div className="mr-modal-sub">
                  {ruta(detalle.rutaId)?.nombre ?? `UNID ${detalle.rutaId}`} · {fmtFecha(detalle.fecha)} {fmtHora(detalle.fecha)}
                </div>
              </div>
            </div>
            {detalle.fotos.length ? (
              <div className="mr-modal-photos">
                {detalle.fotos.map((f) => (
                  <a key={f.url.slice(0, 80) + f.label} href={f.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.url} alt={f.label} />
                    {f.label}
                  </a>
                ))}
              </div>
            ) : (
              <div className="mr-modal-none">Sin evidencia adjunta</div>
            )}
            <div className="mr-modal-kv">
              <span>Valor</span><b>{plata(detalle)}</b>
              <span>Estatus</span><b style={{ color: ESTATUS_COLOR[detalle.estatus] }}>{detalle.estatus || D}</b>
              <span>Aprobación</span><b style={{ color: AP_META[detalle.aprobacion].color }}>{AP_META[detalle.aprobacion].label}</b>
              {detalle.cuotas != null && (<><span>Cuotas</span><b>{detalle.cuotas}</b></>)}
              {detalle.mora != null && (<><span>Mora</span><b>{detalle.mora} cuotas</b></>)}
              <span>Observación</span><b>{detalle.observacion || D}</b>
              {detalle.detalle.map(([k, v]) => (<span key={k} style={{ display: "contents" }}><span>{k}</span><b>{v}</b></span>))}
            </div>
            <div className="mr-modal-actions">
              <button type="button" className="mr-btn mr-btn--sec" onClick={() => setDetalle(null)}>Cerrar</button>
              {accionable(detalle) && (
                <>
                  <button type="button" className="mr-btn mr-btn--danger" disabled={actionKey === detalle.key}
                    onClick={() => { setRechazo(detalle); setMotivo("") }}>Rechazar</button>
                  <button type="button" className="mr-btn mr-btn--ok" disabled={actionKey === detalle.key}
                    onClick={() => pedirAprobar(detalle)}>
                    {actionKey === detalle.key ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                    {detalle.estado === "espera_admin" && !esAdmin ? "Aprobar en lugar del admin" : "Aprobar"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Motivo del rechazo ───────────────────────────────────────────── */}
      {rechazo && (
        <div className="mr-modal-bg" onClick={() => setRechazo(null)}>
          <div className="mr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mr-modal-title">Rechazar movimiento</div>
            <div className="mr-modal-sub">{rechazo.etiqueta} · {rechazo.solicitante} · {plata(rechazo)}</div>
            <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo del rechazo (opcional)" />
            <div className="mr-modal-actions">
              <button type="button" className="mr-btn mr-btn--sec" onClick={() => setRechazo(null)}>Cancelar</button>
              <button type="button" className="mr-btn mr-btn--danger" disabled={actionKey === rechazo.key} onClick={() => void rechazar()}>
                {actionKey === rechazo.key ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />} Rechazar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Aprobar en lugar del admin (secretaría) ──────────────────────── */}
      {enLugarDelAdmin && (
        <div className="mr-modal-bg" onClick={() => setEnLugarDelAdmin(null)}>
          <div className="mr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mr-modal-head">
              <AlertTriangle size={30} color="#e8590c" />
              <div className="mr-modal-title">Aprobar en lugar del admin</div>
            </div>
            <div className="mr-aviso">
              Este movimiento superó el límite de su ítem, así que le correspondía al administrador revisarlo. Si lo
              apruebas tú, se salta esa revisión y queda registrado a tu nombre como aprobado en lugar del admin.
            </div>
            <div className="mr-modal-sub">{enLugarDelAdmin.etiqueta} · {enLugarDelAdmin.observacion} · {plata(enLugarDelAdmin)}</div>
            <div className="mr-modal-actions">
              <button type="button" className="mr-btn mr-btn--sec" onClick={() => setEnLugarDelAdmin(null)}>Cancelar</button>
              <button type="button" className="mr-btn mr-btn--ok" disabled={actionKey === enLugarDelAdmin.key} onClick={() => void aprobar(enLugarDelAdmin)}>
                {actionKey === enLugarDelAdmin.key ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Sí, aprobar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
