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
/**
 * En qué punto del circuito está el movimiento.
 *   pendiente     solicitud sin resolver: la resuelve admin o secretaría
 *   espera_admin  gasto de caja sobre el límite: el admin (o secretaría en su lugar)
 *   espera_secre  gasto de caja con la firma de secretaría pendiente
 *   visto_bueno   solicitud que ya aprobó el admin: falta la firma de
 *                 secretaría, que no mueve plata (script 129)
 */
type EstadoBandeja = "pendiente" | "espera_admin" | "espera_secre" | "visto_bueno" | "aprobado" | "rechazado"
type Aprobacion = "pendiente" | "aprobado" | "rechazado"
/** Un paso de la aprobación: el del admin o el de secretaría. "na" = no le tocó. */
interface Paso { estado: Aprobacion | "na"; quien?: string | null; at?: string | null }

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
  revisado_por: number | null
  revisado_por_nombre: string | null
  revisado_at: string | null
  motivo_rechazo: string | null
  created_at: string
  /** Script 129. `undefined` si todavía no se corrió. */
  secretaria_estado?: string | null
  secretaria_por_nombre?: string | null
  secretaria_at?: string | null
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
  /** Qué ES el movimiento; no cambia con la aprobación ni con el rechazo. */
  estatus: string
  /** Venta: Nueva / Renovó-Aumentó / Renovó-Bajó. Pago: Abono / Cancelada. */
  variacion: string
  cuotas: number | null
  mora: number | null
  observacion: string
  fotos: Foto[]
  fecha: string
  estado: EstadoBandeja
  /** El resumen de los dos pasos: rechazado si alguno rechazó, pendiente si falta alguno. */
  aprobacion: Aprobacion
  pasoAdmin: Paso
  pasoSecre: Paso
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
  "Canceló": "#e11d24", "Reconsiderando": "#e11d24",
  "Nuevo": "#16a34a", "Renovación": "#1f6fe0",
  "Sobre límite": "#e8590c", "Sobre umbral": "#e8590c",
}
const VARIACION_COLOR: Record<string, string> = {
  "Nueva": "#16a34a", "Renovó / Aumentó": "#1f6fe0", "Renovó / Bajó": "#e8590c", "Renovó / Igual": "#1d2b5e",
  "Abono": "#0f8a74", "Cancelada": "#e11d24",
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
function ApIcon({ ap, size = 30 }: { ap: Aprobacion; size?: number }) {
  const s = Math.round(size * 0.6)
  if (ap === "aprobado") return <Circle size={size} bg="#0f9f8a"><Check size={s} strokeWidth={3} /></Circle>
  if (ap === "rechazado") return <Circle size={size} bg="#ec2027"><X size={s} strokeWidth={3} /></Circle>
  return <Clock size={size} color="#e8590c" strokeWidth={1.8} />
}
/** Un renglón de la columna de aprobación: quién (Admin / Secretaría) y cómo va. */
function PasoSello({ titulo, paso }: { titulo: string; paso: Paso }) {
  if (paso.estado === "na") {
    return (
      <span className="mr-paso mr-paso--na">
        <span className="mr-paso-na">–</span>
        <span><b>{titulo}</b><small>No aplica</small></span>
      </span>
    )
  }
  const m = AP_META[paso.estado]
  return (
    <span className="mr-paso" style={{ background: m.bg }} title={paso.quien ?? undefined}>
      <ApIcon ap={paso.estado} size={22} />
      <span>
        <b>{titulo} · <i style={{ color: m.color }}>{m.label}</i></b>
        <small>{paso.at ? `${fmtFecha(paso.at)} ${fmtHora(paso.at)}` : "Falta su firma"}</small>
      </span>
    </span>
  )
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
  const [rolUsuario, setRolUsuario] = useState<Map<number, string>>(new Map())
  /** Renovaciones: el valor del crédito anterior del cliente, por solicitud. */
  const [valorAnterior, setValorAnterior] = useState<Map<string, number>>(new Map())
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

      // Quién pidió el gasto de caja (`adminid` es un usuario, script 039) y
      // quién resolvió cada solicitud: su rol dice si firmó el admin o secretaría.
      const uIds = [...new Set([
        ...[...caja.values()].map((m) => m.adminid),
        ...sols.map((s) => s.revisado_por),
      ].filter((x): x is number => x != null))]
      const uMap = new Map<number, string>()
      const rMap = new Map<number, string>()
      if (uIds.length) {
        const { data } = await sb.from("usuarios").select("id, nombre, rol").in("id", uIds)
        for (const u of (data ?? []) as { id: number; nombre: string | null; rol: string | null }[]) {
          uMap.set(u.id, u.nombre ?? `#${u.id}`)
          rMap.set(u.id, (u.rol ?? "").toLowerCase().trim())
        }
      }

      // RENOVÓ / AUMENTÓ O BAJÓ: el valor de la renovación contra el del
      // último crédito del cliente creado ANTES de la solicitud.
      const renov = sols.filter((s) => s.tipo === "venta" && s.subtipo === "renovacion")
      const cliIds = [...new Set(renov.map((s) => String((s.payload?.p_cliente as { id?: string } | undefined)?.id ?? "")).filter(Boolean))]
      const prestamos: { client_id: string; valor: number; fecha_creacion: string }[] = []
      for (let i = 0; i < cliIds.length; i += 150) {
        const { data } = await sb.from("loans").select("client_id, valor, fecha_creacion").in("client_id", cliIds.slice(i, i + 150))
        prestamos.push(...((data ?? []) as typeof prestamos))
      }
      const anterior = new Map<string, number>()
      for (const s of renov) {
        const cli = String((s.payload?.p_cliente as { id?: string } | undefined)?.id ?? "")
        const previo = prestamos
          .filter((l) => l.client_id === cli && l.fecha_creacion < s.created_at)
          .sort((a, b) => b.fecha_creacion.localeCompare(a.fecha_creacion))[0]
        if (previo) anterior.set(s.id, Number(previo.valor) || 0)
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
      setRolUsuario(rMap)
      setValorAnterior(anterior)
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
  /** El resumen de los dos pasos para la columna, los chips y el orden. */
  const resumir = (a: Paso, s: Paso): Aprobacion =>
    a.estado === "rechazado" || s.estado === "rechazado" ? "rechazado"
    : a.estado === "pendiente" || s.estado === "pendiente" ? "pendiente"
    : "aprobado"

  const bandeja = useMemo<ItemBandeja[]>(() => {
    const desdeRevision: ItemBandeja[] = solicitudes
      // Un gasto aprobado ya existe como movimiento real en `gastosregistros`
      // y desde ahí se ve su estado verdadero: mostrar la solicitud lo duplicaría.
      .filter((s) => !(s.tipo === "gasto" && s.estado === "aprobado"))
      .map((s) => {
        const p = s.payload ?? {}
        // LOS DOS PASOS. La solicitud la resuelve el primero que llega; si fue
        // el admin y la aprobó, secretaría todavía tiene que dar su firma.
        const resuelta = s.estado !== "pendiente"
        const decision: Aprobacion = s.estado === "rechazado" ? "rechazado" : "aprobado"
        const porAdmin = resuelta && ROLES_ADMIN.has(s.revisado_por != null ? rolUsuario.get(s.revisado_por) ?? "" : "")
        const firmaSecre = s.secretaria_estado
        let pasoAdmin: Paso
        let pasoSecre: Paso
        if (!resuelta) {
          pasoAdmin = { estado: "pendiente" }
          pasoSecre = { estado: "pendiente" }
        } else if (porAdmin) {
          pasoAdmin = { estado: decision, quien: s.revisado_por_nombre, at: s.revisado_at }
          pasoSecre =
            firmaSecre === "aprobado" || firmaSecre === "rechazado"
              ? { estado: firmaSecre, quien: s.secretaria_por_nombre, at: s.secretaria_at }
              // Lo histórico (antes del 129) y lo que el admin rechazó no le toca.
              : firmaSecre === "NA" || decision === "rechazado" ? { estado: "na" }
              : { estado: "pendiente" }
        } else {
          // La resolvió secretaría directamente: esa es la única firma.
          pasoAdmin = { estado: "na" }
          pasoSecre = { estado: decision, quien: s.revisado_por_nombre, at: s.revisado_at }
        }
        const estado: EstadoBandeja =
          !resuelta ? "pendiente"
          : decision === "rechazado" || pasoSecre.estado === "rechazado" ? "rechazado"
          : pasoSecre.estado === "pendiente" ? "visto_bueno"
          : "aprobado"
        const base = {
          key: `sr:${s.id}`,
          origen: "revision" as const,
          tipo: s.tipo,
          rutaId: s.ruta_id,
          solicitante: s.solicitado_por_nombre ?? D,
          monto: Number(s.monto ?? 0),
          fecha: s.created_at,
          estado,
          aprobacion: resumir(pasoAdmin, pasoSecre),
          pasoAdmin,
          pasoSecre,
          solicitud: s,
        }
        const resuelto: [string, string][] = !resuelta ? [] : [
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
          const esRenov = s.subtipo === "renovacion"
          const previo = valorAnterior.get(s.id)
          const monto = Number(s.monto ?? 0)
          const variacion = !esRenov ? "Nueva"
            : previo == null ? "Renovó"
            : monto > previo ? "Renovó / Aumentó"
            : monto < previo ? "Renovó / Bajó"
            : "Renovó / Igual"
          return {
            ...base,
            etiqueta: "Venta",
            estatus: esRenov ? "Renovación" : "Nuevo",
            variacion,
            cuotas: Number(loan.numero_cuotas) || null,
            mora: null,
            // La venta no lleva nota del vendedor.
            observacion: "",
            fotos,
            detalle: [
              ["Cliente", s.descripcion ?? D],
              ...(esRenov && previo != null ? [["Crédito anterior", formatearMoneda(previo, rutas.get(s.ruta_id)?.moneda)] as [string, string]] : []),
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
          const cancela = g?.tipo === "cancelacion"
          return {
            ...base,
            etiqueta: "Pago",
            estatus: cancela ? "Canceló" : "Reconsiderando",
            variacion: cancela ? "Cancelada" : "Abono",
            cuotas: g?.num_cuotas ?? null,
            mora: g?.loan_id ? moraPorLoan.get(g.loan_id) ?? null : null,
            // Solo la nota que escribió quien cobró; el motivo del sistema va al detalle.
            observacion: (g?.observacion ?? "").trim(),
            fotos: foto,
            detalle: [["Por qué entró a revisión", g?.motivo_revision || s.descripcion || D], ...resuelto],
          }
        }
        // Gasto / ingreso / retiro por el umbral de la ruta.
        const tipoReal = String((p as { tipo?: string }).tipo ?? "Gasto")
        return {
          ...base,
          etiqueta: tipoReal,
          estatus: "Sobre umbral",
          variacion: tipoReal,
          cuotas: null,
          mora: null,
          observacion: String((p as { observacion?: string }).observacion ?? "").trim(),
          fotos: (p as { foto?: string }).foto ? [{ url: String((p as { foto?: string }).foto), label: "Comprobante" }] : [],
          detalle: [["Concepto", String((p as { concepto?: string }).concepto ?? D)], ...resuelto],
        }
      })

    const desdeCaja: ItemBandeja[] = movimientos.map((m) => {
      const paso = (estado: string, quien: string | null, at: string | null): Paso =>
        estado === "por aprobar" ? { estado: "pendiente" }
        : estado === "aprobado" || estado === "rechazado" ? { estado, quien, at }
        : { estado: "na" }
      const pasoAdmin = paso(m.estadoadmin, m.adminaprobo, m.fechahoraaproboadm)
      // Secretaría puede haber firmado mientras esperaba al admin: su firma
      // queda en `secretariaaprobo` con `estadosecre` todavía en 'NA'.
      const pasoSecre = m.estadosecre === "NA" && m.secretariaaprobo
        ? { estado: "aprobado" as const, quien: m.secretariaaprobo, at: m.fechahoraaprobosecretaria }
        : paso(m.estadosecre, m.secretariaaprobo, m.fechahoraaprobosecretaria)
      const estado: EstadoBandeja =
        m.estadoadmin === "rechazado" || m.estadosecre === "rechazado" ? "rechazado"
        : m.estadoadmin === "por aprobar" ? "espera_admin"
        : m.estadosecre === "por aprobar" ? "espera_secre"
        : "aprobado"
      return {
        key: `gr:${m.id}`,
        origen: "caja",
        tipo: "gasto",
        etiqueta: m.tipo || "Gasto",
        rutaId: m.ruta,
        solicitante: (m.adminid != null ? usuarios.get(m.adminid) : null) ?? D,
        monto: Number(m.valor ?? 0),
        // Pasó al admin porque superó el límite de su ítem; si no, vino por
        // el umbral de la ruta.
        estatus: m.estadoadmin !== "NA" ? "Sobre límite" : "Sobre umbral",
        variacion: m.tipo || "Gasto",
        cuotas: null,
        mora: null,
        observacion: (m.observacion ?? "").trim(),
        fotos: m.foto ? [{ url: m.foto, label: "Comprobante" }] : [],
        fecha: m.fechahorasol,
        estado,
        aprobacion: resumir(pasoAdmin, pasoSecre),
        pasoAdmin,
        pasoSecre,
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
  }, [solicitudes, movimientos, gestiones, moraPorLoan, usuarios, rolUsuario, valorAnterior, rutas])

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

  // ── Acciones ───────────────────────────────────────────────────────────
  // La firma de secretaría (espera_secre, visto_bueno) es SOLO de secretaría:
  // si el admin pudiera ponerla, aprobar él bloquearía de nuevo la revisión
  // de ella, que es justo lo que se pidió corregir (06-oct-2026).
  const accionable = (i: ItemBandeja) =>
    i.estado === "pendiente" || i.estado === "espera_admin" ||
    (!esAdmin && (i.estado === "espera_secre" || i.estado === "visto_bueno"))
  /** El visto bueno sobre lo que el admin ya aprobó no se rechaza: la plata ya se aplicó (eso se corrige con una reversa). */
  const rechazable = (i: ItemBandeja) => accionable(i) && i.estado !== "visto_bueno"
  /** Lo que se puede aprobar sin confirmación aparte. */
  const directo = (i: ItemBandeja) => accionable(i) && !(i.estado === "espera_admin" && !esAdmin)

  /**
   * Deja la firma de secretaría en la solicitud (script 129). Si el script no
   * se corrió todavía, la aprobación ya quedó hecha igual: solo se avisa en
   * consola, para no tumbar algo que ya movió plata.
   */
  const firmarSecretaria = async (s: Solicitud, decision: "aprobado" | "rechazado", nombre: string) => {
    const { error } = await createClient().from("solicitudes_revision")
      .update({ secretaria_estado: decision, secretaria_por_nombre: nombre, secretaria_at: new Date().toISOString() })
      .eq("id", s.id)
    if (error) console.warn("[v0] No se pudo dejar la firma de secretaría (¿falta el script 129?):", error.message)
  }

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
    if (i.estado === "visto_bueno") {
      // El admin ya la aprobó y la plata ya está aplicada: secretaría solo firma.
      // La guarda `is null` evita pisar la firma si dos pantallas lo hacen a la vez.
      const { data, error } = await createClient().from("solicitudes_revision")
        .update({ secretaria_estado: "aprobado", secretaria_por_nombre: nombre, secretaria_at: new Date().toISOString() })
        .eq("id", s.id).eq("estado", "aprobado").is("secretaria_estado", null).select("id")
      if (error) throw new Error(/secretaria_/.test(error.message) ? "Falta correr el script 129 en Supabase" : error.message)
      if (!data || data.length === 0) throw new Error("Este movimiento ya fue firmado por otra persona")
      return
    }
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
        // Si aprueba el admin, el gasto entra con la firma de secretaría
        // pendiente; si aprueba secretaría, ya entra firmado.
        ...(esAdmin ? { esperaSecretaria: true } : { aprobadoPorSecretaria: nombre }),
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
      // Si aprobó secretaría, esa es su firma; si fue el admin, queda esperándola.
      if (!esAdmin) await firmarSecretaria(s, "aprobado", nombre)
    }
  }

  const aprobar = async (i: ItemBandeja) => {
    setActionKey(i.key)
    try {
      await aprobarUno(i)
      setSeleccion((p) => { const n = new Set(p); n.delete(i.key); return n })
      toast({
        title: i.estado === "espera_admin" && !esAdmin ? "Aprobado en lugar del admin"
          : i.estado === "visto_bueno" ? "Firma de secretaría registrada" : "Movimiento aprobado",
      })
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
      if (i.solicitud && !esAdmin) await firmarSecretaria(i.solicitud, "rechazado", nombre)
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
    "Ícono / Evento", "Núm. / Unidad", "Solicitante", "Valor", "Estatus", "Variación", "Cuotas", "Mora", "Observación",
    <>Adjuntos /<br />Evidencia</>, "Acciones", "Fecha y hora", <>Aprobación<br />Admin · Secretaría</>,
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
                    <span className="mr-cell mr-cell--var" style={{ color: VARIACION_COLOR[i.variacion] ?? "#d1191f" }}>{i.variacion || D}</span>
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
                      <button type="button" className="mr-round mr-round--rech" disabled={!rechazable(i) || busy || aprobandoLote}
                        onClick={() => { setRechazo(i); setMotivo("") }} aria-label="Rechazar"><X size={22} strokeWidth={2.6} /></button>
                      <button type="button" className="mr-round" disabled={!accionable(i) || busy || aprobandoLote}
                        style={{ background: i.aprobacion === "aprobado" ? "#0d6b6b" : "#c4c9d0" }}
                        onClick={() => pedirAprobar(i)} aria-label="Aprobar"
                        title={i.estado === "espera_admin" && !esAdmin ? "Aprobar en lugar del admin"
                          : i.estado === "visto_bueno" ? "Firmar como secretaría" : "Aprobar"}>
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
                    <span className="mr-cell mr-cell--pasos">
                      <PasoSello titulo="Admin" paso={i.pasoAdmin} />
                      <PasoSello titulo="Secretaría" paso={i.pasoSecre} />
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
              <span>Variación</span><b style={{ color: VARIACION_COLOR[detalle.variacion] }}>{detalle.variacion || D}</b>
              {([["Admin", detalle.pasoAdmin], ["Secretaría", detalle.pasoSecre]] as [string, Paso][]).map(([k, p]) => (
                <span key={k} style={{ display: "contents" }}>
                  <span>{k}</span>
                  <b style={{ color: p.estado === "na" ? undefined : AP_META[p.estado].color }}>
                    {p.estado === "na" ? "No aplica" : AP_META[p.estado].label}{p.quien ? ` · ${p.quien}` : ""}
                  </b>
                </span>
              ))}
              {detalle.cuotas != null && (<><span>Cuotas</span><b>{detalle.cuotas}</b></>)}
              {detalle.mora != null && (<><span>Mora</span><b>{detalle.mora} cuotas</b></>)}
              <span>Observación</span><b>{detalle.observacion || D}</b>
              {detalle.detalle.map(([k, v]) => (<span key={k} style={{ display: "contents" }}><span>{k}</span><b>{v}</b></span>))}
            </div>
            <div className="mr-modal-actions">
              <button type="button" className="mr-btn mr-btn--sec" onClick={() => setDetalle(null)}>Cerrar</button>
              {accionable(detalle) && (
                <>
                  {rechazable(detalle) && (
                    <button type="button" className="mr-btn mr-btn--danger" disabled={actionKey === detalle.key}
                      onClick={() => { setRechazo(detalle); setMotivo("") }}>Rechazar</button>
                  )}
                  <button type="button" className="mr-btn mr-btn--ok" disabled={actionKey === detalle.key}
                    onClick={() => pedirAprobar(detalle)}>
                    {actionKey === detalle.key ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                    {detalle.estado === "espera_admin" && !esAdmin ? "Aprobar en lugar del admin"
                      : detalle.estado === "visto_bueno" ? "Firmar como secretaría" : "Aprobar"}
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
