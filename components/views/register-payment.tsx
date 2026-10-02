"use client"

import type React from "react"
import { Fragment, useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DollarSign, X, Check, Eye, Clock, ArrowLeftRight, Camera, Edit, FileText, History, User, MoreVertical, Receipt, Loader2, CheckCircle2, XCircle, Users, Pencil, Trash2, RefreshCw, ShoppingCart, MapPinOff, MapPin, AlertCircle, Play, Share2, FileDown, ChevronUp, ChevronDown, Banknote, PieChart } from "lucide-react"
import { RutaNoIniciada } from "@/components/views/ruta-no-iniciada"
import { leerAplazados, aplazar, quitarAplazado, horaDeAplazado } from "@/lib/aplazados"
import {
  cargarMovimientosExtracto, fechaCorta, ETIQUETA_MOVIMIENTO,
  type MovimientoExtracto,
} from "@/lib/extracto-cliente"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
// `createClient` ya no se importa directamente: toda interaccion con
  // Supabase: RLS eliminado. `getSupabaseSafe` y `callRpcAtomic` se conservan
  // como atajos delgados sobre `createClient()`.
import { getSupabaseSafe, getSessionIdentity } from "@/lib/api-helper"
import { enviarOEncolar, encolar } from "@/lib/offline-queue"
import { SalesTodayList } from "@/components/views/sales-today-list"
// Helper que centraliza la carga del dashboard: prueba la RPC atomica
// `obtener_dashboard_pagos` primero (inmune al patron PgBouncer) y si no
// esta desplegada cae al modo legacy con multiples SELECTs paralelos.
import {
  loadDashboardPagos,
  inyectarGestionEnCache,
  type DashboardPagosResult,
  type PaymentPlanEntry as DashboardPaymentPlanEntry,
} from "@/lib/dashboard-data"
import { parcharCache } from "@/lib/offline-cache"
import {
  todayColombia,
  ayerColombia,
  ahoraColombiaISO,
  nuevaGestionId,
  resumenDelDia,
  colorMora,
  etiquetaMora,
  montoEfectivo,
  apodoSiAporta,
  type Gestion,
  cuotasConDecimal,
  fmtMoneda,
  mostrarMonto,
  leerMonto,
} from "@/lib/gestion-core"
import { fmtFecha } from "@/lib/colombia-date"
import { getRutaUmbrales, excedeUmbral, MENSAJE_REVISION, type RutaUmbrales } from "@/lib/ruta-umbrales"
import { renderComprobanteImagen, type SeccionComprobante } from "@/lib/imagen-comprobante"
import { CompartirComprobanteDialog } from "@/components/compartir-comprobante-dialog"
import { getUsuarioSesion } from "@/lib/movimientos"
import { obtenerUbicacion, evaluarGeocerca, formatearDistancia, type ResultadoGeocerca, type UbicacionMedida } from "@/lib/geo"
import { useEstadoGps } from "@/lib/use-gps"
import { fotoParaCola } from "@/lib/foto-offline"
import "./register-payment.css"

/**
 * LAS CASILLAS DEL FORMULARIO DE PAGO.
 *
 * Iban en `bg-muted`, que en este tema es un gris-azulado clarísimo
 * (`oklch(0.95 0.012 230)`). En una pantalla al sol, con el teléfono en la
 * mano y de pie en la calle, ese fondo y el blanco de la tarjeta son el mismo
 * color: no se veía dónde empezaba la casilla ni qué decía adentro.
 *
 * Ahora van en azul lleno con letra blanca y en negrilla.
 *
 * EL COLOR VIVE EN `globals.css`, NO ACÁ. Ese archivo pinta TODOS los inputs
 * con `background-color: var(--input) !important` —a propósito, para que los
 * campos se vean iguales en toda la app—, así que una clase de Tailwind sobre
 * el input no hace nada. Las dos excepciones están puestas como
 * `.casilla-info` y `.casilla-escribible` junto a esa regla, que es donde se
 * decide el color de un input.
 */
/** El `$` lo pinta el diseño afuera del campo; `mostrarMonto` ya lo trae. */
const sinSigno = (texto: string) => texto.replace(/^\$\s*/, "")

const CASILLA_INFO = "h-7 md:h-10 text-xs md:text-sm font-bold casilla-info"

/** La misma casilla, pero la que SE ESCRIBE: más oscura, para que el número que se teclea resalte. */
const CASILLA_ESCRIBIBLE = "casilla-escribible"

/**
 * LO QUE SE PROPONE COBRAR, TOPADO CONTRA EL SALDO.
 *
 * Si la cuota es de $1.000 y al cliente le quedan $800, se propone $800: los
 * $200 de más no existen, no se le pueden cobrar y el formulario ya los
 * rebotaba con "el monto excede el saldo" — después de que el cobrador
 * hubiera abierto el pago y leído la cifra en voz alta.
 *
 * Pasa en TODA última cuota que no cierra exacta, que es la mayoría: el
 * redondeo del script 098 deja el residuo en la última, así que la cuota
 * nominal y lo que de verdad se debe casi nunca coinciden ahí.
 *
 * `Math.max(0, ...)` porque un saldo negativo —plata de más aplicada— no
 * puede proponer un cobro en negativo.
 */
function montoAProponer(cuota: number, saldo: number, cuantas = 1): number {
  const pedido = (Number(cuota) || 0) * (Number(cuantas) || 1)
  const debe = Math.max(0, Number(saldo) || 0)
  return Math.min(pedido, debe)
}

// Types matching DB schema
type LoanWithClient = {
  id: string
  client_id: string
  valor: number
  saldo: number
  valor_a_pagar: number
  valor_cuota: number
  tasa_interes: number
  numero_cuotas: number
  frecuencia_pago: string
  tipo_amortizacion: string
  estado: string
  ruta: number
  ordenvisita: number
  dia_semana: string | null
  created_at: string
  clients: {
    nombre_completo: string
    apodo: string | null
    documento: string
  }
}

// El shape de una cuota lo define la capa de datos: aquí solo se usa. Antes
// había una copia local que se desincronizaba con la real.
type PaymentPlanEntry = DashboardPaymentPlanEntry

type DisplayClient = {
  loanId: string
  clientId: string
  /** Como lo llama el cobrador: el apodo si lo tiene, si no el nombre real.
   *  Es lo que va en el recibo, los dialogos y el buscador — NO se le pega el
   *  otro dato encima, o se propagaria a todos esos sitios. */
  nombre: string
  /** El apodo, ya limpio. null si no tiene o si es igual al nombre real. */
  apodo: string | null
  /** El nombre real, SIN el apodo incrustado. Ver `sinApodo`. */
  nombreCompleto: string
  documento: string
  valorVenta: number
  /**
   * Lo que el cliente termina pagando: capital + intereses. Sale de
   * `v_loan_financiero.total_a_pagar`, la misma cuenta de la que sale el
   * saldo, así que no puede discrepar con él.
   *
   * Es distinto de `valorVenta`, que es el capital prestado a secas. Los dos
   * hacen falta en el extracto: uno dice cuánto se le prestó y el otro cuánto
   * va a devolver.
   */
  totalAPagar: number
  /** Lo que lleva pagado del crédito entero (`total_pagado`). */
  abonado: number
  valorCuota: number
  saldo: number
  // Conteos sobre las cuotas BASE del plan (excluyen cuotas extra de
  // extensiones/prorrogas/pagos de hoy). `cuotasExtra` cuenta esas aparte.
  //
  // OJO: en ESTE modulo `cuotasExtra` ya no se muestra en ningun lado — ni en
  // la lista de cobro ni en el recibo. Se conserva porque es parte de la foto
  // financiera del prestamo y lo consumen las pantallas de revision
  // (Auditoria 360 y Control Total), que lo leen de la vista, no de aqui.
  cuotasPagadas: number
  cuotasTotales: number
  cuotasExtra: number
  // True cuando la cuota objetivo esta pendiente Y es la unica pendiente
  // del plan — es decir, resolverla agota el plan de pagos. Inmune a la
  // numeracion y alineado con lo que evalua registrar_pago_atomico.
  esUltimaCuotaPendiente: boolean
  /** El plan se agoto y todavia debe: hay que completarle el cronograma. */
  cronogramaAgotado: boolean
  mora: number
  ultimoPago: number
  ultimoPagoFecha: string
  frecuenciaPago: string
  // tipo_amortizacion del prestamo (raw): suele ser "aleman" | "americano" |
  // null/empty cuando no aplica (cuotas fijas tradicionales). Se renderiza
  // como badge pequeno en el listado mapeado a "Capital" / "Intereses".
  tipoAmortizacion: string | null
  tasaInteres: number
  nextPaymentId: string | null
  // OJO: `nextPaymentCuota` historicamente almacena el MONTO (valor) de la
  // proxima cuota a pagar, NO su numero de cuota. Mantenemos el nombre por
  // compatibilidad. Para saber el ordinal usar `nextPaymentNumero`.
  nextPaymentCuota: number
  // Numero de cuota (1..cuotasTotales) de la proxima cuota pendiente. Se usa
  // para detectar si el cliente esta pagando la ULTIMA cuota (necesario para
  // habilitar la opcion de "Extender Cuotas" en prestamos americanos).
  nextPaymentNumero: number
  // Capital y valor_cuota de la PROXIMA cuota pendiente, precargados desde
  // fetchData para no tener que hacer un SELECT extra al registrar el pago.
  // Esto evita un round-trip que ademas era vulnerable a RLS por session var
  // perdida en otra conexion del pool de PgBouncer.
  nextPaymentCapital: number
  nextPaymentValorCuota: number
  // True cuando la cuota objetivo del cliente es FUTURA (todas las
  // anteriores ya estan gestionadas y la proxima cuota pendiente cae
  // despues de hoy) — o sea, el cliente esta al dia. NO bloquea nada:
  // cobrarle es un pago ADELANTADO, que es valido. Solo gobierna el
  // badge "Prox. pago dd/mm" y el orden (van al final de la lista).
  nextPaymentEsFuturo: boolean
  // Fecha (YYYY-MM-DD) de la cuota objetivo. La usamos para mostrar
  // "Próximo pago el dd/mm" cuando `nextPaymentEsFuturo` es true.
  nextPaymentFecha: string
  ordenvisita: number
  diaSemana: string | null
  valorPrestamo: number
  /** Fecha de la venta (YYYY-MM-DD). Se imprime en el recibo. */
  fechaVenta: string
  // Multa pendiente del prestamo (null si no tiene). Generada automaticamente
  // cuando el cliente cruza el umbral de cuotas en mora configurado por ruta.
  multaPendiente: { id: string; valor: number; cuotasMora: number | null } | null
  // Ubicacion de referencia del cliente para la geocerca. null mientras no
  // haya sido georreferenciado — su proximo cobro se la captura.
  clienteLatitud: number | null
  clienteLongitud: number | null
  // Cuota mas antigua de un dia ANTERIOR que quedo sin gestionar (ni pago ni
  // no pago). Dispara la pregunta "¿a que dia aplico esta gestion?" y es el
  // ancla cuando el cobrador elige aplicarla a ese dia.
  cuotaVencidaId: string | null
  cuotaVencidaFecha: string | null
}

type RegisterPaymentProps = {
  onViewChange: (view: string, data?: any) => void
  currentRutaId?: number
  // `rutaPais` se reenvia al subcomponente NewLoan para que aplique la
  // validacion correcta de digitos de telefono por pais (Colombia=10,
  // Peru=9, etc.). Si no se pasa, NewLoan asume Colombia por default.
  rutaPais?: string
  rutaActivaEstado?: "abierta" | "cerrada" | null
  // `rutaActivaResolved` indica si el padre ya tiene una respuesta
  // definitiva sobre el estado de la ruta (true) o sigue resolviendo
  // (false). Si está en false NO debemos renderizar el guard "Ruta no
  // iniciada" porque produce un flash confuso durante ~500ms en cada
  // recarga; en su lugar mostramos un spinner discreto.
  rutaActivaResolved?: boolean
  onRouteStateChange?: (estado: "abierta" | "cerrada" | null) => void
  /**
   * EL DÍA AL QUE SE REGISTRAN LAS GESTIONES, "YYYY-MM-DD".
   *
   * Casi siempre viene vacío y todo se fecha HOY, como siempre.
   *
   * Trae fecha solo en un caso: la ruta amaneció congelada porque ayer nadie
   * cerró la caja, la secretaría la desbloqueó, y el cobrador está terminando
   * de registrar lo que le faltó de ESE día antes de cerrarlo. Ahí todo lo que
   * registre —pagos, no pagos, ventas— pertenece al día viejo, no a hoy.
   *
   * `fecha_gestion` es el día de negocio al que aplica el evento (CLAUDE.md),
   * así que fecharlo bien es lo único que hace falta: la plata cae en el
   * cierre correcto y el resumen de ese día la cuenta.
   */
  fechaGestion?: string | null
}

/**
 * Quita el apodo de adentro del nombre completo.
 *
 * En muchos registros el apodo (el oficio o el negocio) quedó guardado TAMBIÉN
 * dentro de `nombre_completo`: "EDUARDO MECANICO RODRIGUEZ" con apodo
 * "MECANICO". Mostrar los dos tal cual daría "MECANICO · EDUARDO MECANICO
 * RODRIGUEZ", que es justo el ruido que hace ilegible la lista al sol.
 *
 * Dos salvaguardas para no dejar a nadie sin nombre: si el apodo ES el nombre
 * completo no hay nada que quitar, y si al quitarlo queda una sola palabra se
 * prefiere el original. Ver scripts/diagnostico-nombres-clientes.sql para
 * limpiar el dato de raíz.
 *
 * Vivía dentro de `handleGenerarRecibo`. Salió acá cuando la lista de cobro
 * empezó a mostrar los dos nombres: si el recibo y la lista limpiaran distinto,
 * el papel y la pantalla dirían cosas distintas del mismo cliente.
 */
const sinApodo = (completo: string, apodo: string | null | undefined): string => {
  const a = (apodo ?? "").trim()
  if (!a || a.toLowerCase() === completo.trim().toLowerCase()) return completo
  const escapado = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const limpio = completo
    .replace(new RegExp(escapado, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim()
  return limpio.split(" ").filter(Boolean).length >= 2 ? limpio : completo
}

const frecuenciaLabel = (freq: string) => {
  switch (freq) {
    case "daily": return "Diario"
    case "weekly": return "Semanal"
    case "biweekly": return "Quincenal"
    case "monthly": return "Mensual"
    default: return freq
  }
}

// Get current day of week in Spanish (Colombia timezone)
const getTodayDayName = () => {
  const days = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"]
  const now = new Date()
  const colombiaDate = new Date(now.toLocaleString("en-US", { timeZone: "America/Bogota" }))
  return days[colombiaDate.getDay()]
}

// Check if the payment day matches today
/**
 * ¿Es un iPhone o un iPad?
 *
 * Se usa SOLO para escribir las instrucciones correctas cuando el permiso de
 * ubicación está negado: en iOS no alcanza con volver a pedirlo —Safari no
 * vuelve a preguntar una vez que se dijo que no— y hay que ir a Ajustes. Sin
 * decírselo, el cobrador toca "Solicitar permiso" una y otra vez sin que pase
 * nada.
 *
 * El iPad moderno se identifica como Mac, por eso el segundo chequeo.
 */
const esIOS = () => {
  if (typeof navigator === "undefined") return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

const isPaymentDayToday = (diaSemana: string | null) => {
  if (!diaSemana) return false
  const today = getTodayDayName()
  return diaSemana.toLowerCase() === today
}

/**
 * Una gestión con el lugar donde ocurrió.
 *
 * `Gestion` (gestion-core) no trae coordenadas porque casi nadie las necesita.
 * Acá sí: una corrección tiene que poder repetir el lugar del evento que
 * corrige, o el servidor la toma por una visita sin prueba.
 */
type GestionConUbicacion = Gestion & {
  referencia_gestion_id: string | null
  latitud: number | null
  longitud: number | null
  geocerca_estado: string | null
  geocerca_motivo: string | null
}

type ManagedClient = DisplayClient & {
  /**
   * Qué pasó hoy con este cliente.
   *
   * `aplazado` NO sale del libro de eventos —no hay gestión que lo respalde—:
   * es la marca del teléfono (`lib/aplazados.ts`) convertida en una fila más
   * de esta lista. Se hace así para que el cobrador vea al que dejó pendiente
   * EN SU SITIO de la ruta, entre los que ya resolvió, y no en un apartado al
   * final por el que hay que bajar cinco pantallas.
   */
  gestionTipo: "pago" | "no_pago" | "aplazado"
  gestionHora: string
  /**
   * El instante CRUDO de la gestión, para poder ordenar.
   *
   * `gestionHora` es para leer y no sirve para esto: comparando texto,
   * "12:58 p. m." va después de "01:05 p. m." y la lista quedaría al revés
   * justo en el cambio de mediodía.
   */
  gestionInstante: string
  /** Suma de lo cobrado HOY en este prestamo, no el monto de una sola cuota. */
  valorAbonado: number
  /** Cuantas cuotas cubrio el cobro de hoy. Se imprime en el recibo. */
  cuotasAbonadas: number
  /**
   * Con qué pagó hoy. `null` en un no pago.
   *
   * Existe para poder marcar las transferencias EN LA LISTA. Un cobrador que
   * cuadra su bolsillo al final del día necesita separar lo que recibió en
   * billetes de lo que le entró a la cuenta, y hasta ahora las dos cosas se
   * veían igual: "Pago $20.000".
   */
  metodoPago: "efectivo" | "transferencia" | "mixto" | null
  paymentPlanId?: string
}

// La obtencion de la posicion vive en lib/geo.ts porque Nueva Venta tambien
// la necesita (para dejar la ubicacion de referencia del cliente) y ahi mismo
// esta la regla de la geocerca.

/**
 * EL ANCHO DE CUOTA · PAGADO · SALDO en el extracto.
 *
 * Las tres se reparten lo que sobra despues de la fecha, en partes iguales.
 * Va como constante para que no se desincronicen: si una llevara otro valor,
 * las columnas volverian a quedar descuadradas entre si.
 */
const COL_EXTRACTO = "calc((100% - 54px) / 3)"

export function RegisterPayment({ onViewChange, currentRutaId = 1, rutaPais = "", rutaActivaEstado, rutaActivaResolved = true, onRouteStateChange, fechaGestion }: RegisterPaymentProps) {
  const { toast } = useToast()

  /**
   * EL DÍA DE NEGOCIO DE ESTE MÓDULO.
   *
   * `todayColombia()` salvo cuando se está cerrando una jornada vieja. Todo lo
   * que escribe plata pasa por acá: pagos, no pagos, cancelaciones y el abono
   * de las ventas.
   *
   * Se ignora una fecha de hoy o futura: este módulo escribe en el libro, y no
   * hay gestiones que registrar en un día que no ocurrió.
   */
  const diaDeTrabajo =
    fechaGestion && fechaGestion < todayColombia() ? fechaGestion : todayColombia()
  const esDiaAtrasado = diaDeTrabajo !== todayColombia()

  // ── Managed-today state (loaded from Supabase payment_plan) ──
  const [managedToday, setManagedToday] = useState<ManagedClient[]>([])
  // "pendientes" es la pestaña de la RUTA (así se llama por dentro desde
  // siempre; en pantalla dice "Ruta"). "aplazados" es la de los que quedaron
  // para después, que en pantalla dice "Pendientes".
  const TAB_ORDER: Array<"pendientes" | "aplazados" | "gestionados" | "ventas"> =
    ["pendientes", "aplazados", "gestionados", "ventas"]
  const [activeTab, setActiveTab] = useState<"pendientes" | "aplazados" | "gestionados" | "ventas">("pendientes")

  /**
   * Los que hoy quedaron PARA DESPUÉS. Ni pago ni no pago: no pasó nada
   * todavía y hay que volver. Ver `lib/aplazados.ts`.
   */
  // `loanId → hora`. La hora se muestra en la tarjeta de Gestionados, donde
  // todas las demás la llevan.
  const [aplazados, setAplazados] = useState<Map<string, string>>(new Map())
  // Los aplazados son del DIA DE TRABAJO: cerrando una jornada vieja, los que
  // se dejaron "para despues" ese dia son los que valen, no los de hoy.
  useEffect(() => { setAplazados(leerAplazados(currentRutaId, diaDeTrabajo)) }, [currentRutaId, diaDeTrabajo])

  /**
   * DE GESTIONADO A PENDIENTE.
   *
   * Es "me equivoqué, este quedó a medias": se anula la gestión —con su
   * reversa, como manda el libro— y el cliente queda marcado para volver a
   * visitarlo. Sin esto había que anular, buscarlo otra vez en la ruta y
   * aplazarlo: tres pasos para deshacer uno.
   *
   * El orden importa. Primero la anulación, que es la que puede fallar (red,
   * revisión de secretaría); la marca de aplazado se pone solo si el servidor
   * aceptó. Al revés, un cliente con la gestión intacta aparecería además en
   * Pendientes.
   */
  const gestionadoAPendiente = async (m: ManagedClient) => {
    await handleDeleteManagedPayment(m)
    setAplazados(new Map(aplazar(currentRutaId, m.loanId, diaDeTrabajo)))
  }

  const marcarAplazado = (client: DisplayClient) => {
    setAplazados(new Map(aplazar(currentRutaId, client.loanId, diaDeTrabajo)))
    toast({
      title: "Queda pendiente",
      description: `${client.nombre} pasó a la pestaña Pendientes para volver a visitarlo.`,
    })
  }

  const devolverALaRuta = (client: DisplayClient) => {
    setAplazados(new Map(quitarAplazado(currentRutaId, client.loanId, diaDeTrabajo)))
    toast({ title: "Vuelve a la ruta", description: `${client.nombre} salió de Pendientes.` })
  }
  // Conteo de ventas registradas HOY en la ruta. Lo recibimos via callback
  // desde `<SalesTodayList>` para evitar duplicar la query y mostrarlo en
  // el badge del tab "Ventas del día" (mismo patron que Pendientes y
  // Gestionados que usan `displayClients.length` / `gestionados.length`).
  const [salesTodayCount, setSalesTodayCount] = useState(0)

  const [editingManaged, setEditingManaged] = useState<ManagedClient | null>(null)
  const [editMonto, setEditMonto] = useState("")
  /** A que se quiere convertir la gestion abierta en el editor. */
  const [editTipo, setEditTipo] = useState<"pago" | "no_pago">("pago")
  /**
   * LA FORMA DE PAGO, TAMBIÉN CORREGIBLE.
   *
   * Se equivoca igual de fácil que el monto —el `Select` arranca en Efectivo y
   * quien cobró por transferencia se lo salta— y hasta ahora la corrección
   * conservaba el método viejo sin forma de tocarlo. El desglose
   * Efectivo/Transferencia del Resumen sale de ahí (script 059), así que un
   * método equivocado descuadra ese cuadro sin que nadie pueda arreglarlo.
   */
  const [editMetodo, setEditMetodo] = useState<"efectivo" | "transferencia">("efectivo")
  const [savingManaged, setSavingManaged] = useState(false)
  // Gestión que se está por anular. Se pide confirmación porque deshace un
  // movimiento de plata y devuelve el cliente a la lista de cobro.
  const [anularManaged, setAnularManaged] = useState<ManagedClient | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clients, setClients] = useState<DisplayClient[]>([])
  const [selectedClient, setSelectedClient] = useState<DisplayClient | null>(null)
  // Saldo a Pagar se toma directamente de selectedClient.saldo (ya viene del
  // listado de Clientes Activos). NO se hace fetch adicional para acelerar
  // la apertura del dialogo de Registrar Pago.
  const [numCuotas, setNumCuotas] = useState(1)
  const [isPartialPayment, setIsPartialPayment] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("efectivo")
  /**
   * DOS FORMAS DE PAGO: parte en efectivo y parte en transferencia.
   *
   * En el libro se escribe como DOS eventos de pago, uno por forma: cada
   * gestión lleva un solo `metodo_pago`, y el resumen ya reparte efectivo y
   * transferencia evento por evento (scripts/112). Así la caja cuadra sin
   * tocar el SQL, y la lista de Gestionados lo muestra como "pago mixto".
   */
  const [dosFormas, setDosFormas] = useState(false)
  const [montoEfectivoMixto, setMontoEfectivoMixto] = useState("")
  const [montoTransfMixto, setMontoTransfMixto] = useState("")
  /** Cuánto sube la barra de cobrar para no quedar debajo del teclado. */
  const [subirBarra, setSubirBarra] = useState(0)
  const barraCobrarRef = useRef<HTMLDivElement | null>(null)
  /** El `id` de la cuenta (tabla `cuentas`) a la que entró la transferencia. */
  const [accountNumber, setAccountNumber] = useState("")
  /**
   * LAS CUENTAS DE VERDAD DE LA RUTA. Antes la lista era de ejemplo
   * (Davivienda/Bancolombia/Nequi fijas) y lo elegido no viajaba a ningún
   * lado. Se guardan en el teléfono para poder elegir sin señal.
   */
  const [cuentasPago, setCuentasPago] = useState<{ id: string; nombre: string }[]>([])
  /** Las notas del pago: viajan como `observacion` del evento. */
  const [notasPago, setNotasPago] = useState("")
  const [isCancelada, setIsCancelada] = useState(false)
  /**
   * RENOVAR: refinanciar el crédito en el mismo cobro (scripts/123).
   *
   * El cliente paga y además recibe plata nueva: el valor, con la tasa del
   * crédito, se suma a lo que debe y el saldo se reparte en las cuotas que le
   * quedaban más los días nuevos. Se registra DESPUÉS del pago, por la misma
   * cola, así que sin señal queda en orden detrás de él. No se combina con
   * "Cancelada".
   */
  const [renovar, setRenovar] = useState(false)
  const [valorRenovar, setValorRenovar] = useState("")
  const [diasRenovar, setDiasRenovar] = useState("")
  // ── Extension de plazo (solo prestamos "americano" en su ULTIMA cuota) ──
  // Cuando un prestamo de tipo intereses (americano) llega a su ultima cuota
  // programada, el administrador puede optar por "prorrogar" el plazo: pagar
  // los intereses de la cuota actual y agregar N cuotas mas al final.
  // El registro del pago se hace primero con `registrar_pago_atomico` y, si
  // tiene exito, se invoca la RPC `extender_prestamo_americano` para crear
  // las nuevas cuotas pendientes.
  const [extenderCuotas, setExtenderCuotas] = useState(false)
  const [cantidadCuotasExtender, setCantidadCuotasExtender] = useState("1")

  // "Pagar multa": cobrar la multa pendiente del cliente junto con el pago.
  // Solo visible cuando el cliente seleccionado tiene multaPendiente.
  const [pagarMulta, setPagarMulta] = useState(false)

  // "Agregar cuota adicional si el cliente aun debe": pregunta que aparece
  // cuando la cuota actual es la ULTIMA del plan (cualquier tipo de
  // amortizacion, a diferencia de "Extender Cuotas" que es solo para
  // americano). Si se marca y tras el pago/no-pago el cliente aun debe
  // (segun saldo_prestamos_clientes), el RPC genera una cuota extra en vez
  // de dejar el prestamo sin fechas a las que caer para seguir cobrando.
  // Activado por defecto: mas seguro, evita que el cliente desaparezca del
  // listado por descuido si no se desmarca a proposito.
  const [agregarCuotaSiDebe, setAgregarCuotaSiDebe] = useState(true)
  const [agregarCuotaSiDebeNoPago, setAgregarCuotaSiDebeNoPago] = useState(true)

  // ── BLINDAJE BUG cuotas duplicadas ────────────────────────────────────
  // Defensa adicional: si por cualquier motivo (cambio de cliente, refetch,
  // etc.) el flag `extenderCuotas` queda en `true` cuando el cliente
  // seleccionado YA NO cumple las condiciones para extender (no es
  // americano, o la cuota actual no es la ultima del plan), lo forzamos a
  // `false` automaticamente. Esto garantiza que `extender_prestamo_americano`
  // jamas se dispare en un pago de cuota intermedia (ej. cuota 4 de 16).
  useEffect(() => {
    if (!extenderCuotas) return
    if (!selectedClient) {
      setExtenderCuotas(false)
      setCantidadCuotasExtender("1")
      return
    }
    const esAmericano =
      selectedClient.tipoAmortizacion?.toLowerCase().trim() === "americano"
    const esUltimaCuota = selectedClient.esUltimaCuotaPendiente
    if (!esAmericano || !esUltimaCuota) {
      console.warn(
        "[v0] BLINDAJE-EXTENDER apagando flag espurio:",
        {
          loanId: selectedClient.loanId,
          tipoAmortizacion: selectedClient.tipoAmortizacion,
          nextPaymentNumero: selectedClient.nextPaymentNumero,
          cuotasTotales: selectedClient.cuotasTotales,
        },
      )
      setExtenderCuotas(false)
      setCantidadCuotasExtender("1")
    }
  }, [extenderCuotas, selectedClient])
  const [showRenovationDialog, setShowRenovationDialog] = useState(false)
  const [clientForRenovation, setClientForRenovation] = useState<DisplayClient | null>(null)

  // Umbral de aprobacion de abonos por ruta (secretaria). Si el monto lo
  // supera, el pago se envia a revision en vez de aplicarse.
  const [umbrales, setUmbrales] = useState<RutaUmbrales | null>(null)
  useEffect(() => {
    getRutaUmbrales(currentRutaId).then(setUmbrales)
  }, [currentRutaId])
  const [showRevisionDialog, setShowRevisionDialog] = useState(false)
  const revisionResolveRef = useRef<((v: boolean) => void) | null>(null)
  const confirmRevision = () =>
    new Promise<boolean>((resolve) => {
      revisionResolveRef.current = resolve
      setShowRevisionDialog(true)
    })
  const handleRevisionChoice = (confirmado: boolean) => {
    setShowRevisionDialog(false)
    revisionResolveRef.current?.(confirmado)
    revisionResolveRef.current = null
  }

  // ── Geocerca ──────────────────────────────────────────────────────────
  // Cuando el cobrador esta lejos del cliente, la gestion se detiene y solo
  // continua si escribe un motivo, que queda guardado junto con la distancia
  // real para que secretaria lo revise.
  const [geocercaBloqueo, setGeocercaBloqueo] = useState<{ nombre: string; distancia: number; radio: number } | null>(null)
  const [geocercaMotivo, setGeocercaMotivo] = useState("")
  // Ultima posicion tomada al abrir una gestion, para no volver a encender el
  // GPS al confirmar. Se guarda con el cliente y el momento para no reusarla
  // con otro cliente ni cuando ya envejecio.
  const ubicacionRecienteRef = useRef<{ loanId: string; coords: UbicacionMedida; tomadaEn: number } | null>(null)
  const geocercaResolveRef = useRef<((motivo: string | null) => void) | null>(null)
  const pedirJustificacionGeocerca = (nombre: string, distancia: number, radio: number) =>
    new Promise<string | null>((resolve) => {
      geocercaResolveRef.current = resolve
      setGeocercaMotivo("")
      setGeocercaBloqueo({ nombre, distancia, radio })
    })
  const handleGeocercaChoice = (motivo: string | null) => {
    setGeocercaBloqueo(null)
    geocercaResolveRef.current?.(motivo)
    geocercaResolveRef.current = null
  }

  /**
   * Toma la posicion actual y decide si la gestion puede seguir.
   *
   * Devuelve null cuando hay que detenerse: el GPS no responde, o el cobrador
   * esta fuera de rango y no quiso justificar.
   */
  const resolverGeocerca = async (
    cliente: DisplayClient,
    accion: "pagos" | "no pagos",
  ): Promise<{ coords: UbicacionMedida; geo: ResultadoGeocerca; motivo: string | null } | null> => {
    let coords: UbicacionMedida
    try {
      // Se reusa la lectura que se tomo al ABRIR la gestion si es del mismo
      // cliente y tiene menos de 45s: entre abrir la pantalla y confirmar el
      // cobro el cobrador no se movio, y encender el chip GPS dos veces por
      // cliente cuesta segundos y bateria en un telefono de gama baja.
      const previa = ubicacionRecienteRef.current
      const fresca =
        previa &&
        previa.loanId === cliente.loanId &&
        Date.now() - previa.tomadaEn < 45_000
      coords = fresca ? previa.coords : await obtenerUbicacion()
    } catch (err) {
      // Se distingue el permiso negado de que el chip no enganche: son dos
      // problemas distintos y se arreglan de forma distinta. Con un solo
      // mensaje —"activa el GPS"— el cobrador que ya lo tenia activado se
      // quedaba mirando la pantalla sin saber que hacer.
      const negado = err instanceof Error && err.message === "GPS_DENIED"
      toast({
        title: negado ? "Sin permiso de ubicación" : "No se pudo leer la ubicación",
        description: negado
          ? `Este teléfono tiene bloqueada la ubicación para la app. Hay que habilitarla en la configuración del sistema para registrar ${accion}.`
          : `El teléfono no logró ubicarse. Salí a un lugar más despejado y volvé a intentar; si estás bajo techo puede tardar. (Se intenta dos veces: primero con el GPS y después por antenas.)`,
        variant: "destructive",
      })
      return null
    }

    const radio = umbrales?.geocerca_radio_metros ?? 100
    const geo = evaluarGeocerca({
      cobrador: coords,
      cliente:
        cliente.clienteLatitud != null && cliente.clienteLongitud != null
          ? { latitud: cliente.clienteLatitud, longitud: cliente.clienteLongitud }
          : null,
      radioMetros: radio,
    })

    // Se evalua aunque la geocerca este apagada: asi la distancia queda
    // registrada desde el primer dia y secretaria puede ver, con datos
    // reales de la ruta, que radio le sirve antes de encenderla.
    if (!umbrales?.geocerca_habilitada || !geo.bloquea) {
      return { coords, geo, motivo: null }
    }

    const motivo = await pedirJustificacionGeocerca(cliente.nombre, geo.distancia ?? 0, radio)
    if (!motivo) return null
    return { coords, geo, motivo }
  }

  // Aviso de proximidad que se muestra al ABRIR la gestion, para que el
  // cobrador sepa como esta parado antes de llenar el formulario. Es
  // informativo: la decision que manda es la que se toma al guardar, con
  // una lectura fresca del GPS.
  const [geocercaAviso, setGeocercaAviso] = useState<ResultadoGeocerca | null>(null)

  const renderAvisoGeocerca = () => {
    if (!umbrales?.geocerca_habilitada || !geocercaAviso) return null
    const { estado, distancia } = geocercaAviso
    const texto =
      estado === "dentro"
        ? `Ubicación verificada — estás a ${formatearDistancia(distancia ?? 0)} del cliente.`
        : estado === "fuera"
          ? `Estás a ${formatearDistancia(distancia ?? 0)} del cliente. Para registrar tendrás que justificarlo.`
          : estado === "sin_referencia"
            ? "Este cliente aún no tiene ubicación guardada. Se tomará la de esta gestión."
            : "No se pudo verificar la ubicación: la señal del GPS es demasiado imprecisa aquí."
    const estilo =
      estado === "dentro"
        ? "border-green-200 bg-green-50 text-green-800"
        : estado === "fuera"
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-amber-200 bg-amber-50 text-amber-800"
    const Icono = estado === "dentro" ? MapPin : MapPinOff
    return (
      <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] md:text-xs ${estilo}`}>
        <Icono className="h-4 w-4 shrink-0 mt-px" />
        <span>{texto}</span>
      </div>
    )
  }

  // Dialogo "fecha distinta a la cuota pendiente": cuando se va a pagar/no
  // pagar en una fecha que no coincide con la cuota objetivo (tipico al
  // ponerse al dia con un cliente atrasado), se pregunta si el pago se
  // asocia a esa cuota pendiente (comportamiento de siempre) o si se
  // registra como un pago de hoy en una linea nueva, dejando la cuota
  // atrasada intacta.
  const [showShareDialog, setShowShareDialog] = useState(false)
  const [clientForShare, setClientForShare] = useState<DisplayClient | null>(null)
  const [sharingPdf, setSharingPdf] = useState(false)
  // El comprobante ya dibujado y listo para mandar. Se prepara al ABRIR el
  // dialogo para que el boton de compartir no tenga que esperar nada: ver el
  // comentario largo sobre la activacion del usuario en `handleShareComprobante`.
  const [reciboListo, setReciboListo] = useState<
    { file: File; dataUrl: string; filename: string } | null
  >(null)
  const [preparandoRecibo, setPreparandoRecibo] = useState(false)
  // true = el dialogo se abrio tras registrar un pago (al cerrarlo hay que
  // volver al listado). false = se abrio desde "Generar recibo" del menu,
  // donde no hay formulario abierto que cerrar.
  const [shareTrasPago, setShareTrasPago] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [paymentPhoto, setPaymentPhoto] = useState<string | null>(null)
  const [isDiario, setIsDiario] = useState(true)

  // Encabezado plegado (solo movil). En un telefono el bloque de arriba
  // —titulo, refrescar, circulos de mora, Diario/No Diario, Nueva Venta,
  // avance y buscador— se come casi un tercio de la pantalla, y el cobrador lo
  // que necesita ver es la lista.
  //
  // Se recuerda entre sesiones: el modulo se abre y se cierra muchas veces al
  // dia, y volver a plegarlo cada vez seria peor que no tener el boton.
  //
  // Arranca DESPLEGADO y se lee el guardado en un efecto, no en el estado
  // inicial: leer localStorage al construir el estado hace que el servidor y
  // el navegador rendericen cosas distintas.
  const CLAVE_ENCABEZADO = "pagos_encabezado_plegado"
  const [encabezadoPlegado, setEncabezadoPlegado] = useState(false)
  useEffect(() => {
    try {
      if (localStorage.getItem(CLAVE_ENCABEZADO) === "1") setEncabezadoPlegado(true)
    } catch { /* modo privado */ }
  }, [])
  const alternarEncabezado = () => {
    setEncabezadoPlegado((prev) => {
      const siguiente = !prev
      try { localStorage.setItem(CLAVE_ENCABEZADO, siguiente ? "1" : "0") } catch { /* modo privado */ }
      return siguiente
    })
  }
  // `max-md:hidden` y no `hidden md:flex`: los elementos que se ocultan ya
  // traen su propio `display` (flex, block), y poner `hidden` al lado deja dos
  // reglas peleando por la misma propiedad — gana el orden del CSS generado,
  // no el orden en que se escriban las clases. Con la variante `max-md:` no
  // hay pelea (Tailwind emite las variantes DESPUÉS) y de paso el escritorio
  // queda exactamente como estaba, sin tener que redeclararle el display.
  const ocultoEnMovil = () => (encabezadoPlegado ? "max-md:hidden" : "")
  const [moraFilter, setMoraFilter] = useState<"green" | "yellow" | "red" | null>(null)

  // No-payment dialog state
  const [noPaymentClient, setNoPaymentClient] = useState<DisplayClient | null>(null)
  const [noPaymentObservation, setNoPaymentObservation] = useState("")
  const [noPaymentPhoto, setNoPaymentPhoto] = useState<string | null>(null)

  // Al abrir una gestion (pago o no pago) se mide la proximidad para avisar
  // de entrada. Si el GPS falla aca no se dice nada: el guard de guardar ya
  // avisa, y no tiene sentido molestar dos veces por lo mismo.
  const clienteEnGestion = selectedClient ?? noPaymentClient
  const loanEnGestion = clienteEnGestion?.loanId ?? null
  useEffect(() => {
    setGeocercaAviso(null)
    ubicacionRecienteRef.current = null
    if (!clienteEnGestion) return
    let cancelado = false
    // La lectura se toma SIEMPRE, este la geocerca encendida o no: de todos
    // modos el cobro necesita coordenadas, y adelantarla aqui hace que al
    // confirmar no haya que esperar otra vez al chip GPS.
    obtenerUbicacion()
      .then((coords) => {
        if (cancelado) return
        ubicacionRecienteRef.current = {
          loanId: clienteEnGestion.loanId,
          coords,
          tomadaEn: Date.now(),
        }
        if (!umbrales?.geocerca_habilitada) return
        setGeocercaAviso(
          evaluarGeocerca({
            cobrador: coords,
            cliente:
              clienteEnGestion.clienteLatitud != null && clienteEnGestion.clienteLongitud != null
                ? { latitud: clienteEnGestion.clienteLatitud, longitud: clienteEnGestion.clienteLongitud }
                : null,
            radioMetros: umbrales.geocerca_radio_metros,
          }),
        )
      })
      .catch(() => {})
    return () => { cancelado = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanEnGestion, umbrales?.geocerca_habilitada, umbrales?.geocerca_radio_metros])

  // Client info dialog
  const [clientInfoDialogOpen, setClientInfoDialogOpen] = useState(false)
  const [selectedClientInfo, setSelectedClientInfo] = useState<DisplayClient | null>(null)

  // Payment history dialog
  const [paymentHistoryOpen, setPaymentHistoryOpen] = useState(false)
  const [paymentHistoryClient, setPaymentHistoryClient] = useState<DisplayClient | null>(null)

  // ── Extracto del cliente ────────────────────────────────────────────────
  // Lo que se sacó de la fila para que quepan más clientes: fecha de venta,
  // total a pagar, interés, abonado y multa. No se perdió, se agrupó — el
  // ojito de cada fila lo abre.
  const [extractoClient, setExtractoClient] = useState<DisplayClient | null>(null)
  // Cuántos movimientos tiene el crédito. Se pide al abrir el extracto porque
  // es un número que solo se mira ahí, y traerlo para las 40 filas de la lista
  // serían 40 consultas para un dato que casi nadie abre.
  const [extractoMovimientos, setExtractoMovimientos] = useState<number | null>(null)
  /** El diálogo de compartir del extracto (imagen, descarga o chat). */
  const [compartirExtracto, setCompartirExtracto] = useState(false)
  const [paymentHistoryRows, setPaymentHistoryRows] = useState<MovimientoExtracto[]>([])
  const [paymentHistoryLoading, setPaymentHistoryLoading] = useState(false)

  // Loan history dialog
  const [loanHistoryOpen, setLoanHistoryOpen] = useState(false)
  const [loanHistoryClient, setLoanHistoryClient] = useState<DisplayClient | null>(null)
  const [loanHistoryRows, setLoanHistoryRows] = useState<{
    id: string; valor: number; numero_cuotas: number; frecuencia_pago: string; estado: string
    fecha_creacion: string; tasa_interes: number | null
  }[]>([])
  const [loanHistoryLoading, setLoanHistoryLoading] = useState(false)

  // Client info dialog — fetched data from clients table
  const [clientInfoFetched, setClientInfoFetched] = useState<{
    nombre_completo: string; apodo: string | null; documento: string; telefono: string | null; direccion: string | null
  } | null>(null)
  const [clientInfoLoading, setClientInfoLoading] = useState(false)

  // Drag-and-drop reorder state

  // El estado del permiso sale de `lib/use-gps.ts`, el MISMO que usa el
  // encabezado. Antes cada pantalla lo averiguaba por su cuenta y podian
  // contradecirse: la pastilla roja de "Sin ubicacion" arriba mientras aca los
  // botones estaban habilitados, o al reves.
  //
  // Ese modulo tambien resuelve lo que costo encontrar en iPhone: que
  // `navigator.permissions` puede no existir y revienta SINCRONO, que Safari
  // no soporta 'geolocation' en esa API, que preguntar con alta precision solo
  // para saber si hay permiso se pasa de tiempo bajo techo, y que volver de
  // Ajustes tiene que notarse sin recargar la pagina.
  const { estado: gpsStatus, volverAPedir: requestGpsPermission } = useEstadoGps()
  // Cuando la lista se sirve desde el dispositivo (sin señal), guarda el
  // momento en que esos datos se trajeron del servidor. null = datos frescos.
  const [datosDesdeCache, setDatosDesdeCache] = useState<string | null>(null)

  // Token monotonico para descartar respuestas obsoletas / concurrentes de fetchData.
  // Cada llamada incrementa el token; las respuestas con token distinto al actual
  // son ignoradas (evita race conditions cuando dos fetches solapan).
  const fetchDataTokenRef = useRef(0)

  // Candado contra el DOBLE TOQUE al registrar una gestion.
  //
  // No basta con el estado `saving`: entre el primer toque y `setSaving(true)`
  // hay un `await` del GPS que en movil tarda 1-2s, y en esa ventana el boton
  // sigue habilitado. El cobrador ve que "no pasa nada", vuelve a tocar, y
  // cada toque genera su PROPIA llave de idempotencia — asi que el candado del
  // servidor no los atrapa: no son reenvios de la misma captura, son capturas
  // distintas, y las escribe todas.
  //
  // Paso de verdad el 17/08/2026 en la ruta 190: cuatro pagos identicos de
  // $6.500 con la misma marca de tiempo al segundo. $19.500 de plata que
  // nunca entro, contados en la caja del dia.
  //
  // Es un ref y no un estado porque `setState` es asincrono: dos toques en el
  // mismo tick leerian ambos el valor viejo y los dos pasarian.
  const enviandoRef = useRef(false)

  // Ref a toast para no recrear fetchData en cada render (evita disparos
  // duplicados del useEffect que escucha fetchData).
  const toastRef = useRef(toast)
  useEffect(() => {
    toastRef.current = toast
  }, [toast])

  const managedIds = new Set(managedToday.map((m) => m.loanId))

  // Un solo predicado de busqueda para las dos pestanas: si Gestionados
  // buscara distinto que Pendientes, el mismo cliente aparece en una y se
  // esconde en la otra.
  // Busca por apodo Y por nombre real. Antes solo miraba `nombre`, que es el
  // apodo cuando lo hay: buscar a alguien por su nombre de cedula no lo
  // encontraba, aunque ahora ese nombre este a la vista en la lista.
  const coincideBusqueda = (c: { nombre: string; nombreCompleto?: string; documento: string }) => {
    if (searchTerm === "") return true
    const q = searchTerm.toLowerCase()
    return (
      c.nombre.toLowerCase().includes(q) ||
      (c.nombreCompleto ?? "").toLowerCase().includes(q) ||
      c.documento.includes(searchTerm)
    )
  }

  // Base filtered clients: all filters except mora — used for the circle counts
  // so the totals per category are always visible regardless of active mora filter.
  // Los que le faltan al cobrador, SIN la busqueda: es el denominador del
  // avance de la ruta. Antes el avance salia de la lista ya buscada, asi que
  // escribir tres letras hacia saltar el porcentaje al 90% — el trabajo del
  // dia no cambia porque alguien escriba en un campo de texto.
  // Todos los que le faltan al cobrador, aplazados incluidos: es el
  // denominador del avance del día. Un aplazado NO está gestionado — sigue
  // siendo trabajo pendiente — así que sacarlo de esta cuenta haría que el
  // avance subiera solo por posponer clientes.
  const sinGestionar = clients.filter((c) => {
    if (managedIds.has(c.loanId)) return false
    if (c.saldo <= 0) return false
    const isDiarioFreq = c.frecuenciaPago === "daily"
    return isDiario ? true : !isDiarioFreq
  })

  /**
   * LA RUTA DE HOY: TODO EL QUE DEBA PLATA, HAYA PAGADO ADELANTADO O NO.
   *
   * Pagar de más NO compra días libres. Si la cuota es de $1.000 y el cliente
   * paga $3.000, ese día pagó tres cuotas y ahí queda registrado — pero mañana
   * vuelve a salir en la ruta, pendiente, y el cobrador le hace la gestión
   * desde cero. Es la regla del negocio: se pasa todos los días.
   *
   * Se probó lo contrario (01/09/2026) y se deshizo el mismo día. Sacar de la
   * ruta al que tenía la cuota de hoy cubierta dejaba la 190 recién abierta,
   * sin una sola visita hecha, mostrando 13 clientes en Gestionados. La
   * insignia decía 13 y nadie había gestionado a nadie.
   *
   * Lo único que sale de la ruta es lo APLAZADO, que vive en su pestaña.
   */
  const pendientesDeLaRuta = sinGestionar.filter((c) => !aplazados.has(c.loanId))
  const aplazadosDeLaRuta = sinGestionar
    .filter((c) => aplazados.has(c.loanId))
    .filter(coincideBusqueda)
    .sort((a, b) => {
      const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
      const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
      return ordA - ordB
    })

  /**
   * LIMPIAR LOS APLAZADOS QUE YA SE RESOLVIERON.
   *
   * Cuando a un aplazado se le registra el pago, sale de `sinGestionar` y las
   * listas dejan de mostrarlo — pero la marca sigue en el teléfono. Si después
   * se anula ese pago, el cliente volvería a "Pendientes" en vez de a la ruta,
   * arrastrando una decisión de hace tres horas que ya se cumplió.
   *
   * Se hace acá y no en cada camino de éxito porque los caminos son varios
   * —pago, no pago, cancelación, la cola offline— y el que se olvide es el que
   * deja la marca colgada.
   */
  useEffect(() => {
    if (aplazados.size === 0) return
    const vivos = new Set(sinGestionar.map((c) => c.loanId))
    const resueltos = [...aplazados.keys()].filter((id) => !vivos.has(id))
    if (resueltos.length === 0) return
    let m = aplazados
    for (const id of resueltos) m = quitarAplazado(currentRutaId, id, diaDeTrabajo)
    setAplazados(new Map(m))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, managedToday, currentRutaId])


  /**
   * LOS APLAZADOS, COMO UNA FILA MAS DE GESTIONADOS.
   *
   * El mismo cliente sale en las DOS pestañas a propósito: en "Pendientes"
   * porque hay que volver a visitarlo, y en "Gestionados" porque el cobrador
   * YA pasó por él hoy. Sin esto, a media tarde no había forma de distinguir
   * al que se aplazó del que todavía no se ha tocado.
   *
   * Antes vivían en un apartado al final de la pestaña. Medido con 30
   * gestionados: el encabezado quedaba a 4.986px de una página de 5.164 —el
   * 97% hacia abajo, cinco pantallas y media de scroll—. Estar ahí abajo y no
   * estar es lo mismo. Ahora van MEZCLADOS y ordenados por orden de visita,
   * que es como el cobrador recorre la ruta.
   *
   * No inventan plata: `valorAbonado` en 0 y `metodoPago` en null, porque un
   * aplazado no movió un peso. Y no tocan el avance del día —"30 de 43"— que
   * sigue saliendo de `managedToday`: contar como resuelto al que se pospuso
   * haría subir el porcentaje por posponer clientes.
   */
  const aplazadosComoGestion: ManagedClient[] = sinGestionar
    .filter((c) => aplazados.has(c.loanId))
    .map((c) => ({
      ...c,
      gestionTipo: "aplazado" as const,
      gestionHora: horaDeAplazado(aplazados.get(c.loanId)),
      gestionInstante: aplazados.get(c.loanId) ?? "",
      valorAbonado: 0,
      cuotasAbonadas: 0,
      metodoPago: null,
    }))

  /**
   * DE LA ÚLTIMA GESTIÓN A LA PRIMERA.
   *
   * Iba por orden de visita, que es el orden en que se RECORRE la ruta — el
   * correcto para la lista de lo que falta. Pero esta es la lista de lo ya
   * hecho, y ahí lo que se busca es casi siempre lo último: el cobro que se
   * acaba de registrar, para comprobarlo o corregirlo. Estaba enterrado a
   * treinta filas de distancia.
   *
   * Ordena por el INSTANTE, no por la hora escrita: comparando texto,
   * "12:58 p. m." va después de "01:05 p. m." y la lista salía al revés justo
   * en el cambio de mediodía.
   *
   * Los que no tienen instante —aplazados marcados con una versión anterior,
   * que guardaba la hora ya escrita— se van al final en vez de mezclarse en un
   * sitio arbitrario.
   */
  /**
   * CUÁNTAS CUOTAS LE QUEDAN AL CLIENTE QUE SE ESTÁ COBRANDO.
   *
   * Es el tope del selector "Nro Cuotas". `cuotasPagadas` viene de la vista ya
   * con el piso puesto (`FLOOR(pagado / valor_cuota)`, script 084), así que la
   * resta contra el total da cuotas ENTERAS que todavía se deben — que es
   * justo lo que se puede elegir.
   *
   * Nunca baja de 1: con el saldo en cero el cliente ya no sale en la ruta, y
   * un selector vacío sería peor que uno con una sola opción.
   */
  const cuotasQueLeQuedan = Math.max(
    1,
    (selectedClient?.cuotasTotales ?? 0) - (selectedClient?.cuotasPagadas ?? 0),
  )

  const sortedManaged = [...managedToday, ...aplazadosComoGestion].sort((a, b) => {
    const ta = Date.parse(a.gestionInstante)
    const tb = Date.parse(b.gestionInstante)
    const va = Number.isNaN(ta) ? -Infinity : ta
    const vb = Number.isNaN(tb) ? -Infinity : tb
    if (va !== vb) return vb - va
    // Empate exacto (dos gestiones en el mismo segundo): el orden de la ruta
    // desempata, para que la lista no baile entre renders.
    const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
    const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
    return ordA - ordB
  })

  // Gestionados tambien se busca. Al final del dia esta lista tiene tantos
  // clientes como la otra, y encontrar a alguien para corregirle un cobro
  // obligaba a bajar por toda la ruta a ojo.
  const filteredManaged = sortedManaged.filter(coincideBusqueda)

  const preFilteredClients = pendientesDeLaRuta.filter(coincideBusqueda)

  const displayClients = preFilteredClients.filter((c) => {
    if (moraFilter === null) return true
    if (moraFilter === "green") return c.mora <= 4
    if (moraFilter === "yellow") return c.mora > 4 && c.mora <= 8
    return c.mora > 8
  }).sort((a, b) => {
    // 1. EL ORDEN DE LA RUTA MANDA, Y ES LO UNICO QUE ORDENA.
    //
    //    Antes era el ultimo criterio de tres, y los dos de arriba lo
    //    deshacian: primero se mandaban al final los clientes con cuota
    //    FUTURA, y en "No Diario" se subian los del dia de cobro. En la ruta
    //    190, 28 de 44 clientes caen en el primer grupo — o sea que quien
    //    acomodaba su ruta en "Ordenar Ruta" abria Pagos y veia OTRA cosa.
    //
    //    Y esa reorganizacion era invisible: el badge "Próx. pago" que la
    //    explicaba se quito hace unas semanas, asi que la lista se reordenaba
    //    sola sin nada en pantalla que dijera por que.
    //
    //    El orden de visita es GEOGRAFICO: es la calle, en el orden en que se
    //    camina. Mandarle al final a los que estan al dia obliga a pasar de
    //    largo y volver.
    const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
    const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
    if (ordA !== ordB) return ordA - ordB

    // 2. Los que TODAVIA no tienen orden asignado van al final, y entre
    //    ellos se ordenan por algo FIJO: la fecha de la venta y, si empatan,
    //    el id del prestamo.
    //
    //    No se usa la cuota futura ni el dia de cobro, aunque sean criterios
    //    mas "inteligentes": esos cambian solos de un dia para el otro, y una
    //    lista que se reacomoda sola es justo lo que se vino a arreglar. Con
    //    la fecha de venta, el cobrador ve siempre la misma secuencia hasta
    //    que decida ordenarla el.
    if (a.fechaVenta !== b.fechaVenta) return a.fechaVenta < b.fechaVenta ? -1 : 1
    return a.loanId < b.loanId ? -1 : a.loanId > b.loanId ? 1 : 0
  })
  
  // Helper to determine if a client can be managed (register payment/no-payment)
  const canManageClient = (client: DisplayClient) => {
    // Location must be available to register any action — no exceptions
    if (gpsStatus !== "granted") return false
    // Cuota objetivo FUTURA: NO bloquea. El cliente que esta al dia puede
    // adelantar la cuota que vence manana, y esa es su decision, no la de la
    // app. El servidor la acepta igual: `cuota_objetivo` es una pista y la
    // cascada asigna la plata a la cuota mas antigua sin cubrir.
    // Daily clients: always allowed once location is confirmed
    if (client.frecuenciaPago === "daily") return true
    // In "No Diario" tab: non-daily clients can always be managed (regardless of payment day)
    if (!isDiario) return true
    // In "Diario" tab: non-daily clients can only be managed if today is their payment day
    return isPaymentDayToday(client.diaSemana)
  }

  // Called when the user taps a payment button but location is not available
  const handleLocationRequired = () => {
    toast({
      title: "Ubicacion requerida",
      description:
        gpsStatus === "denied"
          ? "El permiso de ubicacion esta denegado. Ve a la configuracion de tu navegador y habilita el acceso a la ubicacion para continuar."
          : "No se puede detectar tu ubicacion. Activa la ubicacion en tu dispositivo y vuelve a intentarlo.",
      variant: "destructive",
    })
    // Also re-trigger the browser permission dialog in case it is in "prompt" state
    if (gpsStatus !== "denied" && navigator.geolocation) {
      requestGpsPermission()
    }
  }

  /* Acá vivían `saveNewOrder`, el arrastre y las flechas: unas 90 líneas que
     renumeraban la ruta ENTERA desde la pantalla de cobro. Se fueron con el
     acceso directo a enrutar — `PUT /api/route-order` sigue existiendo y lo
     usa el módulo "Ordenar Ruta" (components/views/configure-route.tsx), que
     es donde se acomoda la ruta a propósito y no de refilón. */


  const fetchData = useCallback(async (options?: { silent?: boolean }) => {
    // silent=true: refresh en background sin tocar el flag `loading` (no se
    // muestra spinner overlay). Lo usamos despues de un pago para sincronizar
    // mora/saldo derivados sin bloquear la UI — el optimistic UI ya tiene
    // los datos correctos visualmente.
    const silent = options?.silent === true

    // Token monotonico para esta llamada. Cualquier respuesta tardia con
    // token diferente sera descartada.
    const myToken = ++fetchDataTokenRef.current

    // Cliente Supabase del navegador (atajo sobre `createClient()`).
    let supabase: Awaited<ReturnType<typeof getSupabaseSafe>>
    try {
      supabase = await getSupabaseSafe()
    } catch (err) {
      // SessionLostError: el listener global en app/page.tsx se encarga
      // del redirect, aqui solo abortamos el fetch limpiamente.
      console.warn("[v0] fetchData abortado por sesion no disponible:", err)
      if (!silent) setLoading(false)
      return
    }

    try {
      if (!silent) setLoading(true)
      // Día de negocio. `hoy` es un string; la función que lo calcula sigue
      // importada como `todayColombia` y no se sombrea (antes se declaraba
      // una constante con ese mismo nombre y cualquier llamada a la función
      // reventaba con "todayColombia is not a function").
      //
      // ES EL DÍA DE TRABAJO, no necesariamente hoy: con la ruta desbloqueada
      // para cerrar una jornada vieja, quien ya se gestionó ESE día tiene que
      // salir en Gestionados, y quien no, en Pendientes. Leyendo hoy, la lista
      // mostraría la ruta entera como pendiente y volvería a cobrarle a quien
      // ya pagó ayer.
      const hoy = diaDeTrabajo
      const ayer = ayerColombia()

      // ── Carga del módulo ─────────────────────────────────────────────
      // Trae préstamos, el financiero derivado, el cronograma y el libro de
      // eventos de hoy y ayer. Sin RLS: cada consulta filtra por ruta.
      const dashboard = await loadDashboardPagos(supabase, {
        rutaId: currentRutaId,
        // El dia que se esta cerrando, para que sus eventos entren en la
        // ventana de datos. Cerrando el 5 un dia 7, "desde ayer" los dejaba
        // fuera y el gestionado se devolvia solo a Pendientes.
        desde: diaDeTrabajo,
      })
      if (fetchDataTokenRef.current !== myToken) return

      const { loans, saldoMap, moraMap, fechaUltimoPagoMap, finMap, gestiones, allPaymentPlans } = dashboard
      console.log(`[v0] dashboard cargado: ${loans.length} loans (${dashboard.source})`)
      // Si los datos vienen del dispositivo, avisamos desde cuándo son: el
      // cobrador debe saber que puede haber gestiones de otros que aún no ve.
      setDatosDesdeCache(dashboard.source === "cache" ? (dashboard.cacheGuardadoEn ?? null) : null)

      // El helper ya devolvio el conjunto correcto: los activos de la ruta MAS
      // los que se movieron desde ayer, aunque hayan quedado cancelados. Esos
      // ultimos se filtran mas abajo de Pendientes por su estado, asi que solo
      // pueden salir en Gestionados — que es donde tienen que estar el dia que
      // se cancelan. Alias para no tocar el resto del componente.
      const activeLoans = loans
      const pendingClients: DisplayClient[] = []
      const managedClientsFromDB: ManagedClient[] = []

      // Group payment plans by loan_id
      const paymentPlansByLoan = new Map<string, PaymentPlanEntry[]>()
      for (const pp of allPaymentPlans) {
        const existing = paymentPlansByLoan.get(pp.loan_id) || []
        existing.push(pp)
        paymentPlansByLoan.set(pp.loan_id, existing)
      }

      // ── Multas por mora ──────────────────────────────────────────────
      // La generacion vive en el servidor (`generar_multas_ruta`, script 047).
      // Antes corria aqui: cada dispositivo que abria esta pantalla evaluaba
      // e INSERTABA multas dentro del camino de lectura, con el indice unico
      // parcial como unica proteccion contra duplicados. Ademas contaba las
      // fallas sobre estados de cuota, asi que una fila sintetica de valor 0
      // producia multas de $0 que se descartaban en silencio.
      //
      // La app solo pide la evaluacion y lee el resultado. Si la RPC falla,
      // el listado carga igual: cobrar nunca puede depender de las multas.
      const multasMap = new Map<string, { id: string; valor: number; cuotasMora: number | null }>()
      try {
        const { error: genErr } = await supabase.rpc("generar_multas_ruta", {
          p_ruta_id: currentRutaId,
        })
        if (genErr) console.error("[v0] generar_multas_ruta:", genErr.message)

        const { data: multasData, error: multasErr } = await supabase
          .from("multas")
          .select("id, loan_id, valor, cuotas_mora")
          .eq("ruta_id", currentRutaId)
          .eq("estado", "pendiente")
        if (multasErr) throw multasErr
        for (const m of (multasData ?? []) as { id: string; loan_id: string; valor: number; cuotas_mora: number | null }[]) {
          multasMap.set(m.loan_id, { id: m.id, valor: m.valor, cuotasMora: m.cuotas_mora })
        }
      } catch (err) {
        console.error("[v0] Error cargando multas:", err)
      }

      // Process each loan with its payment plan
      for (const loan of activeLoans) {
        // Las ventas del dia no se cobran el mismo dia... salvo que se hayan
        // registrado con "Inicia pagos hoy", en cuyo caso su primera cuota
        // vence justamente hoy y el cliente TIENE que aparecer en la lista.
        // Sin esta excepcion, la casilla no serviria de nada: el plan
        // arrancaria hoy pero el cobrador no veria al cliente.
        //
        // OJO CON EL CIERRE ATRASADO. Esta regla mira el dia de trabajo, que
        // cerrando una jornada vieja es ESE dia y no hoy. Una venta hecha el 8
        // con primera cuota el 9, mirada mientras se cierra el 8, caia en
        // "venta de hoy sin cobro hoy" y el cliente DESAPARECIA de la lista:
        // ni en Ruta ni en Pendientes ni en Gestionados. Paso en la ruta 1 con
        // alberto mecanico cagua.
        //
        // Cerrando un dia pasado no hay nada que esconder: ese dia ya termino
        // y lo que se esta haciendo es completar lo que falto. Si al cliente
        // no le tocaba pagar, se vera con su "Prox. pago" y no sera tarea del
        // dia —de eso se encarga el conteo del cierre—, pero TIENE que estar
        // visible: si no, no hay como gestionarlo ni como saber por que no
        // aparece.
        if (loan.fecha_creacion && !esDiaAtrasado) {
          const fechaCreacionColombia = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Bogota",
            year: "numeric", month: "2-digit", day: "2-digit",
          }).format(new Date(loan.fecha_creacion))
          const cobraDesdeHoy = !!loan.fecha_primer_pago && loan.fecha_primer_pago <= hoy
          if (fechaCreacionColombia === hoy && !cobraDesdeHoy) continue
        }

        const paymentPlan = paymentPlansByLoan.get(loan.id) || []
        // Conteos sobre cuotas BASE: las extra de extensiones no alteran el
        // X/Y del prestamo, que es lo que el cliente pacto.
        // Una cuota saldada por CANCELACION TOTAL queda en estado 'cancelada',
        // no en 'pagado'. Contando solo 'pagado', un cliente que pagaba su
        // prestamo completo aparecia con "0 de 24 cuotas" — como si no
        // hubiera abonado nunca. Se cuentan las dos: en ambos casos la cuota
        // quedo saldada.
        const fin = finMap.get(loan.id)
        const cuotasPagadas = fin?.cuotas_cubiertas ?? paymentPlan.filter(
          (p) => !p.es_extra && (p.estado === "pagado" || p.estado === "cancelada"),
        ).length
        const cuotasTotales = fin?.cuotas_totales ?? paymentPlan.filter((p) => !p.es_extra).length
        const cuotasExtra = fin?.cuotas_extra ?? paymentPlan.filter((p) => p.es_extra).length

        // Sort by fecha_pago (vencimiento) to ensure correct order
        const sortedPlan = [...paymentPlan].sort((a, b) => a.fecha_pago.localeCompare(b.fecha_pago))

        // ── Gestionado HOY ───────────────────────────────────────────────
        // UNA sola regla: existe un evento aplicado con fecha_gestion = hoy.
        //
        // Antes esto se deducia de las cuotas (estado + fecha_pago + hora de
        // fecha_pago_real). Como cada gestion pisaba la fecha de la cuota, la
        // deduccion fallaba: aplicar un pago al dia anterior consumia el dia
        // de hoy del cliente — se iba a Gestionados sin salir en los
        // indicadores, y ya no se le podia registrar la gestion del dia.
        const gestionHoy = resumenDelDia(gestiones, loan.id, hoy)
        const gestionAyer = resumenDelDia(gestiones, loan.id, ayer)

        // ------------------------------------------------------------------
        // Cuota objetivo: la que el cobrador va a cobrar (nextPaymentId)
        // ------------------------------------------------------------------
        // Con el cronograma ya inmutable, `fecha_pago` es el vencimiento y la
        // eleccion es directa:
        //   1. La cuota que vence HOY, si sigue sin cubrir.
        //   2. La vencida mas vieja sin cubrir (atraso).
        //   3. La proxima futura — el cliente esta al dia. Sigue visible y
        //      SI se puede cobrar: es un pago adelantado.
        //
        // La cuota objetivo es una PISTA que viaja con la gestion: si al
        // sincronizar ya no aplica, el servidor asigna la plata a la cuota
        // mas antigua sin cubrir. Ya no existe el conflicto "esa cuota ya
        // fue gestionada".
        const sinCubrir = (p: PaymentPlanEntry) =>
          p.estado === "pendiente" || p.estado === "parcial" || p.estado === "no_pago"

        const pendingToday = sortedPlan.find((p) => sinCubrir(p) && p.fecha_pago === hoy)
        const oldestOverduePending = sortedPlan.find((p) => sinCubrir(p) && p.fecha_pago < hoy)
        const nextFuturePending = sortedPlan.find((p) => sinCubrir(p) && p.fecha_pago > hoy)

        const targetEntry = pendingToday || oldestOverduePending || nextFuturePending || null

        // Sin cuota por cobrar y sin gestion hoy: el prestamo esta saldado.
        if (!targetEntry && !gestionHoy.gestionado) {
          continue
        }

        // Cuota FUTURA: el cliente esta al dia. Cobrarle hoy es ADELANTAR.
        // Solo gobierna el badge y el orden en la lista, no el permiso.
        const esFuturo = !pendingToday && !oldestOverduePending && !!nextFuturePending

        // "Ultima cuota": la objetivo es la UNICA sin cubrir del plan —
        // resolverla agota el cronograma. Gobierna los checkboxes de
        // extension y cuota adicional.
        const sinCubrirRestantes = paymentPlan.filter(sinCubrir).length
        const esUltimaCuotaPendiente = !!targetEntry && sinCubrirRestantes === 1

        /**
         * EL CRONOGRAMA SE ACABO Y EL CLIENTE TODAVIA DEBE.
         *
         * `esUltimaCuotaPendiente` avisa cuando queda UNA cuota; esto avisa
         * cuando ya no queda NINGUNA y el saldo sigue vivo. Es el caso que se
         * escapaba: el plan se agota, nadie lo nota, y el cliente sigue
         * pagando todos los dias sin figurar en la meta —porque la meta suma
         * las cuotas que vencen ese dia y el no tiene ninguna—.
         *
         * Medido en la ruta 151: tres clientes asi, $52.000 que el cobrador
         * recauda y que nunca estuvieron en el objetivo.
         */
        const cronogramaAgotado =
          paymentPlan.length > 0 &&
          sinCubrirRestantes === 0 &&
          (fin?.saldo_hoy ?? saldoMap.get(loan.id) ?? 0) > 0

        // Mora en CUOTAS vencidas sin cubrir, derivada del cronograma intacto.
        const mora = moraMap.get(loan.id) ?? 0

        // Ultimo abono: sale del libro de eventos.
        const pagosDelLoan = gestiones
          .filter((g) => g.loan_id === loan.id && Number(g.monto) > 0
            && (g.tipo === "pago" || g.tipo === "cancelacion" || g.tipo === "abono_venta"))
          .sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora))
        const ultimoEvento = pagosDelLoan[pagosDelLoan.length - 1]

        // Saldo: lo que el cliente debe HOY, derivado del libro. `loan.saldo`
        // es un cache de la misma cuenta; solo se usa si la vista no
        // respondio, y se avisa para poder detectarlo en produccion.
        let saldoReal: number
        if (saldoMap.has(loan.id)) {
          saldoReal = saldoMap.get(loan.id)!
        } else {
          console.error(
            `[v0] FALTA v_loan_financiero para loan ${loan.id} — usando loans.saldo como ultimo recurso`,
          )
          saldoReal = loan.saldo
        }

        const clientData: DisplayClient = {
          loanId: loan.id,
          clientId: loan.client_id,
          nombre: loan.clients?.apodo || loan.clients?.nombre_completo || "Sin nombre",
          // Los dos por separado para poder pintarlos en dos lineas. El apodo
          // se descarta cuando es identico al nombre real: repetirlo no agrega
          // nada y ocupa una linea entera. La regla vive en `gestion-core`,
          // que es de donde la leen tambien Control Total y Control de Pagos.
          apodo: apodoSiAporta(loan.clients?.nombre_completo, loan.clients?.apodo),
          nombreCompleto: loan.clients?.nombre_completo
            ? sinApodo(loan.clients.nombre_completo, loan.clients.apodo)
            : (loan.clients?.apodo || "Sin nombre"),
          documento: loan.clients?.documento || "",
          // VALOR DE LA VENTA = el capital prestado, sin intereses.
          //
          // Antes dependia del tipo de credito: en americano mostraba el
          // capital y en los demas `valor_a_pagar`, que es capital + interes.
          // O sea que dos ventas del mismo monto se veian distinto segun el
          // metodo, y la que decia "Monto Venta" en realidad mostraba lo que
          // el cliente iba a terminar pagando.
          valorVenta: loan.valor,
          valorPrestamo: loan.valor,
          // Del MISMO sitio que el saldo. Con `total_a_pagar` y `saldo` de
          // fuentes distintas, el extracto podría mostrar un abonado que no
          // cuadra con la resta que el cliente hace de cabeza.
          totalAPagar: Number(fin?.total_a_pagar) || 0,
          abonado: Number(fin?.total_pagado) || 0,
          // Fecha en que se hizo la venta — se imprime en el recibo.
          fechaVenta: (loan.fecha_creacion || loan.created_at || "").split("T")[0],
          valorCuota: loan.valor_cuota,
          saldo: saldoReal,
          cuotasPagadas: cuotasPagadas,
          cuotasTotales: cuotasTotales,
          cuotasExtra: cuotasExtra,
          esUltimaCuotaPendiente,
          cronogramaAgotado,
          mora,
          ultimoPago: Number(ultimoEvento?.monto) || 0,
          ultimoPagoFecha: fechaUltimoPagoMap.get(loan.id) ?? ultimoEvento?.fecha_gestion ?? "",
          frecuenciaPago: loan.frecuencia_pago,
          tipoAmortizacion: loan.tipo_amortizacion ?? null,
          tasaInteres: loan.tasa_interes,
          // La cuota objetivo viaja como PISTA con la gestion. Si el plan ya
          // se agoto (cliente gestionado hoy sin cuotas por cobrar) queda
          // vacia: el servidor no la necesita para aplicar la plata.
          nextPaymentId: targetEntry?.id ?? "",
          nextPaymentCuota: targetEntry?.valor_cuota || loan.valor_cuota,
          nextPaymentNumero: targetEntry?.numero_cuota ?? 0,
          nextPaymentCapital: targetEntry?.capital ?? 0,
          nextPaymentValorCuota: targetEntry?.valor_cuota ?? loan.valor_cuota ?? 0,
          nextPaymentEsFuturo: esFuturo,
          nextPaymentFecha: targetEntry?.fecha_pago ?? hoy,
          ordenvisita: loan.ordenvisita || 0,
          diaSemana: loan.dia_semana || null,
          multaPendiente: multasMap.get(loan.id) ?? null,
          clienteLatitud: loan.clients?.latitud ?? null,
          clienteLongitud: loan.clients?.longitud ?? null,
          // Día anterior sin gestionar: hay cuota vencida Y ayer no se
          // registró nada. Es lo que dispara la pregunta "¿a qué fecha
          // aplico esta gestión?".
          cuotaVencidaId: !gestionAyer.gestionado ? (oldestOverduePending?.id ?? null) : null,
          cuotaVencidaFecha: !gestionAyer.gestionado && oldestOverduePending ? ayer : null,
        }

        if (gestionHoy.gestionado) {
          managedClientsFromDB.push({
            ...clientData,
            gestionTipo: gestionHoy.tipo === "pago" ? "pago" : "no_pago",
            gestionHora: gestionHoy.hora,
            gestionInstante: gestionHoy.instante,
            valorAbonado: gestionHoy.monto,
            cuotasAbonadas: gestionHoy.cuotas,
            metodoPago: gestionHoy.metodo,
            paymentPlanId: targetEntry?.id ?? "",
          })
        } else {
          // Solo los ACTIVOS entran a la lista de cobro.
          //
          // Antes preguntaba `=== "cancelado"`, que era lo mismo mientras
          // `estado` solo tuviera esos dos valores. Con 'anulado' (script 068)
          // dejo de serlo: una venta anulada se colaba en la ruta como si nada.
          // Preguntar por lo que SI se quiere, y no por lo que no, aguanta el
          // proximo estado que aparezca.
          if (loan.estado !== "activo") {
            continue
          }
          pendingClients.push(clientData)
        }
      }

      // Mismo criterio que la lista visible: manda `ordenvisita`, y solo
      // entre los que no lo tienen asignado decide la cuota futura. Si los dos
      // ordenes no coincidieran, la lista daria un salto al terminar de
      // cargar.
      pendingClients.sort((a, b) => {
        const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
        const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
        if (ordA !== ordB) return ordA - ordB
        if (a.fechaVenta !== b.fechaVenta) return a.fechaVenta < b.fechaVenta ? -1 : 1
        return a.loanId < b.loanId ? -1 : a.loanId > b.loanId ? 1 : 0
      })
      managedClientsFromDB.sort((a, b) => a.ordenvisita - b.ordenvisita)

      // Solo aplicamos el resultado si este fetch sigue siendo el mas reciente.
      if (fetchDataTokenRef.current !== myToken) return

      setClients(pendingClients)
      setManagedToday(managedClientsFromDB)
    } catch (error) {
      if (fetchDataTokenRef.current !== myToken) return
      console.error("[v0] Error fetching payment data:", error)
      toastRef.current({
        title: "Error",
        description: "No se pudieron cargar los datos. Intenta nuevamente.",
        variant: "destructive",
      })
    } finally {
      // Solo apagamos el loading si seguimos siendo el fetch activo
      // Y si no fue un refresh silencioso (en ese caso nunca lo encendimos).
      if (fetchDataTokenRef.current === myToken && !silent) {
        setLoading(false)
      }
    }
    // `diaDeTrabajo` entra en las dependencias: al desbloquear la ruta el
    // módulo pasa a hablar de otro día y la lista tiene que rearmarse.
  }, [currentRutaId, diaDeTrabajo])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  /**
   * EL TECLADO DEL TELÉFONO NO TAPA EL BOTÓN DE COBRAR.
   *
   * En el celular el teclado se abre ENCIMA de la página: el navegador
   * achica la parte visible (`visualViewport`) pero no la página, así que lo
   * que está pegado al fondo queda escondido detrás. Se mide dónde empieza
   * el teclado y se sube la barra lo justo para quedar encima de él.
   */
  useEffect(() => {
    if (!selectedClient) { setSubirBarra(0); return }
    const vv = typeof window !== "undefined" ? window.visualViewport : null
    if (!vv) return
    const medir = () => {
      const barra = barraCobrarRef.current
      if (!barra) return
      // Sin teclado la parte visible mide casi toda la ventana.
      const teclado = window.innerHeight - vv.height - vv.offsetTop
      if (teclado < 80) { setSubirBarra(0); return }
      const bordeTeclado = vv.offsetTop + vv.height
      // La posición de la barra SIN el desplazamiento que ya tiene.
      const actual = Number(barra.style.transform.match(/-?(\d+(?:\.\d+)?)px/)?.[1] ?? 0)
      const fondoBarra = barra.getBoundingClientRect().bottom + actual
      setSubirBarra(Math.max(0, Math.ceil(fondoBarra - bordeTeclado + 4)))
    }
    medir()
    vv.addEventListener("resize", medir)
    vv.addEventListener("scroll", medir)
    return () => {
      vv.removeEventListener("resize", medir)
      vv.removeEventListener("scroll", medir)
    }
  }, [selectedClient])

  // Las cuentas de la ruta para las transferencias. Se guardan en el
  // teléfono: sin señal se elige de la última lista conocida.
  useEffect(() => {
    if (!currentRutaId) return
    const clave = `cuentasRuta:${currentRutaId}`
    try {
      const guardadas = JSON.parse(localStorage.getItem(clave) ?? "null")
      if (Array.isArray(guardadas)) setCuentasPago(guardadas)
    } catch { /* ilegible */ }
    let cancelado = false
    fetch(`/api/cuentas?ruta=${currentRutaId}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelado || !Array.isArray(data)) return
        // `etiqueta` = "Banco · número" (api/cuentas): el cobrador elige por el número.
        const lista = data.map((c: { id: string | number; nombre: string; etiqueta?: string }) => ({ id: String(c.id), nombre: c.etiqueta ?? c.nombre }))
        setCuentasPago(lista)
        try { localStorage.setItem(clave, JSON.stringify(lista)) } catch { /* modo privado */ }
      })
      .catch(() => { /* sin señal: queda la guardada */ })
    return () => { cancelado = true }
  }, [currentRutaId])

  const handleSelectClient = (client: DisplayClient) => {
    // El formulario abre ARRIBA. Si se venía de más abajo en la lista, la
    // pantalla quedaba corrida y había que buscar el botón de cobrar.
    document.querySelector("main")?.scrollTo({ top: 0 })
    setSelectedClient(client)
    setNumCuotas(1)
    setIsPartialPayment(false)
    setPaymentAmount(montoAProponer(client.nextPaymentCuota, client.saldo).toString())
    setPaymentMethod("efectivo")
    setDosFormas(false)
    setMontoEfectivoMixto("")
    setMontoTransfMixto("")
    setAccountNumber("")
    setNotasPago("")
    setPaymentPhoto(null)
    setIsCancelada(false)
    setRenovar(false)
    setValorRenovar("")
    setDiasRenovar("")
    setExtenderCuotas(false)
    setCantidadCuotasExtender("1")
    setPagarMulta(false)
    setAgregarCuotaSiDebe(true)
    // Nota: ya no hacemos fetch de saldo aqui. Usamos client.saldo
    // directamente del listado para que el dialogo abra al instante.
  }

  const handleBack = () => {
    setSelectedClient(null)
    setNumCuotas(1)
    setIsPartialPayment(false)
    setPaymentAmount("")
    setPaymentMethod("efectivo")
    setDosFormas(false)
    setMontoEfectivoMixto("")
    setMontoTransfMixto("")
    setAccountNumber("")
    setNotasPago("")
    setPaymentPhoto(null)
    setIsCancelada(false)
    setRenovar(false)
    setValorRenovar("")
    setDiasRenovar("")
    setExtenderCuotas(false)
    setCantidadCuotasExtender("1")
    setPagarMulta(false)
    setAgregarCuotaSiDebe(true)
  }

  const handleRegisterPayment = async () => {
    // El candado se toma ANTES de cualquier `await` y se suelta en el finally
    // de mas abajo, que cubre TODAS las salidas de esta funcion.
    if (enviandoRef.current) return
    enviandoRef.current = true
    // Deshabilita el boton de una vez, sin esperar al GPS: el ref evita el
    // duplicado, pero el cobrador tambien necesita ver que su toque entro.
    setSaving(true)
    try {
    if (!selectedClient || !selectedClient.nextPaymentId) {
      toast({ title: "Error", description: "No hay cuota pendiente para este cliente", variant: "destructive" })
      return
    }

    // Validaciones sincronicas ANTES de pedir GPS.
    const monto = Number.parseFloat(paymentAmount)
    if (isNaN(monto) || monto <= 0) {
      toast({ title: "Error", description: "Ingrese un monto valido", variant: "destructive" })
      return
    }

    // Con dos formas, cada una tiene que traer plata y entre las dos sumar
    // el monto del pago: lo que se registra es exactamente lo que se cobró.
    // Se escribe el efectivo; la transferencia es lo que falta para el monto.
    const partEfectivo = dosFormas ? Number.parseFloat(montoEfectivoMixto) || 0 : 0
    const partTransf = dosFormas ? Math.max(0, monto - partEfectivo) : 0
    if (dosFormas && (partEfectivo <= 0 || partTransf <= 0)) {
      toast({
        title: "Faltan los valores",
        description: "Con dos formas de pago escribe cuánto va en efectivo y cuánto en transferencia.",
        variant: "destructive",
      })
      return
    }
    if (dosFormas && Math.round(partEfectivo + partTransf) !== Math.round(monto)) {
      toast({
        title: "Los valores no suman el pago",
        description: `Efectivo $${partEfectivo.toLocaleString("es-CO")} + transferencia $${partTransf.toLocaleString("es-CO")} = $${(partEfectivo + partTransf).toLocaleString("es-CO")}, y el pago es de $${monto.toLocaleString("es-CO")}.`,
        variant: "destructive",
      })
      return
    }

    // La transferencia dice A QUÉ CUENTA entró: sin eso secretaría no puede
    // cuadrar el extracto. Solo se exige si la ruta tiene cuentas cargadas.
    if ((dosFormas || paymentMethod === "transferencia") && cuentasPago.length > 0 && !accountNumber) {
      toast({ title: "Falta la cuenta", description: "Elige la cuenta a la que entró la transferencia.", variant: "destructive" })
      return
    }
    const cuentaSnap = accountNumber || null
    const notasSnap = notasPago.trim() || null
    const fotoSnap = paymentPhoto

    // RENOVAR: se valida TODO antes de cobrar, para no dejar un pago hecho y
    // una renovación rebotada por algo que se podía saber desde acá.
    const renovarSnap = renovar
    const valorRenovarN = Number.parseFloat(valorRenovar) || 0
    const diasRenovarN = Number.parseInt(diasRenovar, 10) || 0
    if (renovarSnap) {
      if (valorRenovarN <= 0 || diasRenovarN < 1) {
        toast({ title: "Faltan datos de la renovación", description: "Escribe el valor a renovar y los días.", variant: "destructive" })
        return
      }
      if (selectedClient.tipoAmortizacion?.toLowerCase().trim() === "americano") {
        toast({ title: "No se puede renovar", description: "Los créditos americanos se extienden con la prórroga.", variant: "destructive" })
        return
      }
      // Si el pago salda el crédito, el crédito queda cancelado y ya no hay
      // qué renovar: para eso está la venta nueva de renovación.
      if (monto >= selectedClient.saldo) {
        toast({
          title: "Este pago salda el crédito",
          description: "Para renovar, el pago no puede cubrir todo el saldo. Si va a cancelar, hazle después una venta de renovación.",
          variant: "destructive",
        })
        return
      }
      if (
        umbrales?.venta_renovacion_habilitado &&
        umbrales.venta_renovacion_umbral != null &&
        valorRenovarN > umbrales.venta_renovacion_umbral
      ) {
        toast({
          title: "La renovación supera el umbral de la ruta",
          description: `El tope es $${umbrales.venta_renovacion_umbral.toLocaleString("es-CO")}. Una renovación mayor la hace secretaría.`,
          variant: "destructive",
        })
        return
      }
    }

    const saldoDisponible = selectedClient.saldo
    if (monto > saldoDisponible) {
      toast({
        title: "Monto excede el saldo",
        description: `El monto del pago ($${monto.toLocaleString()}) no puede ser mayor al saldo a pagar ($${saldoDisponible.toLocaleString()})`,
        variant: "destructive",
      })
      return
    }

    // GPS y geocerca primero (el GPS puede tardar 1-2s en moviles): si no
    // esta, o el cobrador esta lejos y no justifica, no abrimos saving.
    const geocerca = await resolverGeocerca(selectedClient, "pagos")
    if (!geocerca) return
    const coords = geocerca.coords

    const clientSnapshot = selectedClient
    const dosFormasSnap = dosFormas
    const isCanceladaSnap = isCancelada
    const isPartialSnap = isPartialPayment
    const numCuotasSnap = numCuotas
    // Snapshot de "pagar multa": solo valido si el cliente tiene multa pendiente.
    const pagarMultaSnap = pagarMulta && !!clientSnapshot.multaPendiente
    // Snapshot del flag de extension. Solo aplica si:
    //   - el prestamo es tipo "americano" (intereses)
    //   - la cuota actual es la ULTIMA del plan
    //   - el admin marco el checkbox y digito una cantidad valida (>=1)
    const extenderSnap =
      extenderCuotas &&
      clientSnapshot.tipoAmortizacion?.toLowerCase().trim() === "americano" &&
      clientSnapshot.esUltimaCuotaPendiente
    const cantidadExtenderSnap = (() => {
      const n = Number.parseInt(cantidadCuotasExtender, 10)
      return Number.isFinite(n) && n > 0 ? n : 0
    })()
    if (extenderSnap && cantidadExtenderSnap === 0) {
      toast({
        title: "Cantidad invalida",
        description: "Ingresa una cantidad valida de cuotas a extender (>= 1).",
        variant: "destructive",
      })
      return
    }
    // Snapshot de "agregar cuota adicional si debe": recalculado desde la
    // condicion real (no solo el checkbox) para que jamas se dispare fuera
    // de la ultima cuota, ni mezclado con cancelacion total o con la
    // extension manual de americano.
    const agregarCuotaSnap =
      agregarCuotaSiDebe &&
      !isCanceladaSnap &&
      !extenderSnap &&
      clientSnapshot.esUltimaCuotaPendiente

    try {
      setSaving(true)

      // Día de negocio y hora exacta, ambos en zona Colombia y de la misma
      // fuente (ver lib/gestion-core.ts).
      // El día al que pertenece el cobro. Con la ruta desbloqueada para
      // cerrar una jornada vieja, es ESE día y no hoy.
      const fechaPago = diaDeTrabajo
      const fechaPagoReal = ahoraColombiaISO()
      const { latitud, longitud } = coords

      // La gestion se registra SIEMPRE con la fecha de hoy.
      //
      // Aca se abria un dialogo —"Quedó un día sin gestionar"— preguntando si
      // el pago iba para ayer o para hoy. Se quito a pedido del dueno: saltaba
      // en cada cliente que arrastrara una cuota vencida, o sea en media ruta
      // los lunes, y en la calle se contesta lo primero que aparezca. La plata
      // se recibe HOY y se registra HOY, que ademas es lo que respondia el 99%
      // de las veces.
      //
      // Lo que se dejo de decidir aca no se pierde: la cuota vieja sigue
      // pendiente y la cascada le asigna la plata igual, porque reparte de la
      // mas vieja hacia adelante. Y si hay que fechar algo en un dia anterior,
      // ese es el trabajo de Control de Pagos.
      const fechaAplicacion = fechaPago
      const numCuotasEfectivo = numCuotasSnap
      const retroAplicado = false

      // Llave del evento: se genera AQUI, al capturar. Es la misma que se
      // usa ahora o dentro de dos horas al drenar la cola, y es la llave
      // primaria del libro — reintentar no puede duplicar la plata.
      const gestionId = nuevaGestionId()

      // -----------------------------------------------------------------
      // ── Umbral de aprobacion de abonos por ruta ──────────────────────
      // El umbral compara la CANTIDAD DE CUOTAS pagadas de una sola vez
      // (selector "Nro Cuotas"), no el monto en pesos. Solo aplica a pago
      // normal -- pago parcial (siempre 1 cuota) y cancelacion total (paga
      // todo el prestamo) nunca disparan este umbral. Si se dispara, el
      // pago se envia a revision ANTES de tocar cualquier tabla real
      // (incluidos los pre-pasos de "pago extraordinario" y "extension de
      // americano" de mas abajo, que tambien quedan en espera).
      // payment_plan/loans no se modifican hasta que secretaria apruebe.
      // El chequeo de aquí es solo un AVISO: se le advierte al cobrador que
      // el abono va a necesitar el visto bueno de secretaría y se le pide
      // confirmar. Quien DECIDE es el servidor, que compara contra la
      // configuración de la ruta dentro de la misma transacción.
      //
      // Antes este camino armaba a mano una solicitud de revisión y no
      // registraba el pago: eran dos formas distintas de payload y dos
      // caminos que podían comportarse distinto. Peor: si la configuración
      // de umbrales no había alcanzado a cargar, el chequeo daba negativo y
      // el abono se aplicaba directo, saltándose la aprobación sin que
      // nadie se enterara. Ahora el pago viaja siempre igual y el servidor
      // lo marca "en revisión" si corresponde — la plata queda registrada
      // desde el primer momento, pero no cuenta hasta que la aprueben.
      if (
        !isCanceladaSnap && !isPartialSnap &&
        excedeUmbral(umbrales?.abono_habilitado ?? false, umbrales?.abono_umbral_cuotas ?? null, numCuotasEfectivo)
      ) {
        const confirmado = await confirmRevision()
        if (!confirmado) { setSaving(false); return }
      }

      // -----------------------------------------------------------------
      // ── DOBLE CANDADO de extension (blindaje anti-bug) ───────────────
      // El RPC `extender_prestamo_americano` SOLO puede dispararse si las
      // 3 condiciones se cumplen simultaneamente. Re-evaluamos aqui las
      // condiciones literales (no confiamos solo en `extenderSnap`) para
      // que un pago normal de cuotas intermedias jamas toque la rama de
      // extension. Si algun guard fallara, abortamos la extension con un
      // log explicito en lugar de silenciosamente dispararla.
      const debeExtender =
        extenderCuotas === true &&
        clientSnapshot.tipoAmortizacion?.toLowerCase().trim() === "americano" &&
        clientSnapshot.esUltimaCuotaPendiente

      if (extenderSnap !== debeExtender) {
        console.warn(
          "[v0] BLINDAJE-EXTENDER mismatch entre snapshot y guard literal:",
          { extenderSnap, debeExtender, extenderCuotas, clientSnapshot },
        )
      }

      // Pre-steps (solo para extension de americano):
      //
      // 1) Ajustar el `valor_cuota` de la ULTIMA cuota original.
      //    Antes valia `intereses + capital` (cierre del prestamo); ahora
      //    pasa a ser un pago normal de intereses, asi que lo bajamos a
      //    `loan.valor_cuota`.
      //
      // 2) Crear las N cuotas adicionales (extension) ANTES de registrar
      //    el pago. Esto es CRITICO para evitar que el `registrar_pago_atomico`
      //    marque el prestamo como `cancelado`: la RPC cancela el loan
      //    cuando ya no quedan cuotas en estado 'pendiente'. Si la
      //    extension corriera DESPUES del pago, habria una ventana donde
      //    el loan queda en estado 'cancelado' (con `tiene_prestamo_activo
      //    = false` en el cliente) y solo despues se reactivaria — lo cual
      //    es exactamente lo que queremos evitar.
      //
      //    Al insertar primero las nuevas cuotas pendientes, cuando la RPC
      //    procese la cuota actual quedaran cuotas pendientes y el loan
      //    se mantendra en estado 'activo' sin pasar nunca por 'cancelado'.
      // -----------------------------------------------------------------
      // La prorroga de americano ya NO se ejecuta aqui: viaja en el payload
      // (`extender_cuotas`) y la RPC la aplica dentro de la misma transaccion
      // del pago. Antes eran 2 escrituras sueltas ANTES del pago cuyo orden
      // era critico — si el pago fallaba despues, el prestamo quedaba
      // extendido sin cobrar.

      // -----------------------------------------------------------------
      // Llamada al RPC atomico `registrar_pago_atomico`.
      //
      // La RPC envuelve en una sola transaccion todos los UPDATEs que
      // antes corrian con `Promise.all` separados, garantizando atomicidad
      // (rollback completo si algun paso falla). El payload va como `jsonb`
      // con una firma estable y la funcion deriva `tipo` para decidir si
      // paga 1 cuota, varias, cancelacion total o no_pago.
      // -----------------------------------------------------------------
      // El evento viaja por la cola: sin señal queda en el teléfono y se
      // sincroniza solo. Su `id` es la llave primaria del libro, así que
      // sincronizar horas después no puede duplicar la plata.
      // ── PAGO EN DOS FORMAS: dos eventos del libro ────────────────────
      // Primero va la parte en TRANSFERENCIA como un pago simple; después la
      // PRINCIPAL (efectivo), que es la que lleva todo lo demás: la multa,
      // la prórroga, la cuota adicional y, si es el caso, la cancelación.
      //
      // El orden importa en la cancelación: el servidor cobra como
      // cancelación el saldo que QUEDA, así que la otra parte tiene que
      // haber entrado antes. Por eso, si la primera quedó en la cola por
      // falta de señal, la segunda va a la cola detrás de ella (la cola se
      // envía en orden de captura) y no directo.
      //
      // Las dos llevan el mismo `num_cuotas`: el umbral de abono del
      // servidor se evalúa igual que con un pago de una sola forma, y partir
      // el pago no sirve para esquivarlo.
      const montoPrincipal = dosFormasSnap ? monto - partTransf : monto
      const metodoPrincipal = dosFormasSnap ? "efectivo" : paymentMethod
      let parteEncolada = false
      let gestionLocalTransf: Gestion | null = null
      if (dosFormasSnap) {
        const idTransf = nuevaGestionId()
        const payloadTransf = {
          id: idTransf,
          tipo: "pago",
          loan_id: clientSnapshot.loanId,
          client_id: clientSnapshot.clientId,
          monto: partTransf,
          num_cuotas: numCuotasEfectivo,
          fecha_gestion: fechaAplicacion,
          fecha_hora: fechaPagoReal,
          latitud,
          longitud,
          geocerca_estado: geocerca.geo.estado,
          geocerca_motivo: geocerca.motivo,
          generar_cuota_si_debe: false,
          cuota_objetivo: clientSnapshot.nextPaymentId || null,
          multa_id: null,
          metodo_pago: "transferencia",
          cliente_nombre: clientSnapshot.nombre,
          extender_cuotas: 0,
          cuenta_id: cuentaSnap,
        }
        const r1 = await enviarOEncolar({
          tipo: "gestion",
          id: idTransf,
          descripcion: `Pago (transferencia) — ${clientSnapshot.nombre} ($${partTransf.toLocaleString()})`,
          payload: payloadTransf,
        })
        parteEncolada = r1.encolado
        gestionLocalTransf = {
          id: idTransf,
          loan_id: clientSnapshot.loanId,
          client_id: clientSnapshot.clientId,
          ruta: currentRutaId,
          user_id: null,
          tipo: "pago",
          estado: "aplicada",
          fecha_gestion: fechaAplicacion,
          monto: partTransf,
          cuota_objetivo: clientSnapshot.nextPaymentId || null,
          num_cuotas: numCuotasEfectivo,
          fecha_hora: fechaPagoReal,
          metodo_pago: "transferencia",
          origen: "campo",
          referencia_gestion_id: null,
          observacion: null,
        }
        if (parteEncolada) {
          // Un respiro de milisegundos: la cola ordena por el instante de
          // captura y las dos partes no pueden empatar.
          await new Promise((r) => setTimeout(r, 5))
        }
      }

      const payloadPrincipal = {
          id: gestionId,
          tipo: isCanceladaSnap ? "cancelacion" : "pago",
          loan_id: clientSnapshot.loanId,
          client_id: clientSnapshot.clientId,
          monto: montoPrincipal,
          num_cuotas: numCuotasEfectivo,
          fecha_gestion: fechaAplicacion,
          fecha_hora: fechaPagoReal,
          latitud,
          longitud,
          // Resultado de la geocerca al momento de capturar. La distancia NO
          // se manda: el servidor la recalcula contra la ubicacion guardada
          // del cliente, porque un numero venido del dispositivo no prueba
          // nada (el payload offline se guarda tal cual y nadie lo revisa).
          geocerca_estado: geocerca.geo.estado,
          geocerca_motivo: geocerca.motivo,
          generar_cuota_si_debe: agregarCuotaSnap,
          // Pista de a qué cuota apuntaba el cobrador. Si al sincronizar ya
          // no aplica, el servidor asigna la plata a la más antigua sin
          // cubrir: nunca se rechaza un pago por una cuota desactualizada.
          cuota_objetivo: clientSnapshot.nextPaymentId || null,
          // La multa y la prórroga entran en la misma transacción.
          multa_id: pagarMultaSnap ? clientSnapshot.multaPendiente?.id ?? null : null,
          metodo_pago: metodoPrincipal,
          cliente_nombre: clientSnapshot.nombre,
          extender_cuotas: debeExtender ? cantidadExtenderSnap : 0,
          // Las notas, la foto y la cuenta van en el MISMO evento (script
          // 125 las guarda en `detalle`; `observacion` ya existía).
          observacion: notasSnap,
          foto_url: fotoSnap,
          cuenta_id: metodoPrincipal === "transferencia" ? cuentaSnap : null,
      }
      const descripcionPrincipal = dosFormasSnap
        ? `Pago (efectivo) — ${clientSnapshot.nombre} ($${montoPrincipal.toLocaleString()})`
        : `Pago — ${clientSnapshot.nombre} ($${monto.toLocaleString()})`
      const { encolado, resultado } = parteEncolada
        ? await encolar({ tipo: "gestion", id: gestionId, descripcion: descripcionPrincipal, payload: payloadPrincipal })
            .then(() => ({ encolado: true as const, resultado: undefined }))
        : await enviarOEncolar({
            tipo: "gestion",
            id: gestionId,
            descripcion: descripcionPrincipal,
            payload: payloadPrincipal,
          })

      // ── LA RENOVACIÓN, DETRÁS DEL PAGO ─────────────────────────────────
      // Primero el pago y después la renovación: la renovación conserva las
      // cuotas que la plata ya cubre, así que el cobro de hoy tiene que haber
      // entrado antes. Si el pago quedó en la cola, la renovación va a la cola
      // detrás de él (se envía en orden de captura) y no directo.
      let renovacionOk = false
      let renovacionError: string | null = null
      if (renovarSnap) {
        const idRenov = nuevaGestionId()
        const opRenov = {
          tipo: "rpc" as const,
          id: idRenov,
          descripcion: `Renovación — ${clientSnapshot.nombre} ($${valorRenovarN.toLocaleString()})`,
          payload: {
            fn: "renovar_prestamo",
            payload: {
              loan_id: clientSnapshot.loanId,
              valor: valorRenovarN,
              dias: diasRenovarN,
              fecha_gestion: fechaAplicacion,
              fecha_hora: fechaPagoReal,
            },
          },
        }
        try {
          if (encolado) {
            await new Promise((r) => setTimeout(r, 5))
            await encolar(opRenov)
            renovacionOk = true
          } else {
            const r = await enviarOEncolar(opRenov)
            renovacionOk = r.encolado || r.resultado?.ok !== false
          }
        } catch (err) {
          // El pago YA entró: no se deshace. Se avisa que la renovación no, y
          // por qué (umbral, crédito cancelado, script 123 sin correr…).
          const e = err as { message?: string; code?: string }
          renovacionError = e.code === "PGRST202"
            ? "Falta correr el script 123 en la base."
            : e.message || "Error desconocido"
          console.error("[v0] Renovación:", err)
        }
      }
      const sufijoRenov = renovarSnap && renovacionOk
        ? ` · Cliente renovado por $${valorRenovarN.toLocaleString("es-CO")}`
        : ""
      if (renovacionError) {
        toast({
          title: "El pago quedó, la renovación no",
          description: renovacionError,
          variant: "destructive",
        })
      }

      if (encolado) {
        // El cliente sale de Pendientes IGUAL que con señal, y el evento se
        // inyecta en el cache del dispositivo.
        //
        // Antes la rama offline no tocaba nada: el cliente se quedaba en la
        // lista y, si el cobrador cerraba y reabría la app, volvía a
        // aparecer. Cobrarle otra vez generaba una SEGUNDA operación con
        // otra llave — dos cobros que el servidor no podía reconocer como
        // el mismo. Es el peor agujero que tenía el modo sin señal.
        const gestionLocal: Gestion = {
          id: gestionId,
          loan_id: clientSnapshot.loanId,
          client_id: clientSnapshot.clientId,
          ruta: currentRutaId,
          user_id: null,
          tipo: isCanceladaSnap ? "cancelacion" : "pago",
          estado: "aplicada",
          fecha_gestion: fechaAplicacion,
          monto: montoPrincipal,
          cuota_objetivo: clientSnapshot.nextPaymentId || null,
          num_cuotas: numCuotasEfectivo,
          fecha_hora: fechaPagoReal,
          metodo_pago: metodoPrincipal,
          origen: "campo",
          referencia_gestion_id: null,
          observacion: notasSnap,
        }
        void parcharCache<DashboardPagosResult>("dashboard-pagos", currentRutaId, (datos) =>
          gestionLocalTransf
            ? inyectarGestionEnCache(inyectarGestionEnCache(datos, gestionLocalTransf), gestionLocal)
            : inyectarGestionEnCache(datos, gestionLocal),
        )

        if (!retroAplicado) {
          setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
          setManagedToday((prev) => [
            {
              ...clientSnapshot,
              saldo: Math.max(0, clientSnapshot.saldo - monto),
              multaPendiente: pagarMultaSnap ? null : clientSnapshot.multaPendiente,
              gestionTipo: "pago",
              // El método que se acaba de elegir en el formulario: la lista lo
              // marca al instante, sin esperar al refetch.
              metodoPago: dosFormasSnap ? "mixto" : paymentMethod === "transferencia" ? "transferencia" : "efectivo",
              gestionHora: fechaPagoReal.slice(11, 16),
              gestionInstante: fechaPagoReal,
              valorAbonado: monto,
              cuotasAbonadas: numCuotasEfectivo,
              paymentPlanId: clientSnapshot.nextPaymentId || undefined,
            },
            ...prev,
          ])
        }

        toast({
          duration: 1000,
          title: "Pago guardado sin conexión",
          description: retroAplicado
            ? `Se registró $${monto.toLocaleString()} con fecha ${fechaAplicacion} en el teléfono. ${clientSnapshot.nombre} sigue disponible para la gestión de hoy.`
            : `Se registró el pago de ${clientSnapshot.nombre} en el teléfono${sufijoRenov}. Se enviará solo cuando vuelva la señal.`,
        })
        handleBack()
        return
      }

      const rpcResult = resultado!

      // Valores derivados desde la respuesta autoritativa del RPC.
      // Los usamos para el optimistic UI inmediato (sin esperar al refetch).
      const nuevoSaldo = (rpcResult.nuevo_saldo as number | undefined) ?? clientSnapshot.saldo
      void rpcResult.loan_estado_final
      void rpcResult.cliente_marcado_sin_prestamo

      // El evento SIEMPRE quedó escrito. Si algo no cuadraba (préstamo ya
      // cancelado, fecha de hace más de un día, abono sobre el umbral de la
      // ruta), entró como "en revisión": la plata está registrada pero no
      // cuenta hasta que secretaría la apruebe. No se mueve a Gestionados.
      if (rpcResult.enviado_a_revision || rpcResult.estado_gestion === "en_revision") {
        toast({
          title: "Pago enviado a revisión",
          description: `${rpcResult.motivo ?? "El pago necesita aprobación"}. Secretaría lo revisará; el cobro ya quedó registrado.`,
        })
        void fetchData({ silent: true })
        handleBack()
        return
      }

      // Recibió más de lo que debía: el excedente se registró igual (nunca
      // se descarta plata), pero conviene que el cobrador lo sepa.
      const sobrepago = Number(rpcResult.sobrepago ?? 0)
      if (sobrepago > 0) {
        toast({
          title: "El abono superó el saldo",
          description: `El saldo de ${clientSnapshot.nombre} quedó en $0 y sobraron $${sobrepago.toLocaleString()}. Verifica con secretaría si hay que devolverlos.`,
        })
      }

      // El cobro de la multa ya viene resuelto por la RPC, dentro de la misma
      // transaccion del pago: o entran los dos, o no entra ninguno. Antes eran
      // dos escrituras sueltas y si la segunda fallaba, la multa quedaba
      // cobrada pero el dinero nunca llegaba a la caja de la ruta.
      const multaCobrada = rpcResult.multa_cobrada === true

      // ── Gestion aplicada al dia anterior ─────────────────────────────
      // NO se mueve a Gestionados: la gestion quedo fechada en ese dia y el
      // cliente sigue vigente para la gestion de HOY. El refetch recalcula
      // su cuota objetivo (la de hoy) y lo deja en la lista de pendientes.
      if (retroAplicado) {
        const multaSufijoRetro = multaCobrada && clientSnapshot.multaPendiente
          ? ` + multa de $${clientSnapshot.multaPendiente.valor.toLocaleString()}`
          : ""
        toast({
          title: `Pago aplicado al ${fechaAplicacion}`,
          description: `Se registró $${monto.toLocaleString()}${multaSufijoRetro} a la cuota del ${fechaAplicacion} de ${clientSnapshot.nombre}. El cliente sigue disponible para la gestión de hoy.`,
        })
        void fetchData({ silent: true })
        handleBack()
        return
      }

      // Optimistic UI con los números que devolvió el servidor (saldo y
      // cuotas cubiertas son derivados, no estimaciones del dispositivo).
      const gestionHora = fechaPagoReal.slice(11, 16)
      setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
      setManagedToday((prev) => [
        {
          ...clientSnapshot,
          // El método que se acaba de elegir: la lista lo marca al instante,
          // sin esperar al refetch.
          metodoPago: dosFormasSnap ? "mixto" : paymentMethod === "transferencia" ? "transferencia" : "efectivo",
          saldo: nuevoSaldo,
          cuotasPagadas: Number(rpcResult.cuotas_cubiertas ?? clientSnapshot.cuotasPagadas),
          multaPendiente: multaCobrada ? null : clientSnapshot.multaPendiente,
          gestionTipo: "pago",
          gestionHora,
          gestionInstante: fechaPagoReal,
          valorAbonado: monto,
          cuotasAbonadas: isCanceladaSnap
            ? Math.max(1, Number(rpcResult.cuotas_cubiertas ?? 0) - clientSnapshot.cuotasPagadas)
            : numCuotasEfectivo,
          paymentPlanId: clientSnapshot.nextPaymentId || undefined,
        },
        ...prev,
      ])

      if (isCanceladaSnap) {
        toast({
          duration: 1000,
          title: "Préstamo cancelado",
          description: `Se canceló el préstamo de ${clientSnapshot.nombre} con un pago de $${monto.toLocaleString()}`,
        })
        setClientForRenovation(clientSnapshot)
        setShowRenovationDialog(true)
      } else if (debeExtender && rpcResult.extension_aplicada) {
        // La extension corrio dentro de la misma transaccion del pago.
        toast({
          duration: 1000,
          title: "Pago registrado y préstamo extendido",
          description: `Pago registrado y préstamo extendido exitosamente por ${cantidadExtenderSnap} cuota${cantidadExtenderSnap === 1 ? "" : "s"} más`,
        })
      } else if (debeExtender && rpcResult.extension_motivo) {
        // El pago SÍ entró; solo la extensión no aplicaba. La plata nunca
        // queda de rehén de una validación.
        toast({
          title: "Pago registrado, extensión no aplicada",
          description: String(rpcResult.extension_motivo),
        })
      } else if (rpcResult.cuota_adicional_generada) {
        // El cliente aun debia al agotarse el plan de pagos: se generó una
        // cuota adicional en vez de cancelar el prestamo (confirmado por el
        // checkbox "Agregar cuota adicional si aún debe").
        toast({
          duration: 1000,
          title: "Pago registrado — cuota adicional agregada",
          description: `Se registró el pago para ${clientSnapshot.nombre}. Como aún debe, se agregó una cuota adicional al plan de pagos.`,
        })
      } else {
        const multaSuffix = multaCobrada && clientSnapshot.multaPendiente
          ? ` + multa de $${clientSnapshot.multaPendiente.valor.toLocaleString()}`
          : ""
        toast({
          duration: 1000,
          title: "Pago registrado",
          description: `Se registró el pago por $${monto.toLocaleString()}${multaSuffix} para ${clientSnapshot.nombre}${sufijoRenov}`,
        })
      }

      // Refetch SILENCIOSO en background para sincronizar mora/saldos calculados.
      void fetchData({ silent: true })

      // Preguntar si desea compartir el comprobante antes de volver al listado.
      setClientForShare(clientSnapshot)
      setShareTrasPago(true)
      setShowShareDialog(true)
    } catch (error) {
      console.error("[v0] Error registering payment:", error)
      toast({ title: "Error", description: "No se pudo registrar el pago", variant: "destructive" })
    } finally {
      setSaving(false)
    }
    } finally {
      // Cubre todas las salidas, incluidas las validaciones que retornan
      // temprano y el caso en que el cobrador cancela el aviso de geocerca.
      enviandoRef.current = false
      setSaving(false)
    }
  }

  const handleRegisterNoPayment = async () => {
    // Mismo candado que en el pago: este flujo tambien espera al GPS antes de
    // deshabilitar el boton. No mueve plata, pero un doble toque dejaba dos
    // "no pago" del mismo cliente el mismo dia.
    if (enviandoRef.current) return
    enviandoRef.current = true
    setSaving(true)
    try {
    if (!noPaymentClient || !noPaymentClient.nextPaymentId) return

    const geocerca = await resolverGeocerca(noPaymentClient, "no pagos")
    if (!geocerca) return
    const coords = geocerca.coords

    const clientSnapshot = noPaymentClient
    // Igual que en handleRegisterPayment: recalculado desde la condicion
    // real, no solo el checkbox.
    const agregarCuotaSnapNoPago =
      agregarCuotaSiDebeNoPago &&
      clientSnapshot.esUltimaCuotaPendiente

    try {
      setSaving(true)

      const colombiaDateStr = diaDeTrabajo
      const fechaPagoReal = ahoraColombiaISO()
      const { latitud, longitud } = coords

      // Igual que en el pago: la visita se registra con la fecha de HOY, sin
      // preguntar. Ver el comentario en `handleConfirmPayment`.
      const fechaAplicacionNp = colombiaDateStr
      const retroAplicadoNp = false

      const gestionIdNp = nuevaGestionId()

      // Un no pago es una VISITA: queda registrada pase lo que pase. Antes,
      // si la cuota ancla ya no estaba pendiente, el servidor devolvía "ok"
      // sin escribir nada y la visita desaparecía en silencio.
      const { encolado: encoladoNoPago, resultado: resNoPago } = await enviarOEncolar({
        tipo: "gestion",
        id: gestionIdNp,
        descripcion: `No pago — ${clientSnapshot.nombre}`,
        payload: {
          id: gestionIdNp,
          tipo: "no_pago",
          loan_id: clientSnapshot.loanId,
          client_id: clientSnapshot.clientId,
          monto: 0,
          num_cuotas: 1,
          fecha_gestion: fechaAplicacionNp,
          fecha_hora: fechaPagoReal,
          latitud,
          longitud,
          geocerca_estado: geocerca.geo.estado,
          geocerca_motivo: geocerca.motivo,
          generar_cuota_si_debe: agregarCuotaSnapNoPago,
          cuota_objetivo: clientSnapshot.nextPaymentId || null,
          cliente_nombre: clientSnapshot.nombre,
          observacion: noPaymentObservation.trim() || null,
        },
      })

      const gestionLocalNp: Gestion = {
        id: gestionIdNp,
        loan_id: clientSnapshot.loanId,
        client_id: clientSnapshot.clientId,
        ruta: currentRutaId,
        user_id: null,
        tipo: "no_pago",
        estado: "aplicada",
        fecha_gestion: fechaAplicacionNp,
        monto: 0,
        cuota_objetivo: clientSnapshot.nextPaymentId || null,
        num_cuotas: 1,
        fecha_hora: fechaPagoReal,
        metodo_pago: null,
        origen: "campo",
        referencia_gestion_id: null,
        observacion: noPaymentObservation.trim() || null,
      }

      if (encoladoNoPago) {
        // Mismo tratamiento que el pago: el cliente sale de pendientes y el
        // evento entra al cache, para que reabrir la app sin señal no lo
        // vuelva a ofrecer.
        void parcharCache<DashboardPagosResult>("dashboard-pagos", currentRutaId, (datos) =>
          inyectarGestionEnCache(datos, gestionLocalNp),
        )
        if (!retroAplicadoNp) {
          setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
          setManagedToday((prev) => [
            {
              ...clientSnapshot,
              gestionTipo: "no_pago",
              // Un no pago no tiene forma de pago.
              metodoPago: null,
              gestionHora: fechaPagoReal.slice(11, 16),
              gestionInstante: fechaPagoReal,
              valorAbonado: 0,
              cuotasAbonadas: 0,
              paymentPlanId: clientSnapshot.nextPaymentId || undefined,
            },
            ...prev,
          ])
        }
        toast({
          title: "No pago guardado sin conexión",
          description: retroAplicadoNp
            ? `Quedó con fecha ${fechaAplicacionNp}. ${clientSnapshot.nombre} sigue disponible para la gestión de hoy.`
            : "Se registró en el teléfono. Se enviará solo cuando vuelva la señal.",
        })
        setNoPaymentClient(null)
        setNoPaymentObservation("")
        return
      }

      const rpcResultNoPago = resNoPago!

      if (rpcResultNoPago.enviado_a_revision || rpcResultNoPago.estado_gestion === "en_revision") {
        toast({
          title: "No pago enviado a revisión",
          description: `${rpcResultNoPago.motivo ?? "Necesita aprobación"}. La visita ya quedó registrada.`,
        })
        setNoPaymentClient(null)
        setNoPaymentObservation("")
        void fetchData({ silent: true })
        return
      }

      // ── No pago aplicado al dia anterior ─────────────────────────────
      // NO se mueve a Gestionados: quedo fechado ese dia y el cliente sigue
      // vigente para la gestion de hoy.
      if (retroAplicadoNp) {
        toast({
          title: `No pago aplicado al ${fechaAplicacionNp}`,
          description: `La visita del ${fechaAplicacionNp} de ${clientSnapshot.nombre} quedó como no pago. El cliente sigue disponible para la gestión de hoy.`,
        })
        setNoPaymentClient(null)
        setNoPaymentObservation("")
        void fetchData({ silent: true })
        return
      }

      // Optimistic UI: quitar de pendientes y agregar a managedToday
      setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
      setManagedToday((prev) => [
        {
          ...clientSnapshot,
          gestionTipo: "no_pago",
          metodoPago: null,
          gestionHora: fechaPagoReal.slice(11, 16),
          gestionInstante: fechaPagoReal,
          valorAbonado: 0,
          cuotasAbonadas: 0,
          paymentPlanId: clientSnapshot.nextPaymentId || undefined,
        },
        ...prev,
      ])

      toast(
        rpcResultNoPago.cuota_adicional_generada
          ? {
              title: "No pago registrado — cuota adicional agregada",
              description: `Se registró que ${clientSnapshot.nombre} no realizó el pago. Como aún debe, se agregó una cuota adicional al plan de pagos.`,
            }
          : {
              title: "No pago registrado",
              description: `Se registró que ${clientSnapshot.nombre} no realizó el pago`,
            },
      )

      setNoPaymentClient(null)
      setNoPaymentObservation("")
      // Refetch SILENCIOSO en background sin bloquear el cierre del dialogo
      // ni mostrar spinner overlay (el optimistic UI ya muestra al cliente
      // como gestionado).
      void fetchData({ silent: true })
    } catch (error) {
      console.error("[v0] Error registering no-payment:", error)
      toast({ title: "Error", description: "No se pudo registrar el no pago", variant: "destructive" })
    } finally {
      setSaving(false)
    }
    } finally {
      enviandoRef.current = false
      setSaving(false)
    }
  }

  const handlePartialPaymentChange = (checked: boolean) => {
    setIsPartialPayment(checked)
    if (checked && selectedClient) {
      setPaymentAmount("")
    } else if (!checked && selectedClient) {
      setPaymentAmount(
        montoAProponer(selectedClient.nextPaymentCuota, selectedClient.saldo, numCuotas).toString(),
      )
    }
  }

  /**
   * LA FOTO DEL PAGO, COMPRIMIDA. Viaja con el evento (`foto_url`) y la cola
   * la sube antes de mandarlo (lib/foto-offline.ts), con o sin señal. Antes
   * se tomaba y no se guardaba en ningún lado.
   */
  const handlePhotoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    try {
      setPaymentPhoto(await fotoParaCola(file))
    } catch (err) {
      console.error("[v0] No se pudo leer la foto del pago:", err)
      toast({ title: "No se pudo leer la foto", description: "Intenta tomarla de nuevo.", variant: "destructive" })
    }
  }

  const handleNoPaymentPhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => setNoPaymentPhoto(reader.result as string)
      reader.readAsDataURL(file)
    }
  }

  // ── Historial de gestiones del cliente ────────────────────────────────
  // Sale del LIBRO DE EVENTOS, no del cronograma: lo que el cobrador quiere
  // ver es qué pasó cada día que se visitó al cliente. Antes se leían las
  // cuotas gestionadas, que era una aproximación — un abono de tres cuotas
  // aparecía como tres líneas y una cancelación como muchas.
  // Cuántos movimientos lleva el crédito. Se pide SOLO al abrir el extracto:
  // traerlo para las cuarenta filas de la lista serían cuarenta consultas por
  // un número que se mira de vez en cuando.
  //
  // CUENTA LOS QUE SE VAN A VER, no las filas del libro. Era un `count` crudo
  // sobre `gestiones` y decía 109 en un crédito cuyo historial muestra 20: el
  // libro guarda además las reversas y los eventos que quedaron anulados, que
  // ya no se listan. Un número que promete cinco veces lo que hay adentro es
  // peor que no ponerlo.
  useEffect(() => {
    if (!extractoClient) { setExtractoMovimientos(null); return }
    let cancelado = false
    ;(async () => {
      try {
        const movs = await cargarMovimientosExtracto(extractoClient.loanId)
        if (cancelado) return
        setExtractoMovimientos(movs.length)
      } catch (err) {
        // Sin conteo el extracto se abre igual; lo que no se puede es que el
        // ojito no responda por una consulta de adorno.
        console.error("[v0] conteo de movimientos del extracto:", err)
        if (!cancelado) setExtractoMovimientos(null)
      }
    })()
    return () => { cancelado = true }
  }, [extractoClient])

  useEffect(() => {
    if (!paymentHistoryOpen || !paymentHistoryClient) return
    let cancelled = false
    setPaymentHistoryLoading(true)
    setPaymentHistoryRows([]);
    ;(async () => {
      // Lo trae `lib/extracto-cliente.ts`, el mismo que arma la imagen que se
      // comparte: si cada uno lo pidiera por su lado, el extracto que se manda
      // por WhatsApp podría decir algo distinto del que se está mirando.
      const movs = await cargarMovimientosExtracto(paymentHistoryClient.loanId)
      if (cancelled) return
      setPaymentHistoryRows(movs)
      setPaymentHistoryLoading(false)
    })()
    return () => { cancelled = true }
  }, [paymentHistoryOpen, paymentHistoryClient])

  // ── Historial de préstamos: fetch loans por client_id ─────────────────
  useEffect(() => {
    if (!loanHistoryOpen || !loanHistoryClient) return
    let cancelled = false
    setLoanHistoryLoading(true)
    setLoanHistoryRows([]);
    (async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("loans")
          .select("id, valor, numero_cuotas, frecuencia_pago, estado, fecha_creacion, created_at, tasa_interes")
          .eq("client_id", loanHistoryClient.clientId)
          .order("created_at", { ascending: false })
        if (cancelled) return
        if (error) throw error
        setLoanHistoryRows(
          (data ?? []).map((r: any) => ({
            id: r.id,
            valor: r.valor,
            numero_cuotas: r.numero_cuotas,
            frecuencia_pago: r.frecuencia_pago,
            estado: r.estado,
            fecha_creacion: (r.fecha_creacion || r.created_at || "").split("T")[0],
            tasa_interes: r.tasa_interes ?? null,
          }))
        )
      } catch (e) {
        console.error("[v0] loanHistory fetch error:", e)
      } finally {
        if (!cancelled) setLoanHistoryLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [loanHistoryOpen, loanHistoryClient])

  // ── Info del cliente: fetch clients table por client_id ───────────────
  useEffect(() => {
    if (!clientInfoDialogOpen || !selectedClientInfo) return
    let cancelled = false
    setClientInfoLoading(true)
    setClientInfoFetched(null);
    (async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("clients")
          .select("nombre_completo, apodo, documento, telefono, direccion")
          .eq("id", selectedClientInfo.clientId)
          .single()
        if (cancelled) return
        if (error) throw error
        setClientInfoFetched(data)
      } catch (e) {
        console.error("[v0] clientInfo fetch error:", e)
      } finally {
        if (!cancelled) setClientInfoLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [clientInfoDialogOpen, selectedClientInfo])

  /** Descarga el logo y lo devuelve como data URL para poder pintarlo. */
  const cargarLogoBase64 = async (url: string): Promise<string | null> => {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const blob = await res.blob()
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(blob)
      })
    } catch {
      return null
    }
  }

  // -- Generar recibo como IMAGEN ---------------------------------------
  // Se dibuja en un canvas y se exporta PNG, en vez del PDF de antes.
  //
  // Por que imagen: compartido por WhatsApp o correo, un PNG se ve dentro
  // del chat y el cliente lo lee de una; un PDF llega como adjunto que hay
  // que abrir aparte. Se usa Canvas 2D y no una libreria: el recibo son
  // filas de texto, dos lineas y el logo, o sea lo mismo que se hacia con
  // jsPDF pero con fillText/drawImage. Sin dependencias nuevas y sigue
  // funcionando sin senal.
  /**
   * EL EXTRACTO COMO IMAGEN, para compartir.
   *
   * Usa `renderComprobanteImagen`, el mismo dibujo del cierre de caja: logo de
   * la ruta arriba, título, subtítulo y la línea de fecha y hora. Así el
   * extracto que le llega a un cliente por WhatsApp se ve como el comprobante
   * de pago que ya conoce, y no como una captura de pantalla.
   *
   * Los movimientos se piden ACÁ y no al abrir el extracto: son una consulta
   * más por cliente, y casi nadie comparte. Salen del mismo
   * `cargarMovimientosExtracto` que pinta la lista, así que la imagen no puede
   * decir algo distinto de lo que se está mirando.
   */
  const construirImagenExtracto = async () => {
    const c = extractoClient
    if (!c) throw new Error("No hay cliente")
    const [movs, umbrales] = await Promise.all([
      cargarMovimientosExtracto(c.loanId),
      getRutaUmbrales(currentRutaId).catch(() => null),
    ])
    const money = (n: number) => `$${Math.round(n).toLocaleString("es-CO")}`
    const ahora = new Date()
    const dia = ahora.toLocaleDateString("es-CO", { timeZone: "America/Bogota" })
    const hora = ahora.toLocaleTimeString("es-CO", {
      timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: true,
    })

    // LOS MISMOS DATOS, EN EL MISMO ORDEN Y CON LA MISMA FORMA QUE EN PANTALLA.
    //
    // Antes esta lista era otra: sin Frecuencia, sin Multa, sin Último pago, y
    // en una sola columna. El cliente recibia algo que no se parecia a lo que
    // el cobrador le acababa de mostrar, aunque los numeros fueran los mismos.
    // Ahora es la rejilla de dos columnas del diálogo, dato por dato.
    const filasCredito: { label: string; valor: string; destacado?: boolean }[] = [
      { label: "Fecha de venta", valor: fechaCorta(c.fechaVenta) },
      {
        label: "Frecuencia",
        valor: `${frecuenciaLabel(c.frecuenciaPago)}${
          c.frecuenciaPago !== "daily" && c.diaSemana
            ? ` · ${c.diaSemana.charAt(0).toUpperCase()}${c.diaSemana.slice(1)}`
            : ""
        }`,
      },
      // NI "Valor prestado" NI EL % DE INTERES.
      //
      // El comprobante dice COMO VA LA DEUDA: total a pagar, cuota, abonado y
      // saldo. Cuanto se presto al principio y a que tasa ya estan
      // incorporados en el total — repetirlos solo abre discusiones en la
      // calle que no son del cobrador.
      //
      // Va igual que el extracto EN PANTALLA: si la imagen mostrara datos que
      // la pantalla no tiene, el cobrador estaria mandando algo distinto de lo
      // que le acaba de ensenar al cliente.
      //
      // OJO: sigue estando en la APP. Se ve en el extracto en pantalla, en
      // Auditoria 360 y en el detalle de clientes, que es donde tiene que
      // estar. Lo unico que se quita es del PNG que se comparte por WhatsApp.
      { label: "Total a pagar", valor: money(c.totalAPagar) },
      { label: "Valor de cuota", valor: money(c.valorCuota) },
      { label: "Cuotas", valor: `${cuotasConDecimal(c.abonado, c.valorCuota, c.cuotasTotales)}/${c.cuotasTotales}` },
      { label: "Abonado", valor: money(c.abonado) },
    ]
    // Igual que en pantalla: si no hay multa, no hay renglón que diga "$0".
    if (c.multaPendiente) {
      filasCredito.push({ label: "Multa pendiente", valor: money(c.multaPendiente.valor) })
    }
    if (c.ultimoPagoFecha) {
      filasCredito.push({
        label: "Último pago",
        valor: `${fechaCorta(c.ultimoPagoFecha)}${c.ultimoPago > 0 ? `  ${money(c.ultimoPago)}` : ""}`,
      })
    }

    // SALDO Y ESTADO, AL FINAL Y JUNTOS.
    //
    // La rejilla llena de a DOS por renglón en el orden de la lista, así que
    // un número impar de filas deja un hueco al final — y el hueco siempre
    // cae en el último dato. Estos dos van destacados y son por lo que el
    // cliente abre el extracto: separarlos, o dejar a Estado solo en el
    // último renglón, es justo lo que no puede pasar.
    //
    // Antes quedaban juntos por casualidad: la lista daba par. Al quitar el
    // interés quedó impar, y las filas condicionales de arriba (multa, último
    // pago) ya podían romper la pareja según el cliente. Poniéndolos de
    // últimos y rellenando a par abajo, quedan siempre en el mismo renglón.
    if (filasCredito.length % 2 !== 0) {
      filasCredito.push({ label: "", valor: "" })
    }
    filasCredito.push(
      { label: "Saldo", valor: money(c.saldo), destacado: true },
      {
        label: "Estado",
        valor: c.mora > 0 ? `Mora: ${etiquetaMora(c.mora)}` : "Al día",
        destacado: true,
      },
    )

    const secciones: SeccionComprobante[] = [
      { titulo: "El crédito", filas: filasCredito, formato: "rejilla" },
    ]
    if (movs.length > 0) {
      // LAS MISMAS CUATRO COLUMNAS DEL HISTORIAL DE PAGOS: Fecha, Cuota,
      // Pagado y Saldo. Antes las tres cifras iban pegadas en un solo texto a
      // la derecha y sin titulos —"Cta 7   $18.000   $333.000"— y habia que
      // adivinar cual era cual. Un no pago dice $0, no una raya, igual que en
      // pantalla.
      secciones.push({
        titulo: `Movimientos (${movs.length})`,
        formato: "tabla",
        columnas: ["Fecha", "Cuota", "Pagado", "Saldo"],
        filas: movs.map((m) => ({
          label: fechaCorta(m.fecha),
          valor: "",
          celdas: [
            m.numeroCuota !== null ? String(m.numeroCuota) : ETIQUETA_MOVIMIENTO[m.tipo],
            money(m.pagado),
            m.saldoDespues !== null ? money(m.saldoDespues) : "—",
          ],
        })),
      })
    }

    return renderComprobanteImagen({
      titulo: "Extracto del cliente",
      subtitulo: c.nombreCompleto,
      meta: `${dia}  ·  ${hora}`,
      secciones,
      logoUrl: umbrales?.logo_url || `${window.location.origin}/opad-logo.png`,
      nombreArchivo: `extracto-${c.documento || c.loanId.slice(0, 8)}-${dia.replace(/\//g, "-")}.png`,
      pie: "Generado por Feelpay",
    })
  }

  const buildReciboImagen = async (
    client: DisplayClient,
    gestionHoy?: ManagedClient,
  ): Promise<{ blob: Blob; filename: string; dataUrl: string }> => {
    const supabase = await getSupabaseSafe()
    const [finRes, clientRes] = await Promise.all([
      supabase
        .from("v_loan_financiero")
        .select("total_a_pagar, total_pagado, saldo_hoy, cuotas_mora, cuotas_cubiertas, cuotas_totales, cuotas_extra")
        .eq("loan_id", client.loanId)
        .maybeSingle(),
      supabase
        .from("clients")
        .select("nombre_completo, apodo")
        .eq("id", client.clientId)
        .maybeSingle(),
    ])

    const finRow = finRes.data as {
      total_a_pagar?: number | null
      total_pagado?: number | null
      saldo_hoy?: number | null
      cuotas_mora?: number | null
      cuotas_cubiertas?: number | null
      cuotas_totales?: number | null
      cuotas_extra?: number | null
    } | null
    // Se conservan los nombres viejos para no reescribir el dibujo del recibo.
    const saldo = finRow && {
      total_con_intereses: finRow.total_a_pagar,
      total_recaudado: finRow.total_pagado,
      saldo_pendiente: finRow.saldo_hoy,
    }
    // El recibo lleva el nombre REAL del cliente, sin el apodo. `sinApodo`
    // vive a nivel de modulo: la lista de cobro usa el mismo, para que el
    // papel y la pantalla no digan cosas distintas del mismo cliente.
    const datosCliente = clientRes.data as { nombre_completo?: string | null; apodo?: string | null } | null
    const nombreCompleto = datosCliente?.nombre_completo
      ? sinApodo(datosCliente.nombre_completo, datosCliente.apodo)
      : client.nombre

    // Abono de hoy: si el cliente ya fue gestionado viene en el objeto (que
    // ya trae la SUMA del dia); si no, se consulta lo gestionado hoy.
    let abonoHoy = gestionHoy?.valorAbonado ?? null
    // El recibo habla del DÍA DE TRABAJO, que con la ruta desbloqueada para
    // cerrar una jornada vieja es ese día y no hoy. Si leyera hoy, el
    // comprobante del cobro que se acaba de registrar saldría sin abono.
    let fechaAbono: string | null = gestionHoy ? diaDeTrabajo : null
    if (abonoHoy == null) {
      // Del libro de eventos: los movimientos de ese día de este préstamo.
      const { data: eventosHoy } = await supabase
        .from("gestiones")
        .select("tipo, monto")
        .eq("loan_id", client.loanId)
        .eq("fecha_gestion", diaDeTrabajo)
        .eq("estado", "aplicada")
      const evs = (eventosHoy ?? []) as { tipo: string; monto: number | null }[]
      if (evs.length > 0) {
        abonoHoy = evs.reduce((acc, e) => acc + montoEfectivo({ tipo: e.tipo as Gestion["tipo"], monto: Number(e.monto) || 0 }), 0)
        fechaAbono = diaDeTrabajo
      }
    }

    // ¿SE RENOVÓ ESE DÍA? Sale del libro (el evento `ajuste` de la
    // renovación, scripts/123), así que el recibo lo dice igual si se vuelve
    // a generar más tarde desde el menú.
    let renovacionHoy: { valor: number; cuotas: number; cuota: number } | null = null
    {
      const { data: ajustes } = await supabase
        .from("gestiones")
        .select("detalle")
        .eq("loan_id", client.loanId)
        .eq("fecha_gestion", diaDeTrabajo)
        .eq("tipo", "ajuste")
        .eq("estado", "aplicada")
      let valorRenov = 0
      let cuotasRenov = 0
      let cuotaRenov = 0
      for (const a of (ajustes ?? []) as { detalle?: Record<string, unknown> | null }[]) {
        const d = a.detalle
        if (d && d.clase === "renovacion") {
          valorRenov += Number(d.valor_entregado) || 0
          cuotasRenov = Number(d.cuotas_nuevas) || 0
          cuotaRenov = Number(d.valor_cuota_nueva) || 0
        }
      }
      if (valorRenov > 0) renovacionHoy = { valor: valorRenov, cuotas: cuotasRenov, cuota: cuotaRenov }
    }

    // Logo propio de la ruta; si no hay, el de la app.
    const umbralesRuta = await getRutaUmbrales(currentRutaId)
    const logoUrl = umbralesRuta.logo_url || `${window.location.origin}/opad-logo.png`
    const logoBase64 = await cargarLogoBase64(logoUrl)
    const logoImg = logoBase64
      ? await new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => resolve(null)
          img.src = logoBase64
        })
      : null

    // LA FECHA Y LA HORA, EN HORA COLOMBIA.
    //
    // `es-CO` es solo el FORMATO: sin `timeZone` el navegador usa la del
    // aparato, y las rutas están en Argentina y Ecuador. El día de negocio de
    // la app es el de Colombia (`todayColombia`), así que un recibo con la hora
    // del teléfono puede llevar impresa OTRA fecha que la del día al que
    // pertenece el pago — de noche, la del día siguiente.
    const now = new Date()
    const fechaStr = now.toLocaleDateString("es-CO", {
      timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric",
    })
    const horaStr = now.toLocaleTimeString("es-CO", {
      timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit",
    })

    const fmt = (n: number | null | undefined) =>
      n != null ? `$${Math.round(n).toLocaleString("es-CO")}` : "-"
    const fmtFechaCorta = (iso: string | null | undefined) => {
      if (!iso) return "-"
      const [yy, mm, dd] = iso.split("-")
      return dd && mm && yy ? `${dd}/${mm}/${yy}` : "-"
    }


    // ── LO QUE DICE EL COMPROBANTE, EN BLOQUES ─────────────────────────────
    // El formato que pidió el dueño: datos del cliente, el pago que se hizo
    // y el resumen de la obligación. Cada bloque es
    // una caja con su título, y lo que el cliente busca —cuánto pagó, cuánto
    // le falta de la cuota y cuánto debe— va en grande.
    type FilaRecibo = { label: string; valor: string; fuerte?: boolean; banda?: boolean }
    const secciones: { titulo: string; filas: FilaRecibo[] }[] = [
      {
        titulo: "Datos del cliente",
        filas: [
          { label: "Cliente:", valor: nombreCompleto },
          { label: "Documento:", valor: client.documento || "-" },
        ],
      },
    ]

    // El bloque del pago solo aparece si hubo movimiento; un recibo de
    // consulta no lo lleva.
    if (abonoHoy != null && abonoHoy > 0) {
      secciones.push({
        titulo: "Pago realizado",
        filas: [
          { label: "Fecha del abono:", valor: fmtFechaCorta(fechaAbono) },
          { label: "Valor pagado:", valor: fmt(abonoHoy), fuerte: true },
        ],
      })
    }

    // CLIENTE RENOVADO: solo si ese día se renovó el crédito.
    if (renovacionHoy && renovacionHoy.valor > 0) {
      secciones.push({
        titulo: "Renovación",
        filas: [
          { label: "Cliente renovado por:", valor: fmt(renovacionHoy.valor), fuerte: true },
          ...(renovacionHoy.cuotas > 0
            ? [{ label: "Nuevas cuotas:", valor: `${renovacionHoy.cuotas} de ${fmt(renovacionHoy.cuota)}` }]
            : []),
        ],
      })
    }

    // "CUOTA ACTUAL" SALIÓ DEL COMPROBANTE (02-oct-2026, a pedido del dueño):
    // cuotas X/Y, restante y frecuencia. Quedan los datos del cliente, el
    // pago, la renovación si la hubo y el resumen de la obligación.

    secciones.push({
      titulo: "Resumen de la obligación",
      filas: [
        { label: "Fecha de venta:", valor: fmtFechaCorta(client.fechaVenta) },
        { label: "Total a pagar:", valor: fmt(saldo?.total_con_intereses) },
        { label: "Total recaudado:", valor: fmt(saldo?.total_recaudado) },
        // La multa solo si hay: un "$0" de sanción es un renglón que no dice nada.
        ...(client.multaPendiente
          ? [{ label: "Saldo por sanción:", valor: fmt(client.multaPendiente.valor) }]
          : []),
        { label: "Saldo pendiente:", valor: fmt(saldo?.saldo_pendiente ?? client.saldo), fuerte: true, banda: true },
      ],
    })

    // -- Dibujo ---------------------------------------------------------
    // Medidas en puntos lógicos y se escala x3 al pintar para que se vea
    // nítido en la pantalla del celular y en WhatsApp.
    const ESCALA = 3
    const W = 360
    const MARGEN = 8           // del borde de la imagen al marco
    const PAD = 22             // del borde de la imagen al contenido
    const ALTO_FILA = 26
    const ALTO_FILA_FUERTE = 30
    const ALTO_CAB = 28        // la franja con el título de cada bloque
    const GAP = 10             // entre bloques
    const ALTO_LOGO = logoImg ? 56 : 0

    const NAVY = "#12284c"
    const TEXTO = "#1f2937"
    const BANDA = "#e6ecf4"
    const BORDE = "#d5dde8"
    const RAYA = "#e4e9f0"

    const altoSeccion = (sec: { filas: FilaRecibo[] }) =>
      ALTO_CAB + sec.filas.reduce((s, f) => s + (f.fuerte ? ALTO_FILA_FUERTE : ALTO_FILA), 0)

    const H =
      MARGEN + 18 + (logoImg ? ALTO_LOGO + 12 : 0) + 12 + 30 + 24 + 12 +
      secciones.reduce((s, sec) => s + altoSeccion(sec) + GAP, 0) +
      8 + 26 + 14 + MARGEN

    const canvas = document.createElement("canvas")
    canvas.width = W * ESCALA
    canvas.height = H * ESCALA
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("No se pudo preparar el lienzo del recibo")
    ctx.scale(ESCALA, ESCALA)

    const FUENTE = "Helvetica, Arial, sans-serif"
    const caja = (x: number, yy: number, w: number, h: number, r: number) => {
      ctx.beginPath()
      ctx.moveTo(x + r, yy)
      ctx.lineTo(x + w - r, yy)
      ctx.arcTo(x + w, yy, x + w, yy + r, r)
      ctx.lineTo(x + w, yy + h - r)
      ctx.arcTo(x + w, yy + h, x + w - r, yy + h, r)
      ctx.lineTo(x + r, yy + h)
      ctx.arcTo(x, yy + h, x, yy + h - r, r)
      ctx.lineTo(x, yy + r)
      ctx.arcTo(x, yy, x + r, yy, r)
      ctx.closePath()
    }
    const raya = (x1: number, x2: number, yy: number, color: string) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x1, yy + 0.5)
      ctx.lineTo(x2, yy + 0.5)
      ctx.stroke()
    }

    // Fondo y marco redondeado
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, W, H)
    caja(MARGEN, MARGEN, W - MARGEN * 2, H - MARGEN * 2, 14)
    ctx.strokeStyle = "#c3cddb"
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.textBaseline = "alphabetic"

    let y = MARGEN + 18

    // El logo de la ruta, respetando su proporción.
    if (logoImg) {
      const alto = ALTO_LOGO
      const ancho = Math.min(220, (logoImg.width / Math.max(1, logoImg.height)) * alto)
      ctx.drawImage(logoImg, W / 2 - ancho / 2, y, ancho, alto)
      y += ALTO_LOGO + 12
    }

    raya(PAD, W - PAD, y, BORDE)
    y += 12

    ctx.fillStyle = NAVY
    ctx.font = `bold 20px ${FUENTE}`
    ctx.textAlign = "center"
    ctx.fillText("COMPROBANTE DE PAGO", W / 2, y + 20)
    y += 30

    // "Fecha: 09/09/2026   |   Hora: 01:12 p. m." con las etiquetas en negrita.
    const trozos: { t: string; negrita: boolean }[] = [
      { t: "Fecha: ", negrita: true }, { t: fechaStr, negrita: false },
      { t: "     |     ", negrita: false },
      { t: "Hora: ", negrita: true }, { t: horaStr, negrita: false },
    ]
    const medir = (p: { t: string; negrita: boolean }) => {
      ctx.font = `${p.negrita ? "bold " : ""}12.5px ${FUENTE}`
      return ctx.measureText(p.t).width
    }
    let x = W / 2 - trozos.reduce((s, p) => s + medir(p), 0) / 2
    ctx.textAlign = "left"
    for (const p of trozos) {
      ctx.font = `${p.negrita ? "bold " : ""}12.5px ${FUENTE}`
      ctx.fillStyle = p.negrita ? NAVY : TEXTO
      ctx.fillText(p.t, x, y + 14)
      x += ctx.measureText(p.t).width
    }
    y += 24 + 12

    // Los bloques
    const X0 = PAD - 6
    const X1 = W - PAD + 6
    for (const sec of secciones) {
      const alto = altoSeccion(sec)
      // Caja con borde, y la franja del título recortada a la caja.
      ctx.save()
      caja(X0, y, X1 - X0, alto, 8)
      ctx.clip()
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(X0, y, X1 - X0, alto)
      ctx.fillStyle = BANDA
      ctx.fillRect(X0, y, X1 - X0, ALTO_CAB)
      ctx.restore()

      ctx.fillStyle = NAVY
      ctx.font = `bold 13.5px ${FUENTE}`
      ctx.textAlign = "left"
      ctx.fillText(sec.titulo, PAD + 2, y + 19)
      let yy = y + ALTO_CAB

      sec.filas.forEach((f, i) => {
        const h = f.fuerte ? ALTO_FILA_FUERTE : ALTO_FILA
        if (f.banda) {
          // La última fila destacada (el saldo) va sobre la franja de color,
          // recortada a las esquinas redondeadas de la caja.
          ctx.save()
          caja(X0, y, X1 - X0, alto, 8)
          ctx.clip()
          ctx.fillStyle = BANDA
          ctx.fillRect(X0, yy, X1 - X0, h)
          ctx.restore()
        } else if (i > 0) {
          raya(X0, X1, yy, RAYA)
        }
        const base = yy + h / 2 + (f.fuerte ? 6 : 4.5)
        ctx.font = `${f.banda ? "bold " : ""}12.5px ${FUENTE}`
        ctx.fillStyle = f.banda ? NAVY : TEXTO
        ctx.textAlign = "left"
        ctx.fillText(f.label, PAD + 2, base)
        const anchoLibre = X1 - X0 - 20 - ctx.measureText(f.label).width - 10
        ctx.font = `${f.fuerte ? "bold 17px" : "12.5px"} ${FUENTE}`
        ctx.fillStyle = f.fuerte ? NAVY : TEXTO
        ctx.textAlign = "right"
        // El ancho máximo evita que un nombre largo se monte sobre la
        // etiqueta o se salga: el navegador lo condensa para que quepa.
        ctx.fillText(f.valor, W - PAD - 2, base, Math.max(40, anchoLibre))
        yy += h
      })

      caja(X0, y, X1 - X0, alto, 8)
      ctx.strokeStyle = BORDE
      ctx.lineWidth = 1
      ctx.stroke()
      y += alto + GAP
    }

    y += 8
    raya(PAD, W - PAD, y, BORDE)
    y += 12

    ctx.font = `10.5px ${FUENTE}`
    ctx.textAlign = "center"
    ctx.fillStyle = "#4b5563"
    ctx.fillText("Este documento es un comprobante informativo.", W / 2, y + 12)

    const filename = `comprobante_${client.nombre.replace(/\s+/g, "_")}_${fechaStr.replace(/\//g, "-")}.png`
    const dataUrl = canvas.toDataURL("image/png")
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo generar la imagen del recibo"))), "image/png")
    })
    return { blob, filename, dataUrl }
  }

  /**
   * "Generar recibo" del menu: abre el mismo dialogo de compartir que sale
   * tras registrar un pago, en vez de descargar el PDF directo. Funciona
   * tambien para clientes sin gestion de hoy (recibo de consulta).
   */
  /** Cierra el dialogo; si venia de registrar un pago, vuelve al listado. */
  const cerrarShare = () => {
    setShowShareDialog(false)
    setClientForShare(null)
    setReciboListo(null)
    if (shareTrasPago) handleBack()
    setShareTrasPago(false)
  }

  const handleGenerarRecibo = (client: DisplayClient) => {
    setClientForShare(client)
    setShareTrasPago(false)
    setShowShareDialog(true)
  }

  // `handleDescargarRecibo` vivía acá y volvía a dibujar el comprobante para
  // descargarlo. Ya no hace falta: el diálogo lo prepara al abrir y el botón
  // de Descargar usa esa misma imagen, sin pedirle otra vez los datos al
  // servidor.

  /** Si el cliente ya fue gestionado hoy, devuelve esa gestion (trae el abono). */
  const gestionDe = (client: DisplayClient): ManagedClient | undefined =>
    managedToday.find((m) => m.loanId === client.loanId)

  /**
   * EL COMPROBANTE SE DIBUJA AL ABRIR EL DIÁLOGO, NO AL TOCAR "COMPARTIR".
   *
   * Esto es lo que hacía que el menú para elegir app no apareciera.
   * `navigator.share()` solo se puede llamar mientras dura la ACTIVACIÓN que
   * deja el toque del usuario, y armar el recibo son CUATRO viajes de red
   * —financiero del crédito, datos del cliente, eventos del día y el logo de
   * la ruta— más el dibujo del canvas. Con señal de calle eso son segundos.
   * Para cuando terminaba, la activación ya había caducado: el navegador
   * rechazaba la llamada y Safari lo hace sin decir nada útil. El cobrador
   * tocaba Compartir y no pasaba nada.
   *
   * Preparándolo antes, el botón llama a `share()` en el mismo gesto y el menú
   * sale siempre.
   */
  useEffect(() => {
    if (!showShareDialog || !clientForShare) return
    let vigente = true
    setReciboListo(null)
    setPreparandoRecibo(true)
    ;(async () => {
      try {
        const { blob, dataUrl, filename } = await buildReciboImagen(
          clientForShare,
          gestionDe(clientForShare),
        )
        if (vigente) setReciboListo({ file: new File([blob], filename, { type: "image/png" }), dataUrl, filename })
      } catch (e) {
        console.error("[v0] No se pudo preparar el comprobante:", e)
        if (vigente) {
          toast({
            title: "Error",
            description: "No se pudo preparar el comprobante.",
            variant: "destructive",
          })
        }
      } finally {
        if (vigente) setPreparandoRecibo(false)
      }
    })()
    return () => { vigente = false }
    // Solo depende de QUÉ comprobante hay que dibujar. `buildReciboImagen` y
    // `gestionDe` se redefinen en cada render y meterlos acá lo dibujaría sin
    // parar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showShareDialog, clientForShare?.loanId])

  /**
   * OJO AL ORDEN: no es `async` y no puede serlo. Entre el toque y
   * `navigator.share()` no puede haber ni un `await`, o se pierde el menú.
   */
  const handleShareComprobante = () => {
    if (!reciboListo) return
    const { file, dataUrl, filename } = reciboListo

    if (
      typeof navigator !== "undefined" &&
      navigator.share &&
      navigator.canShare &&
      navigator.canShare({ files: [file] })
    ) {
      // El menu nativo manda la app a segundo plano, y antes eso armaba el
      // candado: habia que avisarle que no contara como irse. Desde que el PIN
      // solo lo dispara la inactividad, no hay nada que avisar.
      navigator
        .share({ files: [file], title: "Comprobante de pago" })
        .then(() => cerrarShare())
        .catch((e: unknown) => {
          // Cancelar el menú lanza AbortError: es el usuario diciendo que no,
          // y el diálogo se queda abierto por si quiere reintentar.
          if (e instanceof Error && e.name !== "AbortError") {
            console.error("[v0] handleShareComprobante error:", e)
            toast({ title: "Error", description: "No se pudo compartir el comprobante.", variant: "destructive" })
          }
        })
      return
    }

    // Este teléfono no sabe compartir archivos: se descarga y se dice por qué,
    // en vez de dejar la sensación de que el botón no hizo nada.
    const a = document.createElement("a")
    a.href = dataUrl
    a.download = filename
    a.click()
    toast({
      title: "Comprobante descargado",
      description: "Este dispositivo no permite elegir la app para compartir.",
    })
    cerrarShare()
  }

  const handleRenovationConfirm = () => {
    setShowRenovationDialog(false)
    if (onViewChange && clientForRenovation) {
      onViewChange("new-loan", clientForRenovation)
    }
    setClientForRenovation(null)
  }

  const handleRenovationCancel = () => {
    // El cliente dijo que no quiere renovar. No hay nada que escribir: la
    // bandera `tiene_prestamo_activo` la mantiene `recalcular_prestamo` a
    // partir de si le queda algún crédito activo.
    //
    // Antes esto hacía un PATCH suelto por REST que la ponía en false sin
    // mirar los otros créditos del cliente: quien tenía dos préstamos perdía
    // la bandera al cerrar uno.
    setShowRenovationDialog(false)
    setClientForRenovation(null)
  }

  /**
   * Busca en el libro el evento de HOY de este cliente.
   *
   * Antes esto resolvía una fila de `payment_plan` por fecha y estado, y con
   * varias filas del mismo día (la cuota + una línea extra) podía devolver la
   * equivocada. Un evento es una unidad: no hay ambigüedad.
   */
  /**
   * La gestión de hoy que TODAVÍA ESTÁ EN PIE.
   *
   * Antes esto tomaba la más reciente del día y ya. El problema: una gestión
   * ya anulada sigue siendo un evento aplicado, y si era la última, era la que
   * salía elegida. Cada intento de anular volvía a apuntarle a ella, el
   * servidor respondía "esa gestión ya fue reversada" y la mandaba a revisión,
   * mientras el pago que SÍ estaba vivo seguía intacto y el cliente seguía en
   * Gestionados.
   *
   * Pasó de verdad: MARTINEZ EMILCE, ruta 197, el 25/08. El día tenía un pago
   * de 48.000 (anulado), uno de 192.000 (vivo) y uno de 9.600 (anulado). El
   * de 9.600 era el último, así que las VEINTE anulaciones que se intentaron
   * le pegaron a él, y las veinte se apilaron en la bandeja de secretaría.
   *
   * Se traen TODOS los eventos aplicados del préstamo, no solo los de hoy: una
   * reversa puede llevar la fecha de la cuota que corrige y no la de hoy
   * (`ajustar_cuota_control_pagos`), y filtrando por fecha se escapaba.
   */
  const resolveGestionHoy = async (m: ManagedClient): Promise<GestionConUbicacion | null> => {
    try {
      const supabase = await getSupabaseSafe()
      const { data } = await supabase
        .from("gestiones")
        .select(
          "id, loan_id, tipo, monto, fecha_gestion, cuota_objetivo, num_cuotas, " +
            "metodo_pago, referencia_gestion_id, fecha_hora, " +
            // DÓNDE OCURRIÓ LA VISITA. Se traen para que la corrección pueda
            // llevarlas: el servidor trata un pago o un no pago SIN
            // coordenadas como una visita que nadie puede probar (script
            // 064), y una corrección se escribe desde el escritorio.
            "latitud, longitud, geocerca_estado, geocerca_motivo",
        )
        .eq("loan_id", m.loanId)
        .eq("estado", "aplicada")
        .order("fecha_hora", { ascending: false })

      const filas = (data ?? []) as unknown as GestionConUbicacion[]

      // Las que ya tienen una reversa aplicada apuntándoles. Solo cuentan las
      // reversas APLICADAS: una en revisión todavía no anuló nada.
      const anuladas = new Set(
        filas
          .filter((g) => g.tipo === "reversa" && g.referencia_gestion_id)
          .map((g) => g.referencia_gestion_id as string),
      )

      // La más reciente DEL DÍA DE TRABAJO que sea una visita y siga en pie.
      // Corregir o anular tiene que encontrar la gestión de ese día, no la de
      // hoy — que en una jornada atrasada no existe.
      const hoy = diaDeTrabajo
      return (
        filas.find(
          (g) =>
            g.fecha_gestion === hoy &&
            (g.tipo === "pago" || g.tipo === "no_pago" || g.tipo === "cancelacion") &&
            !anuladas.has(g.id),
        ) ?? null
      )
    } catch (_e) {
      return null
    }
  }

  /**
   * Corregir la gestión de hoy = anular la anterior y registrar la corregida.
   * Sirve para las tres correcciones:
   *
   *   · pago → pago      cambiar el monto
   *   · pago → no pago   se marcó pago y el cliente no pagó
   *   · no pago → pago   se marcó no pago y el cliente sí pagó
   *
   * Las dos últimas antes obligaban a anular y volver a gestionar al cliente
   * entero, con el viaje a Pendientes de por medio.
   *
   * EL EVENTO ORIGINAL NUNCA SE MODIFICA. Se registra su reversa y después el
   * evento nuevo, que es la única forma de escribir plata en este sistema: en
   * el historial quedan los tres y la Auditoría 360 puede mostrar qué se
   * cambió, cuándo y por quién. Cambiar `gestiones.tipo` con un UPDATE haría
   * desaparecer el error sin dejar rastro, y de todos modos el trigger
   * `trg_gestiones_inmutables` lo rechaza.
   */
  const handleEditManagedSave = async () => {
    if (!editingManaged) return
    const m = editingManaged
    const destino = editTipo
    const newMonto = destino === "pago" ? Number.parseFloat(editMonto) : 0
    if (destino === "pago" && (isNaN(newMonto) || newMonto <= 0)) return

    // Sin cambios no se escribe nada: dos eventos de más en el libro por un
    // "Guardar" sin querer ensucian el historial y no corrigen nada.
    // Cambiar SOLO la forma de pago cuenta como cambio: es lo que decide de
    // qué lado cae la plata en el desglose Efectivo/Transferencia.
    const metodoViejo = m.metodoPago === "transferencia" ? "transferencia" : "efectivo"
    const igual =
      destino === m.gestionTipo &&
      (destino === "no_pago" ||
        (newMonto === (m.valorAbonado ?? 0) && editMetodo === metodoViejo))
    if (igual) { setEditingManaged(null); return }

    setSavingManaged(true)
    try {
      const original = await resolveGestionHoy(m)
      if (!original) throw new Error("No se encontró la gestión de hoy de este cliente")

      const cambioSoloElMetodo =
        destino === m.gestionTipo &&
        destino === "pago" &&
        newMonto === (m.valorAbonado ?? 0) &&
        editMetodo !== metodoViejo
      const queCambio =
        destino === m.gestionTipo
          ? cambioSoloElMetodo
            ? `Forma de pago corregida a ${editMetodo} desde el módulo de pagos`
            : "Monto corregido desde el módulo de pagos"
          : destino === "pago"
            ? "Corregido de no pago a pago desde el módulo de pagos"
            : "Corregido de pago a no pago desde el módulo de pagos"

      const idReversa = nuevaGestionId()
      await enviarOEncolar({
        tipo: "gestion",
        id: idReversa,
        descripcion: `Corrección — ${m.nombre}`,
        payload: {
          id: idReversa,
          tipo: "reversa",
          loan_id: m.loanId,
          client_id: m.clientId,
          referencia_gestion_id: original.id,
          // LA REVERSA VA AL DIA DE LA GESTION QUE DESHACE, no al de hoy.
          //
          // Una reversa no es plata nueva: es la MISMA plata saliendo de donde
          // entro. Fechandola hoy, el dia original se queda con un cobro que
          // ya no existe y el de hoy amanece con un recaudo negativo.
          //
          // Paso en la ruta 151 el 11/09: se deshicieron dos pagos del 10
          // ($65.000 y $97.500) y el resumen del dia quedo en -$136.500,
          // mientras el 10 seguia contando $162.500 que nadie pago.
          //
          // `original.fecha_gestion` es el dia de negocio al que aplicaba el
          // evento; con el respaldo de `diaDeTrabajo` si por alguna razon no
          // viene, que es como se comportaba antes.
          fecha_gestion: original.fecha_gestion || diaDeTrabajo,
          fecha_hora: ahoraColombiaISO(),
          cliente_nombre: m.nombre,
          observacion: queCambio,
        },
      })

      const idNuevo = nuevaGestionId()
      await enviarOEncolar({
        tipo: "gestion",
        id: idNuevo,
        descripcion:
          destino === "pago"
            ? `Pago corregido — ${m.nombre} ($${newMonto.toLocaleString()})`
            : `No pago corregido — ${m.nombre}`,
        payload: {
          id: idNuevo,
          tipo: destino,
          loan_id: m.loanId,
          client_id: m.clientId,
          monto: newMonto,
          // Al convertir a no pago la gestión vale por UNA visita, no por las
          // cuotas que cubría el pago que se está deshaciendo.
          num_cuotas: destino === "pago" ? (original.num_cuotas ?? 1) : 1,
          // Y EL EVENTO NUEVO VA AL MISMO DIA que el que reemplaza. Corregir
          // el monto de un pago de ayer no es cobrar hoy: es decir que ayer se
          // cobro otra cifra. Con la reversa en un dia y el evento nuevo en
          // otro, la correccion partiria la plata en dos.
          fecha_gestion: original.fecha_gestion || diaDeTrabajo,
          fecha_hora: ahoraColombiaISO(),
          cuota_objetivo: original.cuota_objetivo,
          // El método sale del selector, no del evento original: es lo que
          // se está corrigiendo. Un no pago no tiene forma de pago.
          metodo_pago: destino === "pago" ? editMetodo : null,
          // LAS COORDENADAS DE LA VISITA QUE SE CORRIGE.
          //
          // Sin esto la corrección no entra. El servidor trata un `pago` o un
          // `no_pago` sin GPS como una visita sin prueba de que ocurrió: al
          // pago lo manda `en_revision` —no suma, y el cliente se devuelve a
          // Pendientes— y al no pago lo RECHAZA con una excepción, después de
          // que su reversa ya se aplicó. De ahí salían los dos defectos que
          // se reportaron.
          //
          // No es inventar un dato: son las coordenadas que midió el teléfono
          // en ESA visita. Lo que se corrige es el monto o el tipo, no el
          // lugar. Y llevándolas, la corrección sale en el mapa donde debe.
          latitud: original.latitud ?? null,
          longitud: original.longitud ?? null,
          geocerca_estado: original.geocerca_estado ?? null,
          geocerca_motivo: original.geocerca_motivo ?? null,
          // A propósito en `false`. Un no pago registrado en la calle puede
          // alargar el cronograma si el cliente iba en su última cuota, y esa
          // decisión la toma el cobrador con la casilla del formulario. Una
          // corrección hecha después no puede alargarle el plan al cliente de
          // callada: si hace falta esa cuota, se anula y se gestiona de nuevo.
          generar_cuota_si_debe: false,
          cliente_nombre: m.nombre,
          observacion: queCambio,
        },
      })

      setEditingManaged(null)
      setManagedToday((prev) =>
        prev.map((x) =>
          x.loanId === m.loanId
            ? {
                ...x,
                gestionTipo: destino,
                valorAbonado: newMonto,
                cuotasAbonadas: destino === "pago" ? x.cuotasAbonadas : 0,
              }
            : x,
        ),
      )
      toast({
        title: destino === "pago" ? "Marcado como pago" : "Marcado como no pago",
        description:
          destino === "pago"
            ? `${m.nombre} — $${newMonto.toLocaleString()}`
            : `${m.nombre} queda como no pago del día`,
      })
      void fetchData({ silent: true })
    } catch (e) {
      // La reversa y el evento nuevo son dos llamadas, no una transacción. Si
      // la segunda falla, la primera YA se aplicó: la gestión anterior quedó
      // anulada y no hay nada en su lugar. Callarlo dejaba al cobrador
      // pensando que no había pasado nada, cuando el pago ya no estaba.
      toast({
        title: "No se pudo corregir",
        description:
          (e instanceof Error ? e.message : "Error al registrar la corrección") +
          " · La gestión anterior quedó anulada: vuelve a registrarla desde Pendientes.",
        variant: "destructive",
      })
      void fetchData({ silent: true })
    } finally {
      setSavingManaged(false)
    }
  }

  /**
   * Anular la gestión de hoy: se registra un evento de REVERSA que la
   * compensa. Nada se borra — el historial conserva el pago y su anulación.
   */
  const handleDeleteManagedPayment = async (m: ManagedClient) => {
    setSavingManaged(true)
    try {
      const original = await resolveGestionHoy(m)
      if (!original) throw new Error("No se encontró la gestión de hoy de este cliente")

      const idReversa = nuevaGestionId()
      const { resultado } = await enviarOEncolar({
        tipo: "gestion",
        id: idReversa,
        descripcion: `Anulación — ${m.nombre}`,
        payload: {
          id: idReversa,
          tipo: "reversa",
          loan_id: m.loanId,
          client_id: m.clientId,
          referencia_gestion_id: original.id,
          // LA REVERSA VA AL DIA DE LA GESTION QUE DESHACE, no al de hoy.
          //
          // Una reversa no es plata nueva: es la MISMA plata saliendo de donde
          // entro. Fechandola hoy, el dia original se queda con un cobro que
          // ya no existe y el de hoy amanece con un recaudo negativo.
          //
          // Paso en la ruta 151 el 11/09: se deshicieron dos pagos del 10
          // ($65.000 y $97.500) y el resumen del dia quedo en -$136.500,
          // mientras el 10 seguia contando $162.500 que nadie pago.
          //
          // `original.fecha_gestion` es el dia de negocio al que aplicaba el
          // evento; con el respaldo de `diaDeTrabajo` si por alguna razon no
          // viene, que es como se comportaba antes.
          fecha_gestion: original.fecha_gestion || diaDeTrabajo,
          fecha_hora: ahoraColombiaISO(),
          cliente_nombre: m.nombre,
          observacion: "Gestión anulada desde el módulo de pagos",
        },
      })

      if (resultado?.enviado_a_revision || resultado?.estado_gestion === "en_revision") {
        toast({
          title: "Anulación enviada a revisión",
          description: String(resultado.motivo ?? "Secretaría debe autorizarla."),
        })
        void fetchData({ silent: true })
        return
      }

      const nuevoSaldo = Number(resultado?.nuevo_saldo ?? m.saldo + m.valorAbonado)

      // Optimistic UI: mover de managed → pending sin esperar refetch.
      // ManagedClient extiende DisplayClient, asi que el spread es seguro.
      const restored: DisplayClient = {
        loanId: m.loanId,
        clientId: m.clientId,
        nombre: m.nombre,
        apodo: m.apodo,
        nombreCompleto: m.nombreCompleto,
        documento: m.documento,
        fechaVenta: m.fechaVenta,
        valorVenta: m.valorVenta,
        // La anulacion devuelve la plata: lo abonado baja en el mismo monto
        // que sube el saldo. El refetch silencioso de abajo corrige el exacto.
        totalAPagar: m.totalAPagar,
        abonado: Math.max(0, m.abonado - m.valorAbonado),
        valorCuota: m.valorCuota,
        saldo: nuevoSaldo,
        cuotasPagadas: Math.max(0, m.cuotasPagadas - 1),
        cuotasTotales: m.cuotasTotales,
        cuotasExtra: m.cuotasExtra,
        // Al revertir vuelve a existir al menos una pendiente; el refetch
        // silencioso de abajo corrige el valor exacto.
        esUltimaCuotaPendiente: m.esUltimaCuotaPendiente,
        mora: m.mora,
        ultimoPago: m.ultimoPago,
        ultimoPagoFecha: m.ultimoPagoFecha,
        frecuenciaPago: m.frecuenciaPago,
        tipoAmortizacion: m.tipoAmortizacion,
        tasaInteres: m.tasaInteres,
        nextPaymentId: original.cuota_objetivo ?? m.nextPaymentId,
        nextPaymentCuota: m.nextPaymentCuota,
        nextPaymentNumero: m.nextPaymentNumero,
        nextPaymentCapital: m.nextPaymentCapital,
        nextPaymentValorCuota: m.nextPaymentValorCuota,
        nextPaymentEsFuturo: false,
        // Vuelve a la ruta desde Gestionados: su cronograma no cambio al
        // deshacer la gestion, asi que la bandera se recalcula en el proximo
        // refresco. Falso mientras tanto es el lado seguro: no avisa de mas.
        cronogramaAgotado: false,
        nextPaymentFecha: m.nextPaymentFecha,
        valorPrestamo: m.valorPrestamo,
        multaPendiente: m.multaPendiente,
        ordenvisita: m.ordenvisita,
        diaSemana: m.diaSemana,
        clienteLatitud: m.clienteLatitud,
        clienteLongitud: m.clienteLongitud,
        cuotaVencidaId: m.cuotaVencidaId,
        cuotaVencidaFecha: m.cuotaVencidaFecha,
      }
      setManagedToday((prev) => prev.filter((x) => x.loanId !== m.loanId))
      setClients((prev) => {
        const next = prev.filter((x) => x.loanId !== m.loanId)
        next.push(restored)
        return next.sort((a, b) => a.ordenvisita - b.ordenvisita)
      })

      // Refresh silencioso en background para sincronizar derivados
      // (mora, saldo_prestamos_clientes) sin bloquear la UI.
      void fetchData({ silent: true })
      toast({ title: "Gestión anulada", description: `${m.nombre} volvió a la lista de pendientes` })
    } catch (e) {
      console.error("[v0] handleDeleteManagedPayment error:", e)
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : "No se pudo anular la gestión",
        variant: "destructive",
      })
    } finally {
      setSavingManaged(false)
    }
  }

  // Colores de la lista de cobro. La escala vive en lib/gestion-core.ts para
  // que todas las pantallas usen los mismos cortes.
  const getMoraColor = (mora: number) => {
    const banda = colorMora(mora)
    if (banda === "verde") return "text-green-700 bg-green-100"
    if (banda === "amarillo") return "text-yellow-700 bg-yellow-100"
    return "text-red-700 bg-red-100"
  }

  // Franja de color al inicio de cada fila. Al sol, la lista se ve como un
  // bloque de texto gris: el borde entre un cliente y el siguiente es lo
  // primero que desaparece. Una barra saturada a la izquierda sobrevive al
  // reflejo mucho mejor que una linea de 1px, y de paso dice en que anda el
  // cliente antes de leer una sola palabra. Es la MISMA banda del badge de
  // mora, no un codigo nuevo que haya que aprenderse.
  /**
   * El color de la mora en TEXTO, sin pastilla.
   *
   * `getMoraColor` devuelve texto + fondo, que es lo que necesitaba la
   * pastilla de la fila vieja. En la fila apretada la pastilla costaba
   * relleno arriba y abajo en cada una de las cuarenta filas, así que se
   * quedó solo el color.
   */
  const moraTexto = (mora: number) => {
    const banda = colorMora(mora)
    if (banda === "verde") return "text-green-700"
    if (banda === "amarillo") return "text-yellow-700"
    return "text-red-700"
  }

  const getMoraBarra = (mora: number) => {
    const banda = colorMora(mora)
    if (banda === "verde") return "border-l-green-500"
    if (banda === "amarillo") return "border-l-yellow-500"
    return "border-l-red-500"
  }

  /**
   * EL BOTÓN VERDE Y SUS TRES ACCIONES.
   *
   * Lo usan la lista de la ruta, la de Pendientes y la tarjeta del aplazado en
   * Gestionados. Es una función y no JSX repetido porque de las tres opciones
   * dos mueven plata: tres copias del mismo menú son tres sitios donde una
   * guarda puede quedar sin poner.
   */
  const menuGestion = (client: DisplayClient, aplazado: boolean) => {
    const canManage = canManageClient(client)
    return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          className="h-10 w-10 shrink-0 rounded-full bg-success text-card hover:bg-success/80"
          title="Gestionar este cliente"
          aria-label="Gestionar este cliente"
        >
          <Check className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          className="cursor-pointer text-sm font-medium"
          onClick={() =>
            gpsStatus !== "granted"
              ? handleLocationRequired()
              : handleSelectClient(client)
          }
          disabled={canManage === false && gpsStatus === "granted"}
        >
          {/* Círculo LLENO con el visto en blanco, como el botón verde que
              abre este menú. Lucide no trae la versión rellena, y un aro
              contra un círculo lleno se leen como dos cosas distintas. */}
          <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-600">
            <Check className="h-3 w-3 text-white" strokeWidth={3} />
          </span>
          <span className="font-semibold text-green-700">Pago</span>
          {/* La única variante que sobrevive al recorte de nombres. Cobrar una
              cuota que todavía no vence es válido, pero es una decisión: sin
              este aviso el cobrador no tiene cómo saber que está adelantando.
              Va en gris y pequeño para no romper la fila de las tres. */}
          {client.nextPaymentEsFuturo && (
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">adelantado</span>
          )}
        </DropdownMenuItem>

        <DropdownMenuItem
          className="cursor-pointer text-sm font-medium"
          onClick={() => {
            if (gpsStatus !== "granted") {
              handleLocationRequired()
              return
            }
            setAgregarCuotaSiDebeNoPago(true)
            setNoPaymentClient(client)
          }}
          disabled={canManage === false && gpsStatus === "granted"}
        >
          <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600">
            <X className="h-3 w-3 text-white" strokeWidth={3} />
          </span>
          <span className="font-semibold text-red-700">No Pago</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* APLAZAR no pide GPS ni día de cobro, y por eso NO lleva los
            guardas de los otros dos: no registra nada en el libro. Es
            una nota del cobrador sobre su propio día — "a este vuelvo
            más tarde"— y hasta ahora, para dejarla, había que marcarle
            no pago, que es una visita fallida y no lo fue. */}
        <DropdownMenuItem
          className="cursor-pointer text-sm font-medium"
          onClick={() => (aplazado ? devolverALaRuta(client) : marcarAplazado(client))}
        >
          {/* El reloj se queda SIN rellenar, a diferencia de los otros dos.
              No es un descuido de estilo: pago y no pago cierran el día del
              cliente y por eso van sólidos; dejarlo pendiente no cierra nada.
              La forma dice cuál de las tres no resuelve. */}
          <Clock className="mr-2 h-5 w-5 shrink-0 text-orange-500" strokeWidth={2.5} />
          <span className="font-semibold">{aplazado ? "Volver a la ruta" : "Pendiente"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    )
  }

  /**
   * UNA fila de cliente. Se usa en las DOS listas — "Ruta" y "Pendientes"— y
   * por eso es una función y no JSX repetido: son doscientas líneas con cuatro
   * botones y un menú, y dos copias se separan al primer arreglo que se haga
   * en una sola.
   *
   * `total` es el largo de la lista donde se está pintando, que es lo que
   * decide si "Bajar en la ruta" está disponible.
   */
  const filaCliente = (
    client: DisplayClient,
    index: number,
    total: number,
    aplazado: boolean,
  ) => {
      const canManage = canManageClient(client)
      /* ENRUTAR YA NO SE HACE DESDE ACÁ.
         Se fue el arrastre de la fila y con él las flechas del menú. El orden
         de visita tiene su propio módulo —"Ordenar Ruta"—, y tenerlo también
         acá era un atajo caro: se reordena la ruta ENTERA con un dedo que se
         resbala mientras se está cobrando, y el cobrador no se entera de que
         movió a alguien hasta el día siguiente. */
      return (
      <TableRow
        key={client.loanId}
        className={`${index % 2 === 0 ? "bg-card" : "bg-muted"} hover:bg-accent/30 transition-colors border-b-2 border-b-border ${
          !canManage ? "opacity-60" : ""
        }`}
      >
        {/* La franja de color va en la CELDA y no en la fila:
            la tabla le quita los bordes al último `<tr>`, así
            que puesta en la fila el último cliente se
            quedaría sin ella. */}
        {/* UNA SOLA FILA POR CLIENTE.
          Estuvo en dos —el nombre cruzando las tres columnas y debajo los
          datos— porque con la columna de acciones en 152px al nombre le
          quedaban 124 y se partía en cuatro renglones. Al juntar los dos
          botones de plata en uno solo y apilar el ojo sobre los tres puntos,
          esa columna bajó a 84 y el nombre pasó a tener ~196: ya cabe al lado
          de todo lo demás, y el cliente vuelve a ocupar una línea. */}
        <TableCell
          className={`py-1 md:py-1.5 px-2 border-l-4 align-middle whitespace-normal ${getMoraBarra(client.mora)}`}
        >
          {/* Dos renglones como máximo. `line-clamp-2` envuelve —no corta a
              media palabra— y deja la fila del mismo alto para todos. Lo que
              no quepa se lee completo en el extracto, a un toque del ojito.
              OJO: sin `block`, que pelea con `line-clamp` por el `display` y
              lo deja sin efecto.

              LA LETRA BAJÓ de 13px a 11px, y no por gusto: acá entra un
              renglón más —el apodo— y sin bajarla cada cliente costaba una
              línea extra. Con cuarenta clientes eso es media pantalla de
              scroll para no decir nada nuevo. */}
          <span className="font-semibold text-[11px] md:text-sm leading-tight break-words [overflow-wrap:anywhere] line-clamp-2">
            <span className="mr-1 text-[10px] md:text-xs font-normal text-muted-foreground tabular-nums">
              {index + 1}.
            </span>
            {client.nombreCompleto}
          </span>

          {/* EL APODO, DEBAJO Y EN GRIS.
              El cobrador reconoce al cliente por "kiosko" o "la peluquería" —es
              como lo tiene en la cabeza y como lo va a buscar en la calle—,
              pero el nombre de la cédula es el que lo identifica sin lugar a
              dudas cuando hay dos apellidos iguales. Van los dos.

              Un renglón, no dos: si el apodo es largo se corta. Es la etiqueta
              de reconocer, no la de identificar, y para eso la primera mitad
              alcanza. `client.apodo` ya llega en null cuando es igual al
              nombre, así que nadie ve la misma línea escrita dos veces. */}
          {client.apodo && (
            <span className="block text-[10px] md:text-xs text-muted-foreground leading-tight truncate">
              {client.apodo}
            </span>
          )}

          {/* Mora y cuota en el MISMO renglón. Apiladas, como en el boceto,
              costaban una línea más por cliente — y con cuarenta clientes esa
              línea es media pantalla. Las dos dicen "cómo va este cliente", así
              que leídas juntas no se pierde nada. */}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-tight">
            <span className={`text-[11px] md:text-sm font-semibold ${moraTexto(client.mora)}`}>
              {client.mora > 0 ? `Mora: ${client.mora}` : "Al día"}
            </span>
            <span className="text-[10px] md:text-sm text-muted-foreground tabular-nums">
              Cta {cuotasConDecimal(client.abonado, client.valorCuota, client.cuotasTotales)}/{client.cuotasTotales}
            </span>
            {aplazado && (
              <span className="rounded bg-amber-500/15 px-1 text-[9px] md:text-xs font-semibold text-amber-700">
                Pendiente
              </span>
            )}
            {/* El día de cobro SOLO en los no diarios, que es donde dice algo:
                en una ruta diaria sería la misma etiqueta en las cuarenta
                filas. Verde cuando es hoy. */}
            {client.frecuenciaPago !== "daily" && client.diaSemana && (
              <span className={`rounded px-1 text-[9px] md:text-xs font-semibold ${
                isPaymentDayToday(client.diaSemana)
                  ? "bg-success text-success-foreground"
                  : "bg-muted-foreground/15 text-muted-foreground"
              }`}>
                {client.diaSemana.charAt(0).toUpperCase() + client.diaSemana.slice(1)}
              </span>
            )}
          </span>
        </TableCell>

        <TableCell className="py-1 md:py-1.5 px-1 text-right align-middle">
          <span className="block text-[12px] md:text-base font-semibold tabular-nums leading-tight">
            ${Math.round(client.saldo).toLocaleString()}
          </span>
          {/* LO QUE HAY QUE COBRARLE HOY.
              La columna se llama "Saldo / Cuota" desde siempre, pero la cuota
              no estaba: el cobrador veía la deuda entera y tenía que abrir el
              diálogo para saber cuánto pedir. Con cuarenta clientes eso son
              cuarenta aperturas para leer un número que cabe acá.

              Va en verde y debajo del saldo a propósito: el saldo dice cuánto
              debe —contexto—, la cuota dice cuánto se le pide —la acción—. Con
              los dos del mismo color se leían como dos cifras intercambiables,
              y en la calle, a pulso, se cobra la que se lee primero. */}
          {/* TOPADA CONTRA EL SALDO, igual que la que propone el diálogo.
              Esta cifra dice "cuánto se le pide": si dijera $1.000 sobre un
              saldo de $800, el cobrador pediría de más y el formulario lo
              rebotaría después. Las dos salen de `montoAProponer` para que no
              puedan discrepar. */}
          {montoAProponer(client.nextPaymentValorCuota, client.saldo) > 0 && (
            <span className="block text-[11px] md:text-sm font-bold text-success tabular-nums leading-tight">
              ${Math.round(montoAProponer(client.nextPaymentValorCuota, client.saldo)).toLocaleString()}
            </span>
          )}
          {/* La multa sí se queda en la lista: es plata que
              hay que cobrar HOY y encontrarla solo abriendo
              el extracto sería enterrarla. */}
          {client.multaPendiente && (
            <span className="block text-[10px] md:text-sm font-semibold text-destructive tabular-nums leading-tight">
              Multa ${client.multaPendiente.valor.toLocaleString()}
            </span>
          )}
        </TableCell>

        <TableCell className="py-1 md:py-1.5 px-1 align-middle">
          {/* UNA SOLA PUERTA A LAS GESTIONES.
              Antes eran dos botones sueltos, verde y rojo, pegados en la misma
              fila. Estuvieron a 2px uno de otro y en la calle, a pulso, se
              tocaba No pago queriendo Pago — y cada equivocación cuesta una
              reversa. Ahora hay un solo botón y las tres acciones viven
              adentro, separadas y con su nombre escrito: para equivocarse hay
              que leer mal, no solo temblar.

              Los nombres son de UNA palabra —Pago, No Pago, Pendiente— y sin
              el verbo delante. "Registrar pago" y "Registrar no pago"
              empezaban igual, así que la palabra que de verdad distingue una
              opción de la otra quedaba en segundo lugar, que es el peor sitio
              para leer a pulso. Ahora la primera palabra es la que decide.

              Y libera ancho: la columna pasó de 152px a 84, y eso es lo que le
              devuelve espacio al nombre del cliente.

              Lo que cada acción hace al aplicarse NO cambia: el diálogo de
              pago y el de no pago son los mismos de siempre. */}
          <div className="flex items-center justify-end gap-1.5">
            {menuGestion(client, aplazado)}

            {/* EL OJO ENCIMA DE LOS TRES PUNTOS, no al lado: apilados ocupan
                una columna de 28px en vez de dos, y ese ancho se lo lleva el
                nombre. */}
            <div className="flex shrink-0 flex-col gap-0.5">
              <Button
                size="icon"
                variant="outline"
                className="h-[26px] w-[26px] rounded-full bg-transparent p-0"
                onClick={() => setExtractoClient(client)}
                title="Ver el extracto del cliente"
                aria-label="Ver el extracto del cliente"
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="outline" className="h-[26px] w-[26px] rounded-full bg-transparent p-0">
                    <MoreVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {/* Acá vivían "Subir en la ruta" y "Bajar en la ruta". Se
                      fueron con el arrastre: enrutar es del módulo Ordenar
                      Ruta. Ver el comentario de `filaCliente`. */}
                  <DropdownMenuItem
                    className="text-xs md:text-base cursor-pointer"
                    onClick={() => {
                      setPaymentHistoryClient(client)
                      setPaymentHistoryOpen(true)
                    }}
                  >
                    <History className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                    Historial de pagos
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-xs md:text-base cursor-pointer"
                    onClick={() => {
                      setLoanHistoryClient(client)
                      setLoanHistoryOpen(true)
                    }}
                  >
                    <FileText className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                    Historial de prestamos
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-xs md:text-base cursor-pointer"
                    onClick={() => {
                      setSelectedClientInfo(client)
                      setClientInfoDialogOpen(true)
                    }}
                  >
                    <User className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                    Info del cliente
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-xs md:text-base cursor-pointer"
                    onClick={() => handleGenerarRecibo(client)}
                  >
                    <Receipt className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                    Generar recibo
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </TableCell>
      </TableRow>
      )
  }

  // El guard y el boton de iniciar ruta viven en <RutaNoIniciada>: los usan
  // esta pantalla y el bloqueo global de los vendedores, y dos copias de la
  // logica terminarian discrepando en cuando se considera abierta una ruta.
  // Aca la exigencia es ABIERTA y no solo iniciada: con la jornada cerrada ya
  // no se cobra.
  //
  // SALVO QUE SE ESTÉ CERRANDO UNA JORNADA VIEJA. `rutaActivaEstado` habla de
  // HOY, y cuando la secretaría desbloquea el día anterior lo que hay abierto
  // es ESE día — hoy no tiene fila todavía, y no puede tenerla hasta que el
  // viejo cierre. Sin esta salida, el cobrador quedaba mirando "Ruta no
  // iniciada" con un botón que no debe tocar: iniciar hoy es justo lo que el
  // congelamiento existe para impedir.
  if (!esDiaAtrasado && rutaActivaEstado !== "abierta") {
    return (
      <RutaNoIniciada
        rutaId={currentRutaId}
        resuelto={rutaActivaResolved}
        estado={rutaActivaEstado ?? null}
        onEstadoChange={onRouteStateChange}
        mensaje="Para registrar pagos o no pagos primero debes iniciar la ruta del dia. Tambien puedes hacerlo desde la pestana Resumen del Dia."
        onIrAResumen={() => onViewChange("daily-summary")}
      />
    )
  }

  return (
    <div className="space-y-3 md:space-y-6">
      {/* ── GPS permission banner ─────────────────────────────────────────── */}
      {datosDesdeCache && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold leading-tight">Trabajando sin conexión</p>
            <p className="mt-0.5 text-xs text-amber-700">
              Estás viendo los datos guardados en el teléfono desde las{" "}
              {new Date(datosDesdeCache).toLocaleTimeString("es-CO", {
                timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit",
              })}
              . Puede haber gestiones de otros cobradores que aún no ves. Lo que
              registres se enviará solo cuando vuelva la señal.
            </p>
          </div>
        </div>
      )}

      {gpsStatus !== "granted" && gpsStatus !== "checking" && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <MapPinOff className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold leading-tight">
              {gpsStatus === "denied"
                ? "Permiso de ubicación denegado"
                : "GPS no disponible en este dispositivo"}
            </p>
            <p className="mt-0.5 text-xs text-destructive/80">
              {gpsStatus === "denied"
                ? esIOS()
                  ? "En iPhone hay que habilitarlo desde Ajustes: Ajustes › Privacidad y seguridad › Localización › activarla, y ahí mismo buscar Safari y poner “Al usar la app”. Después volvé y recargá esta pantalla. El botón de acá no sirve: una vez que se dijo que no, Safari no vuelve a preguntar."
                  : "Debes permitir el acceso a la ubicación en la configuración del navegador para registrar pagos o no pagos."
                : esIOS()
                  ? "No se pudo leer la ubicación. Revisá que la Localización esté encendida en Ajustes › Privacidad y seguridad, y que Safari la tenga en “Al usar la app”. Si abriste la app desde el ícono del escritorio, el permiso se pide aparte del de Safari."
                  : "No es posible obtener la ubicación. Verifica que el GPS esté activado."}
            </p>
          </div>
          {gpsStatus !== "denied" && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 gap-1.5 text-xs"
              onClick={requestGpsPermission}
            >
              <MapPin className="h-3.5 w-3.5" />
              Solicitar permiso
            </Button>
          )}
        </div>
      )}
      {gpsStatus === "checking" && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <span>Verificando acceso a GPS...</span>
        </div>
      )}

      {/* OJO con el Card de abajo: el grueso del "contenedor grande" de arriba
          NO era nuestro, lo ponía la librería. `py-6` mete 24px por encima del
          encabezado y `gap-6` otros 24 entre el encabezado y el listado — 48px
          de aire en una pantalla de teléfono. En móvil se van los dos.

          Van como `max-md:` y no como `py-0`/`gap-0` a secas porque
          competirían con `py-6`/`gap-6` por la misma propiedad, y ahí gana el
          orden del CSS generado, no el de las clases. Las variantes se emiten
          después, así que ganan siempre. */}
      {!selectedClient ? (
        <Card className="max-md:py-0 max-md:gap-0">
          {/* `border-b` NO se usa para la línea de abajo. El CardHeader de la
              librería trae `[.border-b]:pb-6`: con esa clase puesta se
              autoañade 24px de relleno inferior, y como es una variante le
              gana a cualquier `pb-*` que pongamos. La sombra de 1px se ve
              igual y no dispara esa regla.

              El `gap-2` propio del CardHeader tambien separa CADA hijo; en
              movil baja a 4px. */}
          <CardHeader
            className={`${encabezadoPlegado ? "p-2" : "p-3"} md:p-6 max-md:gap-1 sticky top-0 z-10 bg-card shadow-[0_1px_0_0_var(--border)]`}
          >
            {/* EL DÍA AL QUE SE ESTÁ REGISTRANDO.
                Va de primero, ámbar y sin poder plegarse: todo lo que el
                cobrador haga en esta pantalla se va a contar en ESE día, no en
                hoy, y equivocarse de día es de las pocas cosas que después
                obligan a que la secretaría corrija una por una. */}
            {esDiaAtrasado && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p className="text-[12px] leading-snug text-foreground">
                  <span className="font-bold">Estás cerrando el {fmtFecha(diaDeTrabajo)}.</span>{" "}
                  Los pagos, no pagos y ventas que registres quedan en ese día. Al cerrar
                  la caja, la ruta queda lista para hoy.
                </p>
              </div>
            )}
            {/* Plegar el encabezado. Solo en móvil: en escritorio no sobra el
                espacio. Plegado sigue diciendo en qué modo está y cuántos
                faltan — es lo único del encabezado que el cobrador necesita
                tener a la vista mientras cobra, y sin eso plegarlo sería
                quedarse sin saber si está mirando Diario o No Diario. */}
            <button
              type="button"
              onClick={alternarEncabezado}
              aria-expanded={!encabezadoPlegado}
              className="md:hidden flex items-center justify-between gap-2 rounded-md px-1 py-0.5 text-muted-foreground hover:bg-muted"
            >
              <span className="text-[12px] font-semibold">
                {encabezadoPlegado
                  ? (() => {
                      // Plegado tambien se va la barra de pestanas, asi que
                      // esta linea tiene que decir DONDE esta parado: sin eso,
                      // Pendientes vacio y Gestionados vacio se ven igual.
                      if (activeTab === "aplazados") return `Pendientes · ${aplazadosDeLaRuta.length}`
                      if (activeTab === "gestionados") return `Gestionados · ${filteredManaged.length}`
                      if (activeTab === "ventas") return `Ventas del día · ${salesTodayCount}`
                      return `Pendientes · ${isDiario ? "Diario" : "No Diario"} · ${displayClients.length}${
                        moraFilter ? " · filtrado por mora" : ""
                      }`
                    })()
                  : "Ocultar encabezado"}
              </span>
              {encabezadoPlegado
                ? <ChevronDown className="h-5 w-5 shrink-0" />
                : <ChevronUp className="h-5 w-5 shrink-0" />}
            </button>

            <div className={`${ocultoEnMovil()} flex flex-col md:flex-row md:items-center md:justify-between gap-2`}>
              <div className="flex items-center gap-2">
                <CardTitle className="text-base md:text-2xl">Clientes Activos</CardTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 md:h-9 md:w-9"
                  onClick={() => {
                    setLoading(true)
                    fetchData()
                  }}
                  disabled={loading}
                >
                  <RefreshCw className={`h-4 w-4 md:h-5 md:w-5 ${loading ? "animate-spin" : ""}`} />
                </Button>
                {/* Mora filter buttons — show totals from preFilteredClients so counts
                    don't change while a filter is active. Click to filter/deactivate. */}
                {(() => {
                  const greenCount = preFilteredClients.filter(c => c.mora <= 4).length
                  const yellowCount = preFilteredClients.filter(c => c.mora > 4 && c.mora <= 8).length
                  const redCount = preFilteredClients.filter(c => c.mora > 8).length
                  const items = [
                    // SON CUOTAS, NO DIAS. El numero que se filtra es
                    // `cuotas_mora`, que cuenta CUOTAS vencidas sin cubrir; el
                    // resto de la app ya lo dice asi ("Mora: 3", "3 cuotas").
                    // Estos tres rotulos eran los ultimos que quedaban
                    // hablando de dias, y en una ruta semanal 4 cuotas son
                    // casi un mes: llamarlas "4 dias" es otra cifra.
                    { id: "green" as const, bg: "bg-green-500", ring: "ring-green-400", count: greenCount, label: "0-4 cuotas de mora" },
                    { id: "yellow" as const, bg: "bg-yellow-500", ring: "ring-yellow-400", count: yellowCount, label: "5-8 cuotas de mora" },
                    { id: "red" as const, bg: "bg-red-500", ring: "ring-red-400", count: redCount, label: "Más de 8 cuotas de mora" },
                  ]
                  return (
                    <div className="flex items-center gap-1.5 ml-1">
                      {items.map(({ id, bg, ring, count, label }) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setMoraFilter(prev => prev === id ? null : id)}
                          className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-all cursor-pointer
                            ${moraFilter === id ? "bg-muted" : ""}
                            ${moraFilter !== null && moraFilter !== id ? "opacity-40" : "opacity-100"}
                          `}
                          title={`${count} clientes · ${label}${moraFilter === id ? " · Clic para quitar filtro" : " · Clic para filtrar"}`}
                        >
                          <span className={`h-3 w-3 rounded-full shrink-0 ${bg} ${moraFilter === id ? `ring-2 ring-offset-1 ${ring}` : ""}`} />
                          <span className={`text-[11px] md:text-xs font-medium ${moraFilter === id ? "text-foreground" : "text-muted-foreground"}`}>
                            {count}
                          </span>
                        </button>
                      ))}
                    </div>
                  )
                })()}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={isDiario ? "default" : "outline"}
                  className="text-[12px] md:text-sm h-7 md:h-10 px-2 md:px-4"
                  onClick={() => { setIsDiario(true); setMoraFilter(null) }}
                >
                  Diario
                </Button>
                <Button
                  variant={!isDiario ? "default" : "outline"}
                  className="text-[12px] md:text-sm h-7 md:h-10 px-2 md:px-4"
                  onClick={() => { setIsDiario(false); setMoraFilter(null) }}
                >
                  No Diario
                </Button>
                <Button
                  className="h-7 md:h-10 gap-1.5 px-2 md:px-4 text-[12px] md:text-sm"
                  onClick={() => onViewChange("new-loan")}
                >
                  <ShoppingCart className="h-3.5 w-3.5 md:h-4 md:w-4" />
                  <span className="hidden sm:inline">Nueva Venta</span>
                </Button>
              </div>
            </div>

            {/* Avance de la ruta.
                Antes, para saber cuanto llevaba recaudado y cuantos clientes
                le faltaban, el cobrador tenia que salirse a Resumen del Dia y
                volver. Esto se lo deja a la vista sin dejar la pantalla. */}
            {(() => {
              const gestionados = managedToday.length
              // Los de cuota FUTURA no entran en la cuenta del día: son ventas
              // recién hechas cuyo primer cobro todavía no llega. Siguen
              // visibles en la lista —se les puede cobrar por adelantado— pero
              // no son tarea de hoy, y contarlos dejaba el avance en "41 de 42"
              // para siempre. Es el mismo criterio que usa el cierre de caja
              // (`clientesSinGestionarHoy`), para que los dos no discrepen.
              // Y tampoco el NO DIARIO al que hoy no le toca: un semanal de
              // martes no es tarea del sabado. Es la misma condicion que usa
              // el cierre; sin ella la barra pedia gente que el cierre no
              // exigia y nunca llegaba a "X de X".
              const total =
                gestionados +
                sinGestionar.filter(
                  (c) =>
                    !c.nextPaymentEsFuturo &&
                    (c.frecuenciaPago === "daily" || c.nextPaymentFecha === diaDeTrabajo),
                ).length
              if (total === 0) return null
              const recaudado = managedToday.reduce((s, m) => s + (m.valorAbonado || 0), 0)
              const pct = Math.round((gestionados / total) * 100)
              return (
                <div className={`${ocultoEnMovil()} px-1 pb-2 space-y-1`}>
                  <div className="flex items-baseline justify-between text-[11px] md:text-xs">
                    <span className="text-muted-foreground">
                      <strong className="text-foreground">{gestionados}</strong> de {total} gestionados
                    </span>
                    <span className="font-semibold tabular-nums">
                      ${recaudado.toLocaleString("es-CO")}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-green-500 transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })()}

            {/* Buscador.
                Va DENTRO de la cabecera fija a proposito. Estaba dentro del
                panel, debajo de todo esto, y como la cabecera es `sticky` con
                fondo opaco, apenas el cobrador hacia scroll para ver la lista
                la cabecera se le montaba encima: el campo quedaba tapado y el
                toque se lo comia la cabecera. Aca queda siempre a la mano,
                que es justo para lo que sirve buscar en una lista larga. */}
            {activeTab !== "ventas" && (
              <Input
                placeholder="Buscar cliente por nombre o documento..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                // El buscador NO se pliega. Es lo unico del encabezado que se
                // usa MIENTRAS se cobra —encontrar al que toco la puerta sin
                // bajar por toda la ruta— y cuesta un renglon, no un tercio de
                // la pantalla como el resto.
                className="max-md:mt-0 mt-2 h-8 md:h-10 text-[12px] md:text-sm md:max-w-sm"
              />
            )}

            {/* Tab bar: Pendientes / Gestionados / Ventas
                Los dots debajo de la barra (solo en móvil) refuerzan la
                affordance de swipe horizontal. */}
            {/* Tab bar: cada botón ocupa 1/3 del ancho disponible para
                que los tres quepan exactamente en cualquier móvil sin
                desbordarse ni necesitar scroll. El texto largo se acorta
                en móvil con versiones compactas visibles solo en <md. */}
            {/* CUATRO pestañas. La de siempre pasa a llamarse RUTA —es el
                recorrido del día— y "Pendientes" queda libre para los que se
                aplazaron, que es lo que la palabra dice de verdad: gente a la
                que hay que volver.

                Con cuatro botones el texto ya no cabe en un teléfono, así que
                las dos de la derecha se quedan solo con su ícono y su número.
                Ruta y Pendientes conservan la palabra: son las dos entre las
                que se salta todo el día. */}
            {/* ── LAS CUATRO PESTAÑAS ──────────────────────────────────
                Sin texto: un ícono con color y su número. Con cuatro pestañas
                y un teléfono de 360px, "Gestionados" y "Ventas del día" ya
                venían recortados a la mitad o escondidos en `md:`, así que el
                nombre no estaba diciendo nada — y las pestañas quedaban de
                anchos distintos según lo que cupiera en cada una.

                El nombre NO se pierde: va en `title` y en `aria-label`, así
                que sigue estando para quien deje el dedo encima y para un
                lector de pantalla. Lo que se va es el texto que no cabía.

                Las cuatro salen del MISMO arreglo, que es lo que garantiza que
                midan igual: un `grid-cols-4` con `gap` reparte el ancho en
                cuartos exactos, pase lo que pase con los números. */}
            <div className={`${ocultoEnMovil()} mt-2 w-full`}>
              <div className="grid grid-cols-4 gap-1.5">
                {([
                  {
                    id: "pendientes" as const,
                    nombre: "Ruta",
                    Icono: MapPin,
                    // La ruta es el recorrido: azul de marca, el color del
                    // encabezado de la app.
                    color: "text-brand",
                    n: displayClients.length,
                  },
                  {
                    id: "aplazados" as const,
                    nombre: "Pendientes",
                    // EL MISMO RELOJ que se usa dentro del módulo — en el menú
                    // verde ("Dejar pendiente") y en la pastilla del aplazado.
                    // Tres reloj distintos para la misma idea serían tres cosas
                    // distintas a los ojos de quien cobra.
                    Icono: Clock,
                    color: "text-orange-500",
                    n: aplazadosDeLaRuta.length,
                  },
                  {
                    id: "gestionados" as const,
                    nombre: "Gestionados",
                    Icono: CheckCircle2,
                    color: "text-green-600",
                    n: filteredManaged.length,
                  },
                  {
                    id: "ventas" as const,
                    nombre: "Ventas del día",
                    Icono: ShoppingCart,
                    color: "text-green-600",
                    n: salesTodayCount,
                  },
                ]).map(({ id, nombre, Icono, color, n }) => {
                  const activa = activeTab === id
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      title={nombre}
                      aria-label={`${nombre}: ${n}`}
                      aria-current={activa ? "true" : undefined}
                      className={`flex items-center justify-center gap-1.5 rounded-xl px-1 py-2 shadow-sm transition-colors ${
                        activa ? "bg-brand/10" : "bg-muted/60 hover:bg-muted"
                      }`}
                    >
                      <Icono className={`h-5 w-5 shrink-0 ${color}`} />
                      {/* El número de la pestaña ACTIVA va en un círculo
                          lleno. Es la única marca que dice dónde estás cuando
                          no hay texto que resaltar. */}
                      <span
                        className={`shrink-0 text-[13px] font-bold tabular-nums ${
                          activa
                            ? "flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-1 text-brand-foreground"
                            : "text-brand"
                        }`}
                      >
                        {n}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* El subrayado de la activa. Va en su propia rejilla de cuatro
                  para caer justo debajo de su pestaña, y sobre la línea gris
                  que separa la cabecera del listado. */}
              <div className="mt-1.5 grid grid-cols-4 gap-1.5 border-b border-border">
                {TAB_ORDER.map((t) => (
                  <span
                    key={t}
                    aria-hidden="true"
                    className={`h-[3px] rounded-full ${activeTab === t ? "bg-brand" : "bg-transparent"}`}
                  />
                ))}
              </div>
            </div>
            {/* Puntos de navegación — solo móvil, y TAMBIÉN se pliegan.
                Plegado no queda nada para cambiar de panel: hay que desplegar,
                tocar la pestaña y volver a plegar. Es a propósito — plegado, la
                pantalla es para cobrar, y para cobrar solo se usa Pendientes.

                (No hay deslizar el dedo: el comentario de más abajo lo decía,
                pero no hay ni un `onTouchStart` en el archivo.)

                El punto se ve chiquito pero el área de toque es de 32px
                (`p-2` alrededor). Antes el botón medía lo mismo que el punto
                —6px— y había que apuntarle. */}
            <div className={`${ocultoEnMovil()} flex md:hidden justify-center gap-0.5 pt-0.5`}>
              {TAB_ORDER.map((tab) => (
                <button
                  key={tab}
                  aria-label={`Ir a ${tab}`}
                  aria-current={activeTab === tab ? "true" : undefined}
                  onClick={() => setActiveTab(tab)}
                  className="p-2 flex items-center justify-center"
                >
                  <span
                    className={`block rounded-full transition-all duration-200 ${
                      activeTab === tab
                        ? "w-5 h-1.5 bg-primary"
                        : "w-1.5 h-1.5 bg-muted-foreground/40"
                    }`}
                  />
                </button>
              ))}
            </div>
          </CardHeader>

          {/* ── Los cuatro paneles ─────────────────────────────────────────
               SOLO SE MONTA EL QUE SE ESTÁ VIENDO. Los otros llevan `hidden`.

               ANTES ERA UN CARRUSEL: los cuatro en fila y un `translateX` que
               los corría. Eso obligaba a que los cuatro ocuparan sitio siempre,
               y de ahí salía el vacío que se reportó — con 2 pendientes y 22
               gestionados, el alto lo ponía Gestionados: el panel visible medía
               185px, el flex 2.160, y se podían bajar 1.729px de blanco después
               del último cliente.

               Y LA CORRECCIÓN A MEDIAS FUE PEOR: al esconder los otros tres,
               los que quedaban dejaban de ocupar ancho, pero el `translateX`
               seguía corriendo el 100% por cada pestaña anterior. Gestionados
               —índice 2— se iba a -200% de un contenedor que ya solo medía un
               panel: quedaba en x=-775 con sus 22 tarjetas dentro, fuera de la
               pantalla. La pestaña decía "22" y no se veía nada.

               Sin `translateX` no hay a dónde correrse: el único panel montado
               empieza en x=0. Se pierde la animación de deslizar, que de todas
               formas nunca se pudo hacer con el dedo —no hay un solo
               `onTouchStart` en el archivo— y el cambio de pestaña siempre fue
               por la barra de arriba o por los puntos de abajo.

               `hidden` y no `invisible`: lo invisible sigue ocupando sitio, que
               es justo lo que hay que quitar. Los ocultos llevan `aria-hidden`
               para que un lector de pantalla no anuncie cuatro listas donde hay
               una. ─────────────────────────────────────────────────────── */}
          <div className="overflow-hidden">
          <div className="flex items-start">

          {/* ── Panel 0: Pendientes ────────────────────────────────────── */}
          <div
            className={`w-full shrink-0 p-2 md:p-6 ${activeTab === "pendientes" ? "" : "hidden"}`}
            aria-hidden={activeTab !== "pendientes"}
          >
            {loading && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Cargando...</span>
              </div>
            )}
            {!loading && (
              // VUELVE A SER TABLA. Estuvo un rato en tarjetas, como el
              // listado de Gestionados, y se devolvio a peticion del dueno:
              // en la tabla cada dato tiene su columna y la vista recorre la
              // ruta de arriba abajo sin releer etiquetas.
              //
              // Lo que SI se conserva de esos dias: el nombre con el apodo
              // debajo, sin el % de interes, el numero que es la posicion real
              // y las flechas grandes.
              //
              // overflow-hidden (en lugar de overflow-x-auto): la tabla DEBE
              // caber dentro del viewport móvil sin scroll horizontal. El
              // nombre del cliente puede partirse en 2 líneas vía `break-words`
              // en la celda correspondiente.
              <div className="rounded-md border overflow-hidden">
                <Table className="w-full table-fixed">
                  <TableHeader>
                    {/* TRES COLUMNAS, no cuatro, y UNA fila por cliente.
                        Antes cada cliente ocupaba dos filas y ~110px: el nombre
                        cruzando las cuatro columnas y debajo orden, acciones,
                        frecuencia, mora, monto de venta, cuota, valor de cuota,
                        saldo, multa y fecha del último pago. En un teléfono
                        entraban cinco clientes; una ruta de cuarenta eran ocho
                        pantallazos.

                        Lo que se fue NO se perdió: se agrupó detrás del ojito
                        de cada fila (el "Extracto"). En la lista se queda lo
                        único que se mira mientras se cobra —quién es, cuánto
                        debe, por qué cuota va y cómo está de mora— y lo demás
                        se consulta cuando hace falta, que es casi nunca. */}
                    <TableRow>
                      {/* LOS ANCHOS SE CALCULARON CONTRA EL CONTENIDO REAL,
                          no a ojo. `table-fixed` respeta estos números pero NO
                          impide que el contenido se salga: la primera versión
                          le dio 142px a Acción cuando sus botones pedían 168, y
                          el sobrante se pintó encima del saldo.

                          Acción = 36 + 8 + 36 + 6 + 28 + 4 + 28 = 146px de
                          botones. Saldo = "$332.600" a 12px. Lo que queda es
                          para el nombre: ~124px en un teléfono de 360, que dan
                          para dos renglones. */}
                      <TableHead className="text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-2">Cliente</TableHead>
                      <TableHead className="w-[84px] md:w-[130px] text-right text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-1">Saldo / Cuota</TableHead>
                      <TableHead className="w-[84px] md:w-[120px] text-center text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-1">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayClients.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground text-[12px] md:text-base py-2 md:py-4">
                          No se encontraron clientes activos
                        </TableCell>
                      </TableRow>
                    ) : (
                      displayClients.map((client, index) =>
                        filaCliente(client, index, displayClients.length, false))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>{/* fin Panel 0: Ruta */}

          {/* ── Panel 1: Pendientes (los aplazados) ────────────────────────
              La MISMA fila que la ruta —`filaCliente`— porque es el mismo
              cliente y las mismas acciones: desde acá también se le cobra o se
              le marca no pago, que es a lo que va. Lo único que cambia es que
              el reloj, en vez de aplazar, lo devuelve a la ruta. */}
          <div
            className={`w-full shrink-0 p-2 md:p-6 ${activeTab === "aplazados" ? "" : "hidden"}`}
            aria-hidden={activeTab !== "aplazados"}
          >
            {aplazadosDeLaRuta.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
                <Clock className="h-8 w-8 opacity-40" />
                <span className="text-sm">Nadie quedó pendiente por ahora.</span>
                <span className="max-w-xs text-xs">
                  Con el reloj del botón verde puedes dejar a un cliente para volver más
                  tarde, sin marcarle pago ni no pago.
                </span>
              </div>
            ) : (
              <div className="rounded-md border overflow-hidden">
                <Table className="w-full table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-2">Cliente</TableHead>
                      <TableHead className="w-[84px] md:w-[130px] text-right text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-1">Saldo / Cuota</TableHead>
                      <TableHead className="w-[84px] md:w-[120px] text-center text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-1">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {aplazadosDeLaRuta.map((client, index) =>
                      filaCliente(client, index, aplazadosDeLaRuta.length, true))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>{/* fin Panel 1: Pendientes */}

          {/* ── Panel 2: Gestionados ────────────────────────────────────── */}
          <div
            className={`w-full shrink-0 p-2 md:p-6 ${activeTab === "gestionados" ? "" : "hidden"}`}
            aria-hidden={activeTab !== "gestionados"}
          >
            <div className="space-y-2">
                {filteredManaged.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                    <Users className="h-8 w-8 opacity-30" />
                    {/* Distinguir "no has gestionado a nadie" de "tu busqueda no
                        encontro a nadie": con el mismo texto para los dos, el
                        cobrador cree que perdio el trabajo del dia. */}
                    <p className="text-xs md:text-sm">
                      {sortedManaged.length === 0
                        ? "No hay clientes gestionados hoy"
                        : `Ningún gestionado coincide con "${searchTerm}"`}
                    </p>
                    {sortedManaged.length > 0 && (
                      <Button variant="outline" size="sm" onClick={() => setSearchTerm("")}>
                        Ver los {sortedManaged.length} gestionados
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                  <div className="space-y-1.5">
                    {filteredManaged.map((m, index) => (
                      <div
                        key={m.loanId}
                        // Mismo criterio que la lista de Pendientes: al sol,
                        // un borde de 1px sobre franjeado al 40% es blanco
                        // contra blanco. Borde grueso + franja de color al
                        // inicio, verde si pagó y roja si no.
                        /* MÁS APRETADA, para que quepan más clientes.
                           Se fue el renglón de Cuota/Préstamo/Saldo entero y
                           los botones subieron al costado, así que la tarjeta
                           pasó de tres líneas a dos y el padding de 8px ya no
                           hace falta. */
                        className={`rounded-lg border-2 border-border border-l-4 px-2.5 py-1.5 ${
                          m.gestionTipo === "pago"
                            ? "border-l-green-500"
                            : m.gestionTipo === "aplazado"
                              ? "border-l-amber-500"
                              : "border-l-red-500"
                        } ${index % 2 === 0 ? "bg-card" : "bg-muted"}`}
                      >
                      {/* EL TEXTO A LA IZQUIERDA, LOS BOTONES AL COSTADO.
                          Los botones estaban en un tercer renglón propio; acá
                          se ponen al lado y aprovechan el alto que ya ocupan
                          el nombre y la insignia. Es la misma forma que tiene
                          la fila de Pendientes. */}
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                        {/* Línea 1: SOLO el nombre, con todo el ancho.
                            Compartía renglón con la insignia del monto y con la
                            hora, que juntas se llevan unos 180px de los 336 que
                            tiene la tarjeta en un teléfono: al nombre le
                            quedaban 150 y se partía en tres o cuatro renglones
                            contra el monto. Solo, le sobra para dos. */}
                        <div className="min-w-0">
                          {/* El nombre ENVUELVE, no se corta. Con `truncate` un
                              nombre largo terminaba en "..." y el cobrador no
                              podia distinguir dos clientes del mismo apellido.
                              Va un punto mas pequeño en movil, que es donde se
                              acaba el ancho; en pantalla grande se queda igual.

                              `min-w-0` es CRITICO: sin eso el span impone su
                              ancho intrinseco al flex item, desborda la fila y
                              se solapa con el badge de estado. */}
                          <span className="block font-semibold text-[13px] md:text-sm leading-tight break-words [overflow-wrap:anywhere]">
                            {m.nombreCompleto}
                          </span>
                          {m.apodo && (
                            <span className="block text-[11px] md:text-xs text-muted-foreground leading-tight break-words [overflow-wrap:anywhere]">
                              {m.apodo}
                            </span>
                          )}
                        </div>

                        {/* Línea 2: qué pasó, por cuánto y a qué hora. */}
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          {/* El valor abonado va DENTRO de la insignia, pegado
                              a "Pago": es el par que el cobrador busca de un
                              vistazo — qué pasó y por cuánto. Abajo, entre
                              Cuota/Préstamo/Saldo, se perdía entre tres cifras
                              más que se parecen. */}
                          {m.gestionTipo === "pago" ? (
                            <span className="inline-flex items-center gap-1 text-[12px] font-bold text-green-700 bg-green-100 px-2 py-1 rounded-full shrink-0">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Pago ${(m.valorAbonado ?? 0).toLocaleString()}
                            </span>
                          ) : m.gestionTipo === "aplazado" ? (
                            /* La misma insignia que lleva en la pestaña
                               Pendientes, en el mismo sitio donde las otras
                               dicen Pago o No pago: la fila se lee igual que
                               las demás y lo único que cambia es qué pasó.
                               Sin monto, porque no hubo. */
                            <span className="inline-flex items-center gap-1 text-[12px] font-bold text-amber-700 bg-amber-100 px-2 py-1 rounded-full shrink-0">
                              <Clock className="h-3.5 w-3.5" />
                              Pendiente
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[12px] font-bold text-red-700 bg-red-100 px-2 py-1 rounded-full shrink-0">
                              <XCircle className="h-3.5 w-3.5" />No pago
                            </span>
                          )}
                          {/* TRANSFERENCIA: SOLO EL ICONO, y más grande.
                              La palabra se llevaba unos 90px de un renglón que
                              ya lleva la insignia del pago y la hora, y no
                              decía nada que el icono no diga. Ahora es una
                              pastilla redonda con las flechas a 18px: se ve de
                              lejos y deja el ancho para lo que sí cambia entre
                              filas.

                              El nombre va en `title` —que es donde se consulta
                              cuando hace falta— y en `aria-label`, para que un
                              lector de pantalla no lea una pastilla muda. */}
                          {m.metodoPago && m.metodoPago !== "efectivo" && (
                            <span
                              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-info-light text-info shrink-0"
                              title={m.metodoPago === "mixto" ? "Pago mixto" : "Transferencia"}
                              aria-label={m.metodoPago === "mixto" ? "Pago mixto" : "Transferencia"}
                            >
                              <ArrowLeftRight className="h-[18px] w-[18px]" strokeWidth={2.5} />
                            </span>
                          )}
                          <span className="text-[11px] text-muted-foreground shrink-0">{m.gestionHora}</span>
                        </div>
                        </div>{/* fin del texto */}

                        {/* SE FUERON CUOTA, PRÉSTAMO Y SALDO.
                            Eran tres cifras que no cambian con la gestión —son
                            del crédito, no del día— y ocupaban un renglón
                            entero de cada tarjeta. Quien las necesita las tiene
                            todas juntas en el extracto, a un toque del ojo de
                            al lado. */}
                        {/* LA MISMA FORMA QUE EN PENDIENTES.
                            Alla el boton que gestiona es grande y va a la
                            izquierda, y a la derecha el ojo encima de los tres
                            puntos. Acá el que gestiona es el LÁPIZ —es la
                            accion de la fila, corregir lo que se registró— así
                            que ocupa ese lugar y ese tamaño. Antes iba apilado
                            con los tres puntos y del mismo tamaño que ellos:
                            las dos pestañas se veian distintas sin que la
                            diferencia significara nada. */}
                        <div className="flex items-center justify-end gap-1.5 shrink-0">
                            {/* AL APLAZADO NO SE LE CORRIGE NADA: se le cobra.
                                No hay gestión detrás suyo —ni pago ni no pago—
                                así que un lápiz que abre "corregir esta
                                gestión" no tendría qué corregir. Lleva el mismo
                                botón verde de la ruta, con el que se resuelve
                                ahí mismo sin ir a buscarlo a la otra pestaña. */}
                            {m.gestionTipo === "aplazado" ? (
                              menuGestion(m, true)
                            ) : (
                              <>
                            {/* EL LÁPIZ ES UN MENÚ, no un botón.
                                Antes eran dos botones sueltos —lápiz y
                                basurero— y el basurero, en rojo y del mismo
                                tamaño que el otro, invitaba a tocarlo. Ahora
                                las cuatro salidas viven detrás del lápiz, con
                                su nombre escrito, y para llegar a la que
                                deshace hay que bajar hasta el final.

                                Los nombres son los MISMOS del menú verde de la
                                ruta —Pago, No Pago, Pendiente— porque son las
                                mismas tres cosas: lo que cambia es que acá ya
                                hay una gestión y se está corrigiendo. */}
<DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="outline"
                                  title="Corregir esta gestión"
                                  aria-label="Corregir esta gestión"
                                  className="h-10 w-10 shrink-0 rounded-full border-info/40 text-info hover:text-info hover:bg-info-light"
                                  disabled={savingManaged}
                                >
                                  <Pencil className="h-5 w-5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-52">
                                <DropdownMenuItem
                                  className="cursor-pointer text-sm font-medium"
                                  onClick={() => {
                                    setEditingManaged(m)
                                    setEditTipo("pago")
                                    // Viniendo de un no pago no hay monto
                                    // anterior que proponer: se ofrece la
                                    // cuota, que es lo que debía ese día.
                                    setEditMonto(
                                      m.gestionTipo === "pago"
                                        ? (m.valorAbonado ?? 0).toString()
                                        : (m.valorCuota ?? 0).toString(),
                                    )
                                    // El método que ya tenía. 'mixto' no se
                                    // ofrece en este selector —lo arma el
                                    // formulario de cobro, no la corrección—
                                    // así que cae a efectivo.
                                    setEditMetodo(
                                      m.metodoPago === "transferencia" ? "transferencia" : "efectivo",
                                    )
                                  }}
                                >
                                  <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-600">
                                    <Check className="h-3 w-3 text-white" strokeWidth={3} />
                                  </span>
                                  <span className="font-semibold text-green-700">Pago</span>
                                </DropdownMenuItem>

                                <DropdownMenuItem
                                  className="cursor-pointer text-sm font-medium"
                                  onClick={() => {
                                    setEditingManaged(m)
                                    setEditTipo("no_pago")
                                    setEditMonto((m.valorCuota ?? 0).toString())
                                    setEditMetodo(
                                      m.metodoPago === "transferencia" ? "transferencia" : "efectivo",
                                    )
                                  }}
                                >
                                  <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600">
                                    <X className="h-3 w-3 text-white" strokeWidth={3} />
                                  </span>
                                  <span className="font-semibold text-red-700">No Pago</span>
                                </DropdownMenuItem>

                                <DropdownMenuItem
                                  className="cursor-pointer text-sm font-medium"
                                  onClick={() => { void gestionadoAPendiente(m) }}
                                >
                                  <Clock className="mr-2 h-5 w-5 shrink-0 text-orange-500" strokeWidth={2.5} />
                                  <span className="font-semibold">Pendiente</span>
                                </DropdownMenuItem>

                                <DropdownMenuSeparator />

                                {/* ELIMINAR es la palabra que el cobrador
                                    busca, pero por dentro NO borra nada:
                                    registra una reversa. El evento original y
                                    su anulación quedan los dos en el
                                    historial, y el diálogo de confirmación lo
                                    dice con todas las letras. */}
                                <DropdownMenuItem
                                  className="cursor-pointer text-sm font-medium"
                                  onClick={() => setAnularManaged(m)}
                                >
                                  <Trash2 className="mr-2 h-5 w-5 shrink-0 text-destructive" />
                                  <span className="font-semibold text-destructive">Eliminar</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                              </>
                            )}

                            {/* EL OJO ENCIMA DE LOS TRES PUNTOS, igual que en
                                Pendientes: apilados ocupan una columna en vez
                                de dos, y ese ancho se lo lleva el nombre. */}
                            <div className="flex shrink-0 flex-col gap-0.5">
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-[26px] w-[26px] rounded-full bg-transparent p-0"
                              onClick={() => setExtractoClient(m)}
                              title="Ver el extracto del cliente"
                              aria-label="Ver el extracto del cliente"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>

                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="outline" className="h-[26px] w-[26px] rounded-full bg-transparent p-0" aria-label="Más opciones">
                                  <MoreVertical className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem
                                  className="text-xs md:text-base cursor-pointer"
                                  onClick={() => { setPaymentHistoryClient(m); setPaymentHistoryOpen(true) }}
                                >
                                  <History className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                  Historial de pagos
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-xs md:text-base cursor-pointer"
                                  onClick={() => { setLoanHistoryClient(m); setLoanHistoryOpen(true) }}
                                >
                                  <FileText className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                  Historial de prestamos
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-xs md:text-base cursor-pointer"
                                  onClick={() => { setSelectedClientInfo(m); setClientInfoDialogOpen(true) }}
                                >
                                  <User className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                  Info del cliente
                                </DropdownMenuItem>
                                {/* Un aplazado no movió plata, así que no hay
                                    recibo que generar. */}
                                {m.gestionTipo !== "aplazado" && (
                                  <DropdownMenuItem
                                    className="text-xs md:text-base cursor-pointer"
                                    onClick={() => handleGenerarRecibo(m)}
                                  >
                                    <Receipt className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                    Generar recibo
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            </div>{/* fin de la columna ojo + tres puntos */}
                          </div>{/* fin de los botones */}
                        </div>{/* fin de la fila texto + botones */}
                      </div>
                    ))}
                  </div>

                  </>
                )}

              </div>
          </div>{/* fin Panel 1: Gestionados */}

          {/* ── Panel 2: Registrar Ventas ───────────────────────────────── */}
          {/* Vista informativa: listado de ventas creadas HOY en la ruta.
              El formulario de creación vive en la pantalla "Nueva Venta"
              del menú principal — aquí solo se consulta lo registrado. */}
          <div
            className={`w-full shrink-0 p-2 md:p-6 ${activeTab === "ventas" ? "" : "hidden"}`}
            aria-hidden={activeTab !== "ventas"}
          >
            <SalesTodayList
              currentRutaId={currentRutaId}
              onCountChange={setSalesTodayCount}
              // El dia que se esta cerrando: sin esto la pestana buscaba las
              // ventas de HOY y las de ese dia no aparecian.
              fechaJornada={esDiaAtrasado ? diaDeTrabajo : null}
            />
          </div>{/* fin Panel 2: Ventas */}

          </div>{/* fin flex deslizable */}
          </div>{/* fin overflow-hidden */}
        </Card>
      ) : (
        // EL DISEÑO DE PROMPT_Registrar_Pago.md (RegistrarPago.jsx), con su
        // propio CSS (`register-payment.css`, prefijo `rp-`). Mantiene el
        // armado a cualquier ancho: en un teléfono se REDUCE, no se apila, y
        // así el botón de cobrar entra en la pantalla sin bajar.
        //
        // Lo que el diseño no trae y la app sí necesita (multa, renovar,
        // prórroga, cuota adicional, geocerca, avisos del cronograma) va en el
        // mismo lenguaje visual, en el lugar donde se decide.
        (() => {
          const saldo = selectedClient.saldo
          const cuotaRef = Number(selectedClient.nextPaymentCuota) || 0
          const monto = Number.parseFloat(paymentAmount) || 0
          const nuevoSaldo = Math.max(0, saldo - monto)
          const efectivoMixto = Number.parseFloat(montoEfectivoMixto) || 0
          const transfMixto = Math.max(0, monto - efectivoMixto)
          const errorMixto = dosFormas && efectivoMixto > monto
          const hayTransferencia = dosFormas ? transfMixto > 0 : paymentMethod === "transferencia"
          // Sin cuentas cargadas para la ruta no se exige: bloquear el cobro
          // por un catálogo vacío dejaría al cobrador sin poder registrar.
          const faltaCuenta = hayTransferencia && cuentasPago.length > 0 && !accountNumber
          const multa = pagarMulta && selectedClient.multaPendiente ? selectedClient.multaPendiente.valor : 0
          const invalido =
            saving || (monto <= 0 && !extenderCuotas) || monto > saldo || errorMixto || faltaCuenta
          const esAmericano = selectedClient.tipoAmortizacion?.toLowerCase().trim() === "americano"
          const metodo: "efectivo" | "transferencia" | "mixto" = dosFormas
            ? "mixto"
            : paymentMethod === "transferencia" ? "transferencia" : "efectivo"

          // Cambiar el monto recalcula las cuotas; cambiar las cuotas, el monto.
          const cambiarMonto = (texto: string) => {
            let m = Number.parseFloat(leerMonto(texto)) || 0
            if (m > saldo) {
              toast({
                title: "Monto excede el saldo",
                description: `El monto del pago no puede ser mayor al saldo a pagar ($${Math.round(saldo).toLocaleString("es-CO")})`,
                variant: "destructive",
              })
              m = saldo
            }
            setPaymentAmount(m > 0 ? String(m) : "")
            if (dosFormas) setMontoEfectivoMixto((c) => String(Math.min(Number.parseFloat(c) || 0, m)))
            if (!isPartialPayment && cuotaRef > 0) {
              setNumCuotas(Math.min(cuotasQueLeQuedan, Math.max(1, Math.round(m / cuotaRef))))
            }
          }
          const cambiarCuotas = (valor: string) => {
            const n = Number.parseInt(valor)
            setNumCuotas(n)
            if (!isPartialPayment) {
              const m = montoAProponer(cuotaRef, saldo, n)
              setPaymentAmount(m.toString())
              if (dosFormas) setMontoEfectivoMixto(String(Math.round(m / 2)))
            }
          }
          const elegirMetodo = (id: "efectivo" | "transferencia" | "mixto") => {
            if (id === "mixto") {
              setDosFormas(true)
              setPaymentMethod("efectivo")
              setMontoEfectivoMixto(String(Math.round(monto / 2)))
            } else {
              setDosFormas(false)
              setPaymentMethod(id)
            }
          }

          const selectorCuenta = (
            <label className="rp-field">
              <span className="rp-label">Cuenta transferencia</span>
              <span className="rp-wrap">
                <select
                  className={`rp-in${faltaCuenta ? " rp-in--err" : ""}`}
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                >
                  <option value="">
                    {cuentasPago.length ? "Seleccionar cuenta..." : "No hay cuentas para esta ruta"}
                  </option>
                  {cuentasPago.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
                <span className="rp-abs" style={{ right: 18 }}><ChevronDown size={20} color="#5b6573" strokeWidth={1.75} /></span>
              </span>
            </label>
          )

          return (
            <div className="rp-root">
              <div className="rp-frame">
                <section className="rp-card [&_input]:scroll-mb-24 [&_textarea]:scroll-mb-24">
                  <h2 className="rp-title">Información del Pago</h2>

                  {renderAvisoGeocerca()}
                  {esAmericano && selectedClient.esUltimaCuotaPendiente && (
                    <div className="rp-aviso">
                      <AlertCircle size={20} strokeWidth={1.75} style={{ flex: "none", marginTop: 1 }} />
                      <b>Última cuota programada — ¿extender cuotas?</b>
                    </div>
                  )}
                  {/* EL CRONOGRAMA SE ACABO Y TODAVIA DEBE. No bloquea el
                      cobro, pero mientras tanto no cuenta en la meta del día. */}
                  {selectedClient.cronogramaAgotado && (
                    <div className="rp-aviso">
                      <AlertCircle size={20} strokeWidth={1.75} style={{ flex: "none", marginTop: 1 }} />
                      <span>
                        <b>Se acabaron las cuotas y todavía debe {fmtMoneda(saldo)}.</b>{" "}
                        El cobro se registra igual, pero pídele a secretaría que le complete el cronograma:
                        mientras tanto no cuenta en la meta del día.
                      </span>
                    </div>
                  )}

                  <div className="rp-row3">
                    <label className="rp-field">
                      <span className="rp-label">Apodo</span>
                      <input id="apodo" readOnly value={selectedClient.nombre} className="rp-in rp-in--lock" />
                    </label>
                    <label className="rp-field">
                      <span className="rp-label">Saldo a Pagar</span>
                      <input id="saldoCliente" readOnly value={`$${Math.round(saldo).toLocaleString("es-CO")}`} className="rp-in rp-in--amber" />
                    </label>
                    <label className="rp-field">
                      <span className="rp-label">Últ. Pago</span>
                      <input id="lastPaymentDate" readOnly value={selectedClient.ultimoPagoFecha || "—"} className="rp-in rp-in--lock" />
                    </label>
                  </div>

                  {/* Multa pendiente: valor y origen. Informativo. */}
                  {selectedClient.multaPendiente && (
                    <div className="rp-aviso rp-aviso--rojo">
                      <span>
                        Multa por fallas
                        {selectedClient.multaPendiente.cuotasMora != null
                          ? ` — generada por ${selectedClient.multaPendiente.cuotasMora} falla${selectedClient.multaPendiente.cuotasMora !== 1 ? "s" : ""}`
                          : ""}
                      </span>
                      <b>${selectedClient.multaPendiente.valor.toLocaleString("es-CO")}</b>
                    </div>
                  )}

                  <div className="rp-row2">
                    <label className="rp-field">
                      <span className="rp-label">Monto del Pago</span>
                      <span className="rp-wrap">
                        <span className="rp-abs" style={{ left: 20 }}>$</span>
                        {/* `type="text"`: un input numérico no deja pintar los
                            puntos de miles. `inputMode` saca el teclado de números. */}
                        <input
                          id="paymentAmount"
                          type="text"
                          inputMode="numeric"
                          value={sinSigno(mostrarMonto(paymentAmount))}
                          onChange={(e) => cambiarMonto(e.target.value)}
                          className="rp-in rp-in--big rp-in--peso"
                        />
                      </span>
                    </label>
                    <label className="rp-field">
                      <span className="rp-label">Nuevo Saldo</span>
                      <input
                        readOnly
                        value={`$${Math.round(nuevoSaldo).toLocaleString("es-CO")}`}
                        className={`rp-in rp-in--big ${nuevoSaldo === 0 ? "rp-in--cero" : "rp-in--ok"}`}
                      />
                    </label>
                  </div>

                  <div className="rp-row2">
                    <label className="rp-field">
                      {/* CUÁNTAS LE QUEDAN, al lado del selector: sin esto, que
                          la lista llegue hasta 7 y no hasta 10 parece un error. */}
                      <span className="rp-label">
                        Nro Cuotas<span className="rp-label-note">(le quedan {cuotasQueLeQuedan})</span>
                      </span>
                      <span className="rp-wrap">
                        <select
                          id="numCuotas"
                          className="rp-in"
                          value={String(numCuotas)}
                          onChange={(e) => cambiarCuotas(e.target.value)}
                          disabled={isPartialPayment}
                        >
                          {Array.from({ length: cuotasQueLeQuedan }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                        <span className="rp-abs" style={{ right: 18 }}><ChevronDown size={20} color="#5b6573" strokeWidth={1.75} /></span>
                      </span>
                    </label>
                  </div>

                  <div className="rp-field" style={{ gap: 10 }}>
                    <span className="rp-label">Método de Pago</span>
                    <div role="radiogroup" className="rp-seg">
                      {([
                        ["efectivo", "Efectivo", Banknote],
                        ["transferencia", "Transferencia", ArrowLeftRight],
                        ["mixto", "Mixto", PieChart],
                      ] as const).map(([id, texto, Icono]) => (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={metodo === id}
                          className="rp-seg-btn"
                          onClick={() => elegirMetodo(id)}
                        >
                          <Icono
                            size={26}
                            strokeWidth={1.75}
                            fill={id === "mixto" ? "#1f5fc4" : "none"}
                            color={id === "mixto" ? "#1f5fc4" : "#0f3a80"}
                          />
                          {texto}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* PAGO EN DOS MEDIOS: se escribe el efectivo y la
                      transferencia es lo que falta. En el libro son dos
                      eventos, uno por forma (ver `dosFormas`). */}
                  {dosFormas && (
                    <div className="rp-panel">
                      <div className="rp-panel-head">
                        <PieChart size={26} fill="#1f5fc4" color="#1f5fc4" strokeWidth={1.75} style={{ flex: "none", marginTop: 2 }} />
                        <div>
                          <div className="rp-panel-title">Pago en dos medios</div>
                          <div className="rp-panel-sub">Ingresá cuánto se cobra en cada medio.</div>
                        </div>
                      </div>
                      <div className="rp-row2 rp-row2--tight">
                        <label className="rp-field">
                          <span className="rp-label">Efectivo</span>
                          <span className="rp-wrap">
                            <span className="rp-abs" style={{ left: 16 }}><Banknote size={24} strokeWidth={1.75} /></span>
                            <span className="rp-abs" style={{ left: 58 }}>$</span>
                            <input
                              id="montoEfectivoMixto"
                              type="text"
                              inputMode="numeric"
                              value={sinSigno(mostrarMonto(montoEfectivoMixto))}
                              onChange={(e) => setMontoEfectivoMixto(leerMonto(e.target.value))}
                              className={`rp-in rp-in--ico${errorMixto ? " rp-in--err" : ""}`}
                            />
                          </span>
                        </label>
                        <label className="rp-field">
                          <span className="rp-label">Transferencia</span>
                          <span className="rp-wrap">
                            <span className="rp-abs" style={{ left: 16 }}><ArrowLeftRight size={24} strokeWidth={1.75} /></span>
                            <span className="rp-abs" style={{ left: 58 }}>$</span>
                            <input
                              id="montoTransfMixto"
                              readOnly
                              value={Math.round(transfMixto).toLocaleString("es-CO")}
                              className="rp-in rp-in--ico"
                            />
                          </span>
                        </label>
                      </div>
                      {errorMixto && <span className="rp-err">El efectivo no puede superar el monto del pago.</span>}
                      {selectorCuenta}
                    </div>
                  )}
                  {!dosFormas && paymentMethod === "transferencia" && selectorCuenta}

                  <div className="rp-checks-row">
                    <div className="rp-checks">
                      <label className="rp-check">
                        <input
                          id="partialPayment"
                          type="checkbox"
                          checked={isPartialPayment}
                          onChange={(e) => handlePartialPaymentChange(e.target.checked)}
                        />
                        Pago manual
                      </label>
                      {/* RENOVAR: no en créditos americanos (tienen la
                          prórroga). No se combina con "Cancelada". */}
                      {!esAmericano && (
                        <label className="rp-check rp-check--renovar">
                          <input
                            id="renovar"
                            type="checkbox"
                            checked={renovar}
                            onChange={(e) => {
                              setRenovar(e.target.checked)
                              if (e.target.checked) setIsCancelada(false)
                            }}
                          />
                          Renovar
                        </label>
                      )}
                      {!renovar && (
                        <label className="rp-check">
                          <input
                            id="cancelada"
                            type="checkbox"
                            checked={isCancelada}
                            onChange={(e) => {
                              setIsCancelada(e.target.checked)
                              // Cancelar = cobrar todo lo que queda.
                              if (e.target.checked) setPaymentAmount(saldo.toString())
                            }}
                          />
                          Cancelada
                        </label>
                      )}
                      {/* Prórroga: solo americanos en su ÚLTIMA cuota. */}
                      {esAmericano && selectedClient.esUltimaCuotaPendiente && (
                        <label className="rp-check">
                          <input
                            id="extenderCuotas"
                            type="checkbox"
                            checked={extenderCuotas}
                            onChange={(e) => {
                              const on = e.target.checked
                              setExtenderCuotas(on)
                              // Prorrogado, esta cuota deja de ser la final: se
                              // cobran solo los intereses (`valorCuota`).
                              if (on) {
                                setPaymentAmount(selectedClient.valorCuota.toString())
                                setIsCancelada(false)
                                setIsPartialPayment(false)
                              } else {
                                setPaymentAmount("")
                              }
                            }}
                          />
                          Extender Cuotas (Prórroga)
                        </label>
                      )}
                      {/* La multa se cobra junto con el pago. */}
                      {selectedClient.multaPendiente && (
                        <label className="rp-check rp-check--multa">
                          <input
                            id="pagarMulta"
                            type="checkbox"
                            checked={pagarMulta}
                            onChange={(e) => setPagarMulta(e.target.checked)}
                          />
                          Pagar multa (${selectedClient.multaPendiente.valor.toLocaleString("es-CO")})
                        </label>
                      )}
                      {/* Cuota adicional si aún debe: solo en la ÚLTIMA cuota,
                          y no junto con la prórroga ni con la cancelación. */}
                      {selectedClient.esUltimaCuotaPendiente && !extenderCuotas && !isCancelada && (
                        <label className="rp-check rp-check--extra">
                          <input
                            id="agregarCuotaSiDebe"
                            type="checkbox"
                            checked={agregarCuotaSiDebe}
                            onChange={(e) => setAgregarCuotaSiDebe(e.target.checked)}
                          />
                          Agregar cuota adicional si aún debe
                        </label>
                      )}
                    </div>
                    <input type="file" accept="image/*" capture="environment" onChange={handlePhotoCapture} className="rp-file" id="payment-photo" />
                    <label
                      htmlFor="payment-photo"
                      aria-label="Adjuntar foto"
                      className={`rp-cam${paymentPhoto ? " rp-cam--ok" : ""}`}
                    >
                      <Camera size={24} strokeWidth={1.75} />
                    </label>
                  </div>

                  {/* ── Los datos de la renovación ─────────────────────────
                      Vista previa APROXIMADA: el cálculo exacto lo hace la
                      base con el cronograma real (scripts/123). */}
                  {renovar && (() => {
                    const x = Number.parseFloat(valorRenovar) || 0
                    const d = Number.parseInt(diasRenovar, 10) || 0
                    const tasa = Number(selectedClient.tasaInteres) || 0
                    const agregado = x * (1 + tasa / 100)
                    const quedaban = Math.max(0, cuotasQueLeQuedan - numCuotas)
                    const n = quedaban + d
                    const saldoRenovado = nuevoSaldo + agregado
                    return (
                      <div className="rp-panel">
                        <div className="rp-row2 rp-row2--tight">
                          <label className="rp-field">
                            <span className="rp-label">Valor a renovar</span>
                            <span className="rp-wrap">
                              <span className="rp-abs" style={{ left: 20 }}>$</span>
                              <input
                                id="valorRenovar"
                                type="text"
                                inputMode="numeric"
                                placeholder="Plata que recibe hoy"
                                value={sinSigno(mostrarMonto(valorRenovar))}
                                onChange={(e) => setValorRenovar(leerMonto(e.target.value))}
                                className="rp-in rp-in--peso"
                              />
                            </span>
                          </label>
                          <label className="rp-field">
                            <span className="rp-label">Días</span>
                            <input
                              id="diasRenovar"
                              type="text"
                              inputMode="numeric"
                              placeholder="Días que se agregan"
                              value={diasRenovar}
                              onChange={(e) => setDiasRenovar(e.target.value.replace(/\D/g, ""))}
                              className="rp-in"
                            />
                          </label>
                        </div>
                        {x > 0 && d > 0 && (
                          <span className="rp-panel-sub" style={{ color: "#0f3a80", fontSize: 15 }}>
                            Se entregan <b>${x.toLocaleString("es-CO")}</b>
                            {tasa > 0 ? ` (+${tasa}%: $${Math.round(agregado).toLocaleString("es-CO")})` : ""}. Nuevo saldo aprox.{" "}
                            <b>${Math.round(saldoRenovado).toLocaleString("es-CO")}</b> en {n} cuotas de ~$
                            {Math.round(saldoRenovado / Math.max(1, n)).toLocaleString("es-CO")}.
                          </span>
                        )}
                      </div>
                    )
                  })()}

                  {extenderCuotas && (
                    <label className="rp-field">
                      <span className="rp-label">Cantidad de cuotas a extender</span>
                      <input
                        id="cantidadCuotasExtender"
                        type="text"
                        inputMode="numeric"
                        value={cantidadCuotasExtender}
                        onChange={(e) => setCantidadCuotasExtender(e.target.value.replace(/\D/g, ""))}
                        className="rp-in"
                        placeholder="Ej: 3"
                      />
                    </label>
                  )}

                  {multa > 0 && (
                    <div className="rp-aviso rp-aviso--rojo">
                      <span>Total a cobrar (pago + multa)</span>
                      <b>${(monto + multa).toLocaleString("es-CO")}</b>
                    </div>
                  )}

                  {paymentPhoto && (
                    <div className="rp-foto">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={paymentPhoto} alt="Comprobante de pago" />
                      <button type="button" className="rp-foto-x" aria-label="Quitar foto" onClick={() => setPaymentPhoto(null)}>
                        <X size={18} />
                      </button>
                    </div>
                  )}

                  <label className="rp-field" style={{ gap: 10 }}>
                    <span className="rp-notas-label">Notas (Opcional)</span>
                    <textarea
                      id="notes"
                      rows={2}
                      value={notasPago}
                      onChange={(e) => setNotasPago(e.target.value)}
                      placeholder="Agregar comentarios sobre el pago..."
                      className="rp-in"
                    />
                  </label>

                  {/* LA BARRA DE COBRAR NO SE ESCONDE DETRÁS DEL TECLADO (ver
                      `subirBarra`). El desplazamiento se mide en px de la
                      pantalla y la barra vive dentro del zoom: se divide. */}
                  <div
                    ref={barraCobrarRef}
                    className="rp-actions"
                    style={subirBarra > 0 ? { transform: `translateY(calc(-${subirBarra}px / var(--k)))` } : undefined}
                  >
                    <button type="button" className="rp-btn rp-btn--cancel" onClick={handleBack}>
                      Cancelar
                    </button>
                    {/* El monto va EN el botón: es lo último que ve el cobrador
                        antes de confirmar. Incluye la multa si va en el mismo
                        movimiento. */}
                    <button type="button" className="rp-btn rp-btn--cobrar" onClick={handleRegisterPayment} disabled={invalido}>
                      {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                      {saving
                        ? "Cobrando…"
                        : (() => {
                            const total = monto + multa
                            if (total <= 0) return extenderCuotas ? "Registrar y extender plazo" : "Registrar pago"
                            const cifra = `$${total.toLocaleString("es-CO")}`
                            return extenderCuotas ? `Cobrar ${cifra} y extender` : `Cobrar ${cifra}`
                          })()}
                    </button>
                  </div>
                </section>
              </div>
            </div>
          )
        })()
      )}

      {/* No Payment Dialog */}
      <Dialog open={!!noPaymentClient} onOpenChange={(open) => { if (!open) { setNoPaymentClient(null); setNoPaymentPhoto(null) } }}>
        <DialogContent className="sm:max-w-[425px] p-4 md:p-6">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Confirmar no pago</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Registrar que el cliente {noPaymentClient?.nombre} no realizo el pago del dia.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 md:space-y-4 py-2 md:py-4">
            {renderAvisoGeocerca()}
            <div className="space-y-1.5 md:space-y-2">
              <Label htmlFor="last-payment-date" className="text-xs md:text-sm">Fecha del Ultimo Pago</Label>
              <Input id="last-payment-date" type="text" value={noPaymentClient?.ultimoPagoFecha || "N/A"} readOnly className="bg-muted text-xs md:text-sm h-7 md:h-10" />
            </div>

            <div className="space-y-1.5 md:space-y-2">
              <Label htmlFor="mora-days" className="text-xs md:text-sm">Mora</Label>
              <div className={`text-xs md:text-sm font-semibold px-2 py-1 rounded h-7 md:h-10 flex items-center justify-center ${
                noPaymentClient?.mora === 0 ? "bg-green-500/60" : (noPaymentClient?.mora ?? 0) < 10 ? "bg-yellow-500/60" : "bg-red-500/60"
              }`}>
                {noPaymentClient?.mora} {noPaymentClient?.mora === 1 ? "cuota" : "cuotas"}
              </div>
            </div>

            <div className="space-y-1.5 md:space-y-2">
              <Label htmlFor="observation" className="text-xs md:text-sm">Notas</Label>
              <Textarea id="observation" placeholder="Escriba el motivo o comentarios sobre el no pago..." value={noPaymentObservation} onChange={(e) => setNoPaymentObservation(e.target.value)} className="min-h-[60px] md:min-h-[100px] text-xs md:text-sm" />
            </div>

            {/* Solo visible cuando la cuota actual es la ULTIMA del plan de
                pagos: si el cliente aun debe tras este no-pago, agrega una
                cuota adicional en vez de dejar el prestamo sin fechas. */}
            {noPaymentClient && noPaymentClient.esUltimaCuotaPendiente && (
              <div className="flex items-center space-x-1.5">
                <Checkbox
                  id="agregarCuotaSiDebeNoPago"
                  checked={agregarCuotaSiDebeNoPago}
                  onCheckedChange={(c) => setAgregarCuotaSiDebeNoPago(c as boolean)}
                  className="h-4 w-4 border-2 border-amber-400"
                />
                <Label htmlFor="agregarCuotaSiDebeNoPago" className="text-[11px] md:text-sm font-normal cursor-pointer text-amber-700">
                  Agregar cuota adicional si aún debe (última cuota)
                </Label>
              </div>
            )}

            {noPaymentPhoto && (
              <div className="space-y-1.5 md:space-y-2">
                <Label className="text-xs md:text-sm">Foto Adjunta</Label>
                <div className="relative rounded-lg border overflow-hidden">
                  <img src={noPaymentPhoto} alt="Foto de no pago" className="w-full h-auto max-h-[150px] md:max-h-[200px] object-contain" />
                  <Button type="button" size="icon" variant="destructive" className="absolute top-1 right-1 md:top-2 md:right-2 h-6 w-6 md:h-8 md:w-8" onClick={() => setNoPaymentPhoto(null)}>
                    <X className="h-3 w-3 md:h-4 md:w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-1.5 md:gap-2">
            <div className="flex gap-1.5 md:gap-2 flex-wrap">
              <div className="relative">
                <input type="file" accept="image/*" capture="environment" onChange={handleNoPaymentPhotoCapture} className="hidden" id="no-payment-photo" />
                <Label htmlFor="no-payment-photo" className="cursor-pointer m-0">
                  <Button type="button" size="icon" variant={noPaymentPhoto ? "default" : "outline"} className={`h-8 w-8 md:h-10 md:w-10 ${noPaymentPhoto ? "bg-green-600 hover:bg-green-700" : ""}`} asChild>
                    <span><Camera className="h-3.5 w-3.5 md:h-5 md:w-5" /></span>
                  </Button>
                </Label>
              </div>
              <Button onClick={handleRegisterNoPayment} disabled={saving} className="bg-red-400 hover:bg-red-500 text-white h-8 md:h-10 text-xs md:text-base">
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Registrar No Pago
              </Button>
              {/* EL SALDO, junto al boton. Antes de dejar a alguien en no pago
                  el cobrador suele preguntar cuanto debe: tenerlo aca evita
                  cerrar el dialogo, buscar el extracto y volver.
                  Va ENCASILLADO como el boton de al lado —misma altura, mismo
                  radio— y en verde, para que se lea como un dato y no se
                  confunda con la accion roja que tiene pegada. */}
              <div className="flex h-8 md:h-10 items-center gap-1.5 rounded-md border border-green-600 bg-green-50 px-2 md:px-3 dark:bg-green-950/40">
                <span className="text-[10px] md:text-xs font-medium text-green-800 dark:text-green-300">
                  Saldo
                </span>
                <span className="text-xs md:text-base font-bold tabular-nums text-green-800 dark:text-green-300">
                  {fmtMoneda(noPaymentClient?.saldo)}
                </span>
              </div>
            </div>
            <Button variant="outline" onClick={() => { setNoPaymentClient(null); setNoPaymentPhoto(null) }} className="h-8 md:h-10 text-xs md:text-base">
              Cancelar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog de confirmacion: el abono supera el umbral de la ruta */}
      <Dialog open={showRevisionDialog} onOpenChange={(open) => { if (!open) handleRevisionChoice(false) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-amber-100 mx-auto mb-2">
              <AlertCircle className="h-6 w-6 text-amber-600" />
            </div>
            <DialogTitle className="text-sm md:text-lg text-center">Abono supera el umbral de la ruta</DialogTitle>
            <DialogDescription className="text-xs md:text-sm text-center">
              {MENSAJE_REVISION}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 md:gap-3 pt-2 md:pt-4">
            <Button variant="outline" onClick={() => handleRevisionChoice(false)} className="flex-1 h-8 md:h-10 text-xs md:text-base bg-transparent">Cancelar</Button>
            <Button onClick={() => handleRevisionChoice(true)} className="flex-1 h-8 md:h-10 text-xs md:text-base">Continuar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: el cobrador esta fuera del rango del cliente */}
      <Dialog open={!!geocercaBloqueo} onOpenChange={(open) => { if (!open) handleGeocercaChoice(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mx-auto mb-2">
              <MapPinOff className="h-6 w-6 text-red-600" />
            </div>
            <DialogTitle className="text-sm md:text-lg text-center">Estás fuera del rango del cliente</DialogTitle>
            <DialogDescription className="text-xs md:text-sm text-center">
              Estás a <strong>{geocercaBloqueo ? formatearDistancia(geocercaBloqueo.distancia) : ""}</strong> de donde
              quedó ubicado <strong>{geocercaBloqueo?.nombre}</strong>, y el máximo permitido en esta ruta es de{" "}
              {geocercaBloqueo?.radio} m. Si aun así necesitas registrar la gestión, escribe por qué.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="geocerca-motivo" className="text-xs md:text-sm">Motivo</Label>
            <Textarea
              id="geocerca-motivo"
              placeholder="Ej: el cliente se trasladó de local, o me pagó en otro punto"
              value={geocercaMotivo}
              onChange={(e) => setGeocercaMotivo(e.target.value)}
              className="min-h-[70px] text-xs md:text-sm"
            />
            <p className="text-[11px] md:text-xs text-muted-foreground">
              Queda registrado junto con la distancia real para que secretaría lo revise.
            </p>
          </div>
          <div className="flex gap-2 md:gap-3 pt-2">
            <Button variant="outline" onClick={() => handleGeocercaChoice(null)} className="flex-1 h-8 md:h-10 text-xs md:text-base bg-transparent">
              Cancelar
            </Button>
            <Button
              onClick={() => handleGeocercaChoice(geocercaMotivo.trim())}
              disabled={geocercaMotivo.trim().length < 10}
              className="flex-1 h-8 md:h-10 text-xs md:text-base"
            >
              Continuar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Anular una gestión del día */}
      <Dialog open={!!anularManaged} onOpenChange={(o) => { if (!o) setAnularManaged(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Anular la gestión de hoy</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {anularManaged && (
                <>
                  {anularManaged.gestionTipo === "pago"
                    ? `Se anulará el pago de $${(anularManaged.valorAbonado ?? 0).toLocaleString()} de ${anularManaged.nombre}.`
                    : `Se anulará el no pago de ${anularManaged.nombre}.`}
                  {" "}El cliente vuelve a la lista de pendientes para gestionarlo de nuevo.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <p className="text-[11px] md:text-xs text-muted-foreground">
            Nada se borra: en el historial del cliente quedan la gestión y su anulación,
            con la hora y quién la hizo.
          </p>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="flex-1 h-8 md:h-10 text-xs md:text-base"
              onClick={() => setAnularManaged(null)}
              disabled={savingManaged}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              className="flex-1 h-8 md:h-10 text-xs md:text-base"
              disabled={savingManaged}
              onClick={async () => {
                const m = anularManaged
                setAnularManaged(null)
                if (m) await handleDeleteManagedPayment(m)
              }}
            >
              {savingManaged ? <Loader2 className="h-4 w-4 animate-spin" /> : "Anular"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Renovation Dialog */}
      <Dialog open={showRenovationDialog} onOpenChange={setShowRenovationDialog}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Confirmar Renovacion</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 md:space-y-4">
            <p className="text-xs md:text-sm text-muted-foreground">
              El prestamo ha sido cancelado. Desea realizar una renovacion para el cliente{" "}
              <span className="font-semibold">{clientForRenovation?.nombre}</span>?
            </p>
          </div>
          <div className="flex gap-2 md:gap-3 pt-2 md:pt-4">
            <Button variant="outline" onClick={handleRenovationCancel} className="flex-1 h-8 md:h-10 text-xs md:text-base bg-transparent">No</Button>
            <Button onClick={handleRenovationConfirm} className="flex-1 h-8 md:h-10 text-xs md:text-base">Si, Renovar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Client Info Dialog */}
      <Dialog open={clientInfoDialogOpen} onOpenChange={(open) => { setClientInfoDialogOpen(open); if (!open) setClientInfoFetched(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Info del Cliente</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">Datos registrados en el sistema</DialogDescription>
          </DialogHeader>
          {clientInfoLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : clientInfoFetched ? (
            <div className="space-y-2">
              {[
                ["Nombre completo", clientInfoFetched.nombre_completo],
                ["Apodo", clientInfoFetched.apodo ?? "—"],
                ["Documento", clientInfoFetched.documento],
                ["Teléfono", clientInfoFetched.telefono ?? "—"],
                ["Dirección", clientInfoFetched.direccion ?? "—"],
              ].map(([label, val]) => (
                <div key={label}>
                  <p className="text-[10px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
                  <p className="text-sm md:text-base font-medium">{val}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground py-4 text-center">No se pudieron cargar los datos.</p>
          )}
        </DialogContent>
      </Dialog>

      {/* ── EXTRACTO DEL CLIENTE ──────────────────────────────────────
          Lo que se sacó de la fila para que quepan más clientes. No es una
          pantalla nueva: es la MISMA información de antes, agrupada donde se
          consulta en vez de repetida cuarenta veces donde estorba. */}
      <Dialog open={!!extractoClient} onOpenChange={(o) => { if (!o) setExtractoClient(null) }}>
        <DialogContent className="max-h-[88vh] max-w-md overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="text-base">Extracto del cliente</DialogTitle>
            <DialogDescription className="text-sm font-semibold text-foreground">
              {extractoClient?.nombreCompleto}
              {extractoClient?.apodo && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {extractoClient.apodo}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {extractoClient && (() => {
            const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`
            const fecha = (f: string) => {
              if (!f) return "—"
              const [y, m, d] = f.split("-")
              return d ? `${d}/${m}/${y}` : f
            }
            // Dos columnas, cada dato con su nombre encima. `null` en el valor
            // apaga la fila entera: una multa que no existe no merece un
            // renglón que diga "$0".
            const datos: [string, React.ReactNode][] = [
              ["Fecha de venta", fecha(extractoClient.fechaVenta)],
              ["Frecuencia", `${frecuenciaLabel(extractoClient.frecuenciaPago)}${
                extractoClient.frecuenciaPago !== "daily" && extractoClient.diaSemana
                  ? ` · ${extractoClient.diaSemana.charAt(0).toUpperCase()}${extractoClient.diaSemana.slice(1)}`
                  : ""
              }`],
              // NI "Valor prestado" NI "Interés".
              //
              // El extracto existe para que el cliente sepa CÓMO VA SU DEUDA,
              // y para eso lo que manda es el total a pagar, la cuota, lo
              // abonado y el saldo. Cuánto se prestó al principio y a qué
              // tasa ya está incorporado en el total: repetirlos solo abre
              // discusiones en la calle que no son del cobrador.
              //
              // Los dos siguen en la app donde sí hacen falta: Auditoría 360,
              // el detalle de clientes y Control Total.
              ["Total a pagar", fmt(extractoClient.totalAPagar)],
              ["Valor de cuota", fmt(extractoClient.valorCuota)],
              ["Cuotas", `${cuotasConDecimal(extractoClient.abonado, extractoClient.valorCuota, extractoClient.cuotasTotales)}/${extractoClient.cuotasTotales}`],
              ["Abonado", fmt(extractoClient.abonado)],
            ]
            return (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/30 p-3">
                  {datos.map(([k, v]) => (
                    <div key={k}>
                      <p className="text-[11px] leading-tight text-muted-foreground">{k}</p>
                      <p className="text-sm font-semibold leading-tight text-foreground tabular-nums">{v}</p>
                    </div>
                  ))}

                  {/* El saldo y el estado van aparte y más grandes: son las dos
                      cosas por las que se abre este extracto. */}
                  <div>
                    <p className="text-[11px] leading-tight text-muted-foreground">Saldo</p>
                    <p className="text-lg font-bold leading-tight text-foreground tabular-nums">
                      {fmt(extractoClient.saldo)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] leading-tight text-muted-foreground">Estado</p>
                    {/* "1 cuota" a secas no dice si es lo que lleva pagado o
                        lo que debe. Con "Mora:" delante se lee de una. */}
                    <p className={`text-lg font-bold leading-tight ${moraTexto(extractoClient.mora)}`}>
                      {extractoClient.mora > 0
                        ? `Mora: ${etiquetaMora(extractoClient.mora)}`
                        : "Al día"}
                    </p>
                  </div>

                  {extractoClient.multaPendiente && (
                    <div>
                      <p className="text-[11px] leading-tight text-muted-foreground">Multa pendiente</p>
                      <p className="text-sm font-bold leading-tight text-destructive tabular-nums">
                        {fmt(extractoClient.multaPendiente.valor)}
                      </p>
                    </div>
                  )}
                  {extractoClient.ultimoPagoFecha && (
                    <div>
                      <p className="text-[11px] leading-tight text-muted-foreground">Último pago</p>
                      <p className="text-sm font-semibold leading-tight text-foreground tabular-nums">
                        {fecha(extractoClient.ultimoPagoFecha)}
                        {extractoClient.ultimoPago > 0 && (
                          <span className="ml-1 font-normal text-muted-foreground">
                            {fmt(extractoClient.ultimoPago)}
                          </span>
                        )}
                      </p>
                    </div>
                  )}
                </div>

                {/* ACCESO DIRECTO AL HISTORIAL, como en el boceto. El
                    extracto contesta "cómo va este crédito"; el historial,
                    "qué ha pasado día por día". Son dos preguntas seguidas y
                    por eso la segunda se abre desde la primera, sin volver a
                    la lista y buscar el menú. */}
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent/40"
                  onClick={() => {
                    const c = extractoClient
                    setExtractoClient(null)
                    setPaymentHistoryClient(c)
                    setPaymentHistoryOpen(true)
                  }}
                >
                  <span className="text-sm font-semibold text-foreground">
                    Historial de pagos
                    {extractoMovimientos !== null && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        ({extractoMovimientos})
                      </span>
                    )}
                  </span>
                  <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>

                {/* COMPARTIR EL EXTRACTO.
                    Sale como imagen con el mismo encabezado del comprobante de
                    pago —logo de la ruta, título y la línea de fecha y hora—
                    para que al cliente le llegue algo que reconoce y no una
                    captura de pantalla. Lleva el resumen del crédito y los
                    movimientos, los mismos que se ven acá. */}
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => setCompartirExtracto(true)}
                >
                  <Share2 className="h-4 w-4" />
                  Compartir extracto
                </Button>
              </div>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* El compartir del extracto. Es el MISMO diálogo del cierre de caja:
          compartir, descargar o mandar al chat, con la guarda del AbortError
          cuando alguien cancela el menú nativo. */}
      {extractoClient && (
        <CompartirComprobanteDialog
          open={compartirExtracto}
          onOpenChange={setCompartirExtracto}
          construirImagen={construirImagenExtracto}
          mensajeChat={`Extracto — ${extractoClient.nombreCompleto}`}
          currentUser={{
            id: getUsuarioSesion().id ?? 0,
            nombre: getUsuarioSesion().nombre,
          }}
          titulo="Compartir el extracto"
        />
      )}

      {/* Payment History Dialog */}
      <Dialog open={paymentHistoryOpen} onOpenChange={(open) => { setPaymentHistoryOpen(open); if (!open) { setPaymentHistoryClient(null); setPaymentHistoryRows([]) } }}>
        <DialogContent className="p-4 md:p-6 max-w-[95vw] md:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Historial de Pagos</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {paymentHistoryClient?.nombre} — días con pago o no pago registrado
            </DialogDescription>
          </DialogHeader>
          {paymentHistoryLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : paymentHistoryRows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Sin registros.</p>
          ) : (
            <div className="overflow-auto max-h-[60vh]">
              {/* UNA FILA POR MOVIMIENTO, con los cuatro datos en el mismo
                  renglón: fecha, cuota, pagado y valor.

                  Estaba agrupado por día, con un encabezado con la fecha y
                  debajo las cuotas de ese día. Un crédito de veinticinco
                  cuotas eran veinticinco cajitas, y para comparar dos días
                  había que saltar entre encabezados. Con la fecha DENTRO de
                  la fila se lee de corrido y cabe el triple en la pantalla.

                  Los que no apuntan a una cuota —el abono de la venta— llevan
                  su nombre en la columna de la cuota, que es lo único que
                  tienen para decir. */}
              <table className="w-full table-fixed">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-[10px] md:text-xs text-muted-foreground">
                    {/* LA FECHA SE QUEDA CON LO JUSTO, no con un cuarto.
                        Con `w-1/4` en las otras tres, la fecha se llevaba
                        tambien 90px de 360 para un texto de 27px: sobraban 55
                        de aire a su derecha que empujaban TODO el bloque de
                        cifras hacia la izquierda. Medido en el navegador.

                        Ahora lleva 54px —lo que ocupa "12/09" con su padding—
                        y las tres columnas de plata se reparten el resto en
                        partes iguales. El ancho va por `style` y no por clase
                        de Tailwind: `w-[54px]` no se compila si esa clase no
                        existe en otra parte del proyecto, y quedaba sin
                        efecto. Comprobado a 340, 390 y 480px: las tres dan
                        exactamente el mismo ancho y el texto queda centrado
                        al pixel. */}
                    <th style={{ width: "54px" }} className="px-1 py-1.5 text-left font-semibold">Fecha</th>
                    <th style={{ width: COL_EXTRACTO }} className="px-1 py-1.5 text-center font-semibold">Cuota</th>
                    <th style={{ width: COL_EXTRACTO }} className="px-1 py-1.5 text-center font-semibold">Pagado</th>
                    {/* SALDO, no "Valor". La columna mostraba el valor de la
                        CUOTA: el mismo número en todos los renglones, que no
                        dice nada. Ahora dice con cuánto quedó el cliente
                        después de ese abono, que es lo que viene a preguntar. */}
                    <th style={{ width: COL_EXTRACTO }} className="px-1 py-1.5 text-center font-semibold">Saldo</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {paymentHistoryRows.map((m) => {
                    const esNoPago = m.tipo === "no_pago"
                    return (
                      <tr
                        key={m.id}
                        className={esNoPago ? "bg-red-50 dark:bg-red-950/30" : ""}
                      >
                        <td className="px-2 py-1.5 text-[10px] md:text-xs tabular-nums whitespace-nowrap">
                          {fechaCorta(m.fecha)}
                        </td>
                        <td className={`px-1 py-1.5 text-center text-[10px] md:text-xs truncate ${
                          esNoPago ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
                        }`}>
                          {/* SIN LA PALABRA "No pago": el $0 de la columna
                              de al lado ya lo dice, y el rojo de la fila lo
                              confirma. Repetirlo solo alargaba la celda del
                              numero de cuota, que es angosta. */}
                          {m.numeroCuota !== null
                            ? m.numeroCuota
                            : ETIQUETA_MOVIMIENTO[m.tipo]}
                        </td>
                        <td className={`px-1 py-1.5 text-center text-[10px] md:text-xs font-semibold tabular-nums ${
                          esNoPago ? "text-red-600 dark:text-red-400" : ""
                        }`}>
                          {/* UN NO PAGO DICE $0, no una raya. Mezclar un
                              guión con las cifras de la columna obliga a
                              traducir; "$0" se suma de un vistazo. */}
                          {`$${Math.round(m.pagado).toLocaleString("es-CO")}`}
                        </td>
                        <td className="px-1 py-1.5 text-center text-[10px] md:text-xs tabular-nums text-muted-foreground">
                          {m.saldoDespues !== null ? `$${Math.round(m.saldoDespues).toLocaleString("es-CO")}` : "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Managed Payment Dialog */}
      <Dialog open={!!editingManaged} onOpenChange={(open) => { if (!open) setEditingManaged(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Editar gestión — {editingManaged?.nombre}</DialogTitle>
            {/* EL SALDO, en lugar de la explicación de cómo funciona el libro.
                Esa explicación decía algo cierto —no se borra nada, se anula y
                queda la corrección— pero se lo decía a alguien que ya está
                corrigiendo y no le cambia la decisión. El saldo sí: es contra
                lo que se compara el monto que se va a escribir. */}
            <DialogDescription asChild>
              <div className="flex items-baseline gap-1.5 text-[11px] md:text-sm">
                <span className="text-muted-foreground">Saldo del cliente:</span>
                <span className="font-bold tabular-nums text-foreground">
                  {fmtMoneda(editingManaged?.saldo)}
                </span>
              </div>
            </DialogDescription>
          </DialogHeader>

          {/* Los dos estados como botones grandes y no como un desplegable:
              se usa con el pulgar y en la calle. 44px de alto es el mínimo
              para un dedo; un <select> nativo queda en 20. */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setEditTipo("pago")}
              className={`flex items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-sm font-bold transition-colors ${
                editTipo === "pago"
                  ? "border-green-500 bg-green-100 text-green-700"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              <CheckCircle2 className="h-4 w-4" />
              Pago
            </button>
            <button
              type="button"
              onClick={() => setEditTipo("no_pago")}
              className={`flex items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-sm font-bold transition-colors ${
                editTipo === "no_pago"
                  ? "border-red-500 bg-red-100 text-red-700"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              <XCircle className="h-4 w-4" />
              No pago
            </button>
          </div>

          {editTipo === "pago" ? (
            <div className="space-y-1.5">
              <label className="text-xs md:text-sm text-muted-foreground">
                {editingManaged?.gestionTipo === "pago" ? "Nuevo monto abonado" : "Monto que pagó"}
              </label>
              <Input
                type="text"
                inputMode="decimal"
                value={mostrarMonto(editMonto)}
                onChange={(e) => setEditMonto(leerMonto(e.target.value))}
                placeholder="$ 0"
                className="h-9 text-sm"
                autoFocus
              />

              {/* LA FORMA DE PAGO. Dos botones y no un desplegable: son dos
                  opciones y se resuelve de un toque, sin abrir nada. Es lo
                  mismo que hacen Pago / No pago de arriba. */}
              <label className="block pt-1 text-xs md:text-sm text-muted-foreground">Forma de pago</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setEditMetodo("efectivo")}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border-2 px-2 py-2 text-xs font-bold transition-colors ${
                    editMetodo === "efectivo"
                      ? "border-green-500 bg-green-100 text-green-700"
                      : "border-border bg-card text-muted-foreground"
                  }`}
                >
                  <DollarSign className="h-4 w-4" />
                  Efectivo
                </button>
                <button
                  type="button"
                  onClick={() => setEditMetodo("transferencia")}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border-2 px-2 py-2 text-xs font-bold transition-colors ${
                    editMetodo === "transferencia"
                      ? "border-info bg-info-light text-info"
                      : "border-border bg-card text-muted-foreground"
                  }`}
                >
                  <ArrowLeftRight className="h-4 w-4" />
                  Transferencia
                </button>
              </div>
            </div>
          ) : (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-snug text-red-700">
              Queda como visita sin pago.
              {editingManaged?.gestionTipo === "pago" &&
                ` Se anula el pago de $${(editingManaged?.valorAbonado ?? 0).toLocaleString()}.`}
            </p>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" size="sm" onClick={() => setEditingManaged(null)}>Cancelar</Button>
            <Button size="sm" onClick={handleEditManagedSave} disabled={savingManaged}>
              {savingManaged ? <Loader2 className="h-3 w-3 animate-spin" /> : "Guardar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Share Comprobante Dialog */}
      <Dialog open={showShareDialog} onOpenChange={(open) => { if (!open) cerrarShare() }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Comprobante de {clientForShare?.nombre}</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {shareTrasPago
                ? "El pago fue registrado. ¿Deseas compartir el comprobante?"
                : "Puedes compartirlo por WhatsApp, correo o cualquier app del teléfono, o descargarlo."}
            </DialogDescription>
          </DialogHeader>
          {/* VISTA PREVIA. Además de dejar ver qué se va a mandar, es la
              salida de emergencia en los iPhone viejos (iOS 14 y anteriores):
              ahí no existe `canShare({files})` Y el enlace de descarga tampoco
              funciona — Safari navega en vez de guardar. Manteniendo pulsada
              la imagen, el teléfono ofrece "Guardar imagen" y "Compartir". */}
          {reciboListo && (
            <img
              src={reciboListo.dataUrl}
              alt="Comprobante de pago"
              className="mx-auto max-h-[45vh] w-auto rounded-md border border-border"
            />
          )}
          <div className="flex flex-col gap-2 pt-2 md:pt-4">
            {/* `onClick={handleShareComprobante}` a secas: sin envolverlo en
                una función async, para que el navegador vea la llamada a
                `share()` dentro del mismo gesto del usuario. */}
            <Button
              className="h-9 md:h-10 text-xs md:text-base gap-1.5"
              disabled={sharingPdf || preparandoRecibo || !reciboListo}
              onClick={handleShareComprobante}
            >
              {preparandoRecibo || sharingPdf ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Share2 className="h-4 w-4" />
              )}
              {preparandoRecibo ? "Preparando…" : "Compartir"}
            </Button>
            <Button
              variant="outline"
              className="h-9 md:h-10 text-xs md:text-base gap-1.5"
              disabled={sharingPdf || preparandoRecibo || !reciboListo}
              onClick={() => {
                if (!reciboListo) return
                const a = document.createElement("a")
                a.href = reciboListo.dataUrl
                a.download = reciboListo.filename
                a.click()
                cerrarShare()
              }}
            >
              <FileDown className="h-4 w-4" />
              Descargar
            </Button>
            <Button
              variant="ghost"
              className="h-8 text-xs md:text-sm"
              disabled={sharingPdf}
              onClick={cerrarShare}
            >
              Cerrar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Loan History Dialog */}
      <Dialog open={loanHistoryOpen} onOpenChange={(open) => { setLoanHistoryOpen(open); if (!open) { setLoanHistoryClient(null); setLoanHistoryRows([]) } }}>
        <DialogContent className="p-4 md:p-6 max-w-[95vw] md:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Historial de Préstamos</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {loanHistoryClient?.nombre} — todos los préstamos registrados
            </DialogDescription>
          </DialogHeader>
          {loanHistoryLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : loanHistoryRows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Sin registros.</p>
          ) : (
            <div className="overflow-auto max-h-[60vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3">Fecha</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-right">Valor</TableHead>
                    {/* El % de interes vive ACA y ya no en la lista de cobro:
                        es un dato que se consulta, no que se recorre. */}
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-right">Interés</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-center">Cuotas</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-center">Frec.</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-center">Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loanHistoryRows.map((row) => {
                    const [y, m, d] = (row.fecha_creacion || "").split("-")
                    const fechaFmt = y ? `${d}/${m}/${y.slice(2)}` : "—"
                    const estadoColor = row.estado === "activo"
                      ? "text-green-600 dark:text-green-400"
                      : row.estado === "cancelado"
                      ? "text-muted-foreground"
                      : "text-yellow-600 dark:text-yellow-400"
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3">{fechaFmt}</TableCell>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3 text-right">
                          ${Math.round(row.valor).toLocaleString("es-CO")}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3 text-right tabular-nums">
                          {row.tasa_interes != null ? `${row.tasa_interes}%` : "—"}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3 text-center">{row.numero_cuotas}</TableCell>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3 text-center">{frecuenciaLabel(row.frecuencia_pago)}</TableCell>
                        <TableCell className={`text-[10px] md:text-xs px-1 md:px-3 text-center font-medium capitalize ${estadoColor}`}>
                          {row.estado}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
