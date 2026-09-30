"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
 import { createClient } from "@/lib/supabase/client"
import type { SupabaseClient } from "@supabase/supabase-js"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  MapPin,
  RefreshCw,
  Calendar as CalendarIcon,
  Banknote,
  CheckCircle2,
  XCircle,
  Clock,
  MapPinOff,
  Loader2,
  Route,
  AlertTriangle,
  ShieldCheck,
  TrendingUp,
  Receipt,
  Wallet,
  ShoppingCart,
  ReceiptText,
  Eye,
  Filter,
  Snowflake,
  Unlock,
  Target,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { habilitarCierreAtrasado, puedeDescongelar } from "@/lib/jornada-pendiente"
import { fmtFecha } from "@/lib/colombia-date"
import { DetalleClientesDialog } from "@/components/detalle-clientes-dialog"
import { PagosDelDiaDialog, type FuentePagos } from "@/components/pagos-del-dia-dialog"
import {
  todayColombia,
  horaColombia,
  colapsarPorCliente,
  type TipoGestion,
} from "@/lib/gestion-core"
import type { MapPoint } from "./admin-route-monitor-map"

// Map is dynamically imported so Leaflet does not try to run during SSR.
const AdminRouteMonitorMap = dynamic(() => import("./admin-route-monitor-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] w-full items-center justify-center rounded-xl bg-muted/40 shadow-steel">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  ),
})

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────
type MonitoreoRuta = {
  /**
   * El id de la fila de `rutas_diarias`. Es lo que hace falta para
   * DESCONGELAR: `descongelarJornada` cierra esa jornada por id, no por
   * (ruta, fecha). Viene en la vista; las filas "sin apertura" no lo tienen
   * porque no existe la fila que representarían.
   */
  registro_id: number | null
  /**
   * LA JORNADA VIEJA QUE TIENE CONGELADA A ESTA RUTA, si la hay.
   *
   * Solo se llena en las filas de HOY, y por eso hace falta: la fila que
   * quedó abierta es la de AYER, y el monitoreo abre en el día de hoy. Sin
   * esto, para enterarse de que una ruta está congelada había que acordarse
   * de mover el rango de fechas hacia atrás — o sea, no enterarse.
   */
  jornada_congelada: { id: number; fecha: string } | null
  /**
   * Creditos de la ruta que DEBEN plata pero ya no tienen cuotas por delante:
   * su cronograma se agoto. Mientras esten asi no suman a la meta del dia
   * —la meta cuenta las cuotas que vencen ese dia y ellos no tienen ninguna—
   * y el cobrador les cobra plata que nunca estuvo en el objetivo.
   */
  cronogramas_agotados: number
  ruta_id: number
  estado_ruta: "abierta" | "cerrada" | string | null
  aprobacion_admin: "pendiente" | "aprobado" | string | null
  total_recaudado: number | null
  /** Script 071: la plata que entró POR LA CALLE. Es la que responde el
   *  cobrador y la que se muestra acá. */
  recaudo_campo: number | null
  /** El resto: correcciones de secretaría sobre cuotas de otros días. Es
   *  plata real, pero no se recaudó hoy ni en esta ruta. No se esconde —
   *  se muestra aparte para que el número de arriba sea el del cobrador. */
  recaudo_ajuste: number | null
  pagos_exitosos: number | null
  visitas_sin_pago: number | null
  /** Script 060: la CARTERA de esa ruta ese día que quedó sin gestionar —
   *  todo el que debía, no solo el que vencía. Es lo mismo que ve el cobrador
   *  en su lista. */
  pendientes_por_visitar: number | null
  /** Denominador: sin él, "48 pendientes" no dice si la ruta va atrasada o si
   *  simplemente tiene 300 clientes. */
  cartera_activa: number | null
  /** Lo que esta tarjeta contaba ANTES: solo las cuotas que vencen ese día.
   *  Se conserva porque explica la diferencia entre los dos números. */
  cuotas_vencen_hoy: number | null
  total_ingresos: number | null
  total_gastos: number | null
  total_retiros: number | null
  total_ventas: number | null
  cantidad_ventas: number | null
  /** Parte de `total_ventas` que son ventas homologadas (script 057). Esa
   *  plata no salio de la caja de hoy: entro en el sistema anterior. */
  total_ventas_homologadas: number | null
  cantidad_ventas_homologadas: number | null
  fecha: string | null
  /**
   * La caja con la que la ruta EMPEZÓ el día y con la que lo TERMINÓ.
   *
   * No salen de `vista_monitoreo_admin` —no las tiene— sino de
   * `resumen_diario_v2`, que las calcula como parte del cierre:
   *
   *   caja final = caja inicial + recaudo + ingresos − gastos − retiros − ventas
   *
   * Comprobado contra la base: cuadra en las 25 filas de los últimos cuatro
   * días, sin una sola diferencia.
   *
   * LA CADENA ENTERA SALE DE ESA MISMA VISTA, no de las columnas del
   * monitoreo. Dos detalles la romperían si se mezclaran: el recaudo de acá
   * es `valor_pago` (con ajustes) y no `recaudo_campo`, y las ventas que
   * descuentan de la caja son `valor_ventas_caja` y no `total_ventas`, que
   * incluye las homologadas —plata que nunca pasó por esta caja—. Tomando
   * todo del mismo sitio, el informe siempre suma.
   */
  caja: {
    inicial: number
    recaudo: number
    ingresos: number
    gastos: number
    retiros: number
    ventas: number
    final: number
  } | null
  /**
   * LA META DEL DÍA y lo recaudado contra ella. De `resumen_diario_v2`, la
   * MISMA fila que muestra el Resumen del Día del cobrador (`meta_pagos` vs
   * `valor_pago`): así el monitoreo y el teléfono dicen el mismo porcentaje.
   */
  meta: { meta: number; recaudo: number } | null
}

type FinancialMovement = {
  id: number
  fechahorasol: string | null
  concepto: string | null
  valor: number | null
  observacion?: string | null
  tipo?: string | null
}

type SaleRow = {
  id: string
  created_at: string | null
  /** Capital prestado: es lo que vale la VENTA. */
  valor: number | null
  /** Total del contrato (capital + interes). No es el valor de la venta. */
  valor_a_pagar: number | null
  numero_cuotas: number | null
  clients?: {
    nombre_completo?: string | null
    apodo?: string | null
  } | null
}

/**
 * Un movimiento de la ruta = UN evento del libro `gestiones`.
 *
 * Antes esto era una fila de `payment_plan` ordenada por `fecha_pago_real`.
 * Esa columna ya no se escribe: el instante real de cada visita vive en
 * `gestiones.fecha_hora` y el día de negocio en `gestiones.fecha_gestion`.
 * Las coordenadas del cobrador también quedan en el evento.
 */
type GestionRow = {
  id: string
  loan_id: string
  tipo: TipoGestion
  monto: number | null
  fecha_gestion: string | null
  fecha_hora: string | null
  latitud: number | null
  longitud: number | null
  loans?: {
    id: string
    clients?: {
      nombre_completo?: string | null
      apodo?: string | null
      documento?: string | null
    } | null
  } | null
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
const formatCurrency = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString()}`

const formatHora = (iso: string | null) => horaColombia(iso)

/**
 * CÓMO VA LA META DE UNA RUTA.
 *
 * Mientras la jornada está EN CURSO no se juzga en rojo: a las diez de la
 * mañana faltan horas de cobro (la misma regla del Resumen del Día). Se
 * muestra el avance en azul y cuánto falta. Con el día terminado —cerrada o
 * un día pasado— sí: verde si llegó, rojo si no.
 */
function estadoMeta(m: { meta: number; recaudo: number }, terminado: boolean) {
  const pct = m.meta > 0 ? (m.recaudo / m.meta) * 100 : 0
  const cumplida = m.meta > 0 && m.recaudo >= m.meta
  const color = cumplida
    ? "var(--success)"
    : terminado
      ? "var(--destructive)"
      : pct >= 50
        ? "var(--info)"
        : "var(--warning)"
  return { pct, cumplida, falta: Math.max(0, m.meta - m.recaudo), color }
}

// `estadoVisual` vivía acá y traducía el tipo de UN evento al vocabulario de
// la pantalla. Ya no hace falta: las filas son de un CLIENTE, no de un evento,
// y `colapsarPorCliente` decide el estado mirando el día completo.

/** Eventos que representan una visita del cobrador en el terreno. */
const ES_VISITA: TipoGestion[] = ["pago", "no_pago", "cancelacion", "abono_venta"]

const COLUMNAS_MOVIMIENTO =
  "id, loan_id, tipo, monto, fecha_gestion, fecha_hora, latitud, longitud, " +
  "loans:loans(id, clients:clients(nombre_completo, apodo, documento))"

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────
/** Quiénes ven TODAS las rutas. El resto ve las suyas y nada más. */
const ROLES_QUE_VEN_TODO = new Set(["admin", "administrador"])

interface AdminRouteMonitorProps {
  /**
   * Quién está mirando. Sin esto la pantalla mostraba todas las rutas a
   * cualquiera que tuviera el módulo habilitado — ver `rutasPermitidas`.
   */
  currentUser?: { id: number | string; rol?: string | null; nombre?: string | null } | null
}

export function AdminRouteMonitor({ currentUser }: AdminRouteMonitorProps) {
  const { toast } = useToast()
  /**
   * EL PERÍODO. Arranca en un solo día —hoy— así que sin tocar nada el módulo
   * se comporta como siempre.
   *
   * `hasta` es la fecha "de referencia" para lo que necesita UNA fecha y no un
   * rango (aprobar un cierre, abrir el mapa). Pero ojo: casi todo eso debe
   * usar la fecha DE LA FILA, no esta. Con una sola fecha daba igual; con un
   * rango, confundirlas abre el día equivocado.
   */
  const [desde, setDesde] = useState<string>(todayColombia())
  const [hasta, setHasta] = useState<string>(todayColombia())
  const esUnSoloDia = desde === hasta

  // Filtros. "" = sin filtrar.
  const [fPais, setFPais] = useState("")
  const [fCiudad, setFCiudad] = useState("")
  const [fAdmin, setFAdmin] = useState("")
  const [fUnidad, setFUnidad] = useState("")

  /** Ficha de cada ruta: para los filtros y para mostrar ciudad y país. */
  const [rutasMeta, setRutasMeta] = useState<
    { id: number; nombre: string | null; ciudad: string | null; pais: string | null; idadmin: number | null }[]
  >([])
  const [adminsMeta, setAdminsMeta] = useState<{ id: number; nombre: string }[]>([])
  /**
   * Qué le toca mostrar a la tabla de clientes, o `null` si está cerrada.
   *
   * Se guarda el objeto entero y no un par de banderas: el efecto que carga
   * los datos depende de él, así que construirlo en línea en el JSX crearía
   * uno nuevo en cada render y la consulta entraría en bucle.
   */
  const [pagosDialog, setPagosDialog] = useState<FuentePagos | null>(null)
  const [rutas, setRutas] = useState<MonitoreoRuta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * LAS RUTAS QUE ESTA PERSONA PUEDE VER.
   *
   * `null` = todas (es admin). Un arreglo = solo esas.
   *
   * Esta pantalla se escribió para el admin, que ve la operación entera, y la
   * consulta salía sin filtro de ruta. Pero el módulo se puede habilitar por
   * usuario, y al hacerlo un cobrador de la 190 veía también la 151: su
   * recaudo, sus clientes y su cierre. Es el mismo agujero que el resto de la
   * app cierra con `.eq('ruta', ...)`, que acá faltaba.
   *
   * El admin NO se filtra por sus rutas asignadas a propósito: los dos admins
   * tienen rutas puestas (1,2 y 197) y filtrarlos los dejaría viendo dos
   * rutas de diez.
   */
  const [rutasPermitidas, setRutasPermitidas] = useState<number[] | null>(null)
  const [resolviendoPermiso, setResolviendoPermiso] = useState(true)

  useEffect(() => {
    let vigente = true
    const resolver = async () => {
      const rol = (currentUser?.rol ?? "").toLowerCase()
      if (ROLES_QUE_VEN_TODO.has(rol)) {
        if (vigente) { setRutasPermitidas(null); setResolviendoPermiso(false) }
        return
      }
      if (!currentUser?.id) {
        // Sin sesión identificable no se muestra nada. Antes se mostraba todo,
        // que es exactamente al revés de como conviene equivocarse.
        if (vigente) { setRutasPermitidas([]); setResolviendoPermiso(false) }
        return
      }
      try {
        const { data } = await createClient()
          .from("usuario_rutas")
          .select("ruta_id")
          .eq("usuario_id", currentUser.id)
        if (!vigente) return
        setRutasPermitidas(((data ?? []) as { ruta_id: number }[]).map((r) => r.ruta_id))
      } catch (e) {
        console.error("[v0] No se pudieron leer las rutas del usuario:", e)
        if (vigente) setRutasPermitidas([])
      } finally {
        if (vigente) setResolviendoPermiso(false)
      }
    }
    resolver()
    return () => { vigente = false }
  }, [currentUser?.id, currentUser?.rol])

  // La ficha de las rutas no cambia con la fecha: se pide una sola vez.
  useEffect(() => {
    let vigente = true
    const cargar = async () => {
      try {
        const supabase = createClient()
        const [rs, us] = await Promise.all([
          supabase.from("rutas").select("id, nombre, ciudad, pais, idadmin").order("id"),
          supabase.from("usuarios").select("id, nombre"),
        ])
        if (!vigente) return
        setRutasMeta((rs.data ?? []) as typeof rutasMeta)
        setAdminsMeta((us.data ?? []) as { id: number; nombre: string }[])
      } catch (e) {
        console.error("[v0] No se pudo cargar la ficha de rutas:", e)
      }
    }
    void cargar()
    return () => { vigente = false }
  }, [])

  /**
   * Los días del período, uno por uno.
   *
   * TOPE DE 62. Un rango escrito de más —o un año tecleado sin querer en el
   * campo de fecha— dispararía cientos de consultas contra producción. Se
   * corta y se avisa en pantalla, en vez de dejar la app colgada.
   */
  const diasDelRango = useMemo(() => {
    const out: string[] = []
    if (!desde || !hasta || desde > hasta) return out
    const d = new Date(`${desde}T12:00:00Z`)
    const fin = new Date(`${hasta}T12:00:00Z`)
    while (d <= fin && out.length < 62) {
      out.push(d.toISOString().slice(0, 10))
      d.setUTCDate(d.getUTCDate() + 1)
    }
    return out
  }, [desde, hasta])

  const metaDe = useCallback(
    (id: number) => rutasMeta.find((r) => r.id === id) ?? null,
    [rutasMeta],
  )

  /**
   * Los países y ciudades vienen escritos a mano y sin criterio: la base tiene
   * "ARGENTINA" y "Argentina", "LA PLATA" y "La Plata". Si se agruparan tal
   * cual, el filtro ofrecería la misma ciudad dos veces y ninguna de las dos
   * traería todas sus rutas. Se agrupa en minúsculas y se muestra bonito.
   */
  const clave = (v: string | null | undefined) => (v ?? "").trim().toLowerCase()
  const bonito = (v: string) =>
    v.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")

  const opciones = useMemo(() => {
    const unicos = (vals: (string | null)[]) => {
      const m = new Map<string, string>()
      for (const v of vals) {
        const k = clave(v)
        if (k && !m.has(k)) m.set(k, bonito(v as string))
      }
      return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "es"))
    }
    // Cada filtro ofrece solo lo que sigue siendo alcanzable con los otros
    // puestos: elegir Argentina y que después aparezca Cuenca sería ofrecer
    // un camino que no lleva a nada.
    const base = rutasMeta.filter(
      (r) =>
        (!fPais || clave(r.pais) === fPais) &&
        (!fCiudad || clave(r.ciudad) === fCiudad) &&
        (!fAdmin || String(r.idadmin ?? "") === fAdmin),
    )
    return {
      paises: unicos(rutasMeta.map((r) => r.pais)),
      ciudades: unicos(
        rutasMeta.filter((r) => !fPais || clave(r.pais) === fPais).map((r) => r.ciudad),
      ),
      admins: [
        ...new Map(
          rutasMeta
            .filter((r) => r.idadmin != null)
            .map((r) => [
              String(r.idadmin),
              adminsMeta.find((a) => a.id === r.idadmin)?.nombre ?? `Usuario ${r.idadmin}`,
            ]),
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1], "es")),
      unidades: base.map((r) => [String(r.id), `#${r.id}${r.nombre ? ` · ${r.nombre}` : ""}`] as const),
    }
  }, [rutasMeta, adminsMeta, fPais, fCiudad, fAdmin])

  const hayFiltro = Boolean(fPais || fCiudad || fAdmin || fUnidad)

  const rutasFiltradas = useMemo(
    () =>
      rutas.filter((r) => {
        if (fUnidad && String(r.ruta_id) !== fUnidad) return false
        const m = metaDe(r.ruta_id)
        if (fPais && clave(m?.pais) !== fPais) return false
        if (fCiudad && clave(m?.ciudad) !== fCiudad) return false
        if (fAdmin && String(m?.idadmin ?? "") !== fAdmin) return false
        return true
      }),
    [rutas, metaDe, fPais, fCiudad, fAdmin, fUnidad],
  )

  const limpiarFiltros = () => { setFPais(""); setFCiudad(""); setFAdmin(""); setFUnidad("") }

  // Dialog state
  const [selectedRuta, setSelectedRuta] = useState<MonitoreoRuta | null>(null)
  const [detalle, setDetalle] = useState<GestionRow[]>([])
  const [loadingDetalle, setLoadingDetalle] = useState(false)
  // Token monotonico para descartar respuestas obsoletas / concurrentes.
  // Cada llamada a openDetalle incrementa el token; las respuestas con
  // token distinto al actual son ignoradas (evita race conditions).
  const fetchTokenRef = useRef(0)

  // Tracks which ruta_id is currently being approved (for per-card loading state)
  const [approvingRutaId, setApprovingRutaId] = useState<number | null>(null)

  // ── DESCONGELAR UNA RUTA ────────────────────────────────────────────────
  // `porDescongelar` es la fila que está esperando confirmación. No se
  // descongela de un toque: cerrar una jornada sin cuadrarla deja ese día sin
  // cierre para siempre, y acá hay una fila por ruta y por día — un dedo
  // torcido en el teléfono no puede costar el cierre de un día.
  type Descongelable = { ruta: MonitoreoRuta; jornada: { id: number; fecha: string } }
  const [porDescongelar, setPorDescongelar] = useState<Descongelable | null>(null)
  const [descongelandoId, setDescongelandoId] = useState<number | null>(null)
  const puedeDescongelarRutas = puedeDescongelar(currentUser?.rol)

  // Financial details dialog state ("Detalle de Caja")
  const [cajaRuta, setCajaRuta] = useState<MonitoreoRuta | null>(null)
  const [cajaLoading, setCajaLoading] = useState(false)
  const [gastosList, setGastosList] = useState<FinancialMovement[]>([])
  const [ingresosList, setIngresosList] = useState<FinancialMovement[]>([])
  const [retirosList, setRetirosList] = useState<FinancialMovement[]>([])
  const [ventasList, setVentasList] = useState<SaleRow[]>([])

  // El ojito de Pendientes: quiénes son los que quedaron sin gestionar.
  const [cartera, setCartera] = useState<{ titulo: string; subtitulo: string; ids: string[] } | null>(null)
  const [cargandoCartera, setCargandoCartera] = useState<number | null>(null)

  /**
   * LAS RUTAS QUE NO SALEN EN LA VISTA.
   *
   * `vista_monitoreo_admin` solo devuelve filas de rutas que ese día abrieron
   * jornada o registraron algo. Una ruta que nadie tocó simplemente NO APARECE
   * — y ahí está el problema: en el monitoreo se ve igual que si no existiera.
   *
   * La auditoría del 26/08 lo destapó: la 933 llevaba nueve días sin un solo
   * movimiento con 48 clientes vivos, y la 154 once días con 15. Ninguna de
   * las dos salía en pantalla. Lo que no se ve no se reclama.
   *
   * Se agregan acá, con estado "Sin apertura".
   *
   * SOLO LAS QUE TIENEN CARTERA VIVA. Una ruta sin un solo crédito activo no
   * está "sin abrir": no tiene nada que hacer, y llenar la pantalla de esas
   * todos los días enseña a ignorar la lista entera.
   *
   * Los pendientes salen de `cartera_del_dia`, la MISMA función que abre el
   * ojito. Si acá se pusiera el número de créditos activos a secas, la
   * tarjeta y la lista podrían decir cosas distintas — que es justo lo que un
   * monitoreo no se puede permitir. Si la función falla, la fila entra igual
   * sin ese número: perder el contador es mejor que perder la ruta.
   */
  const rutasSinApertura = useCallback(
    async (supabase: SupabaseClient, presentes: MonitoreoRuta[]): Promise<MonitoreoRuta[]> => {
      try {
        // La llave es ruta + día: una ruta puede haber abierto el lunes y no
        // el martes, y las dos filas tienen que existir.
        const yaEstan = new Set(presentes.map((r) => `${r.ruta_id}|${r.fecha ?? ""}`))

        let consulta = supabase.from("loans").select("ruta").eq("estado", "activo")
        if (rutasPermitidas !== null) consulta = consulta.in("ruta", rutasPermitidas)
        const { data, error } = await consulta
        if (error) throw error

        const conCartera = new Set(
          ((data ?? []) as { ruta: number | null }[])
            .map((l) => Number(l.ruta))
            .filter((r) => Number.isFinite(r)),
        )
        // Cuántos créditos vivos tiene cada ruta. Es el respaldo cuando no se
        // puede preguntar día por día.
        const activosPorRuta = new Map<number, number>()
        for (const l of (data ?? []) as { ruta: number | null }[]) {
          const r = Number(l.ruta)
          if (Number.isFinite(r)) activosPorRuta.set(r, (activosPorRuta.get(r) ?? 0) + 1)
        }

        const faltantes: { ruta_id: number; dia: string }[] = []
        for (const dia of diasDelRango) {
          for (const ruta_id of [...conCartera].sort((a, b) => a - b)) {
            if (!yaEstan.has(`${ruta_id}|${dia}`)) faltantes.push({ ruta_id, dia })
          }
        }
        if (faltantes.length === 0) return []

        return await Promise.all(
          faltantes.map(async ({ ruta_id, dia }) => {
            let cartera: number | null = activosPorRuta.get(ruta_id) ?? null
            let pendientes: number | null = null
            // `cartera_del_dia` solo se consulta con UN día a la vista. En un
            // rango serían días × rutas llamadas —una semana con cuatro rutas
            // caídas son veintiocho— y el módulo tardaría más de lo que vale
            // el dato. En rango la fila igual aparece y dice "Sin apertura",
            // que es lo que se pidió ver.
            if (esUnSoloDia) {
              try {
                const { data: c } = await supabase.rpc("cartera_del_dia", {
                  p_ruta_id: ruta_id,
                  p_fecha: dia,
                })
                const cs = (c ?? []) as { gestionado: boolean }[]
                cartera = cs.length
                pendientes = cs.filter((x) => !x.gestionado).length
              } catch (e) {
                console.error("[v0] cartera_del_dia (sin apertura):", e)
              }
            }
            return {
              // No hay fila en `rutas_diarias`: esa es toda la noticia de esta
              // fila sintética. Sin id no hay nada que descongelar.
              registro_id: null,
              jornada_congelada: null,
              cronogramas_agotados: 0,
              ruta_id,
              // `null` es lo que dispara la insignia "Sin apertura".
              estado_ruta: null,
              aprobacion_admin: null,
              total_recaudado: 0,
              recaudo_campo: 0,
              recaudo_ajuste: 0,
              pagos_exitosos: 0,
              visitas_sin_pago: 0,
              pendientes_por_visitar: pendientes,
              cartera_activa: cartera,
              cuotas_vencen_hoy: null,
              total_ingresos: 0,
              total_gastos: 0,
              total_retiros: 0,
              total_ventas: 0,
              cantidad_ventas: 0,
              total_ventas_homologadas: 0,
              cantidad_ventas_homologadas: 0,
              fecha: dia,
              caja: null,
              meta: null,
            } satisfies MonitoreoRuta
          }),
        )
      } catch (err) {
        console.error("[v0] rutasSinApertura:", err)
        return []
      }
    },
    [diasDelRango, esUnSoloDia, rutasPermitidas],
  )

  // ── Load routes for the selected date ─────────────────────────────────────
  // SELECT sobre `vista_monitoreo_admin` por fecha Y POR LAS RUTAS QUE ESTA
  // PERSONA PUEDE VER. No hay RLS: si no se filtra acá, no lo filtra nadie.
  const fetchRutas = useCallback(async () => {
    // Todavía no se sabe qué puede ver: no se consulta. Un instante sin datos
    // es preferible a un instante mostrando rutas ajenas.
    if (resolviendoPermiso) return
    try {
      setLoading(true)
      setError(null)
      const supabase = createClient()

      let consulta = supabase
        .from("vista_monitoreo_admin")
        .select("*")
        .gte("fecha", desde)
        .lte("fecha", hasta)
        .order("fecha", { ascending: false })
        .order("ruta_id", { ascending: true })

      // `null` = admin, ve todas. Un arreglo = solo esas. Vacío = ninguna, y
      // `.in()` con lista vacía devuelve cero filas, que es lo correcto.
      if (rutasPermitidas !== null) consulta = consulta.in("ruta_id", rutasPermitidas)

      const { data, error } = await consulta

      if (error) {
        console.error("[v0] vista_monitoreo_admin error:", error.message)
        setError(error.message)
        setRutas([])
        return
      }
      const filas = (data ?? []) as MonitoreoRuta[]
      const todas = [...filas, ...(await rutasSinApertura(supabase, filas))]

      // LA CAJA. Va aparte porque `vista_monitoreo_admin` no la trae: vive en
      // `resumen_diario_v2`, que es donde se calcula el cierre. Se pide para
      // TODO el período de una sola vez y se pega por ruta y día.
      //
      // Se pide después de armar las filas —incluidas las "sin apertura"— a
      // propósito: una ruta que nadie abrió igual tiene caja, y esconderla
      // sería justo perder el dato que explica por qué no se movió. La 154
      // lleva $809.000 quietos hace once días.
      try {
        let caja = supabase
          .from("resumen_diario_v2")
          .select(
            "ruta, fecha_pago, caja_anterior, efectivo, valor_pago, meta_pagos, " +
              "valor_ingresos, valor_gastos, valor_retiros, valor_ventas_caja",
          )
          .gte("fecha_pago", desde)
          .lte("fecha_pago", hasta)
        if (rutasPermitidas !== null) caja = caja.in("ruta", rutasPermitidas)
        const { data: cajaRows, error: cajaErr } = await caja
        if (cajaErr) throw cajaErr
        const porDia = new Map<string, MonitoreoRuta["caja"]>()
        const metaPorDia = new Map<string, MonitoreoRuta["meta"]>()
        for (const c of (cajaRows ?? []) as Record<string, unknown>[]) {
          metaPorDia.set(`${c.ruta}|${String(c.fecha_pago).slice(0, 10)}`, {
            meta: Number(c.meta_pagos) || 0,
            recaudo: Number(c.valor_pago) || 0,
          })
          porDia.set(`${c.ruta}|${String(c.fecha_pago).slice(0, 10)}`, {
            inicial: Number(c.caja_anterior) || 0,
            recaudo: Number(c.valor_pago) || 0,
            ingresos: Number(c.valor_ingresos) || 0,
            gastos: Number(c.valor_gastos) || 0,
            retiros: Number(c.valor_retiros) || 0,
            ventas: Number(c.valor_ventas_caja) || 0,
            final: Number(c.efectivo) || 0,
          })
        }
        for (const r of todas) {
          r.caja = porDia.get(`${r.ruta_id}|${r.fecha ?? ""}`) ?? null
          r.meta = metaPorDia.get(`${r.ruta_id}|${r.fecha ?? ""}`) ?? null
        }
      } catch (e) {
        // Que falle la caja no puede tumbar el monitoreo entero: las filas ya
        // están armadas y se muestran sin ese par de cifras.
        console.error("[v0] caja del monitoreo:", e)
      }

      /**
       * QUÉ RUTAS ESTÁN CONGELADAS HOY.
       *
       * Una ruta se congela cuando le quedó una jornada ABIERTA en un día
       * pasado. Esa fila vive en el pasado, así que en el monitoreo —que abre
       * en hoy— no se ve. La marca se pega en las filas de HOY, que son las
       * que la secretaría está mirando cuando alguien le escribe que no puede
       * empezar.
       *
       * Se toma la MÁS VIEJA de cada ruta, igual que `buscarJornadaPendiente`:
       * si hay varias hay que ir resolviéndolas en orden, y mostrar la última
       * dejaría las anteriores escondidas detrás.
       *
       * Si esta consulta falla no pasa nada más que no ver la marca: el
       * monitoreo se muestra igual. Y si `cerrada_sin_cuadre` todavía no
       * existe —script 086 sin correr— PostgREST responde 42703 y el
       * congelamiento no está en vigor, así que tampoco hay nada que marcar.
       */
      try {
        const hoy = todayColombia()
        if (todas.some((r) => (r.fecha ?? "") === hoy)) {
          let viejas = supabase
            .from("rutas_diarias")
            .select("id, ruta_id, fecha")
            .eq("estado", "abierta")
            .lt("fecha", hoy)
            .order("fecha", { ascending: true })
          if (rutasPermitidas !== null) viejas = viejas.in("ruta_id", rutasPermitidas)
          const { data: pendientes, error: errPend } = await viejas
          if (errPend) throw errPend

          const masVieja = new Map<number, { id: number; fecha: string }>()
          for (const j of (pendientes ?? []) as { id: number; ruta_id: number; fecha: string }[]) {
            // Vienen ordenadas de la más vieja a la más nueva: la primera de
            // cada ruta es la que manda.
            if (!masVieja.has(j.ruta_id)) masVieja.set(j.ruta_id, { id: j.id, fecha: j.fecha })
          }
          for (const r of todas) {
            if ((r.fecha ?? "") !== hoy) continue
            r.jornada_congelada = masVieja.get(r.ruta_id) ?? null
          }
        }
      } catch (e) {
        console.error("[v0] jornadas congeladas del monitoreo:", e)
      }

      // ── CRONOGRAMAS AGOTADOS ────────────────────────────────────────────
      // Creditos que deben plata y ya no tienen ninguna cuota por delante.
      // Se cuenta por ruta para poder avisarlo en la fila de hoy.
      //
      // Un fallo aca NO puede tumbar el monitoreo: es un aviso extra, no el
      // dato principal. Si la consulta falla, el contador queda en 0 y la
      // pantalla se ve como antes.
      try {
        const hoyCol = todayColombia()
        const { data: activos } = await createClient()
          .from("v_loan_financiero")
          .select("loan_id, ruta, saldo")
          .eq("loan_estado", "activo")
          .gt("saldo", 0)
          .limit(5000)

        const porRuta = new Map<number, number>()
        const ids = ((activos ?? []) as { loan_id: string; ruta: number }[]).map((x) => x.loan_id)
        const rutaDe = new Map(
          ((activos ?? []) as { loan_id: string; ruta: number }[]).map((x) => [x.loan_id, x.ruta]),
        )

        // La ultima cuota de cada credito. Se pide en lotes: un `.in()` con
        // miles de UUID revienta la URL de PostgREST en silencio.
        const ultima = new Map<string, string>()
        for (let i = 0; i < ids.length; i += 120) {
          const { data: pp } = await createClient()
            .from("payment_plan")
            .select("loan_id, fecha_pago")
            .in("loan_id", ids.slice(i, i + 120))
            .limit(100000)
          for (const p of (pp ?? []) as { loan_id: string; fecha_pago: string }[]) {
            const prev = ultima.get(p.loan_id)
            if (!prev || p.fecha_pago > prev) ultima.set(p.loan_id, p.fecha_pago)
          }
        }
        for (const [loanId, f] of ultima) {
          if (f < hoyCol) {
            const ruta = rutaDe.get(loanId)
            if (ruta != null) porRuta.set(ruta, (porRuta.get(ruta) ?? 0) + 1)
          }
        }
        for (const r of todas) {
          if ((r.fecha ?? "") !== hoyCol) continue
          r.cronogramas_agotados = porRuta.get(r.ruta_id) ?? 0
        }
      } catch (e) {
        console.error("[v0] cronogramas agotados del monitoreo:", e)
      }

      // El día más reciente arriba; dentro de cada día, por número de ruta.
      todas.sort(
        (a, b) =>
          String(b.fecha ?? "").localeCompare(String(a.fecha ?? "")) || a.ruta_id - b.ruta_id,
      )
      setRutas(todas)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[v0] fetchRutas exception:", msg)
      setError(msg)
      setRutas([])
    } finally {
      setLoading(false)
    }
  }, [desde, hasta, rutasPermitidas, resolviendoPermiso, rutasSinApertura])

  useEffect(() => {
    fetchRutas()
  }, [fetchRutas])

  // ── Approve a closed route (aprobacion_admin → 'aprobado') ────────────────
  const handleAprobarCierre = useCallback(
    async (ruta: MonitoreoRuta) => {
      if (approvingRutaId !== null) return
      try {
        setApprovingRutaId(ruta.ruta_id)
        const supabase = createClient()
        const { error } = await supabase
          .from("rutas_diarias")
          .update({ aprobacion_admin: "aprobado" })
          .eq("ruta_id", ruta.ruta_id)
          // La fecha de la FILA. Con un rango en pantalla, usar la del filtro
          // aprobaría el cierre del día equivocado.
          .eq("fecha", ruta.fecha ?? hasta)

        if (error) {
          console.error("[v0] Error aprobando cierre:", error.message)
          return
        }

        // Optimistic local update + refresh
        setRutas((prev) =>
          prev.map((r) =>
            r.ruta_id === ruta.ruta_id ? { ...r, aprobacion_admin: "aprobado" } : r,
          ),
        )
        await fetchRutas()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[v0] handleAprobarCierre exception:", msg)
      } finally {
        setApprovingRutaId(null)
      }
    },
    [approvingRutaId, hasta, fetchRutas],
  )

  // ── Descongelar una ruta desde el monitoreo ───────────────────────────────
  //
  // DESBLOQUEAR NO CIERRA EL DÍA: habilita al cobrador para que lo cierre él.
  //
  // La jornada vieja queda ABIERTA y marcada, y el cobrador ve esa fecha en su
  // teléfono con el botón para hacer su cierre. Al cerrarlo —con sus números,
  // no sin cuadre— la ruta queda lista para hoy.
  //
  // POR QUÉ NO LA CIERRA LA SECRETARÍA. Porque el que tiene la plata contada
  // en la mano es el cobrador. Cerrar desde el escritorio dejaba ese día sin
  // cuadre para siempre: la ruta se liberaba, pero la jornada nunca tuvo
  // cierre.
  //
  // Si el script 096 todavía no corrió, `habilitarCierreAtrasado` se cae al
  // comportamiento viejo —cerrar sin cuadre— y lo dice en el aviso, para que
  // nadie se quede sin poder desbloquear una ruta por un script pendiente.
  const handleDescongelar = useCallback(
    async ({ ruta, jornada }: Descongelable) => {
      if (descongelandoId !== null) return
      if (!currentUser?.id) {
        toast({
          title: "No se pudo desbloquear",
          description: "No hay sesión con la que dejar constancia de quién la desbloqueó.",
          variant: "destructive",
        })
        return
      }
      setDescongelandoId(jornada.id)
      const r = await habilitarCierreAtrasado(jornada.id, {
        id: currentUser.id,
        nombre: currentUser.nombre || "sin nombre",
      })
      setDescongelandoId(null)
      if (!r.ok) {
        toast({ title: "No se pudo desbloquear", description: r.error, variant: "destructive" })
        return
      }
      setPorDescongelar(null)
      toast({
        title:
          r.modo === "habilitada"
            ? `Ruta ${ruta.ruta_id}: cobrador habilitado`
            : `Ruta ${ruta.ruta_id} desbloqueada sin cuadre`,
        description:
          r.modo === "habilitada"
            ? `Ya puede cerrar la caja del ${fmtFecha(jornada.fecha)} desde su teléfono. Al cerrarla, la ruta queda lista para hoy.`
            : `El ${fmtFecha(jornada.fecha)} quedó cerrado sin cuadre, a tu nombre. Falta correr el script 096.`,
      })
      await fetchRutas()
    },
    [descongelandoId, currentUser?.id, currentUser?.nombre, toast, fetchRutas],
  )

  // ── Detalle de Caja: consultar gastos/ingresos/retiros/ventas ─────────────
  // Usa rango UTC equivalente al día de Colombia (UTC-5): [fechaT05:00Z, fecha+1T05:00Z)
  const fetchFinancialDetails = useCallback(
    async (ruta: MonitoreoRuta) => {
      try {
        setCajaLoading(true)
        setGastosList([])
        setIngresosList([])
        setRetirosList([])
        setVentasList([])
        const supabase = createClient()

        // Rango UTC del día en zona America/Bogota (UTC-5). El día es el DE
        // LA FILA: en un período, cada fila es un día distinto.
        const dia = ruta.fecha ?? hasta
        const startUtc = `${dia}T05:00:00Z`
        const nextDate = new Date(`${dia}T00:00:00Z`)
        nextDate.setUTCDate(nextDate.getUTCDate() + 1)
        const nextYmd = nextDate.toISOString().slice(0, 10)
        const endUtc = `${nextYmd}T05:00:00Z`

        // Paralelo: gastos/ingresos/retiros + ventas
        const [gastosRes, ventasRes] = await Promise.all([
          supabase
            .from("gastosregistros")
            .select("id, fechahorasol, concepto, valor, observacion, tipo")
            .eq("ruta", ruta.ruta_id)
            .gte("fechahorasol", startUtc)
            .lt("fechahorasol", endUtc)
            .order("fechahorasol", { ascending: true }),
          supabase
            .from("loans")
            .select(
              "id, created_at, valor, valor_a_pagar, numero_cuotas, clients:clients(nombre_completo, apodo)",
            )
            .eq("ruta", ruta.ruta_id)
            .gte("created_at", startUtc)
            .lt("created_at", endUtc)
            .order("created_at", { ascending: true }),
        ])

        if (gastosRes.error) {
          console.error("[v0] Error fetching gastosregistros:", gastosRes.error.message)
        } else {
          const rows = (gastosRes.data ?? []) as FinancialMovement[]
          setGastosList(
            rows.filter((r) => (r.tipo ?? "").toLowerCase() === "gasto"),
          )
          setIngresosList(
            rows.filter((r) => (r.tipo ?? "").toLowerCase() === "ingreso"),
          )
          setRetirosList(
            rows.filter((r) => (r.tipo ?? "").toLowerCase() === "retiro"),
          )
        }

        if (ventasRes.error) {
          console.error("[v0] Error fetching ventas:", ventasRes.error.message)
        } else {
          setVentasList((ventasRes.data ?? []) as unknown as SaleRow[])
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[v0] fetchFinancialDetails exception:", msg)
      } finally {
        setCajaLoading(false)
      }
    },
    [hasta],
  )

  const openCajaDetalle = useCallback(
    (ruta: MonitoreoRuta) => {
      setCajaRuta(ruta)
      fetchFinancialDetails(ruta)
    },
    [fetchFinancialDetails],
  )

  const closeCajaDetalle = useCallback(() => {
    setCajaRuta(null)
    setGastosList([])
    setIngresosList([])
    setRetirosList([])
    setVentasList([])
  }, [])

  // ── Load detail for a specific route ──────────────────────────────────────
  // RLS eliminado: las queries filtran por `.eq('ruta', rutaId)` directamente.

  // Los movimientos del día salen del libro de eventos, no del cronograma:
  // `fecha_gestion` es el día de negocio al que aplica la visita y `fecha_hora`
  // el orden real del recorrido. Se excluye `homologacion` (historia migrada de
  // otro sistema) para cuadrar con los contadores de `vista_monitoreo_admin`.
  const fetchGestiones = useCallback(
    // El día llega por parámetro: con un período en pantalla cada fila es un
    // día distinto y no hay "la fecha" del módulo.
    async (rutaId: number, dia: string) => {
      const supabase = createClient()
      return supabase
        .from("gestiones")
        .select(COLUMNAS_MOVIMIENTO)
        .eq("ruta", rutaId)
        .eq("fecha_gestion", dia)
        .eq("estado", "aplicada")
        .neq("origen", "homologacion")
        .order("fecha_hora", { ascending: true })
    },
    [],
  )

  const openDetalle = useCallback(
    async (ruta: MonitoreoRuta) => {
      // Generamos un token nuevo para esta solicitud. Cualquier respuesta vieja
      // que llegue tarde sera descartada.
      const myToken = ++fetchTokenRef.current

      setSelectedRuta(ruta)
      setDetalle([])
      setLoadingDetalle(true)

      try {
        // Primer intento
        let { data, error } = await fetchGestiones(ruta.ruta_id, ruta.fecha ?? hasta)

        // Si el usuario cerro o cambio de ruta mientras tanto, descartar.
        if (fetchTokenRef.current !== myToken) return

        if (error) {
          console.error("[v0] gestiones detalle error:", error.message)
          setDetalle([])
          return
        }

        // Reintento silencioso si la primera respuesta vino vacia: el pool
        // pudo haber devuelto una conexion "fria" sin session vars. Una
        // segunda llamada normalmente sale por una conexion ya calentada.
        if (!data || data.length === 0) {
          // Pequena pausa para dar tiempo a que el RPC anterior haga commit
          await new Promise((r) => setTimeout(r, 120))
          if (fetchTokenRef.current !== myToken) return
          const retry = await fetchGestiones(ruta.ruta_id, ruta.fecha ?? hasta)
          if (fetchTokenRef.current !== myToken) return
          if (retry.error) {
            console.error("[v0] gestiones retry error:", retry.error.message)
          } else if (retry.data && retry.data.length > 0) {
            data = retry.data
          }
        }

        setDetalle((data ?? []) as unknown as GestionRow[])
      } catch (err) {
        if (fetchTokenRef.current !== myToken) return
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[v0] openDetalle exception:", msg)
        setDetalle([])
      } finally {
        if (fetchTokenRef.current === myToken) {
          setLoadingDetalle(false)
        }
      }
    },
    [fetchGestiones, hasta],
  )

  const closeDetalle = useCallback(() => {
    // Invalidar cualquier fetch en vuelo para que su respuesta no toque el estado.
    fetchTokenRef.current++
    setSelectedRuta(null)
    setDetalle([])
    setLoadingDetalle(false)
  }, [])

  // ── El ojito de Pendientes ────────────────────────────────────────────────
  // La lista sale de `cartera_del_dia`, que repite EL MISMO predicado que
  // cuenta la vista (script 060, paso 6 lo verifica). Se listan solo los que
  // quedaron sin gestionar: es exactamente el número sobre el que se hizo
  // clic, así que quien cuente las filas obtiene lo mismo que dice la tarjeta.
  const abrirCartera = useCallback(
    async (r: MonitoreoRuta) => {
      const dia = r.fecha ?? hasta
      setCargandoCartera(r.ruta_id)
      try {
        const { data, error } = await createClient().rpc("cartera_del_dia", {
          p_ruta_id: r.ruta_id,
          p_fecha: dia,
        })
        if (error) throw error
        const filas = (data ?? []) as { loan_id: string; gestionado: boolean }[]
        const pendientes = filas.filter((f) => !f.gestionado).map((f) => f.loan_id)
        setCartera({
          titulo: `Pendientes por visitar · Ruta #${r.ruta_id}`,
          subtitulo: `${pendientes.length} sin gestionar de ${filas.length} en cartera · ${dia}`,
          ids: pendientes,
        })
      } catch (err) {
        // Avisar SIN tocar `error`: esa bandera reemplaza toda la grilla por
        // una tarjeta de fallo, y que un ojito no abra no es motivo para
        // borrarle el monitoreo de la pantalla a quien lo está mirando.
        console.error("[v0] cartera_del_dia:", err)
        toast({
          title: "No se pudo cargar la lista de pendientes",
          description: err instanceof Error ? err.message : "Intenta de nuevo.",
          variant: "destructive",
        })
      } finally {
        setCargandoCartera(null)
      }
    },
    [hasta, toast],
  )

  // Reintenta el fetch para la ruta actualmente abierta (boton "Reintentar"
  // que aparece cuando no hay datos GPS).
  const retryDetalle = useCallback(() => {
    if (selectedRuta) {
      openDetalle(selectedRuta)
    }
  }, [openDetalle, selectedRuta])

  /**
   * UNA FILA POR CLIENTE, no una por papel.
   *
   * `detalle` es el libro crudo del dia. Una tarde de correcciones de
   * secretaria deja diez renglones del mismo cliente, ocho de ellos en cero.
   * `colapsarPorCliente` aplica la MISMA regla que `resumen_diario_v2`
   * (script 070), asi que esta lista y el contador de la tarjeta no pueden
   * discrepar: si la vista dice 13 pagos, aca hay 13 filas.
   *
   * Se le pasa `tieneGps` para que, cuando un cliente tenga varios eventos,
   * la fila se quede con la hora y las coordenadas de la VISITA real y no
   * con las de un ajuste de escritorio posterior.
   */
  const detalleColapsado = useMemo(
    () =>
      colapsarPorCliente(detalle, {
        tieneGps: (e) =>
          typeof e.latitud === "number" &&
          typeof e.longitud === "number" &&
          !Number.isNaN(e.latitud) &&
          !Number.isNaN(e.longitud),
      }),
    [detalle],
  )

  // ── Build ordered list of map points (with valid GPS) ─────────────────────
  /**
   * Cuantas de las gestiones del dia SON una visita.
   *
   * Se separa de `mapPoints` para poder distinguir dos situaciones que antes
   * daban el mismo mensaje: que la ruta no haya trabajado todavia, y que haya
   * trabajado sin GPS. La primera es normal; la segunda hay que mirarla.
   *
   * Cuenta SOLO pago, no_pago y cancelacion. No usa `ES_VISITA`, que ademas
   * incluye `abono_venta`: ese se registra al CREAR la venta, desde el
   * formulario, y nunca trae coordenadas — contarlo haria que una ruta con un
   * abono y nada mas avisara de un problema de GPS que no existe.
   *
   * Las reversas y los ajustes tampoco cuentan, por lo mismo: se registran
   * desde un escritorio corrigiendo algo que ya paso.
   *
   * Ahora cuenta CLIENTES visitados, no eventos: si no, un cobrador que
   * corrige el monto tres veces inflaba el aviso de GPS igual que inflaba
   * el recaudo.
   */
  const TIPOS_CON_GPS: TipoGestion[] = ["pago", "no_pago", "cancelacion"]
  const visitasDelDia = useMemo(
    () =>
      detalleColapsado.filter((r) => TIPOS_CON_GPS.includes(r.representante.tipo))
        .length,
    [detalleColapsado],
  )

  const mapPoints: MapPoint[] = useMemo(() => {
    return detalleColapsado
      .filter((r) => {
        const e = r.representante
        return (
          typeof e.latitud === "number" &&
          typeof e.longitud === "number" &&
          !Number.isNaN(e.latitud) &&
          !Number.isNaN(e.longitud) &&
          ES_VISITA.includes(e.tipo)
        )
      })
      .map((r, idx) => ({
        id: r.representante.id,
        lat: r.representante.latitud as number,
        lng: r.representante.longitud as number,
        estado: r.estado,
        cliente:
          r.representante.loans?.clients?.apodo ||
          r.representante.loans?.clients?.nombre_completo ||
          "Cliente",
        // El NETO del cliente ese dia, no el monto de un evento suelto.
        monto: r.neto,
        hora: formatHora(r.representante.fecha_hora),
        orden: idx + 1,
      }))
  }, [detalleColapsado])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-xl md:text-2xl">
                <Route className="h-5 w-5 text-brand" />
                Monitoreo de Rutas
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Estado de cada ruta, recaudo y seguimiento en mapa
              </p>
            </div>

            <div className="grid grid-cols-2 items-end gap-2 md:flex md:flex-wrap">
              <div className="flex flex-col gap-1">
                <Label htmlFor="desde-monitoreo" className="text-xs text-muted-foreground">
                  Desde
                </Label>
                <div className="relative">
                  <CalendarIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="desde-monitoreo"
                    type="date"
                    value={desde}
                    onChange={(e) => {
                      const v = e.target.value
                      setDesde(v)
                      // Un "desde" posterior al "hasta" no devuelve nada y se
                      // ve como si no hubiera datos. Se arrastra el otro
                      // extremo en vez de dejar el rango imposible.
                      if (v && hasta && v > hasta) setHasta(v)
                    }}
                    className="h-9 w-full pl-8"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="hasta-monitoreo" className="text-xs text-muted-foreground">
                  Hasta
                </Label>
                <div className="relative">
                  <CalendarIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="hasta-monitoreo"
                    type="date"
                    value={hasta}
                    onChange={(e) => {
                      const v = e.target.value
                      setHasta(v)
                      if (v && desde && v < desde) setDesde(v)
                    }}
                    className="h-9 w-full pl-8"
                  />
                </div>
              </div>
              <Button
                variant="outline"
                className="col-span-2 h-9 gap-1.5 md:col-span-1"
                onClick={fetchRutas}
                disabled={loading}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Actualizar
              </Button>
            </div>
          </div>

          {/* Filtros. En dos columnas en el teléfono y en fila en pantalla
              grande: cuatro desplegables uno debajo de otro se comen la
              pantalla antes de llegar a la primera ruta. */}
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/60 pt-3 md:flex md:flex-wrap md:items-center">
            <span className="col-span-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground md:col-span-1">
              <Filter className="h-3.5 w-3.5" />
              Filtrar
            </span>
            {([
              { v: fPais,   set: setFPais,   ph: "País",    ops: opciones.paises },
              { v: fCiudad, set: setFCiudad, ph: "Ciudad",  ops: opciones.ciudades },
              { v: fAdmin,  set: setFAdmin,  ph: "Admin",   ops: opciones.admins },
              { v: fUnidad, set: setFUnidad, ph: "Unidad",  ops: opciones.unidades },
            ] as const).map(({ v, set, ph, ops }) => (
              <Select
                key={ph}
                value={v || "__todas__"}
                onValueChange={(nv) => set(nv === "__todas__" ? "" : nv)}
              >
                <SelectTrigger className="h-8 w-full text-xs md:w-[150px]">
                  <SelectValue placeholder={ph} />
                </SelectTrigger>
                <SelectContent>
                  {/* Un `value=""` no es válido en este Select: se usa un
                      centinela y se traduce al entrar y al salir. */}
                  <SelectItem value="__todas__" className="text-xs">
                    {ph}: todas
                  </SelectItem>
                  {ops.map(([k, label]) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ))}
            {hayFiltro && (
              <Button
                variant="ghost"
                size="sm"
                className="col-span-2 h-8 text-xs md:col-span-1"
                onClick={limpiarFiltros}
              >
                Quitar filtros
              </Button>
            )}
            <span className="col-span-2 text-[11px] text-muted-foreground md:col-span-1 md:ml-auto">
              {rutasFiltradas.length} {rutasFiltradas.length === 1 ? "fila" : "filas"}
              {!esUnSoloDia && ` · ${diasDelRango.length} días`}
              {diasDelRango.length >= 62 && " (tope)"}
            </span>
          </div>
        </CardHeader>
      </Card>

      {/* Route cards grid */}
      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 w-24 rounded bg-muted" />
                <div className="h-4 w-16 rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="h-8 w-32 rounded bg-muted" />
                <div className="mt-3 h-4 w-full rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <XCircle className="h-10 w-10 text-destructive" />
            <p className="font-semibold">No se pudo cargar el monitoreo</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchRutas}>
              Reintentar
            </Button>
          </CardContent>
        </Card>
      ) : rutasFiltradas.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <CalendarIcon className="h-10 w-10 text-muted-foreground" />
            <p className="font-semibold">
              {hayFiltro ? "Ningún resultado con esos filtros" : "Sin rutas en este período"}
            </p>
            <p className="text-sm text-muted-foreground">
              {hayFiltro
                ? "Prueba quitando alguno."
                : esUnSoloDia
                  ? `No hay actividad registrada en ${desde}`
                  : `No hay actividad registrada entre ${desde} y ${hasta}`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-border/60 shadow-steel">
          {/* LA META DE TODAS DE UN VISTAZO. Se cuenta en RUTAS y no en plata:
              cada ruta puede tener su moneda y sumar guaraníes con pesos no
              dice nada. Solo con un día elegido: en un período, cada fila es
              una ruta en un día distinto. */}
          {esUnSoloDia && (() => {
            const conMeta = rutasFiltradas.filter((r) => r.meta && r.meta.meta > 0)
            if (conMeta.length === 0) return null
            const terminado = hasta < todayColombia()
            const estados = conMeta.map((r) =>
              estadoMeta(r.meta!, terminado || (r.estado_ruta ?? "").toLowerCase() === "cerrada"),
            )
            const cumplidas = estados.filter((e) => e.cumplida).length
            const bajas = estados.filter((e) => !e.cumplida && e.pct < 50).length
            const promedio = estados.reduce((s, e) => s + Math.min(100, e.pct), 0) / estados.length
            return (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/30 px-3 py-2 text-xs lg:px-4">
                <span className="flex items-center gap-1.5 font-semibold">
                  <Target className="h-3.5 w-3.5 text-brand" />
                  Meta del día
                </span>
                <span>
                  <b className="text-success">{cumplidas}</b> de {conMeta.length} rutas cumplidas
                </span>
                {bajas > 0 && (
                  <span>
                    <b className="text-warning">{bajas}</b> bajo el 50%
                  </span>
                )}
                <span className="text-muted-foreground">Avance promedio {Math.round(promedio)}%</span>
              </div>
            )
          })()}
          <div className="divide-y divide-border">
            {rutasFiltradas.map((r) => {
              const isAbierta = (r.estado_ruta ?? "").toLowerCase() === "abierta"
              const isCerrada = (r.estado_ruta ?? "").toLowerCase() === "cerrada"

              /**
               * ESTADO DE LA JORNADA — tres casos, no dos.
               *
               * Antes una jornada 'abierta' decía "Abierta" sin mirar la
               * fecha, así que un día pasado en el que la ruta NUNCA cerró
               * caja se leía igual que una ruta trabajando ahora mismo. Son
               * cosas distintas: una está en curso y la otra terminó mal.
               *
               * La auditoría del 26/08 vive de esta diferencia: las rutas 1 y
               * 151 aparecían "Abiertas" cuando lo que pasó es que se
               * quedaron sin cerrar.
               */
              const esHoy = (r.fecha ?? hasta) === todayColombia()

              /**
               * CONGELADA = una jornada de un día pasado que sigue abierta.
               *
               * Antes esto decía "Sin cierre", que es cierto pero cuenta la
               * mitad: además de que ese día no cuadró, la ruta NO PUEDE
               * empezar el día de hoy hasta que se resuelva. Esa es la parte
               * que le importa a quien mira el monitoreo, porque es la que
               * tiene a alguien parado en la calle.
               */
              //
              // La jornada que hay que cerrar para soltar la ruta. Puede ser
              // ESTA fila —un día pasado que sigue abierto— o, en una fila de
              // hoy, la vieja que se marcó al cargar (`jornada_congelada`).
              const jornadaACerrar =
                isAbierta && !esHoy && r.registro_id !== null
                  ? { id: r.registro_id, fecha: r.fecha ?? "" }
                  : r.jornada_congelada
              const congelada = jornadaACerrar !== null

              const FRIA = { clase: "border-0 bg-info text-info-foreground", icono: true }
              const jornada = isCerrada
                ? { texto: "Cerrada", clase: "border-0 bg-success text-success-foreground", icono: false }
                : isAbierta
                  ? esHoy
                    ? { texto: "Abierta", clase: "border-0 bg-info text-info-foreground", icono: false }
                    : { texto: "Congelada", ...FRIA }
                  : congelada
                    ? { texto: "Congelada", ...FRIA }
                    : { texto: "Sin apertura", clase: "border-0 bg-destructive-light text-destructive", icono: false }
              const aprobacion = (r.aprobacion_admin ?? "").toLowerCase()
              const pendienteAprobacion = isCerrada && aprobacion === "pendiente"
              const aprobado = isCerrada && aprobacion === "aprobado"
              const isApproving = approvingRutaId === r.ruta_id
              const pagos = r.pagos_exitosos ?? 0
              const sinPago = r.visitas_sin_pago ?? 0
              const pendientes = r.pendientes_por_visitar ?? 0
              const carteraActiva = r.cartera_activa ?? 0
              const vencenHoy = r.cuotas_vencen_hoy ?? 0
              const cargandoEste = cargandoCartera === r.ruta_id

              return (
                <div
                  key={`${r.ruta_id}-${r.fecha ?? ""}`}
                  /* MÓVIL: tres renglones apretados en vez de cinco bloques
                     apilados. La fila envuelve, el recaudo se va a la derecha
                     del primer renglón, los contadores toman el segundo y los
                     botones el tercero. En pantalla grande no cambia nada:
                     `lg:flex-nowrap` la devuelve a una sola línea. */
                  className={`group relative flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 transition-colors hover:bg-muted/30 lg:flex-nowrap lg:gap-4 lg:px-4 lg:py-4 ${
                    pendienteAprobacion ? "bg-warning/5" : ""
                  }`}
                >
                  {/* Indicador lateral para cierre pendiente */}
                  {pendienteAprobacion && (
                    <span className="absolute inset-y-0 left-0 w-1 bg-warning" aria-hidden />
                  )}

                  {/* Ruta + Estado */}
                  <div className="flex items-center gap-2 lg:w-[190px] lg:shrink-0 lg:gap-3">
                    {/* El círculo del ícono se va en el teléfono: son 40px de
                        ancho que no dicen nada y ahí el ancho es todo. */}
                    <div className="hidden h-10 w-10 items-center justify-center rounded-full bg-brand/10 shrink-0 lg:flex">
                      <Route className="h-5 w-5 text-brand" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {/* Con un período, cada fila es una ruta EN UN DÍA. Sin
                            la fecha, dos filas de la misma ruta se leen como un
                            duplicado. */}
                        {esUnSoloDia ? "Ruta" : (r.fecha ?? "")}
                      </span>
                      {/* `flex-wrap`: con "Sin apertura" y "4 sin cuotas" juntos
                          la fila pasaba de los 190px de la columna y las
                          etiquetas se montaban encima del recaudo. */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-lg font-bold leading-none text-brand lg:text-xl">
                          #{r.ruta_id}
                        </span>
                        <Badge
                          className={`gap-1 ${jornada.clase}`}
                          title={
                            jornada.texto === "Congelada"
                              ? "Esa jornada se abrió y nunca se cerró la caja. Mientras siga así, el cobrador no puede empezar el día de hoy."
                              : jornada.texto === "Sin apertura"
                                ? "Nadie abrió esta ruta ese día: no hubo un solo movimiento"
                                : undefined
                          }
                        >
                          {jornada.icono && <Snowflake className="h-3 w-3" />}
                          {jornada.texto}
                        </Badge>
                        {/* CRONOGRAMAS AGOTADOS.
                            Creditos que deben plata y ya no tienen cuotas por
                            delante. Mientras esten asi no suman a la meta del
                            dia, y el cobrador les cobra plata que nunca
                            estuvo en el objetivo. Es un aviso para
                            secretaria: quien completa el cronograma es ella.
                            Solo sale si hay alguno; en cero no dice nada. */}
                        {esHoy && r.cronogramas_agotados > 0 && (
                          <Badge
                            variant="outline"
                            className="gap-1 border-warning/50 bg-warning/10 text-warning"
                            title={`${r.cronogramas_agotados} ${
                              r.cronogramas_agotados === 1 ? "crédito tiene" : "créditos tienen"
                            } saldo pendiente pero ya no les quedan cuotas por cobrar. Mientras estén así no cuentan en la meta del día: hay que completarles el cronograma.`}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {r.cronogramas_agotados} sin cuotas
                          </Badge>
                        )}
                      </div>
                      {metaDe(r.ruta_id)?.ciudad && (
                        <span className="text-[10px] leading-tight text-muted-foreground">
                          {bonito(metaDe(r.ruta_id)!.ciudad as string)}
                        </span>
                      )}
                      {pendienteAprobacion && (
                        <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-warning">
                          <AlertTriangle className="h-3 w-3" />
                          Pendiente aprobación
                        </span>
                      )}
                      {aprobado && (
                        <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-success">
                          <ShieldCheck className="h-3 w-3" />
                          Cierre auditado
                        </span>
                      )}
                      {/* EL ESTADO Y SU REMEDIO, JUNTOS.
                          El botón va acá y no en la fila de acciones de la
                          derecha: ahí sería el cuarto, y a 1280px con los tres
                          de siempre le robaba el ancho a los contadores hasta
                          montarlos encima de la caja. Esta columna tiene ancho
                          fijo (190px) y sitio de sobra hacia abajo, y además
                          se lee mejor — el problema y lo que se hace con él,
                          uno debajo del otro. */}
                      {congelada && jornadaACerrar && (
                        <>
                          <span className="mt-1 inline-flex items-start gap-1 text-[10px] font-semibold leading-tight text-info">
                            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                            <span>
                              Sin cerrar el {fmtFecha(jornadaACerrar.fecha)} — el cobrador no puede
                              empezar
                            </span>
                          </span>
                          {puedeDescongelarRutas && (
                            <Button
                              size="sm"
                              className="mt-1.5 h-7 w-full gap-1.5 bg-info text-info-foreground hover:bg-info/90"
                              onClick={() => setPorDescongelar({ ruta: r, jornada: jornadaACerrar })}
                              disabled={descongelandoId !== null}
                            >
                              {descongelandoId === jornadaACerrar.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Unlock className="h-3.5 w-3.5" />
                              )}
                              <span className="text-xs">Habilitar cierre</span>
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Recaudo — EL DEL COBRADOR.
                      Antes acá iba `total_recaudado`, que mezcla la plata de
                      la calle con las correcciones que secretaría escribe ese
                      día sobre cuotas de OTROS días. Por eso la 151 marcaba
                      1.103.500 un día en que el cobrador recaudó 341.500.
                      Arriba va lo que él responde; los ajustes se muestran
                      debajo, en pequeño, para que no desaparezcan. */}
                  {/* `ml-auto` lo manda al extremo derecho del primer renglón
                      en el teléfono; en pantalla grande vuelve a su columna. */}
                  <div className="ml-auto flex flex-col items-end lg:ml-0 lg:w-[185px] lg:shrink-0 lg:items-start">
                    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <Banknote className="h-3 w-3" />
                      Recaudo
                    </span>
                    <span className="text-base font-bold tabular-nums text-foreground lg:text-lg">
                      {formatCurrency(r.recaudo_campo)}
                    </span>
                    {Number(r.recaudo_ajuste) !== 0 && (
                      <span
                        className="text-[11px] tabular-nums text-muted-foreground"
                        title="Correcciones de secretaría sobre cuotas de otros días. No es plata que haya entrado hoy por la calle."
                      >
                        {Number(r.recaudo_ajuste) > 0 ? "+" : "−"}
                        {formatCurrency(Math.abs(Number(r.recaudo_ajuste)))} en ajustes
                      </span>
                    )}

                    {/* CAJA INICIAL → CAJA FINAL.
                        Van acá, pegadas al recaudo, y no en el cuadro
                        financiero: ese cuadro no se muestra en el teléfono, y
                        con qué plata abrió y cerró la ruta es de lo primero
                        que se mira.

                        En rojo cuando la caja queda NEGATIVA. No es un adorno:
                        hoy la 151 está en −$18.300 y la 933 en −$217, y en un
                        renglón de cifras grises eso pasa desapercibido. */}
                    {r.caja && (
                      <span
                        className="mt-0.5 flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground"
                        title="Con cuánta plata abrió la ruta ese día y con cuánta lo cerró. El desglose completo está en Detalle de Caja."
                      >
                        <span className="uppercase tracking-wide">Caja</span>
                        <span className={r.caja.inicial < 0 ? "font-semibold text-destructive" : ""}>
                          {formatCurrency(r.caja.inicial)}
                        </span>
                        <span aria-hidden>→</span>
                        <span
                          className={
                            r.caja.final < 0
                              ? "font-semibold text-destructive"
                              : "font-semibold text-foreground"
                          }
                        >
                          {formatCurrency(r.caja.final)}
                        </span>
                      </span>
                    )}

                    {/* LA META DEL DÍA: barra, porcentaje y cuánto falta.
                        Es lo que se pidió para "darse cuenta a tiempo": una
                        ruta en 20% a mediodía se ve desde acá, sin abrirla. */}
                    {r.meta && r.meta.meta > 0 && (() => {
                      const e = estadoMeta(r.meta, isCerrada || !esHoy)
                      return (
                        <div
                          className="mt-1 w-full min-w-[150px] lg:w-[170px]"
                          title={`Meta del día ${formatCurrency(r.meta.meta)} · recaudado ${formatCurrency(r.meta.recaudo)} (lo mismo que ve el cobrador en su Resumen del Día)`}
                        >
                          <div className="flex items-center justify-between gap-1 text-[10px] tabular-nums">
                            <span className="flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
                              <Target className="h-3 w-3" />
                              Meta {formatCurrency(r.meta.meta)}
                            </span>
                            <span className="font-bold" style={{ color: e.color }}>{Math.round(e.pct)}%</span>
                          </div>
                          <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${Math.min(100, e.pct)}%`, background: e.color }}
                            />
                          </div>
                          <span className="text-[10px] tabular-nums" style={{ color: e.cumplida ? e.color : undefined }}>
                            {e.cumplida
                              ? "Meta cumplida"
                              : isCerrada || !esHoy
                                ? `Quedó faltando ${formatCurrency(e.falta)}`
                                : `Falta ${formatCurrency(e.falta)}`}
                          </span>
                        </div>
                      )
                    })()}
                    {r.meta && r.meta.meta <= 0 && (
                      <span className="mt-0.5 text-[10px] text-muted-foreground">Sin meta ese día</span>
                    )}
                  </div>

                  {/* Gestión: Pagos / Sin Pago / Pendientes */}
                  <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 lg:w-auto lg:flex-1 lg:min-w-0 lg:gap-x-4">
                    {/* Los dos contadores abren la MISMA tabla que el ojito
                        de Pagos en el Resumen del Día: nombre con apodo, la
                        plata, las cuotas, el saldo y el ojo de historial. Se
                        pidió "poder ver quiénes fueron esos pagos y no pagos"
                        y esa tabla ya existía. */}
                    <button
                      type="button"
                      onClick={() =>
                        setPagosDialog({
                          tipo: "dia", rutaId: r.ruta_id, fecha: r.fecha ?? hasta,
                          modo: "pagos", titulo: `Pagos · ruta ${r.ruta_id}`,
                        })
                      }
                      disabled={pagos === 0}
                      title={pagos === 0 ? "Sin pagos ese día" : `Ver los ${pagos} clientes que pagaron`}
                      className="flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-success/10 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <span className="text-sm font-bold tabular-nums text-foreground">{pagos}</span>
                      <span className="text-[11px] text-muted-foreground">Pagos</span>
                      {/* El ojito. Va DENTRO del boton y no al lado como en el
                          Resumen: aca el contador entero ya es el area que se
                          toca, y meter un boton dentro de otro es HTML
                          invalido. Se ve igual y el dedo tiene mas sitio. */}
                      <Eye
                        className={`h-3 w-3 shrink-0 ${
                          pagos === 0 ? "text-muted-foreground/30" : "text-muted-foreground"
                        }`}
                        aria-hidden
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPagosDialog({
                          tipo: "dia", rutaId: r.ruta_id, fecha: r.fecha ?? hasta,
                          modo: "no_pagos", titulo: `No pagos · ruta ${r.ruta_id}`,
                        })
                      }
                      disabled={sinPago === 0}
                      title={sinPago === 0 ? "Sin no pagos ese día" : `Ver los ${sinPago} clientes visitados que no pagaron`}
                      className="flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-destructive/10 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <XCircle className="h-4 w-4 text-destructive" />
                      <span className="text-sm font-bold tabular-nums text-foreground">{sinPago}</span>
                      <span className="text-[11px] text-muted-foreground">Sin Pago</span>
                      <Eye
                        className={`h-3 w-3 shrink-0 ${
                          sinPago === 0 ? "text-muted-foreground/30" : "text-muted-foreground"
                        }`}
                        aria-hidden
                      />
                    </button>
                    {/* Pendientes = CARTERA sin gestionar, no solo las cuotas
                        que vencen hoy. El denominador va al lado porque "48
                        pendientes" a secas no dice si la ruta va atrasada o si
                        simplemente tiene 300 clientes. */}
                    <button
                      type="button"
                      onClick={() => void abrirCartera(r)}
                      disabled={cargandoEste || pendientes === 0}
                      title={
                        pendientes === 0
                          ? "Sin pendientes"
                          : `Ver los ${pendientes} clientes sin gestionar (${vencenHoy} con cuota que vence hoy)`
                      }
                      className="flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-brand/10 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      {cargandoEste ? (
                        <Loader2 className="h-4 w-4 animate-spin text-brand" />
                      ) : (
                        <Clock className="h-4 w-4 text-brand" />
                      )}
                      <span className="text-sm font-bold tabular-nums text-foreground">
                        {pendientes}
                        {carteraActiva > 0 && (
                          <span className="font-normal text-muted-foreground"> / {carteraActiva}</span>
                        )}
                      </span>
                      <span className="text-[11px] text-muted-foreground">Pendientes</span>
                      {pendientes > 0 && <Eye className="h-3.5 w-3.5 text-brand/70" />}
                    </button>
                    {vencenHoy > 0 && (
                      <span
                        className="text-[11px] text-muted-foreground"
                        title="De la cartera, cuántas cuotas tienen vencimiento justo hoy"
                      >
                        {vencenHoy} vencen hoy
                      </span>
                    )}
                  </div>

                  {/* Resumen Financiero */}
                  {/* EN EL TELEFONO TAMBIEN SE MUESTRA.
                      Antes iba `hidden` y solo aparecia en pantalla grande:
                      quien abre el monitoreo desde el celular —que es como se
                      usa en la calle— no veia ingresos, gastos, retiros ni
                      ventas por ninguna parte. Estaban detras de "Detalle de
                      Caja", pero eso son dos toques por ruta y nueve rutas.

                      En movil van en rejilla de 2x2 con la etiqueta encima
                      del valor: apiladas en un renglon cada una no caben en
                      390px sin que el numero se monte sobre el texto. Desde
                      `lg` queda como estaba, en cuatro columnas. */}
                  <div className="grid w-full grid-cols-2 gap-x-3 gap-y-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-[11px] lg:w-auto lg:grid-cols-4 lg:gap-y-0.5 lg:py-1.5 lg:flex-1 lg:min-w-[280px]">
                    <div className="flex flex-col items-start justify-center gap-0">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <TrendingUp className="h-3 w-3 text-success" />
                        Ingresos
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatCurrency(r.total_ingresos)}
                      </span>
                    </div>
                    <div className="flex flex-col items-start justify-center gap-0">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Receipt className="h-3 w-3 text-destructive" />
                        Gastos
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatCurrency(r.total_gastos)}
                      </span>
                    </div>
                    <div className="flex flex-col items-start justify-center gap-0">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Wallet className="h-3 w-3 text-brand-secondary" />
                        Retiros
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatCurrency(r.total_retiros)}
                      </span>
                    </div>
                    <div className="flex flex-col items-start justify-center gap-0">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <ShoppingCart className="h-3 w-3 text-brand" />
                        Ventas
                      </span>
                      <span
                        className="inline-flex items-center gap-1 font-semibold tabular-nums text-foreground"
                        title={
                          (r.cantidad_ventas_homologadas ?? 0) > 0
                            ? `Incluye ${r.cantidad_ventas_homologadas} homologada(s) por ${formatCurrency(r.total_ventas_homologadas)}: esa plata no salio de la caja de hoy.`
                            : undefined
                        }
                      >
                        {formatCurrency(r.total_ventas)}
                        {(r.cantidad_ventas ?? 0) > 0 && (
                          <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-brand/10 px-1 text-[9px] font-bold text-brand">
                            {r.cantidad_ventas}
                          </span>
                        )}
                        {/* Las homologadas suman al total de ventas pero NO
                            salieron de la caja: se marcan para que la
                            diferencia con el efectivo se pueda explicar. */}
                        {(r.cantidad_ventas_homologadas ?? 0) > 0 && (
                          <span className="rounded-full bg-violet-100 px-1 text-[9px] font-bold text-violet-700">
                            {r.cantidad_ventas_homologadas} hom.
                          </span>
                        )}
                      </span>
                    </div>
                  </div>

                  {/* Acciones */}
                  <div className="flex w-full items-center justify-end gap-1.5 lg:w-auto lg:shrink-0 lg:gap-2">
                    {pendienteAprobacion && (
                      <Button
                        size="sm"
                        className="gap-1.5 bg-brand-secondary text-brand-secondary-foreground hover:bg-brand-secondary/90"
                        onClick={() => handleAprobarCierre(r)}
                        disabled={isApproving}
                      >
                        {isApproving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5" />
                        )}
                        <span className="hidden sm:inline">
                          {isApproving ? "Aprobando..." : "Aprobar Cierre"}
                        </span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => openCajaDetalle(r)}
                    >
                      <ReceiptText className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Detalle de Caja</span>
                    </Button>
                    <Button
                      size="sm"
                      variant={pendienteAprobacion ? "outline" : "default"}
                      className="gap-1.5"
                      onClick={() => openDetalle(r)}
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Ver Mapa</span>
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Detail Dialog */}
      <Dialog open={selectedRuta !== null} onOpenChange={(open) => !open && closeDetalle()}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Route className="h-5 w-5 text-brand" />
              Ruta #{selectedRuta?.ruta_id} · {selectedRuta?.fecha ?? hasta}
            </DialogTitle>
            <DialogDescription>
              Seguimiento cronológico del vendedor, pagos y no pagos registrados.
            </DialogDescription>
          </DialogHeader>

          {loadingDetalle ? (
            <div className="flex h-[420px] items-center justify-center rounded-xl bg-muted/40 shadow-steel">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mapPoints.length > 0 ? (
            <AdminRouteMonitorMap points={mapPoints} />
          ) : (
            /* Dos situaciones distintas que antes decian lo mismo.
               "Sin datos GPS disponibles" sobre una ruta que simplemente no ha
               salido a cobrar se lee como una falla del sistema, y asi lo
               reportan los usuarios. */
            <div className="flex h-[240px] w-full flex-col items-center justify-center gap-2 rounded-xl bg-muted/30 px-4 text-center">
              <MapPinOff className="h-10 w-10 text-muted-foreground" />
              <p className="font-semibold">
                {visitasDelDia === 0 ? "Todavía no hay visitas registradas" : "Visitas sin ubicación"}
              </p>
              <p className="text-sm text-muted-foreground">
                {visitasDelDia === 0
                  ? detalle.length > 0
                    ? "La ruta tiene movimientos de este día, pero ninguno es una visita: las reversas y los ajustes se registran desde un escritorio y no llevan ubicación."
                    : "La jornada está abierta pero no se ha registrado ningún pago ni no pago. El mapa se dibuja con las visitas del día."
                  : `Las ${visitasDelDia} visitas de este día se registraron sin coordenadas. Eso no debería pasar: revisa el GPS del dispositivo del cobrador.`}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 gap-1.5"
                onClick={retryDetalle}
                disabled={loadingDetalle}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingDetalle ? "animate-spin" : ""}`} />
                Reintentar
              </Button>
            </div>
          )}

          {/* Movements table */}
          <div className="mt-4 overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">#</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Monto</TableHead>
                  <TableHead>Hora</TableHead>
                  <TableHead className="text-center">GPS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detalleColapsado.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                      Sin movimientos registrados
                    </TableCell>
                  </TableRow>
                ) : (
                  detalleColapsado.map((fila, idx) => {
                    const r = fila.representante
                    const cliente =
                      r.loans?.clients?.apodo ||
                      r.loans?.clients?.nombre_completo ||
                      "Cliente"
                    const hasGps =
                      typeof r.latitud === "number" && typeof r.longitud === "number"
                    const estado = fila.estado
                    const color =
                      estado === "pagado"
                        ? "bg-success text-success-foreground"
                        : "bg-destructive text-destructive-foreground"
                    // Cuantos papeles hubo detras de esta fila. Se dice, no se
                    // esconde: es la pista de que ese cliente se corrigio.
                    const correcciones = fila.eventos.length
                    return (
                      <TableRow key={fila.loanId}>
                        <TableCell className="font-medium">{idx + 1}</TableCell>
                        <TableCell className="font-medium">
                          {cliente}
                          {correcciones > 1 && (
                            <span
                              className="ml-1 text-[11px] font-normal text-muted-foreground"
                              title={`${correcciones} movimientos en el libro, ya netos`}
                            >
                              ({correcciones} mov.)
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge className={`${color} border-0`}>{estado}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {formatCurrency(fila.neto)}
                        </TableCell>
                        <TableCell>{formatHora(r.fecha_hora) || "—"}</TableCell>
                        <TableCell className="text-center">
                          {hasGps ? (
                            <a
                              href={`https://www.google.com/maps?q=${r.latitud},${r.longitud}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Ubicar en Google Maps"
                            >
                              <MapPin className="mx-auto h-4 w-4 text-success hover:text-success/70" />
                            </a>
                          ) : (
                            <MapPinOff className="mx-auto h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Caja detalle dialog (Gastos / Ingresos / Retiros / Ventas) */}
      <Dialog open={cajaRuta !== null} onOpenChange={(open) => !open && closeCajaDetalle()}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ReceiptText className="h-5 w-5 text-brand" />
              Detalle de Caja · Ruta #{cajaRuta?.ruta_id} · {cajaRuta?.fecha ?? hasta}
            </DialogTitle>
            <DialogDescription>
              Desglose de los movimientos financieros registrados durante la jornada.
            </DialogDescription>
          </DialogHeader>

          {/* DE CUÁNTO A CUÁNTO, Y POR QUÉ.
              La cadena completa, en el orden en que la caja se mueve. No es
              una suma que se arme acá: los siete números vienen de
              `resumen_diario_v2`, y por eso siempre cierran. */}
          {cajaRuta?.caja && (
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                {([
                  ["Caja inicial", cajaRuta.caja.inicial, ""],
                  ["Recaudo", cajaRuta.caja.recaudo, "+"],
                  ["Ingresos", cajaRuta.caja.ingresos, "+"],
                  ["Gastos", cajaRuta.caja.gastos, "−"],
                  ["Retiros", cajaRuta.caja.retiros, "−"],
                  ["Ventas", cajaRuta.caja.ventas, "−"],
                ] as const).map(([label, valor, signo]) => (
                  <div key={label} className="flex items-center justify-between gap-2 sm:flex-col sm:items-start sm:gap-0">
                    <span className="text-muted-foreground">
                      {signo && <span className="mr-0.5 font-semibold">{signo}</span>}
                      {label}
                    </span>
                    <span
                      className={`font-semibold tabular-nums ${
                        valor < 0 ? "text-destructive" : "text-foreground"
                      }`}
                    >
                      {formatCurrency(valor)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  = Caja final
                </span>
                <span
                  className={`text-lg font-bold tabular-nums ${
                    cajaRuta.caja.final < 0 ? "text-destructive" : "text-foreground"
                  }`}
                >
                  {formatCurrency(cajaRuta.caja.final)}
                </span>
              </div>
              {/* Una caja negativa no es un detalle de formato: significa que
                  salió más plata de la que entró y que alguien la puso. */}
              {cajaRuta.caja.final < 0 && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  La caja quedó en negativo: salió más plata de la que entró.
                </p>
              )}
            </div>
          )}

          {cajaLoading ? (
            <div className="flex h-[280px] items-center justify-center rounded-xl bg-muted/30 shadow-steel">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Tabs defaultValue="gastos" className="mt-2">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="gastos" className="gap-1.5">
                  <Receipt className="h-3.5 w-3.5" />
                  <span>Gastos</span>
                </TabsTrigger>
                <TabsTrigger value="ingresos" className="gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" />
                  <span>Ingresos</span>
                </TabsTrigger>
                <TabsTrigger value="retiros" className="gap-1.5">
                  <Wallet className="h-3.5 w-3.5" />
                  <span>Retiros</span>
                </TabsTrigger>
                <TabsTrigger value="ventas" className="gap-1.5">
                  <ShoppingCart className="h-3.5 w-3.5" />
                  <span>Ventas</span>
                </TabsTrigger>
              </TabsList>

              {/* Gastos */}
              <TabsContent value="gastos" className="mt-3">
                <FinancialTable
                  rows={gastosList}
                  emptyMessage="No se registraron gastos en este día"
                  showObservacion
                />
              </TabsContent>

              {/* Ingresos */}
              <TabsContent value="ingresos" className="mt-3">
                <FinancialTable
                  rows={ingresosList}
                  emptyMessage="No se registraron ingresos en este día"
                />
              </TabsContent>

              {/* Retiros */}
              <TabsContent value="retiros" className="mt-3">
                <FinancialTable
                  rows={retirosList}
                  emptyMessage="No se registraron retiros en este día"
                />
              </TabsContent>

              {/* Ventas */}
              <TabsContent value="ventas" className="mt-3">
                <SalesTable rows={ventasList} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* Quiénes son los pendientes por visitar */}
      <DetalleClientesDialog
        open={cartera !== null}
        onOpenChange={(v) => { if (!v) setCartera(null) }}
        titulo={cartera?.titulo ?? ""}
        subtitulo={cartera?.subtitulo}
        loanIds={cartera?.ids ?? []}
      />

      {/* Quiénes fueron los pagos y los no pagos de esa ruta ese día. Es el
          mismo diálogo del Resumen del Día, con la misma tabla. */}
      <PagosDelDiaDialog
        open={pagosDialog !== null}
        onOpenChange={(v) => { if (!v) setPagosDialog(null) }}
        fuente={pagosDialog}
      />

      {/* ── Confirmar que se habilita al cobrador ──────────────────────────
          Dice exactamente qué pasa y qué NO pasa: la jornada no se cierra acá,
          se habilita para que la cierre quien tiene la plata contada. */}
      <Dialog open={porDescongelar !== null} onOpenChange={(v) => { if (!v) setPorDescongelar(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Snowflake className="h-5 w-5 text-info" />
              Habilitar el cierre — ruta {porDescongelar?.ruta.ruta_id}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-1 text-left">
                <p className="text-sm text-foreground">
                  Al cobrador le va a aparecer la jornada del{" "}
                  <span className="font-semibold">{fmtFecha(porDescongelar?.jornada.fecha)}</span> con
                  el botón para hacer el cierre. Cuando lo haga, la ruta queda lista para
                  trabajar hoy.
                </p>
                <div className="rounded-lg border border-info/40 bg-info/10 p-3">
                  <p className="text-[13px] font-semibold text-foreground">
                    Esto NO cierra la caja de ese día.
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                    La cierra el cobrador, que es el que tiene la plata contada — y así ese día
                    queda con sus números en vez de quedar sin cuadre para siempre. Mientras no
                    la cierre, la ruta sigue sin poder empezar hoy.
                  </p>
                </div>
                <p className="text-[12px] text-muted-foreground">
                  Queda registrado que lo habilitaste vos
                  {currentUser?.nombre ? ` (${currentUser.nombre})` : ""} y cuándo.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setPorDescongelar(null)}
              disabled={descongelandoId !== null}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1 gap-1.5 bg-info text-info-foreground hover:bg-info/90"
              onClick={() => porDescongelar && handleDescongelar(porDescongelar)}
              disabled={descongelandoId !== null}
            >
              {descongelandoId !== null ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Unlock className="h-4 w-4" />
              )}
              {descongelandoId !== null ? "Habilitando..." : "Sí, habilitar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Compact financial tables (used inside Detalle de Caja)
// ────────────────────────────────────────────────────────────────────────────
function FinancialTable({
  rows,
  emptyMessage,
  showObservacion = false,
}: {
  rows: FinancialMovement[]
  emptyMessage: string
  showObservacion?: boolean
}) {
  const total = rows.reduce((acc, r) => acc + (Number(r.valor) || 0), 0)

  if (rows.length === 0) {
    return (
      <div className="flex h-[200px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-muted/20 text-center">
        <Receipt className="h-7 w-7 text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Hora</TableHead>
            <TableHead>Concepto</TableHead>
            {showObservacion && <TableHead>Observación</TableHead>}
            <TableHead className="text-right">Valor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="text-xs tabular-nums text-muted-foreground">
                {formatHora(r.fechahorasol) || "—"}
              </TableCell>
              <TableCell className="text-sm font-medium">{r.concepto || "—"}</TableCell>
              {showObservacion && (
                <TableCell className="text-xs text-muted-foreground">
                  {r.observacion || "—"}
                </TableCell>
              )}
              <TableCell className="text-right text-sm font-semibold tabular-nums">
                {formatCurrency(r.valor)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="bg-muted/50">
            <TableCell
              colSpan={showObservacion ? 3 : 2}
              className="text-right text-xs font-bold uppercase tracking-wider text-muted-foreground"
            >
              Total de la sección
            </TableCell>
            <TableCell className="text-right text-base font-bold tabular-nums text-foreground">
              {formatCurrency(total)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}

function SalesTable({ rows }: { rows: SaleRow[] }) {
  // El valor de una venta es el CAPITAL prestado. Antes se sumaba
  // `valor_a_pagar` (capital + interes), asi que este listado no cuadraba con
  // el total de ventas de la tarjeta de arriba ni con "Ventas del dia".
  const total = rows.reduce((acc, r) => acc + (Number(r.valor) || 0), 0)

  if (rows.length === 0) {
    return (
      <div className="flex h-[200px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-muted/20 text-center">
        <ShoppingCart className="h-7 w-7 text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">
          No se registraron ventas en este día
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Hora</TableHead>
            <TableHead>Cliente</TableHead>
            <TableHead className="text-right">Valor Venta</TableHead>
            <TableHead className="text-center">Cuotas</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const cliente = r.clients?.apodo || r.clients?.nombre_completo || "Cliente"
            return (
              <TableRow key={r.id}>
                <TableCell className="text-xs tabular-nums text-muted-foreground">
                  {formatHora(r.created_at) || "—"}
                </TableCell>
                <TableCell className="text-sm font-medium">{cliente}</TableCell>
                <TableCell className="text-right text-sm font-semibold tabular-nums">
                  {formatCurrency(r.valor)}
                </TableCell>
                <TableCell className="text-center text-xs font-bold tabular-nums text-brand">
                  {r.numero_cuotas ?? "—"}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
        <TableFooter>
          <TableRow className="bg-muted/50">
            <TableCell
              colSpan={2}
              className="text-right text-xs font-bold uppercase tracking-wider text-muted-foreground"
            >
              Total ventas ({rows.length})
            </TableCell>
            <TableCell className="text-right text-base font-bold tabular-nums text-foreground">
              {formatCurrency(total)}
            </TableCell>
            <TableCell />
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}
