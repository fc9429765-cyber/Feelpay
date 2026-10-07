"use client"

import React from "react"

import { useState, useEffect, useRef, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Barcode as BarCode, X, Loader2, UserPlus, AlertCircle, CheckCircle2, ChevronsUpDown, Check, Paperclip, Trash2, ChevronLeft, ChevronDown, User, Store, CircleDollarSign, Camera, Lock, MapPin, Info, MessageCircle, ArrowLeftRight, Shuffle, Calculator, SlidersHorizontal, LocateFixed, MapPinned } from "lucide-react"
import "./new-loan.css"
// Ya no usamos los helpers de lib/database (createClient/createLoan/
// createPaymentPlan): la creacion de venta corre ahora en una sola
// transaccion via la RPC `crear_venta_atomica` que evita los problemas
// de session vars RLS perdidas entre peticiones HTTP stateless.
import { createClient } from "@/lib/supabase/client"
import { todayColombia } from "@/lib/colombia-date"
import {
  fmtFecha, fmtMoneda, sumarDias, ayerColombia,
  AMORTIZACIONES, etiquetaAmortizacion,
  mostrarMonto,
  leerMonto,
} from "@/lib/gestion-core"
import {
  buildPaymentSchedule, redondearCuota,
  type Frecuencia, type TipoAmortizacion,
} from "@/lib/loan-schedule"
import { useToast } from "@/hooks/use-toast"
import { getRutaUmbrales, excedeUmbral, MENSAJE_REVISION, getSolicitanteNombre } from "@/lib/ruta-umbrales"
import { avisarSolicitudPendiente } from "@/lib/avisos-revision"
import { enviarOEncolar } from "@/lib/offline-queue"
import { fotoParaCola, esFotoPendiente } from "@/lib/foto-offline"
import { esErrorDeRed } from "@/lib/credenciales-offline"
import { obtenerUbicacion } from "@/lib/geo"
import dynamic from "next/dynamic"
import { CamaraEnApp } from "@/components/camara-en-app"
import { renderComprobanteImagen, type SeccionComprobante } from "@/lib/imagen-comprobante"
import { CompartirComprobanteDialog } from "@/components/compartir-comprobante-dialog"
import { getUsuarioSesion } from "@/lib/movimientos"
import { etiquetaFrecuencia } from "@/lib/gestion-core"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"

// ── Fechas del cronograma ───────────────────────────────────────────────
// En frecuencia diaria NO se cobra los domingos: la semana de cobro es de
// lunes a sabado, seis dias.
//
// La regla anterior calculaba `inicio + (i-1)` y, si caia domingo, corria
// esa cuota un dia — pero sin mover las siguientes. La cuota del domingo y
// la del lunes terminaban el MISMO dia y el cliente amanecia debiendo dos.
// Ahora la cuota i cae en el i-esimo dia de cobro, saltando los domingos de
// corrido, asi que nunca se doblan.
//
// `inicio` nunca debe ser domingo (se ajusta con `siguienteDiaDeCobro`).
function fechaCuotaDiaria(inicio: Date, i: number): Date {
  const posicionEnLaSemana = (inicio.getDay() + 6) % 7 // lunes=0 … sabado=5
  const k = i - 1
  const d = new Date(inicio)
  d.setDate(d.getDate() + k + Math.floor((posicionEnLaSemana + k) / 6))
  return d
}

/** Corre la fecha al lunes si cae domingo. Solo aplica a frecuencia diaria. */
function siguienteDiaDeCobro(d: Date, diasEntrePagos: number): Date {
  if (diasEntrePagos !== 1 || d.getDay() !== 0) return d
  const ajustada = new Date(d)
  ajustada.setDate(ajustada.getDate() + 1)
  return ajustada
}

/** Fecha de la cuota `i` (1-based) segun la frecuencia. */
function fechaDeCuota(inicio: Date, i: number, diasEntrePagos: number): Date {
  if (diasEntrePagos === 1) return fechaCuotaDiaria(inicio, i)
  const d = new Date(inicio)
  d.setDate(d.getDate() + diasEntrePagos * (i - 1))
  return d
}

/**
 * Saca el mensaje legible de un error, venga de donde venga.
 *
 * Un error de Supabase NO es un `Error` de JavaScript: es un objeto plano
 * `{ message, details, hint, code }`. Por eso el clásico
 * `err instanceof Error ? err.message : String(err)` terminaba imprimiendo
 * "[object Object]" y escondía la causa real — que era justo lo que había que
 * leer para poder arreglar el problema.
 */
function mensajeDeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === "object") {
    const e = err as { message?: string; details?: string; hint?: string }
    const partes = [e.message, e.details, e.hint].filter(Boolean)
    if (partes.length > 0) return partes.join(" — ")
  }
  const s = String(err)
  return s === "[object Object]" ? "No se pudo completar la operación" : s
}

interface AmortizationRow {
  cuota: number
  fecha: string
  saldoInicial: number
  interes: number
  capital: number
  cuotaPago: number
  saldoFinal: number
}

type Client = {
  id: string
  clientId: string
  name: string
  cedula: string
  activeLoans: number
  pendingAmount: number
  cuota: number
  paidInstallments: number
  pendingInstallments: number
  mora: number
  lastPayment: number
  lastPaymentDate: string
  installmentAmount: number
  balance: number
}

type NewLoanProps = {
  preSelectedClientId?: string | null
  currentRutaId?: number
  rutaPais?: string
  onCancel?: () => void
  /**
   * EL DÍA AL QUE PERTENECE LA VENTA (YYYY-MM-DD). Sin esto es hoy, que es lo
   * que pasa en la calle: se vende y se registra en el mismo acto.
   *
   * Control Total lo manda para registrar una venta de un día anterior — la
   * que se hizo ayer y llegó en papel hoy. NO es la fecha en que se teclea:
   * es la del reporte al que tiene que contarse, y por eso mueve también la
   * primera cuota, el abono inicial y la caja de ese día.
   */
  fechaVenta?: string
  /**
   * Quien registra es SECRETARÍA desde Control Total, no un cobrador en la
   * calle. Es una sola cosa con dos consecuencias, y por eso es una sola
   * bandera y no dos que haya que acordarse de poner juntas:
   *
   *   · LA RUTA la elige quien registra. El formulario siempre leyó
   *     `localStorage.selectedRuta` justo antes de enviar, porque en la calle
   *     la ruta de la sesión ES la ruta de la venta. Secretaría hace lo
   *     contrario: elige la de otro. Sin esto, esa venta se iría a la ruta de
   *     la secretaria.
   *
   *   · EL UMBRAL no aplica. El tope existe para que un cobrador no preste
   *     por encima sin que alguien firme, y quien firma es secretaría:
   *     mandarla a la bandeja solo crea una solicitud que ella misma aprueba
   *     dos clics después. Quien decide de verdad es el servidor
   *     (`registrar_venta`, script 079), y lo hace con el rol REAL del
   *     usuario; esta bandera sola no abre nada.
   */
  comoSecretaria?: boolean
  /** Se llama después de cada venta registrada, para refrescar lo de afuera. */
  onCreated?: () => void
}

const MapaUbicacionCliente = dynamic(() => import("@/components/mapa-ubicacion-cliente"), {
  ssr: false,
  loading: () => <div className="cv-map-loading">Cargando mapa…</div>,
})

// ── Piezas del diseño de Crear Venta (CrearVenta.jsx) ─────────────────────
// Van FUERA del componente: definidas adentro, React las vería como un
// componente nuevo en cada tecla y los campos perderían el foco al escribir.
const CvLabel = ({ children, req, opt }: { children: React.ReactNode; req?: boolean; opt?: string }) => (
  <span className="cv-label">
    {children}
    {req && <b className="cv-req">*</b>}
    {opt && <span className="cv-opt">{opt}</span>}
  </span>
)
const Candado = () => <Lock size={20} fill="#6b7480" color="#6b7480" />
const Pin = () => <MapPin size={24} fill="#1f6fe0" color="#fff" strokeWidth={1.5} />
const Seccion = ({ icon: Icono, relleno, title, children }: {
  icon: React.ElementType; relleno?: boolean; title: string; children: React.ReactNode
}) => (
  <section className="cv-section">
    <div className="cv-band">
      <Icono size={32} fill="#1f6fe0" color={relleno ? "#fff" : "#1f6fe0"} strokeWidth={1.6} />
      <h2>{title}</h2>
    </div>
    <div className="cv-section-body">{children}</div>
  </section>
)

export function NewLoan({
  preSelectedClientId, currentRutaId = 1, rutaPais = "", onCancel,
  fechaVenta, comoSecretaria = false, onCreated,
}: NewLoanProps) {
  const { toast } = useToast()
  const [rutaId] = useState<number>(currentRutaId)

  /**
   * El día de la venta, en UN solo sitio para todo el formulario.
   *
   * Todo lo que colgaba de "hoy" cuelga ahora de acá: la primera cuota, la
   * tabla de amortización que se le muestra al cliente y el día del abono
   * inicial. Si alguno se quedara en `todayColombia()`, una venta de ayer
   * nacería con el cronograma corrido un día.
   */
  const diaVenta = fechaVenta || todayColombia()
  const esRetroactiva = diaVenta !== todayColombia()
  const [isNewClient, setIsNewClient] = useState(false)
  /**
   * LA UBICACIÓN DEL CLIENTE, con PIN.
   *
   * `ubicActual` es dónde está el vendedor (GPS). `pinCliente` es lo que se
   * GUARDA como ubicación del cliente: arranca en el GPS (cliente nuevo) o en
   * la ubicación ya guardada (renovación), y el vendedor lo puede mover en el
   * mapa. `pinManual` dice que lo tocó: en una renovación es lo que autoriza a
   * CORREGIR la ubicación guardada (scripts/128); sin tocarlo, se respeta.
   */
  const [ubicActual, setUbicActual] = useState<{ lat: number; lng: number; precision: number } | null>(null)
  const [pinCliente, setPinCliente] = useState<{ lat: number; lng: number } | null>(null)
  const [pinManual, setPinManual] = useState(false)
  const [ubicGuardada, setUbicGuardada] = useState<{ lat: number; lng: number } | null>(null)
  const [buscandoGps, setBuscandoGps] = useState(false)
  const [selectedClient, setSelectedClient] = useState(preSelectedClientId || "")
  const [clientSearch, setClientSearch] = useState("")
  // Etiqueta del cliente elegido. Va aparte de `clientSearch` porque esa
  // ahora es SOLO el texto que se escribe para buscar: si se reutilizara
  // para mostrar el seleccionado, elegir un cliente dispararia una
  // busqueda nueva contra el servidor con su propio nombre.
  const [selectedClientLabel, setSelectedClientLabel] = useState("")
  const [clientPickerOpen, setClientPickerOpen] = useState(false)
  const [clientOptions, setClientOptions] = useState<{ id: string; apodo: string; nombre_completo: string; numero?: number | null; tiene_prestamo_activo?: boolean }[]>([])
  const [loadingClients, setLoadingClients] = useState(false)
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false)
  // Cuando viene de una renovación ya hay cliente preseleccionado; desactivar
  // el filtro para garantizar que aparezca sin importar tiene_prestamo_activo.
  const [soloSinPrestamo, setSoloSinPrestamo] = useState(!preSelectedClientId)


  // Contador que obliga a releer la lista de clientes.
  //
  // La lista se traia una sola vez por combinacion de busqueda/ruta/filtro, y
  // registrar una venta no cambia ninguna de esas: el cliente al que se le
  // acababa de vender seguia apareciendo como disponible, y con el filtro
  // "solo sin prestamo" encima parecia que la venta no se habia guardado.
  // Al terminar una venta se incrementa esto y la lista se vuelve a pedir.
  const [recargaClientes, setRecargaClientes] = useState(0)

  // Fetch clients by apodo filtered by ruta and optionally by tiene_prestamo_activo.
  // Usa Supabase directamente (no /api/clients). RLS eliminado: el filtrado
  // por ruta es 100% a nivel aplicacion con `.eq('ruta', currentRutaId)`.
  useEffect(() => {
    if (isNewClient) return
    setLoadingClients(true)
    const timeout = setTimeout(async () => {
      try {
        const supabase = createClient()

        let query = supabase
          .from("clients")
          .select("id, nombre_completo, apodo, documento, numero, tiene_prestamo_activo")
          .eq("ruta", rutaId)
          // EL ORDEN ES EL DEL NUMERO, que es como se pidio: el cliente se
          // llama por su numero, asi que la lista tiene que ir en ese orden.
          // `nullsFirst: false` por si algun cliente quedara sin numero: se
          // va al final en vez de encabezar la lista. Ver scripts/117.
          .order("numero", { ascending: true, nullsFirst: false })

        if (clientSearch.trim()) {
          const busca = clientSearch.trim()
          // SI ESCRIBE UN NUMERO, BUSCA POR NUMERO. El numero existe para
          // poder llamar al cliente por el —"el 14"—, asi que teclear 14
          // tiene que llevar al 14. Es exacto a proposito: con `ilike` el 14
          // traeria tambien el 140 y el 214, y el numero dejaria de servir
          // para lo unico que se invento.
          //
          // Un apodo puede ser un numero ("911"), asi que no se descarta la
          // busqueda por apodo: se piden las dos cosas con `or`.
          query = /^\d+$/.test(busca)
            ? query.or(`numero.eq.${busca},apodo.ilike.%${busca}%`)
            : query.ilike("apodo", `%${busca}%`)
        }
        if (soloSinPrestamo) {
          query = query.eq("tiene_prestamo_activo", false)
        }

        let { data, error } = await query

        // ── SI TODAVIA NO SE CORRIO EL SCRIPT 117 ──────────────────────────
        // `numero` es una columna nueva. Mientras no exista, PostgREST
        // responde 42703 y la consulta entera falla: el selector se quedaria
        // VACIO y no se podrian hacer ventas. Asi que se reintenta sin el
        // numero, con el orden viejo por apodo.
        //
        // Esto no es un adorno defensivo: la app se despliega antes de que el
        // dueño corra el script a mano, o sea que este camino SE VA A USAR.
        if (error && (error.code === "42703" || /numero/i.test(error.message))) {
          console.warn("[v0] clients.numero no existe todavia (falta scripts/117); se ordena por apodo")
          let vieja = supabase
            .from("clients")
            .select("id, nombre_completo, apodo, documento, tiene_prestamo_activo")
            .eq("ruta", rutaId)
            .order("apodo", { ascending: true })
          if (clientSearch.trim()) {
            vieja = vieja.ilike("apodo", `%${clientSearch.trim()}%`)
          }
          if (soloSinPrestamo) {
            vieja = vieja.eq("tiene_prestamo_activo", false)
          }
          const r = await vieja
          data = r.data
          error = r.error
        }

        if (error) {
          console.error("[v0] Error fetching clients (new-loan):", error.message)
          setClientOptions([])
        } else {
          setClientOptions(Array.isArray(data) ? data : [])
        }
      } catch (err) {
        console.error("[v0] Unexpected error fetching clients (new-loan):", err)
        setClientOptions([])
      } finally {
        setLoadingClients(false)
      }
    }, 300)
    return () => clearTimeout(timeout)
  }, [clientSearch, rutaId, isNewClient, soloSinPrestamo, recargaClientes])

  // Cuando el componente se abre desde el flujo de renovación, pre-carga el
  // cliente para que el Select muestre su nombre sin que el usuario tenga que buscarlo.
  useEffect(() => {
    if (!preSelectedClientId) return
    const fetchPreSelected = async () => {
      try {
        const supabase = createClient()
        let { data, error } = await supabase
          .from("clients")
          .select("id, nombre_completo, apodo, numero, tiene_prestamo_activo")
          .eq("id", preSelectedClientId)
          .maybeSingle()
        // Mismo caso que arriba: sin el script 117 la columna no existe. Sin
        // este reintento la renovacion abriria con el nombre en blanco.
        if (error && (error.code === "42703" || /numero/i.test(error.message))) {
          const r = await supabase
            .from("clients")
            .select("id, nombre_completo, apodo, tiene_prestamo_activo")
            .eq("id", preSelectedClientId)
            .maybeSingle()
          data = r.data
        }
        if (data) {
          setClientOptions([data])
          setSelectedClientLabel((data.apodo || data.nombre_completo).toUpperCase())
        }
      } catch (err) {
        console.error("[v0] Error pre-cargando cliente para renovacion:", err)
      }
    }
    fetchPreSelected()
  }, [preSelectedClientId])

  const [isCreating, setIsCreating] = useState(false)
  const [cedulaImage, setCedulaImage] = useState<string | null>(null)
  const [documento, setDocumento] = useState("")
  const [nombreCompleto, setNombreCompleto] = useState("")
  const [apodo, setApodo] = useState("")
  /**
   * EL SEGUNDO APODO, y con cual de los dos se ve ESTE prestamo.
   *
   * Un cliente puede conocerse de dos formas —"KIOSKO" y "LA ESQUINA"— y no
   * siempre por la misma en todos sus creditos. `apodo2` se guarda en el
   * cliente; `apodoElegido` se guarda en el prestamo y dice cual de los dos
   * usar. Ver scripts/107.
   */
  const [apodo2, setApodo2] = useState("")
  const [apodoElegido, setApodoElegido] = useState<1 | 2>(1)
  /**
   * LA DIRECCIÓN DE RESIDENCIA, aparte de la Dirección.
   *
   * "Dirección" es donde se le cobra (el negocio, casi siempre). La de
   * residencia es donde VIVE, la que trae impresa el respaldo del documento:
   * se llena sola al leerlo y se guarda en `clients.direccion_residencia`
   * (scripts/122). Es opcional.
   */
  const [direccionResidencia, setDireccionResidencia] = useState("")
  /**
   * EL DISEÑO NUEVO DE CREAR VENTA (scripts/124).
   *   · Dirección de DOMICILIO, si es diferente de la del DNI.
   *   · Foto del LOCAL: opcional, se sube al elegirla.
   *   · Venta MIXTA: cuánto va en efectivo y cuánto por transferencia.
   *   · El modal de la simulación de amortización.
   */
  const [direccionDomicilio, setDireccionDomicilio] = useState("")
  const [fotoLocalUrl, setFotoLocalUrl] = useState<string | null>(null)
  const [subiendoFotoLocal, setSubiendoFotoLocal] = useState(false)
  const [ventaEfectivo, setVentaEfectivo] = useState("")
  const [ventaTransferencia, setVentaTransferencia] = useState("")
  const [showSimulacion, setShowSimulacion] = useState(false)
  const [procesandoCedula, setProcessandoCedula] = useState(false)
  /**
   * LEER LA DIRECCIÓN DEL RESPALDO DE LA CÉDULA.
   *
   * Opcional, con un check: al activarlo aparece un segundo botón para
   * fotografiar el respaldo del documento, se lee el domicilio y se escribe
   * en el campo Dirección de residencia (no en Dirección, que es donde se le
   * cobra). Sigue siendo editable: lo que lee la IA es una propuesta.
   *
   * La foto del respaldo NO se guarda: solo se usa para leer la dirección.
   */
  const [leerDireccion, setLeerDireccion] = useState(false)
  /**
   * LA CÁMARA DENTRO DE LA APP (components/camara-en-app.tsx). Con la cámara
   * del teléfono, Android cerraba la app en los celulares con poca memoria y
   * la venta se perdía. Cada foto dice a qué input y a qué manejador va.
   */
  const [camara, setCamara] = useState<null | { titulo: string; inputId: string; destino: "cedula" | "reverso" | "local" | "evidencia" }>(null)
  const [procesandoRespaldo, setProcesandoRespaldo] = useState(false)
  const [pagoAdelantado, setPagoAdelantado] = useState(false)
  // Por defecto el plan arranca MAÑANA (regla de negocio de siempre). Con
  // esto marcado arranca HOY, el mismo dia de la venta.
  const [iniciaPagosHoy, setIniciaPagosHoy] = useState(false)

  // ── Condiciones especiales ───────────────────────────────────────────────
  // "Inicia pagos hoy" y "Venta homologada" son la excepción, no lo normal:
  // la mayoría de las ventas arrancan mañana y no vienen de otro sistema. Los
  // dos recuadros estaban siempre a la vista, en medio del formulario, y hay
  // que leerlos en cada venta para confirmar que NO van marcados.
  //
  // Al apagar esto se limpian LAS DOS opciones (ver el manejador del check).
  // Esconderlas dejándolas activas sería lo peor de los dos mundos: la venta
  // saldría con condiciones que ya no se ven en pantalla.
  const [condicionesEspeciales, setCondicionesEspeciales] = useState(false)


  // ── Venta homologada ─────────────────────────────────────────────────────
  // Para cargar créditos que ya venían corriendo en otro sistema: se elige la
  // fecha real en que arrancó y se marca, día por día, qué pagó y qué no.
  // Con eso el saldo, la mora y el X/Y quedan exactos al día de hoy, en vez
  // de tener que "inventar" un préstamo nuevo por el saldo que quedaba.
  const [ventaHomologada, setVentaHomologada] = useState(false)
  const [fechaInicioHomologada, setFechaInicioHomologada] = useState("")
  // Marcas por número de cuota: qué pasó ese día y cuánto entró.
  const [marcasHomologacion, setMarcasHomologacion] = useState<
    Record<number, { tipo: "pago" | "no_pago"; monto: string }>
  >({})
  // Cuotas del cronograma que NO se cargan al historial. La lista automática
  // asume que el crédito se pagó al ritmo pactado, y no siempre fue así: a
  // veces conviene borrarla toda y dejar un solo pago consolidado. Quitar una
  // fila no crea ningún evento para ese día — es distinto de marcarla
  // "No pagó", que sí deja constancia de que se visitó y no entró plata.
  const [cuotasOmitidas, setCuotasOmitidas] = useState<Set<number>>(new Set())
  // Pagos que no caen en una fecha del cronograma: el cliente abonó días
  // seguidos, o con montos que no son la cuota. Fecha y monto libres.
  // El `id` es solo la llave de React: un contador y no un UUID, porque
  // `crypto.randomUUID` no existe si se entra por http (la IP de la LAN).
  const [pagosManuales, setPagosManuales] = useState<
    { id: number; fecha: string; monto: string }[]
  >([])
  const proximoIdPagoManual = useRef(1)
  const [numeroCuotas, setNumeroCuotas] = useState(1)
  const [otroValor, setOtroValor] = useState(false)
  const [valorPago, setValorPago] = useState("")
  const [prestamoEmpleado, setPrestamoEmpleado] = useState(false)
  const [telefono, setTelefono] = useState("")
  // EL COMPROBANTE DE LA TRANSFERENCIA. Se sube al mismo Vercel Blob que las
  // fotos de cedula y los logos, y la URL viaja con la venta (scripts/115).
  // Se guarda la URL y no el archivo: la imagen ya vive en la bodega, y
  // mandar el binario dentro del payload de la venta lo haria enorme.
  const [indicativo, setIndicativo] = useState("+57")
  const [comprobanteUrl, setComprobanteUrl] = useState<string | null>(null)
  const [subiendoComprobante, setSubiendoComprobante] = useState(false)
  const [telefono2, setTelefono2] = useState("")
  // ── Campos antes no controlados que ahora se persisten en estado para
  //    poder validar "obligatoriedad" y resaltar errores en la UI. ──
  const [direccion, setDireccion] = useState("")
  const [tipoComercio, setTipoComercio] = useState("")
  // Set de claves con errores de campo obligatorio. Se llena cuando el
  // usuario intenta enviar y faltan datos; cada Input/Select consulta este
  // set para pintar borde rojo. Se limpia automaticamente cuando el campo
  // recibe un valor valido (efecto controlado por el onChange).
  const [formErrors, setFormErrors] = useState<Set<string>>(new Set())
  // Banners persistentes en la cabecera del formulario:
  // - `formAlert` muestra "Faltan datos obligatorios" cuando la validacion
  //   bloquea el submit (queda visible hasta que el usuario empieza a
  //   corregir el primer campo en error).
  // - `successAlert` muestra el mensaje de exito tras crear la venta y se
  //   auto-oculta a los 5 segundos.
  // Estos avisos complementan los toasts existentes para que el usuario
  // vea el feedback aunque el toast haya desaparecido.
  const [formAlert, setFormAlert] = useState<string | null>(null)
  const [successAlert, setSuccessAlert] = useState<string | null>(null)
  // Dialog modal de confirmacion de venta exitosa. El usuario lo debe
  // cerrar explicitamente con "Aceptar" para no perderse el feedback.
  const [successDialog, setSuccessDialog] = useState<{ open: boolean; msg: string }>({
    open: false,
    msg: "",
  })
  /**
   * EL RECIBO DE LA VENTA (07-oct-2026). Se toma una foto de los datos ANTES
   * de limpiar el formulario, y desde el diálogo de éxito se comparte como
   * imagen, igual que el recibo de pago. No hay recibo de una venta que quedó
   * en revisión: todavía no es una venta.
   */
  const [reciboVenta, setReciboVenta] = useState<DatosReciboVenta | null>(null)
  const [compartirRecibo, setCompartirRecibo] = useState(false)
  // Dialog modal para campos faltantes. Muestra la lista de campos
  // pendientes de forma central y explicita.
  const [errorDialog, setErrorDialog] = useState<{ open: boolean; fields: string[] }>({
    open: false,
    fields: [],
  })
  // Toast pill flotante (mismo patron que register-transaction.tsx):
  // aparece en la parte inferior de la pantalla con fondo verde y
  // desaparece automaticamente a los 3 segundos.
  const [toastPill, setToastPill] = useState<string | null>(null)
  const showToastPill = (msg: string) => {
    setToastPill(msg)
    setTimeout(() => setToastPill(null), 3000)
  }
  // Dialog de confirmacion cuando la venta supera el umbral de la ruta
  // (nueva o renovacion, configurado por secretaria). Se resuelve via
  // Promise para poder "pausar" handleCreateVenta hasta que el usuario
  // decida, sin duplicar toda la logica de construccion de p_cliente/p_loan.
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
  // Helper: marca/desmarca un campo en formErrors. Permite que el onChange
  // de cada input limpie el resaltado tan pronto el usuario corrige.
  /**
   * SUBIR EL COMPROBANTE DE LA TRANSFERENCIA.
   *
   * Va al mismo `/api/upload-photo` que el resto de imagenes de la app. Se
   * sube AL ELEGIRLO y no al guardar la venta: si la subida falla, el
   * vendedor se entera ahi mismo y puede reintentar, en vez de perder todo
   * el formulario al final.
   *
   * No bloquea la venta: si no se pudo subir, se avisa y la venta se puede
   * registrar igual sin comprobante. Es un respaldo, no un requisito.
   */
  const handleComprobante = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Se limpia el input para que elegir el MISMO archivo dos veces seguidas
    // vuelva a disparar el onChange.
    e.target.value = ""
    if (!file) return

    if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
      toast({
        title: "Formato no compatible",
        description: "Sube una imagen (JPG o PNG) o un PDF.",
        variant: "destructive",
      })
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Archivo muy pesado",
        description: "El comprobante no puede pasar de 10 MB.",
        variant: "destructive",
      })
      return
    }

    setSubiendoComprobante(true)
    // SIN SEÑAL LA FOTO SE GUARDA EN EL TELÉFONO y sube con la venta cuando
    // vuelva la red (lib/foto-offline.ts). Sin esto ninguna venta se podía
    // hacer sin señal: la evidencia es obligatoria y nunca terminaba de subir.
    const guardarSinSenal = async () => {
      setComprobanteUrl(await fotoParaCola(file))
      toast({ title: "Foto guardada sin señal", description: "Se sube sola con la venta cuando vuelva la conexión." })
    }
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await guardarSinSenal()
        return
      }
      const fd = new FormData()
      fd.append("file", file)
      fd.append("folder", `comprobantes/${currentRutaId}`)
      const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? "No se pudo subir el comprobante")
      setComprobanteUrl(json.url)
      toast({ title: "Comprobante cargado", description: "Queda guardado con la venta." })
    } catch (err) {
      console.error("[v0] Error subiendo el comprobante:", err)
      if (esErrorDeRed(err)) {
        try {
          await guardarSinSenal()
          return
        } catch (e2) {
          err = e2
        }
      }
      toast({
        title: "No se pudo subir",
        description: err instanceof Error ? err.message : "Intenta de nuevo",
        variant: "destructive",
      })
    } finally {
      setSubiendoComprobante(false)
    }
  }

  /** LA FOTO DEL LOCAL. Opcional; se sube al elegirla, como el comprobante. */
  const handleFotoLocal = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast({ title: "Formato no compatible", description: "Sube una foto (JPG o PNG).", variant: "destructive" })
      return
    }
    setSubiendoFotoLocal(true)
    try {
      // Sin señal se guarda en el teléfono, como la evidencia.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setFotoLocalUrl(await fotoParaCola(file))
        return
      }
      const fd = new FormData()
      fd.append("file", file)
      fd.append("folder", `locales/${currentRutaId}`)
      const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? "No se pudo subir la foto")
      setFotoLocalUrl(json.url)
    } catch (err) {
      console.error("[v0] Error subiendo la foto del local:", err)
      if (esErrorDeRed(err)) {
        try {
          setFotoLocalUrl(await fotoParaCola(file))
          return
        } catch { /* se avisa abajo */ }
      }
      toast({
        title: "No se pudo subir la foto del local",
        description: err instanceof Error ? err.message : "Intenta de nuevo",
        variant: "destructive",
      })
    } finally {
      setSubiendoFotoLocal(false)
    }
  }

  const clearFieldError = (field: string) =>
    setFormErrors((prev) => {
      // Cuando el usuario corrige un campo, ocultamos tambien el banner
      // global de error si seguia visible — asi el aviso desaparece tan
      // pronto el usuario empieza a actuar en respuesta al feedback.
      if (formAlert) setFormAlert(null)
      if (!prev.has(field)) return prev
      const next = new Set(prev)
      next.delete(field)
      return next
    })
  // Clase utilitaria que devuelve el borde rojo si el campo esta en error.
  // Se concatena al className existente para conservar estilos base.
  const errCls = (field: string) =>
    formErrors.has(field) ? "border-red-500 focus-visible:ring-red-500" : ""
  const [telefonoError, setTelefonoError] = useState("")
  const [telefono2Error, setTelefono2Error] = useState("")

  /**
   * CUANTOS DIGITOS TIENE UN CELULAR EN CADA PAIS.
   *
   * Los cinco de la operacion, como se pidieron:
   *
   *   Argentina  11      Colombia  10      Ecuador  10
   *   Brasil     10      Paraguay  10
   *
   * Los demas quedan de antes. La clave va en MINUSCULAS porque en la base
   * conviven "Argentina" y "ARGENTINA" —se comprobo: 4 rutas con una forma y
   * 2 con la otra— y la busqueda normaliza antes de mirar.
   */
  const phoneDigitsByCountry: Record<string, number> = {
    argentina: 11,
    colombia: 10,
    ecuador: 10,
    brasil: 10,
    brazil: 10,
    paraguay: 10,
    // Los demas del desplegable. No se pidieron, pero si una opcion existe
    // tiene que tener su numero: sin esto, elegir Mexico o EE. UU. caia al
    // valor por defecto de 10 sin que nadie lo hubiera decidido.
    peru: 9,
    perú: 9,
    chile: 9,
    venezuela: 10,
    méxico: 10,
    mexico: 10,
    "ee. uu.": 10,
    españa: 9,
  }

  /**
   * CUANDO EL CAMPO `pais` DE LA RUTA NO ES UN PAIS.
   *
   * La ruta 204 tiene "BUENOS AIRES" —una ciudad— en la columna del pais. Sin
   * esto caeria al valor por defecto de 10 digitos, cuando en Argentina son
   * 11, y el vendedor no podria registrar un celular valido.
   *
   * Se resuelve aca y no arreglando el dato porque el dato lo escribe quien
   * crea la unidad: manana puede aparecer otra ciudad. Corregir la ruta 204 en
   * la configuracion sigue siendo lo ideal; esto es la red debajo.
   */
  const CIUDADES_A_PAIS: Record<string, string> = {
    "buenos aires": "argentina",
    "la plata": "argentina",
    chaco: "argentina",
    rosario: "argentina",
    cordoba: "argentina",
    "córdoba": "argentina",
    quito: "ecuador",
    guayaquil: "ecuador",
    cuenca: "ecuador",
    ibarra: "ecuador",
    riobamba: "ecuador",
    rioamba: "ecuador",
    asuncion: "paraguay",
    "asunción": "paraguay",
    cali: "colombia",
    bogota: "colombia",
    "bogotá": "colombia",
    medellin: "colombia",
    "medellín": "colombia",
  }

  /**
   * INDICATIVO DEL PAIS AL QUE PERTENECE EL NUMERO.
   *
   * No se deduce del pais de la ruta: una ruta de Colombia puede tener un
   * cliente con celular de Venezuela o de Ecuador, y ese es justo el caso que
   * se pidio cubrir. El pais de la ruta solo decide cual viene ELEGIDO por
   * defecto — la mayoria de las veces acierta y nadie toca nada.
   *
   * Se guarda pegado al numero (`+57 3001234567`) y no en una columna aparte:
   * `clients.telefono` es texto y ya lo admite, y asi el numero viaja completo
   * a donde sea que se lea —el recibo, la lista, WhatsApp— sin que cada
   * pantalla tenga que volver a juntarlo.
   */
  const INDICATIVOS: { codigo: string; pais: string }[] = [
    { codigo: "+57", pais: "Colombia" },
    { codigo: "+54", pais: "Argentina" },
    { codigo: "+593", pais: "Ecuador" },
    { codigo: "+595", pais: "Paraguay" },
    { codigo: "+51", pais: "Perú" },
    { codigo: "+56", pais: "Chile" },
    { codigo: "+58", pais: "Venezuela" },
    { codigo: "+55", pais: "Brasil" },
    { codigo: "+52", pais: "México" },
    { codigo: "+1", pais: "EE. UU." },
    { codigo: "+34", pais: "España" },
  ]

  const indicativoPorPais: Record<string, string> = {
    colombia: "+57",
    argentina: "+54",
    ecuador: "+593",
    paraguay: "+595",
    peru: "+51",
    perú: "+51",
    chile: "+56",
    venezuela: "+58",
    brasil: "+55",
    brazil: "+55",
  }

  /**
   * LOS DIGITOS LOS MANDA EL INDICATIVO ELEGIDO, no la ruta.
   *
   * La ruta solo decide cual indicativo viene puesto por defecto. A partir de
   * ahi manda lo que la persona SELECCIONA: si a un cliente de una ruta
   * argentina se le pone +57, el numero pasa a pedir los 10 digitos de
   * Colombia en el mismo momento. Antes los digitos se quedaban clavados en
   * los de la ruta y el numero correcto se marcaba como invalido.
   *
   * El pais sale de `INDICATIVOS`, que ya empareja cada codigo con su nombre:
   * asi no hay una segunda lista de codigos que se pueda desincronizar.
   */
  const paisDelIndicativo = INDICATIVOS.find((i) => i.codigo === indicativo)?.pais ?? ""

  const requiredPhoneDigits =
    phoneDigitsByCountry[paisDelIndicativo.toLowerCase()] ?? 10

  // El indicativo arranca en el del pais de la ruta. Se hace en un efecto y
  // no al crear el estado porque `rutaPais` llega despues del primer render.
  useEffect(() => {
    // Misma traduccion de ciudad a pais que los digitos: si no, la ruta 204
    // ("BUENOS AIRES") se quedaria sin indicativo por defecto.
    const clave = rutaPais.trim().toLowerCase()
    const porDefecto =
      indicativoPorPais[clave] ?? indicativoPorPais[CIUDADES_A_PAIS[clave] ?? ""]
    if (porDefecto) setIndicativo(porDefecto)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rutaPais])

  /**
   * CAMBIAR EL INDICATIVO CAMBIA LOS DIGITOS QUE SE PIDEN.
   *
   * Y hay que arreglar lo que ya estaba escrito, o el formulario queda
   * mintiendo de dos formas:
   *
   *   1. Un numero de 11 digitos al pasar a un pais de 10 se queda con uno de
   *      mas. El `maxLength` del campo NO recorta lo ya tecleado — solo
   *      impide seguir escribiendo— asi que hay que recortarlo a mano.
   *   2. El error viejo ("debe tener 11 digitos") se queda en pantalla
   *      aunque el numero ya sea valido para el pais nuevo.
   *
   * Se recalculan los digitos aca en vez de leer `requiredPhoneDigits`
   * porque ese valor todavia tiene el indicativo ANTERIOR: el estado de React
   * no se actualiza hasta el siguiente render.
   */
  const cambiarIndicativo = (codigo: string) => {
    setIndicativo(codigo)

    const pais = INDICATIVOS.find((i) => i.codigo === codigo)?.pais ?? ""
    const digitos = phoneDigitsByCountry[pais.toLowerCase()] ?? 10

    const ajustar = (
      valor: string,
      setValor: (v: string) => void,
      setError: (v: string) => void,
    ) => {
      const limpio = valor.replace(/\D/g, "").slice(0, digitos)
      if (limpio !== valor) setValor(limpio)
      setError(
        limpio.length > 0 && limpio.length !== digitos
          ? `El teléfono debe tener ${digitos} dígitos (${pais})`
          : "",
      )
    }

    ajustar(telefono, setTelefono, setTelefonoError)
    ajustar(telefono2, setTelefono2, setTelefono2Error)
  }

  const validatePhone = (value: string, field: "tel1" | "tel2") => {
    const digits = value.replace(/\D/g, "")
    if (digits.length > 0 && digits.length !== requiredPhoneDigits) {
      // El pais del INDICATIVO elegido, no el de la ruta: si el numero es
      // colombiano en una ruta argentina, decir "(Argentina)" confunde.
      const msg = `El teléfono debe tener ${requiredPhoneDigits} dígitos (${paisDelIndicativo || rutaPais || "país no definido"})`
      if (field === "tel1") setTelefonoError(msg)
      else setTelefono2Error(msg)
      return false
    }
    if (field === "tel1") setTelefonoError("")
    else setTelefono2Error("")
    return true
  }

  const [valor, setValor] = useState("")
  const [saldo, setSaldo] = useState("")
  const [valorAPagar, setValorAPagar] = useState("")
  const [valorCuota, setValorCuota] = useState("")
  const [tasaInteres, setTasaInteres] = useState("")
  const [dias, setDias] = useState("")
  const [tipoAmortizacion, setTipoAmortizacion] = useState("")
  const [tipoVenta, setTipoVenta] = useState("efectivo")
  const [cuentaId, setCuentaId] = useState<string>("")
  const [cuentas, setCuentas] = useState<{ id: string; nombre: string }[]>([])
  const [loadingCuentas, setLoadingCuentas] = useState(false)

  // Fetch cuentas filtered by ruta when tipoVenta = transferencia
  useEffect(() => {
    if (tipoVenta !== "transferencia") return
    setLoadingCuentas(true)
    fetch(`/api/cuentas?ruta=${rutaId}`)
      .then((r) => r.json())
      .then((data) => setCuentas(Array.isArray(data) ? data : []))
      .catch(() => setCuentas([]))
      .finally(() => setLoadingCuentas(false))
  }, [tipoVenta, rutaId])
  // Frecuencia de pago: queda VACIA por defecto; el usuario debe elegir
  // explicitamente una opcion antes de poder generar el plan o registrar
  // la venta. La validacion en `handleGenerarPlanPago` y en el submit
  // bloquean continuar si esta en "".
  const [frecuenciaPago, setFrecuenciaPago] = useState("")
  const [diaSemana, setDiaSemana] = useState("")
  // `enrutar_venta` se eliminó: la columna no existe en la base y el estado
  // nunca tuvo un input que lo cambiara, así que siempre viajaba vacío.
  const [amortizacionTable, setAmortizacionTable] = useState<AmortizationRow[]>([])
  const [showAmortization, setShowAmortization] = useState(false)

  // ── Métodos de interés que usa esta unidad ───────────────────────────────
  // Los define secretaría por ruta. Si no hay configuración, se ofrecen los
  // dos (comportamiento de siempre).
  const [amortizacionesRuta, setAmortizacionesRuta] = useState<string[]>(["aleman", "americano"])
  const [amortizacionDefaultRuta, setAmortizacionDefaultRuta] = useState("")

  /**
   * ¿Esta unidad exige fotografiar la cédula para un cliente nuevo?
   *
   * Arranca en `true` —como se comportó siempre la app— y `getRutaUmbrales`
   * también falla cerrada. Así, mientras la respuesta no llegue o si no llega
   * nunca, el formulario sigue pidiendo la cédula: aflojar la regla por una
   * consulta lenta sería aflojarla por accidente.
   */
  const [cedulaObligatoria, setCedulaObligatoria] = useState(true)

  /**
   * ¿Esta unidad permite venderle otra vez a quien ya tiene un credito?
   *
   * Arranca en `false` y `getRutaUmbrales` tambien falla cerrada: mientras la
   * respuesta no llegue —o si no llega nunca— el formulario se comporta como
   * siempre, mostrando solo a los clientes sin credito activo. Un permiso que
   * se concede solo porque una consulta tardo no es un permiso.
   */
  const [multiplesPrestamos, setMultiplesPrestamos] = useState(false)

  /**
   * Cuándo el documento y el nombre están bajo llave.
   *
   * Sin foto y con la cédula exigida, los llena SOLO el escaneo. Con la foto
   * ya tomada se abren aunque la unidad la exija: el escaneo lee mal a menudo
   * —foto borrosa, reflejo, cédula cortada— y la app ya prometía en dos
   * mensajes distintos que en ese caso se podían "escribir a mano", con los
   * campos en readOnly. Era una promesa que no se podía cumplir; ahora sí, y
   * la foto sigue ahí como respaldo de lo que se escriba.
   */
  /**
   * LO QUE LEYÓ LA IA NO SE TOCA. Si el documento o el nombre salieron de la
   * foto de la cédula, quedan bloqueados: lo que se guarda es lo que dice el
   * documento, no lo que alguien escriba encima. Lo que la foto NO alcanzó a
   * leer queda abierto para escribirlo. Cambiar la foto los libera.
   */
  const [docLeidoIA, setDocLeidoIA] = useState(false)
  const [nombreLeidoIA, setNombreLeidoIA] = useState(false)
  const datosBloqueados = cedulaObligatoria && !cedulaImage
  const docBloqueado = datosBloqueados || docLeidoIA
  const nombreBloqueado = datosBloqueados || nombreLeidoIA
  useEffect(() => {
    let cancelado = false
    getRutaUmbrales(rutaId)
      .then((u) => {
        if (cancelado) return
        setAmortizacionesRuta(u.amortizaciones_habilitadas)
        setAmortizacionDefaultRuta(u.amortizacion_default ?? "")
        setCedulaObligatoria(u.cedula_obligatoria)
        setMultiplesPrestamos(u.multiples_prestamos)
      })
      .catch((err) => console.error("[v0] NewLoan umbrales error:", err))
    return () => { cancelado = true }
  }, [rutaId])
  /**
   * CON EL PERMISO PUESTO, EL FILTRO SE APAGA SOLO.
   *
   * `soloSinPrestamo` arranca marcado, asi que sin esto el vendedor de una
   * ruta que YA tiene el permiso seguiria sin ver a esos clientes hasta que se
   * acordara de destildar una casilla. La configuracion de la unidad es la que
   * manda; la casilla queda como un filtro de busqueda, no como la regla.
   */
  useEffect(() => {
    if (multiplesPrestamos) setSoloSinPrestamo(false)
  }, [multiplesPrestamos])

  const amortizacionesDisponibles = useMemo(
    () => AMORTIZACIONES.filter((a) => amortizacionesRuta.includes(a.valor)),
    [amortizacionesRuta],
  )

  /**
   * Con qué método arranca el formulario: el predeterminado de la unidad, o
   * el único habilitado si solo hay uno. Vacío obliga al vendedor a elegir.
   */
  const amortizacionInicial = useMemo(() => {
    if (amortizacionDefaultRuta) return amortizacionDefaultRuta
    return amortizacionesRuta.length === 1 ? amortizacionesRuta[0] : ""
  }, [amortizacionDefaultRuta, amortizacionesRuta])

  // Se aplica al cargar la config Y despues de cada venta.
  //
  // Antes esto vivia dentro del fetch, que solo corre al cambiar de ruta,
  // mientras que `resetForm` dejaba el metodo en "". Resultado: de la segunda
  // venta en adelante el campo quedaba vacio. Con el selector a la vista se
  // notaba; con el campo oculto (unidad de un solo metodo) seria un error de
  // validacion sobre algo que el vendedor no puede ver ni corregir.
  useEffect(() => {
    if (!amortizacionInicial) return
    setTipoAmortizacion((prev) => prev || amortizacionInicial)
  }, [amortizacionInicial, tipoAmortizacion])

  // ── Cuotas que ya vencieron en una venta homologada ─────────────────────
  // Se calculan con la MISMA fórmula del servidor (lib/loan-schedule.ts es
  // espejo de `generar_cronograma`), así que lo que se marca aquí es
  // exactamente lo que quedará en el plan.
  const cuotasHomologacion = useMemo(() => {
    if (!ventaHomologada || !fechaInicioHomologada) return []
    const valorNum = Number.parseFloat(valor)
    const nCuotas = Number.parseInt(dias)
    const tasaNum = prestamoEmpleado ? 0 : Number.parseFloat(tasaInteres)
    if (!(valorNum > 0) || !(nCuotas >= 1)) return []
    if (!prestamoEmpleado && (!tipoAmortizacion || Number.isNaN(tasaNum))) return []
    if (!prestamoEmpleado && !frecuenciaPago) return []
    try {
      const { schedule } = buildPaymentSchedule({
        valor: valorNum,
        tasaInteres: tasaNum,
        numeroCuotas: nCuotas,
        frecuenciaPago: (prestamoEmpleado ? "daily" : frecuenciaPago) as Frecuencia,
        tipoAmortizacion: (prestamoEmpleado ? "empleado" : tipoAmortizacion) as TipoAmortizacion,
        prestamoEmpleado,
        fechaInicio: fechaInicioHomologada,
        diaSemana: diaSemana || null,
      })
      // Hasta AYER, no hasta hoy: la homologación carga la HISTORIA del
      // crédito. La cuota de hoy queda pendiente para gestionarse en la ruta
      // como la de cualquier otro cliente — si se pudiera marcar aquí, el
      // cliente nacería ya gestionado y desaparecería de la lista del día.
      return schedule.filter((r) => r.fecha_pago <= ayerColombia())
    } catch (e) {
      console.warn("[v0] No se pudo simular el cronograma homologado:", e)
      return []
    }
  }, [
    ventaHomologada, fechaInicioHomologada, valor, dias, tasaInteres,
    tipoAmortizacion, frecuenciaPago, prestamoEmpleado, diaSemana,
  ])

  // Las que de verdad se van a cargar: el cronograma menos las quitadas.
  const cuotasVigentes = useMemo(
    () => cuotasHomologacion.filter((c) => !cuotasOmitidas.has(c.numero_cuota)),
    [cuotasHomologacion, cuotasOmitidas],
  )

  // Marca efectiva de una cuota: lo que eligió el usuario, o "pagó completo"
  // por defecto (el caso normal al homologar es que venía al día).
  const marcaDe = (numeroCuota: number, valorCuota: number) =>
    marcasHomologacion[numeroCuota] ?? { tipo: "pago" as const, monto: String(valorCuota) }

  const resumenHomologacion = useMemo(() => {
    let pagado = 0
    let noPagos = 0
    for (const c of cuotasVigentes) {
      const m = marcaDe(c.numero_cuota, c.valor_cuota)
      if (m.tipo === "pago") pagado += Number.parseFloat(m.monto) || 0
      else noPagos += 1
    }
    for (const p of pagosManuales) pagado += Number.parseFloat(p.monto) || 0
    return { pagado, noPagos, cuotas: cuotasVigentes.length + pagosManuales.length }
  }, [cuotasVigentes, marcasHomologacion, pagosManuales])

  /**
   * La cuota, escrita sin decimales cuando es redonda.
   *
   * `toFixed(2)` a secas ponía "20000.00" en el campo aunque la cuota ya
   * fuera un número cerrado, que es justo lo que se pidió quitar. Los
   * decimales solo aparecen cuando de verdad los hay — el americano, donde la
   * cuota es el interés del período y no se redondea.
   */
  const comoTexto = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

  // Auto-calculate Saldo (Valor a Pagar) y valor de cuota.
  // - Empleado: sin interes, saldo = valor.
  // - Aleman: interes total unico → saldo = valor + (valor * tasa).
  // - Americano: interes plano por periodo → cada cuota paga (valor * tasa)
  //   y la ultima cuota suma el capital. Saldo total = valor + (valor * tasa * numCuotas).
  useEffect(() => {
    const valorNum = Number.parseFloat(valor)
    if (!valorNum || isNaN(valorNum)) {
      setValorAPagar("")
      setValorCuota("")
      return
    }

    if (prestamoEmpleado) {
      // No interest for employee loans
      setValorAPagar(valorNum.toFixed(2))
      const diasNum = Number.parseInt(dias)
      if (diasNum > 0) setValorCuota(comoTexto(redondearCuota(valorNum / diasNum, valorNum, diasNum)))
      else setValorCuota("")
      return
    }

    const tasaNum = Number.parseFloat(tasaInteres) / 100
    // Se distingue "todavia no escribio nada" de "escribio 0". Antes bastaba
    // con `!tasaNum`, y como 0 es falso, una venta al 0% dejaba el saldo y la
    // cuota en blanco: parecia que el formulario no respondia.
    if (tasaInteres.trim() === "" || isNaN(tasaNum)) {
      setValorAPagar("")
      setValorCuota("")
      return
    }

    const diasNum = Number.parseInt(dias)

    if (tipoAmortizacion === "americano" && diasNum > 0) {
      // Interes plano por periodo: cada cuota intermedia paga valor*tasa,
      // la ultima cuota paga valor*tasa + capital. Total a pagar incluye
      // todos los intereses acumulados.
      const interesPorPeriodo = valorNum * tasaNum
      const valorTotal = valorNum + interesPorPeriodo * diasNum
      setValorAPagar(valorTotal.toFixed(2))
      // El "valor de cuota" mostrado es el de las cuotas intermedias (solo interes).
      // La ultima cuota sera mayor porque incluye el capital.
      setValorCuota(interesPorPeriodo.toFixed(2))
      return
    }

    // Aleman (o cuando aun no se elige tipoAmortizacion): saldo = valor + (valor*tasa)
    const valorTotal = valorNum + valorNum * tasaNum
    setValorAPagar(valorTotal.toFixed(2))
    if (diasNum > 0) setValorCuota(comoTexto(redondearCuota(valorTotal / diasNum, valorTotal, diasNum)))
    else setValorCuota("")
  }, [valor, tasaInteres, dias, prestamoEmpleado, tipoAmortizacion])

  // Mock cuota value - this would come from loan calculation
  const cuotaValue = 50000

  /** Lo más largo que puede quedar la foto guardada. */
  const MAX_LADO_CEDULA = 1200

  /**
   * La foto de la cédula, comprimida ANTES de tocar nada más.
   *
   * ESTO ES LO QUE CERRABA LA APP EN IPHONE. El camino anterior era:
   * `readAsDataURL` sobre la foto → una cadena de varios MB → al estado de
   * React → `<img>` que la decodifica para la vista previa → `new Image()`
   * que la decodifica OTRA VEZ a tamaño completo para comprimirla. Medido
   * sobre las fotos que quedaron guardadas en la base: 6.738 KB en base64
   * cada una, o sea ~5 MB de foto y unos 12 megapíxeles al decodificar.
   * Sumado, eso se pasa del presupuesto de memoria de una pestaña en un
   * teléfono y Safari la mata sin decir nada — lo que el cobrador ve es que
   * "se cerró el sistema".
   *
   * Ahora se trabaja desde el `File` y nunca existe la cadena gigante.
   *
   * `createImageBitmap` con `resizeWidth` decodifica Y reescala en un solo
   * paso, sin pasar por el bitmap de tamaño completo: es el camino barato.
   * No todos los navegadores aceptan esas opciones, así que si falla se cae al
   * de siempre — pero con un objectURL, que tampoco crea la cadena.
   */
  const comprimirFoto = async (file: File): Promise<string> => {
    const alLienzo = (
      fuente: CanvasImageSource, ancho: number, alto: number,
    ): string | null => {
      const escala = Math.min(1, MAX_LADO_CEDULA / Math.max(ancho, alto))
      const w = Math.max(1, Math.round(ancho * escala))
      const h = Math.max(1, Math.round(alto * escala))
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d")
      if (!ctx) return null
      ctx.drawImage(fuente, 0, 0, w, h)
      return canvas.toDataURL("image/jpeg", 0.7)
    }

    // Camino barato.
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(file, {
          resizeWidth: MAX_LADO_CEDULA,
          resizeQuality: "medium",
        })
        const salida = alLienzo(bmp, bmp.width, bmp.height)
        bmp.close()
        if (salida) return salida
      } catch {
        /* el navegador no acepta las opciones: se sigue por el otro camino */
      }
    }

    // Respaldo: objectURL en vez de base64. Decodifica a tamaño completo, que
    // es caro, pero al menos no se suma la cadena de varios MB.
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error("No se pudo leer la foto"))
        i.src = url
      })
      const salida = alLienzo(img, img.naturalWidth, img.naturalHeight)
      if (!salida) throw new Error("No se pudo preparar la foto")
      return salida
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /**
   * Cuánto se espera al escaneo antes de darlo por perdido.
   *
   * El servidor se toma hasta 60s (`maxDuration` en la ruta). Acá se corta
   * antes, a 45: sin un tope, una red que se cae a mitad dejaba la promesa
   * colgada para siempre, el botón en "Procesando…" y al cobrador sin forma
   * de salir de ahí más que recargando la app.
   */
  const ESPERA_CEDULA_MS = 45000

  /** La foto del respaldo: se lee el domicilio y va a Dirección de residencia. */
  const handleRespaldoCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    const control = new AbortController()
    const reloj = setTimeout(() => control.abort(), ESPERA_CEDULA_MS)
    try {
      setProcesandoRespaldo(true)
      const foto = await comprimirFoto(file)
      const response = await fetch("/api/escanear-cedula", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: foto, modo: "direccion" }),
        signal: control.signal,
      })
      const texto = await response.text()
      let datos: { direccion?: string; error?: string; details?: string }
      try {
        datos = JSON.parse(texto)
      } catch {
        throw new Error(`Respuesta inválida del servidor: ${texto.substring(0, 100)}`)
      }
      if (!response.ok) throw new Error(datos.details || datos.error || "Error desconocido")

      const dir = String(datos.direccion ?? "").replace(/\s+/g, " ").trim().toUpperCase()
      if (!dir) {
        toast({
          title: "No se encontró la dirección",
          description: "Vuelve a tomar la foto del respaldo bien enfocada y sin reflejos, o escribe la dirección de residencia a mano.",
          variant: "destructive",
        })
        return
      }
      setDireccionResidencia(dir)
      toast({ title: "Dirección de residencia leída", description: "Revísala en su campo y corrígela si hace falta." })
    } catch (error) {
      const abortado = error instanceof DOMException && error.name === "AbortError"
      toast({
        title: abortado ? "La lectura tardó demasiado" : "No se pudo leer la dirección",
        description: abortado
          ? "Revisa la señal e intenta de nuevo."
          : error instanceof Error ? error.message : "Error desconocido",
        variant: "destructive",
      })
    } finally {
      clearTimeout(reloj)
      setProcesandoRespaldo(false)
    }
  }

  const handleCedulaCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // El input se limpia para que volver a elegir LA MISMA foto dispare el
    // evento otra vez. Sin esto, un reintento sobre el mismo archivo no hace
    // nada y parece que el botón se colgó.
    e.target.value = ""
    if (!file) return

    const control = new AbortController()
    const reloj = setTimeout(() => control.abort(), ESPERA_CEDULA_MS)
    try {
      setProcessandoCedula(true)

      // SE COMPRIME PRIMERO Y SOLO ENTONCES SE GUARDA.
      //
      // La foto comprimida es la ÚNICA que existe de acá en adelante: la que
      // se ve en la vista previa y la que se manda a la base al guardar la
      // venta. Antes se guardaba la original de ~5 MB, y esa foto viajaba
      // entera en el payload de la venta y quedaba en `clients`. Ver el
      // comentario de `comprimirFoto`.
      const foto = await comprimirFoto(file)
      setCedulaImage(foto)

      const response = await fetch("/api/escanear-cedula", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: foto }),
        signal: control.signal,
      })

      const responseText = await response.text()

      let responseData
      try {
        responseData = JSON.parse(responseText)
      } catch {
        throw new Error(`Respuesta inválida del servidor: ${responseText.substring(0, 100)}`)
      }

      if (!response.ok) {
        throw new Error(responseData.details || responseData.error || "Error desconocido")
      }

      const doc = String(responseData.numero_documento ?? "").trim().toUpperCase()
      const nom = String(responseData.nombre_completo ?? "").trim().toUpperCase()

      // LA IA CONTESTÓ, PERO SIN LEER NADA.
      //
      // Esto es lo que se reportaba como "no carga sus datos": con una foto
      // borrosa, con reflejo o cortada, el modelo devuelve el JSON vacío, la
      // ruta responde 200 tal cual, y acá se escribían dos cadenas vacías en
      // los campos. Ni error ni aviso: la pantalla simplemente no hacía nada
      // y no había forma de saber por qué.
      //
      // La foto NO se borra: sirve igual como respaldo, y así se pueden
      // escribir los datos a mano sin tener que volver a fotografiar.
      if (!doc && !nom) {
        toast({
          title: "No se pudo leer la cédula",
          description:
            "La foto quedó guardada. Vuelve a tomarla bien enfocada, sin reflejos y con la cédula completa dentro del cuadro — o escribe los datos a mano en los campos de abajo, que ya quedaron abiertos.",
          variant: "destructive",
        })
        return
      }

      setDocumento(doc)
      setNombreCompleto(nom)
      setDocLeidoIA(!!doc)
      setNombreLeidoIA(!!nom)

      // Leyó a medias. Se pone lo que vino y se dice qué falta, en vez de
      // dejar que la persona descubra sola el campo vacío.
      if (!doc || !nom) {
        toast({
          title: "Se leyó solo una parte",
          description: `Falta ${!doc ? "el número de documento" : "el nombre"}. Complétalo a mano.`,
        })
      }
    } catch (error) {
      const abortado = error instanceof DOMException && error.name === "AbortError"
      toast({
        title: abortado ? "El escaneo tardó demasiado" : "Error al procesar la cédula",
        description: abortado
          ? "Revisa la señal e intenta de nuevo. La foto quedó guardada."
          : error instanceof Error
            ? error.message
            : "Error desconocido",
        variant: "destructive",
      })
      // La foto se conserva a propósito: borrarla obligaba a repetir la
      // captura por un problema que casi siempre es de red, no de la foto.
    } finally {
      clearTimeout(reloj)
      setProcessandoCedula(false)
    }
  }

  const clearCedulaImage = () => {
    setCedulaImage(null)
    setDocumento("")
    setNombreCompleto("")
    setDocLeidoIA(false)
    setNombreLeidoIA(false)
  }

  const calcularAmortizacion = () => {
    const valorPrestamo = Number.parseFloat(valor)
    // El campo `dias` esta etiquetado como "Numero de cuotas" en la UI, por lo
    // que se interpreta como el numero total de cuotas a generar (no como
    // dias totales del prestamo). Esto mantiene la simulacion consistente
    // con handleCreateVenta, que tambien usa `dias` como numero de cuotas.
    const numeroCuotas = Number.parseInt(dias)
    // El día de la venta, no el de hoy: la tabla que se le muestra al cliente
    // tiene que ser la misma que se va a guardar.
    const todayStr = diaVenta
    const [y, m, d] = todayStr.split("-").map(Number)
    const fechaInicioCruda = new Date(y, m - 1, d + (iniciaPagosHoy ? 0 : 1))

    if (!valorPrestamo || !numeroCuotas) {
      alert("Por favor complete los campos de valor y número de cuotas")
      return
    }

    if (!prestamoEmpleado && (!tasaInteres || !tipoAmortizacion || !frecuenciaPago)) {
      alert("Por favor complete todos los campos requeridos")
      return
    }
    if (frecuenciaPago === "weekly" && !diaSemana) {
      alert("Para frecuencia Semanal debe seleccionar el día de cobro")
      return
    }

    // `numeroCuotas` ya es el numero total de pagos. Solo necesitamos calcular
    // la distancia (en dias) entre pagos segun la frecuencia.
    const numeroPagos = numeroCuotas
    let diasEntrePagos = 1

    if (!prestamoEmpleado) {
      switch (frecuenciaPago) {
        case "weekly":    diasEntrePagos = 7;  break
        case "biweekly":  diasEntrePagos = 15; break
        case "monthly":   diasEntrePagos = 30; break
        default:          diasEntrePagos = 1
      }
    }

    // La previsualizacion tiene que salir IDENTICA al plan que se guarda:
    // antes esta tabla no aplicaba la regla de domingos y el cobrador le
    // mostraba al cliente unas fechas y se guardaban otras.
    const fechaInicio = siguienteDiaDeCobro(fechaInicioCruda, diasEntrePagos)

    const schedule: AmortizationRow[] = []

    if (prestamoEmpleado) {
      // Employee loan: no interest, divide valor evenly by number of installments (daily)
      // La cuota en números cerrados, y la ÚLTIMA absorbe el residuo para que
      // la suma siga dando el total. Es la misma regla del servidor
      // (`redondear_cuota`, script 087) y de `lib/loan-schedule.ts`.
      const cuotaDiaria = redondearCuota(valorPrestamo / numeroCuotas, valorPrestamo, numeroCuotas)
      for (let i = 1; i <= numeroCuotas; i++) {
        const fechaPago = fechaDeCuota(fechaInicio, i, diasEntrePagos)
        const esUltima = i === numeroCuotas
        const cuota = esUltima
          ? Math.round((valorPrestamo - cuotaDiaria * (numeroCuotas - 1)) * 100) / 100
          : cuotaDiaria
        schedule.push({
          cuota: i,
          fecha: fechaPago.toLocaleDateString("es-ES"),
          saldoInicial: Math.round((valorPrestamo - cuotaDiaria * (i - 1)) * 100) / 100,
          interes: 0,
          capital: cuota,
          cuotaPago: cuota,
          saldoFinal: Math.round(Math.max(0, valorPrestamo - cuotaDiaria * (i - 1) - cuota) * 100) / 100,
        })
      }
    } else {
      const tasa = Number.parseFloat(tasaInteres) / 100
      if (tipoAmortizacion === "americano") {
        // Interes plano por periodo: cada cuota paga valor*tasa de intereses,
        // la ultima cuota incluye ademas el capital completo. El saldo
        // inicial/final refleja capital + intereses pendientes por pagar.
        // Ej: valor=100, tasa=10%, 10 cuotas → $10 interes c/u, capital $100 al final.
        const interesPorPeriodo = valorPrestamo * tasa
        const interesRound = Math.round(interesPorPeriodo * 100) / 100
        for (let i = 1; i <= numeroPagos; i++) {
          const fechaPago = fechaDeCuota(fechaInicio, i, diasEntrePagos)
          const esUltimaCuota = i === numeroPagos
          const capitalCuota = esUltimaCuota ? valorPrestamo : 0
          const cuotaPago = interesRound + capitalCuota
          // Intereses que aun faltan por pagar al inicio de esta cuota:
          // si quedan k cuotas (incluyendo esta), faltan k * interes.
          const cuotasRestantesInicio = numeroPagos - i + 1
          const cuotasRestantesFinal = numeroPagos - i
          const saldoInicial = valorPrestamo + interesRound * cuotasRestantesInicio
          const saldoFinal = esUltimaCuota ? 0 : valorPrestamo + interesRound * cuotasRestantesFinal
          schedule.push({
            cuota: i,
            fecha: fechaPago.toLocaleDateString("es-ES"),
            saldoInicial: Math.round(saldoInicial * 100) / 100,
            interes: interesRound,
            capital: Math.round(capitalCuota * 100) / 100,
            cuotaPago: Math.round(cuotaPago * 100) / 100,
            saldoFinal: Math.round(saldoFinal * 100) / 100,
          })
        }
      } else if (tipoAmortizacion === "aleman") {
        // Cuota fija simple: el saldo total ya incluye intereses (valor + valor*tasa)
        // cuota = saldoTotal / numCuotas  →  siempre igual
        const saldoTotal = valorPrestamo + valorPrestamo * tasa
        // Números cerrados, con la última absorbiendo el residuo: la misma
        // regla del servidor (`redondear_cuota`, script 087).
        const cuotaFija = redondearCuota(saldoTotal / numeroPagos, saldoTotal, numeroPagos)
        const cuotaUltima = Math.round((saldoTotal - cuotaFija * (numeroPagos - 1)) * 100) / 100
        const interesTotal = valorPrestamo * tasa
        const interesPorCuota = Math.round((interesTotal / numeroPagos) * 100) / 100
        const capitalPorCuota = Math.round((valorPrestamo / numeroPagos) * 100) / 100
        let saldoRestante = saldoTotal
        for (let i = 1; i <= numeroPagos; i++) {
          const fechaPago = fechaDeCuota(fechaInicio, i, diasEntrePagos)
          const esUltima = i === numeroPagos
          const cuota = esUltima ? cuotaUltima : cuotaFija
          const saldoInicial = Math.round(saldoRestante * 100) / 100
          saldoRestante = Math.max(0, saldoRestante - cuota)
          schedule.push({
            cuota: i,
            fecha: fechaPago.toLocaleDateString("es-ES"),
            saldoInicial,
            interes: interesPorCuota,
            capital: esUltima ? Math.round((cuota - interesPorCuota) * 100) / 100 : capitalPorCuota,
            cuotaPago: cuota,
            saldoFinal: Math.round(saldoRestante * 100) / 100,
          })
        }
      }
    }

    setAmortizacionTable(schedule)
    setShowAmortization(true)
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value)
  }

  // Limpieza del formulario tras registrar una venta. Se usa en los tres
  // caminos de salida: creacion directa, envio a revision por umbral, y
  // guardado en la cola cuando no hay conexion.
  // Limpia SOLO los datos del cliente. Se usa al elegir otro cliente, donde
  // los valores del prestamo que el cobrador ya digito deben conservarse.
  const limpiarDatosCliente = () => {
    setDocumento("")
    setNombreCompleto("")
    setApodo("")
    setDireccionResidencia("")
    setDireccionDomicilio("")
    setDocLeidoIA(false)
    setNombreLeidoIA(false)
    setFotoLocalUrl(null)
    setTelefono("")
    setTelefono2("")
    setTelefonoError("")
    setTelefono2Error("")
    setDireccion("")
    setTipoComercio("")
    setCedulaImage(null)
  }

  // El GPS al abrir el formulario: es el punto azul y el pin de arranque.
  const leerGps = async (moverPin: boolean) => {
    setBuscandoGps(true)
    try {
      const pos = await obtenerUbicacion()
      const aqui = { lat: pos.latitud, lng: pos.longitud, precision: pos.precision }
      setUbicActual(aqui)
      if (moverPin) {
        setPinCliente({ lat: aqui.lat, lng: aqui.lng })
        setPinManual(true)
      } else {
        setPinCliente((prev) => prev ?? { lat: aqui.lat, lng: aqui.lng })
      }
    } catch (err) {
      console.warn("[v0] Crear Venta sin GPS:", err)
      if (moverPin) {
        toast({ title: "Sin ubicación", description: "No se pudo leer el GPS. Pon el pin tocando el mapa.", variant: "destructive" })
      }
    } finally {
      setBuscandoGps(false)
    }
  }
  useEffect(() => { void leerGps(false) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // RENOVACIÓN: el pin arranca en la ubicación que el cliente YA tiene.
  useEffect(() => {
    if (isNewClient || !selectedClient) { setUbicGuardada(null); return }
    let vigente = true
    void createClient()
      .from("clients").select("latitud, longitud").eq("id", selectedClient).maybeSingle()
      .then(({ data }: { data: unknown }) => {
        if (!vigente) return
        const c = data as { latitud: number | null; longitud: number | null } | null
        const g = c?.latitud != null && c?.longitud != null ? { lat: Number(c.latitud), lng: Number(c.longitud) } : null
        setUbicGuardada(g)
        setPinManual(false)
        setPinCliente(g ?? (ubicActual ? { lat: ubicActual.lat, lng: ubicActual.lng } : null))
      })
    return () => { vigente = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClient, isNewClient])

  const moverPin = (lat: number, lng: number) => {
    setPinCliente({ lat, lng })
    setPinManual(true)
  }

  /** El mapa con el pin. Lo usan el cliente nuevo y la renovación. */
  const bloqueMapa = (
    <div className="cv-field cv-span-2">
      <div className="cv-map">
        <div className="cv-map-inner">
          <MapaUbicacionCliente pin={pinCliente} actual={ubicActual} onPin={moverPin} />
        </div>
      </div>
      <div className="cv-map-foot">
        <span className="cv-hint" style={{ paddingLeft: 0 }}>
          {pinCliente
            ? `Pin: ${pinCliente.lat.toFixed(6)}, ${pinCliente.lng.toFixed(6)}${
                pinManual ? " · puesto a mano" : !isNewClient && ubicGuardada ? " · ubicación guardada" : " · tu ubicación actual"
              }`
            : buscandoGps ? "Buscando tu ubicación…" : "Toca el mapa para poner el pin del cliente."}
          {ubicActual && ` · precisión ±${Math.round(ubicActual.precision)} m`}
        </span>
        <button type="button" className="cv-reverso" onClick={() => void leerGps(true)} disabled={buscandoGps}>
          {buscandoGps ? <Loader2 size={16} className="animate-spin" /> : <LocateFixed size={16} />}
          Usar mi ubicación actual
        </button>
      </div>
      <span className="cv-hint">Arrastra el pin rojo o toca el mapa para marcar dónde está el cliente.</span>
    </div>
  )

  const resetFormularioVenta = () => {
    // La ubicación vuelve a la del vendedor: el pin era de ESTE cliente.
    setPinManual(false)
    setUbicGuardada(null)
    setPinCliente(ubicActual ? { lat: ubicActual.lat, lng: ubicActual.lng } : null)
    setLeerDireccion(false)
    // La evidencia es de ESTA venta: si quedara, la siguiente salía con la
    // foto de la anterior.
    setComprobanteUrl(null)
    setVentaEfectivo("")
    setVentaTransferencia("")
    setShowSimulacion(false)
    setValor("")
    setSaldo("")
    setValorAPagar("")
    setValorCuota("")
    setTasaInteres("")
    setDias("")
    // Vuelve al metodo de la unidad, no a vacio: si la ruta usa uno solo el
    // campo esta oculto y nadie podria volver a elegirlo.
    setTipoAmortizacion(amortizacionInicial)
    setFrecuenciaPago("")
    setDiaSemana("")
    setAmortizacionTable([])
    setShowAmortization(false)
    setPagoAdelantado(false)
    setIniciaPagosHoy(false)
    setCondicionesEspeciales(false)
    setVentaHomologada(false)
    setFechaInicioHomologada("")
    setMarcasHomologacion({})
    setNumeroCuotas(1)
    setOtroValor(false)
    setValorPago("")
    setPrestamoEmpleado(false)
    setSelectedClient("")
    setSelectedClientLabel("")
    setClientSearch("")
    setClientSearch("")
    limpiarDatosCliente()
    setFormErrors(new Set())
    // `tiene_prestamo_activo` ya cambio en la base: hay que volver a pedir la
    // lista para que el cliente recien vendido salga de las opciones.
    setRecargaClientes((n) => n + 1)
  }

  // Candado de re-entrada. `disabled={isCreating}` en el boton no alcanza:
  // solo aplica despues del re-render, y un doble toque rapido en el celular
  // vuelve a entrar antes de eso — creando dos ventas.
  const creandoVentaRef = useRef(false)

  const handleCreateVenta = async () => {
    if (creandoVentaRef.current) {
      console.warn("[v0] Venta ya en curso: se ignora el segundo envio")
      return
    }
    creandoVentaRef.current = true
    try {
      setIsCreating(true)

      // ── Validacion de campos requeridos ───────────────────────────────
      // Construimos un set con los IDs de los campos faltantes para poder
      // resaltarlos individualmente en la UI (cada Input/SelectTrigger
      // consulta `formErrors.has(<id>)` via el helper `errCls`).
      //
      // Campos obligatorios (segun regla de negocio):
      // - Cliente NUEVO: apodo, telefono, direccion, tipoComercio,
      //   nombreCompleto (auto desde cedula). El sector y la referencia ya
      //   no se piden en la venta (a pedido del dueño).
      // - Cliente EXISTENTE: solo se valida que se haya seleccionado
      // - Datos del prestamo: valor, dias (nro cuotas), frecuenciaPago
      //   (+ tasaInteres y tipoAmortizacion si NO es prestamo empleado)
      // Mapa de IDs de campo → etiqueta legible para el usuario. Se usa
      // tanto en el banner de error como en el toast para que el mensaje
      // sea especifico en lugar de generico.
      const fieldLabels: Record<string, string> = {
        documento: "Documento",
        nombreCompleto: "Nombre completo",
        apodo: "Apodo",
        telefono: "Teléfono",
        direccion: "Dirección",
        tipoComercio: "Nombre del establecimiento",
        amount: "Valor del préstamo",
        dias: "Número de cuotas",
        frequency: "Frecuencia de pago",
        diaSemana: "Día de cobro (obligatorio para frecuencia Semanal)",
        tasaInteres: "Tasa de interés",
        tipoAmortizacion: "Método de interés",
        evidencia: "Evidencia de entrega del crédito (foto)",
        mixto: "Valores en efectivo y transferencia (deben sumar el valor)",
      }

      const errors = new Set<string>()
      if (isNewClient) {
        // El documento SIEMPRE hizo falta —es NOT NULL en `clients`, y único
        // dentro de la ruta desde el script 095—, pero no estaba en esta lista
        // porque no había forma de teclearlo: o lo llenaba el escaneo o no
        // había venta. Ahora que se puede escribir, se valida y se resalta
        // como cualquier otro campo.
        if (!documento.trim()) errors.add("documento")
        if (!nombreCompleto.trim()) errors.add("nombreCompleto")
        if (!apodo.trim()) errors.add("apodo")
        if (!telefono.trim()) errors.add("telefono")
        if (!direccion.trim()) errors.add("direccion")
        if (!tipoComercio.trim()) errors.add("tipoComercio")
        // LAS REFERENCIAS YA NO SON OBLIGATORIAS.
        //
        // La base nunca las exigio —las tres columnas aceptan NULL— y el
        // requisito se estaba esquivando igual: de 338 clientes solo 69 (20%)
        // tienen la referencia llena, o sea que en la calle se escribe
        // cualquier cosa para poder seguir. Un campo obligatorio que se llena
        // con basura es peor que uno opcional vacio: ensucia el dato y no
        // protege nada.
        //
        // Los campos siguen ahi y se guardan cuando se llenan.
      }
      if (!valor || Number.parseFloat(valor) <= 0) errors.add("amount")
      if (!dias || Number.parseInt(dias) <= 0) errors.add("dias")
      if (!frecuenciaPago) errors.add("frequency")
      if (frecuenciaPago === "weekly" && !diaSemana) errors.add("diaSemana")
      if (!prestamoEmpleado) {
        if (!tasaInteres) errors.add("tasaInteres")
        if (!tipoAmortizacion) errors.add("tipoAmortizacion")
      }
      // LA EVIDENCIA ES OBLIGATORIA EN TODA VENTA (decisión del dueño): en
      // efectivo, la foto entregando el dinero; en transferencia, el
      // comprobante. Se guarda en `comprobante_url`.
      if (!comprobanteUrl) errors.add("evidencia")
      // MIXTA: las dos partes con plata, y entre las dos el valor exacto.
      if (tipoVenta === "mixto") {
        const ef = Number.parseFloat(ventaEfectivo) || 0
        const tr = Number.parseFloat(ventaTransferencia) || 0
        if (ef <= 0 || tr <= 0 || Math.round(ef + tr) !== Math.round(Number.parseFloat(valor) || 0)) {
          errors.add("mixto")
        }
      }

      if (errors.size > 0) {
        setFormErrors(errors)
        const missingNames = [...errors].map((id) => fieldLabels[id] ?? id)
        // Dialog modal con lista de campos faltantes
        setErrorDialog({ open: true, fields: missingNames })
        // Banner persistente en cabecera como respaldo visual
        setFormAlert(missingNames.join("||"))
        setSuccessAlert(null)
        return
      }
      // Limpiar errores previos si la validacion paso.
      setFormErrors(new Set())
      setFormAlert(null)

      // ── Construir p_cliente (nuevo vs existente) ──────────────────────
      // Si es cliente nuevo validamos sus campos y armamos el payload
      // completo; si es existente, solo enviamos `is_new: false` y `id`.
      let p_cliente: Record<string, unknown>
      if (isNewClient) {
        // Sin conexion no se pueden crear clientes nuevos. Eran dos motivos y
        // ahora queda uno, que es el que de verdad pesa: `clients.documento`
        // es UNIQUE, asi que dos cobradores sin senal pueden registrar a la
        // misma persona y el segundo en sincronizar se choca con la llave y se
        // queda con la venta trabada. El otro motivo —que el escaneo necesita
        // el servidor— ya no aplica en las unidades que apagaron la cedula
        // obligatoria, pero levantar el bloqueo por eso es otra decision, con
        // su propio riesgo, y no se toma de pasada aca.
        //
        // Las renovaciones a clientes existentes si funcionan offline.
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          toast({
            title: "Sin conexión",
            description:
              "No se pueden registrar clientes nuevos sin internet. Puedes hacer ventas a clientes que ya existen, o esperar a tener señal.",
            variant: "destructive",
          })
          return
        }
        // Con la cédula exigida, el documento vacío no es un descuido: es que
        // no se tomó la foto, y los campos están bajo llave hasta que se tome.
        // Decir "complete los datos" mandaba a la persona a un campo que no la
        // dejaba escribir.
        if (cedulaObligatoria && !cedulaImage) {
          toast({
            title: "Falta la foto de la cédula",
            description:
              "En esta unidad el documento y el nombre se llenan fotografiando la cédula. Toma la foto para continuar.",
            variant: "destructive",
          })
          return
        }
        if (!documento || !nombreCompleto) {
          toast({
            title: "Error",
            description: "Por favor complete los datos del cliente",
            variant: "destructive",
          })
          return
        }
        if (telefono && telefono.replace(/\D/g, "").length !== requiredPhoneDigits) {
          toast({
            title: "Teléfono inválido",
            description: `El teléfono debe tener exactamente ${requiredPhoneDigits} dígitos para ${rutaPais || "el país configurado"}`,
            variant: "destructive",
          })
          return
        }
        if (telefono2 && telefono2.replace(/\D/g, "").length !== requiredPhoneDigits) {
          toast({
            title: "Teléfono 2 inválido",
            description: `El teléfono 2 debe tener exactamente ${requiredPhoneDigits} dígitos para ${rutaPais || "el país configurado"}`,
            variant: "destructive",
          })
          return
        }
        p_cliente = {
          is_new: true,
          // Se normaliza acá porque ahora hay dos orígenes: el escaneo, que ya
          // devolvía todo en mayúsculas y sin espacios sobrantes, y el
          // teclado, que no. Sin esto "12345 " y "12345" serían dos clientes
          // distintos y la llave única no atraparía el duplicado.
          documento: documento.trim().toUpperCase(),
          nombre_completo: nombreCompleto.trim().toUpperCase(),
          apodo: apodo || null,
          apodo_2: apodo2.trim() || null,
          direccion_residencia: direccionResidencia || null,
          // Donde vive si no es la del DNI, y la foto del local (scripts/124).
          direccion_domicilio: direccionDomicilio.trim().toUpperCase() || null,
          foto_local_url: fotoLocalUrl,
          // El numero viaja COMPLETO, con su indicativo. Sin el, un celular de
          // otro pais no se puede marcar desde la ruta.
          telefono: telefono ? `${indicativo} ${telefono}` : null,
          telefono2: telefono2 || null,
          // Datos adicionales obligatorios capturados en el formulario
          // (antes se enviaban como null porque eran inputs no controlados).
          direccion: direccion || null,
          tipo_comercio: tipoComercio || null,
          cedula_image_url: cedulaImage || null,
        }
      } else {
        if (!selectedClient) {
          toast({
            title: "Error",
            description: "Por favor seleccione un cliente",
            variant: "destructive",
          })
          return
        }
        // En un cliente que ya existe tambien se puede agregar o corregir el
        // segundo apodo desde acá: es el mismo formulario y no tiene sentido
        // mandarlo a otra pantalla solo para eso. Vacio = no se toca.
        p_cliente = { is_new: false, id: selectedClient, apodo_2: apodo2.trim() || null }
      }

      // ── Calculos de amortizacion (se preservan tal cual) ──────────────
      const valorNum = Number.parseFloat(valor)
      const tasaNum = Number.parseFloat(tasaInteres) / 100
      const numeroCuotasNum = Number.parseInt(dias)

      // Total a pagar segun el tipo:
      // - Empleado: solo el capital
      // - Americano: capital + intereses planos por cada cuota (valor*tasa*N)
      // - Aleman: capital + interes total unico (valor*tasa)
      // Si el usuario ya tiene un valorAPagar calculado por el useEffect lo usamos,
      // pero recalculamos como respaldo para americano para garantizar consistencia.
      let valorAPagarNum: number
      if (prestamoEmpleado) {
        valorAPagarNum = valorNum
      } else if (tipoAmortizacion === "americano") {
        valorAPagarNum = valorNum + valorNum * tasaNum * numeroCuotasNum
      } else {
        valorAPagarNum = valorAPagar ? Number.parseFloat(valorAPagar) : valorNum + valorNum * tasaNum
      }
      // Para americano la "cuota" tipica es solo el interes; para aleman es el
      // promedio, ya redondeado a números cerrados con la misma regla que usa
      // el servidor al generar el cronograma (`redondear_cuota`, script 087).
      // Sin esto, `loans.valor_cuota` guardaba 216.666,67 mientras el plan
      // llevaba cuotas cerradas: dos números distintos para lo mismo.
      const valorCuotaNum =
        tipoAmortizacion === "americano" && !prestamoEmpleado
          ? valorNum * tasaNum
          : redondearCuota(valorAPagarNum / numeroCuotasNum, valorAPagarNum, numeroCuotasNum)

      // Calculate days between payments based on frequency
      let diasEntrePagos = 1
      if (!prestamoEmpleado) {
        switch (frecuenciaPago) {
          case "weekly": diasEntrePagos = 7; break
          case "biweekly": diasEntrePagos = 15; break
          case "monthly": diasEntrePagos = 30; break
          default: diasEntrePagos = 1
        }
      }

      // ── Fecha de la primera cuota ─────────────────────────────────────
      // REGLA DE NEGOCIO: por defecto el plan inicia al día siguiente de la
      // venta. Con "Inicia pagos hoy" arranca el mismo día. En una venta
      // homologada arranca el día real en que arrancó en el otro sistema.
      //
      // El CRONOGRAMA ya no se arma aquí: lo genera el servidor con
      // `generar_cronograma` (script 045). Antes esta matemática vivía en
      // tres copias distintas —dos en este archivo y una en la librería—
      // y divergían entre sí.
      const hoyStr = diaVenta
      const fechaPrimerPago = ventaHomologada && fechaInicioHomologada
        ? fechaInicioHomologada
        : sumarDias(hoyStr, iniciaPagosHoy ? 0 : 1)

      // ── Historial de la venta homologada ──────────────────────────────
      // Un evento por cada día ya vencido: qué pagó y qué no. El servidor
      // los aplica como gestiones con origen 'homologacion' — cuentan para
      // el saldo y la mora, pero NO entran en la caja de esos días (esa
      // plata se recibió en el sistema anterior).
      // A las cuotas del cronograma (menos las quitadas) se suman los pagos
      // manuales. Al servidor le da igual de dónde salga cada fila: acepta
      // cualquier {fecha, tipo, monto} con fecha <= hoy, sin cruzarla contra
      // el cronograma.
      const historial = ventaHomologada
        ? [
            ...cuotasVigentes.map((c) => {
              const m = marcaDe(c.numero_cuota, c.valor_cuota)
              return {
                fecha: c.fecha_pago,
                tipo: m.tipo,
                monto: m.tipo === "pago" ? Number.parseFloat(m.monto) || 0 : 0,
              }
            }),
            ...pagosManuales.map((p) => ({
              fecha: p.fecha,
              tipo: "pago" as const,
              monto: Number.parseFloat(p.monto) || 0,
            })),
          ]
        : []

      if (ventaHomologada) {
        if (!fechaInicioHomologada) {
          toast({
            title: "Falta la fecha de inicio",
            description: "Indica en qué fecha arrancó el crédito para poder cargar su historia.",
            variant: "destructive",
          })
          return
        }
        if (fechaInicioHomologada > hoyStr) {
          toast({
            title: "Fecha de inicio inválida",
            description: "La fecha de inicio de una venta homologada no puede ser futura.",
            variant: "destructive",
          })
          return
        }
        // Las filas manuales se validan una por una: si se descartaran en
        // silencio, el usuario creería que cargó un pago que nunca se guardó.
        const ayerStr = ayerColombia()
        for (const p of pagosManuales) {
          if (!p.fecha) {
            toast({
              title: "Falta la fecha de un pago adicional",
              description: "Cada pago que agregaste a mano necesita su fecha, o quítalo de la lista.",
              variant: "destructive",
            })
            return
          }
          if (p.fecha > ayerStr) {
            toast({
              title: "Fecha de pago inválida",
              description: `El pago del ${fmtFecha(p.fecha)} no puede ser de hoy ni futuro: el historial carga solo lo ya ocurrido.`,
              variant: "destructive",
            })
            return
          }
          if (!(Number.parseFloat(p.monto) > 0)) {
            toast({
              title: "Monto inválido",
              description: `El pago del ${fmtFecha(p.fecha)} debe tener un monto mayor a cero, o quítalo de la lista.`,
              variant: "destructive",
            })
            return
          }
        }
        const totalHistorial = historial.reduce((s, h) => s + h.monto, 0)
        if (totalHistorial > valorAPagarNum) {
          toast({
            title: "Los pagos superan el total",
            description: `Lo marcado como pagado (${fmtMoneda(totalHistorial)}) supera el total a pagar (${fmtMoneda(valorAPagarNum)}).`,
            variant: "destructive",
          })
          return
        }
      }

      // ── Construir p_loan ──────────────────────────────────────────────
      // OJO: NO se incluye `cuenta_id` porque la columna no existe en el
      // esquema actual de `loans` (la RPC se encarga de moverlo a otra
      // tabla si aplica). `ruta` tampoco va aqui porque la RPC la toma de
      // p_ruta_id para evitar inconsistencias entre params.
      // ── Abono inicial ─────────────────────────────────────────────────
      const abonoInicialNum = pagoAdelantado ? (Number.parseFloat(valorPago) || 0) : 0
      if (pagoAdelantado && abonoInicialNum <= 0) {
        toast({
          title: "Abono inválido",
          description: "Marcaste pago adelantado pero el valor está vacío o en cero.",
          variant: "destructive",
        })
        return
      }
      if (abonoInicialNum > valorAPagarNum) {
        toast({
          title: "Abono mayor que la venta",
          description: `El abono ($${abonoInicialNum.toLocaleString()}) no puede superar el total a pagar ($${valorAPagarNum.toLocaleString()}).`,
          variant: "destructive",
        })
        return
      }

      const p_loan = {
        valor: valorNum,
        saldo: valorAPagarNum,
        valor_a_pagar: valorAPagarNum,
        valor_cuota: Math.round(valorCuotaNum * 100) / 100,
        tasa_interes: prestamoEmpleado ? 0 : Number.parseFloat(tasaInteres),
        numero_cuotas: numeroCuotasNum,
        tipo_amortizacion: prestamoEmpleado ? "empleado" : tipoAmortizacion,
        frecuencia_pago: frecuenciaPago,
        dia_semana: diaSemana || null,
        tipo_venta: tipoVenta,
        // La EVIDENCIA de la entrega (scripts/115): foto del dinero en
        // efectivo o comprobante en transferencia. Obligatoria.
        comprobante_url: comprobanteUrl,
        // Con cual de los dos apodos se ve ESTE prestamo. 1 = el de siempre.
        apodo_elegido: apodoElegido,
        prestamo_empleado: prestamoEmpleado,
        cuenta_id: (tipoVenta === "transferencia" || tipoVenta === "mixto") && cuentaId ? cuentaId : null,
        // Venta MIXTA: cuánto se entregó de cada forma (scripts/124). La caja
        // descuenta el valor completo igual que siempre.
        venta_efectivo: tipoVenta === "mixto" ? Number.parseFloat(ventaEfectivo) || 0 : null,
        venta_transferencia: tipoVenta === "mixto" ? Number.parseFloat(ventaTransferencia) || 0 : null,
        fecha_primer_pago: fechaPrimerPago,
        // Fecha del DISPOSITIVO: si la venta se sincroniza mañana, el abono
        // inicial debe quedar en el día en que el cliente entregó la plata,
        // no en el día en que el servidor la recibió.
        fecha_dispositivo: hoyStr,
        // EL DÍA DEL REPORTE. Viaja solo cuando alguien lo ELIGIÓ, o sea desde
        // Control Total. En la calle no se manda, y el servidor sigue fechando
        // con su NOW(): mandarlo siempre con el "hoy" del teléfono le
        // entregaría el día del informe al reloj del dispositivo, que hoy no
        // decide nada.
        //
        // Se manda aunque el día elegido sea hoy, y no solo cuando va hacia
        // atrás: si alguien deja la pantalla abierta y guarda pasada la
        // medianoche, la venta queda en el día que decía la pantalla y no en
        // el que amaneció.
        ...(fechaVenta ? { fecha_venta: fechaVenta } : {}),
        // SIN TOPE. Lo lee `registrar_venta` (script 079) y solo le hace caso
        // si el rol REAL de quien registra es secretaría o admin, así que
        // mandarla desde otro lado no abre nada.
        ...(comoSecretaria ? { omitir_umbral: true } : {}),
        // Historia de la venta homologada (vacío en una venta normal).
        historial,
        // Abono inicial ("Pago adelantado"). Viaja DENTRO de p_loan igual que
        // la llave de idempotencia, para no cambiar la firma de la RPC — que
        // tiene otros callers, como la aprobacion de solicitudes.
        //
        // Hasta el script 040 este dato se capturaba en el formulario y se
        // descartaba al guardar: la venta quedaba con todas las cuotas
        // pendientes y la plata que el cliente entrego no aparecia por
        // ningun lado.
        abono_inicial: abonoInicialNum,
      }

      // El plan lo genera el servidor: se manda vacío. Ver `crear_venta_atomica`
      // en el script 045 — si llegara con filas las respeta (compatibilidad
      // con dispositivos que aún tengan la versión anterior en su cola).
      const p_payment_plan: unknown[] = []

      // ── Leer credenciales del usuario desde localStorage ──────────────
      // currentUser y selectedRuta los persiste el shell (app/page.tsx).
      let p_user_id: string | null = null
      let p_ruta_id: number = rutaId
      let p_rol: string | null = null
      try {
        const rawUser = typeof window !== "undefined" ? localStorage.getItem("currentUser") : null
        if (rawUser) {
          const parsed = JSON.parse(rawUser)
          p_user_id = parsed?.id ?? null
          p_rol = parsed?.rol ?? null
        }
        // La ruta la eligió quien registra (Control Total) y no se pisa con
        // la de la sesión.
        if (!comoSecretaria) {
          const rawRuta = typeof window !== "undefined" ? localStorage.getItem("selectedRuta") : null
          if (rawRuta) {
            const parsedRuta = JSON.parse(rawRuta)
            if (typeof parsedRuta?.id === "number") p_ruta_id = parsedRuta.id
          }
        }
      } catch (e) {
        console.warn("[v0] Error leyendo credenciales de localStorage:", e)
      }

      if (!p_user_id || !p_ruta_id || !p_rol) {
        toast({
          title: "Sesión inválida",
          description: "No se pudieron obtener las credenciales del usuario. Vuelve a iniciar sesión.",
          variant: "destructive",
        })
        return
      }

      // ── Ubicacion de la venta ─────────────────────────────────────────
      // Queda como referencia del cliente para la geocerca: al cobrarle se
      // compara contra este punto. Tambien viaja en las renovaciones — si
      // el cliente venia sin ubicacion la RPC la llena con esta, y si ya
      // tenia no la pisa.
      //
      // Es de MEJOR ESFUERZO a proposito. Una venta es plata entrando; no
      // puede quedar bloqueada porque el chip GPS no engancho o el permiso
      // esta en prompt. Si no se captura aca, el primer cobro la captura.
      //
      // Va DESPUES de las validaciones para no hacerle esperar hasta 10s de
      // GPS a un formulario que igual iba a rebotar.
      // EL PIN MANDA. Lo que se ve en el mapa es lo que se guarda. En una
      // renovación, solo si el vendedor lo movió viaja `ubicacion_manual`, y
      // con eso el servidor CORRIGE la ubicación ya guardada (scripts/128);
      // sin tocarlo, la de siempre se respeta.
      if (pinCliente) {
        p_cliente.latitud = pinCliente.lat
        p_cliente.longitud = pinCliente.lng
        if (!isNewClient && pinManual) p_cliente.ubicacion_manual = true
      } else {
        try {
          const pos = await obtenerUbicacion()
          p_cliente.latitud = pos.latitud
          p_cliente.longitud = pos.longitud
        } catch (err) {
          console.warn("[v0] Venta sin ubicacion (se capturara en el primer cobro):", err)
        }
      }

      // ── Umbral de aprobacion por ruta (venta nueva vs renovacion) ──────
      // QUIEN DECIDE ES EL SERVIDOR (`registrar_venta`, script 061). Acá el
      // umbral se lee SOLO para poder avisar antes de enviar; si la lectura
      // falla, la venta se manda igual y el servidor decide con la config de
      // verdad. Antes esta lectura ERA la decisión, y `getRutaUmbrales` falla
      // abierto: un error de red al vender saltaba la revisión sin dejar
      // rastro de que se la había saltado.
      //
      // Renovación = el crédito va a un cliente que YA existe, se haya llegado
      // desde otra vista (`preSelectedClientId`) o eligiéndolo en el formulario.
      const esRenovacion = !!preSelectedClientId || !isNewClient

      // Nombre del cliente para etiquetar la venta.
      //
      // Se calcula ACÁ y no más abajo porque también lo necesita la solicitud
      // de revisión: `apodo`/`nombreCompleto` son los campos del formulario de
      // cliente NUEVO, y en una renovación llegan vacíos. Por eso las
      // solicitudes de venta decían "Venta nueva — " sin nombre, justo lo que
      // el aprobador necesita para saber qué está aprobando.
      //
      // Se usa la etiqueta guardada al elegir y no una búsqueda dentro de
      // `clientOptions`: esa lista se refiltra con cada tecla, así que el
      // cliente ya seleccionado puede no estar en ella.
      const nombreParaEtiqueta = isNewClient
        ? (apodo || nombreCompleto || "Cliente")
        : (selectedClientLabel
            || clientOptions.find((c) => c.id === selectedClient)?.apodo
            || clientOptions.find((c) => c.id === selectedClient)?.nombre_completo
            || "Cliente")

      // Lo que lleva el recibo, tomado ya: el formulario se limpia al guardar.
      let rutaNombre = `Ruta ${p_ruta_id}`
      try {
        const r = JSON.parse(localStorage.getItem("selectedRuta") ?? "null")
        if (r?.id === p_ruta_id && r?.nombre) rutaNombre = String(r.nombre)
      } catch { /* sin nombre */ }
      const datosRecibo: DatosReciboVenta = {
        esRenovacion,
        clienteId: isNewClient ? null : selectedClient || null,
        nombre: isNewClient ? (nombreCompleto || apodo || "Cliente") : nombreParaEtiqueta,
        documento: isNewClient ? documento : "",
        valor: valorNum,
        tasa: prestamoEmpleado ? 0 : Number.parseFloat(tasaInteres) || 0,
        totalAPagar: valorAPagarNum,
        cuotas: numeroCuotasNum,
        valorCuota: valorCuotaNum,
        frecuencia: frecuenciaPago,
        primerPago: fechaPrimerPago,
        abono: abonoInicialNum,
        entrega: tipoVenta,
        efectivo: tipoVenta === "mixto" ? Number.parseFloat(ventaEfectivo) || 0 : null,
        transferencia: tipoVenta === "mixto" ? Number.parseFloat(ventaTransferencia) || 0 : null,
        dia: diaVenta,
        hora: new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date()),
        rutaNombre,
        vendedor: getSolicitanteNombre() || getUsuarioSesion().nombre || "",
        sinSenal: false,
      }

      // PRIMERA LÍNEA. Cuando la lectura del umbral sí llegó, se decide acá
      // para poder preguntarle al vendedor ANTES de mandar nada. Si dice que
      // no, no se envía; si dice que sí, la solicitud entra directo y la RPC
      // nunca se llama — así que este camino y el del servidor no pueden
      // producir dos solicitudes por la misma venta.
      //
      // El agujero que arregla el script 061 es el OTRO caso: cuando esta
      // lectura falla, `getRutaUmbrales` devuelve todo deshabilitado, o sea
      // "ninguna venta necesita revisión", y la venta entraba sin revisión sin
      // dejar rastro. Ahora eso lo atrapa `registrar_venta` en el servidor.
      //
      // Y no corre para secretaría: preguntarle "¿la mando a revisión?" a la
      // persona que atiende la bandeja de revisiones no tiene a quién
      // consultarle. Se salta la lectura entera, no solo la pregunta, porque
      // es una vuelta a la red que ya no decide nada.
      const umbrales = comoSecretaria ? null : await getRutaUmbrales(p_ruta_id)
      const ventaHabilitada = umbrales
        ? (esRenovacion ? umbrales.venta_renovacion_habilitado : umbrales.venta_nueva_habilitado)
        : false
      const ventaUmbral = umbrales
        ? (esRenovacion ? umbrales.venta_renovacion_umbral : umbrales.venta_nueva_umbral)
        : null

      if (excedeUmbral(ventaHabilitada, ventaUmbral, valorNum)) {
        const confirmado = await confirmRevision()
        if (!confirmado) return

        // POR LA COLA, como todo lo demás: sin señal la solicitud queda en el
        // teléfono y se manda sola al volver la red (con sus fotos, que suben
        // primero). Antes era un INSERT directo que sin señal fallaba y la
        // venta se perdía con el formulario.
        let revisionEncolada = false
        try {
          const r = await enviarOEncolar({
            tipo: "revision",
            descripcion: `${esRenovacion ? "Renovación" : "Venta nueva"} a revisión — ${nombreParaEtiqueta} ($${valorNum.toLocaleString()})`,
            payload: {
              tipo: "venta",
              subtipo: esRenovacion ? "renovacion" : "nueva",
              solicitado_por_nombre: getSolicitanteNombre(),
              monto: valorNum,
              descripcion: `${esRenovacion ? "Renovación" : "Venta nueva"} — ${nombreParaEtiqueta}`,
              payload: { p_cliente, p_loan, p_payment_plan },
            },
            rutaId: p_ruta_id,
          })
          revisionEncolada = r.encolado
        } catch (err) {
          toast({ title: "Error", description: mensajeDeError(err), variant: "destructive" })
          return
        }

        // Encolada, el aviso lo manda la cola al subirla.
        if (!revisionEncolada) {
          void avisarSolicitudPendiente({
            etiqueta: esRenovacion ? "Renovación" : "Venta",
            monto: valorNum,
            cliente: nombreParaEtiqueta,
            rutaId: p_ruta_id,
          })
        }

        const msgRevision = revisionEncolada
          ? "Guardada sin señal. Se enviará a revisión de secretaría al volver la conexión."
          : MENSAJE_REVISION
        showToastPill(msgRevision)
        setSuccessDialog({ open: true, msg: msgRevision })
        setSuccessAlert(MENSAJE_REVISION)
        setFormAlert(null)
        setTimeout(() => setSuccessAlert(null), 6000)

        resetFormularioVenta()
        return
      }

      // ── Llamada UNICA a la RPC atomica ────────────────────────────────
      // Toda la creacion (cliente + loan + payment_plan) corre en una sola
      // transaccion en la base; si algo falla, se hace rollback completo
      // y nunca quedan registros huerfanos.
      // Sin conexion la venta queda en la cola del dispositivo y se envia sola
      // despues. Las fechas del plan NO se recalculan al sincronizar: son las
      // que se pactaron con el cliente al hacer la venta.
      let ventaEncolada = false
      let resultadoVenta: unknown = null
      try {
        const r = await enviarOEncolar({
          tipo: "venta",
          descripcion: `Venta — ${nombreParaEtiqueta} ($${valorNum.toLocaleString()})`,
          payload: { p_cliente, p_loan, p_payment_plan },
          // LA RUTA QUE SE ELIGIÓ, no la de la sesión.
          //
          // Sin esto, `p_ruta_id` se calculaba arriba con todo cuidado y NO
          // VIAJABA: `enviarOEncolar` armaba la identidad por su cuenta con
          // `getSessionIdentity()`, y la RPC usa esa. En la calle daba igual
          // —la ruta de la sesión es la de la venta— pero desde Control Total
          // la secretaria elegía la 151 y la venta quedaba en la ruta que
          // tuviera abierta arriba. Pasó con tres ventas del 31/08.
          //
          // Se manda SIEMPRE, no solo desde Control Total: en la calle vale
          // exactamente lo mismo que la de la sesión, y así la ruta de la
          // venta es la que el formulario dice, no la que otro módulo suponga.
          rutaId: p_ruta_id,
        })
        ventaEncolada = r.encolado
        resultadoVenta = r.resultado ?? null
      } catch (err) {
        // Documento repetido: mensaje claro en vez del generico. Antes este
        // caso solo se veia por la llamada duplicada que ya se elimino.
        //
        // Y AHORA EL CHOQUE ES SOLO DENTRO DE LA RUTA. Desde el script 095 la
        // unicidad de `clients.documento` es por (ruta, documento): la misma
        // persona puede estar en varias rutas. Asi que un 23505 aca ya no
        // significa "existe en el sistema" sino "existe EN ESTA RUTA" — y eso
        // cambia el consejo: "Cliente Existente" trae solo los de esta ruta
        // (`.eq("ruta", rutaId)`), asi que antes se podia estar mandando al
        // cobrador a buscar una ficha que no le iba a aparecer nunca.
        const msg = mensajeDeError(err)
        const code = (err as { code?: string })?.code
        const esDocDuplicado =
          code === "23505" || /documento/i.test(msg) || /clients_documento/i.test(msg)
        console.error("[v0] Error creando venta:", err)
        toast({
          title: esDocDuplicado ? "Documento ya registrado en esta ruta" : "Error al crear la venta",
          description: esDocDuplicado
            ? `El documento ${documento} ya está cargado en esta ruta. Búscalo en "Cliente Existente" para registrarle otra venta. En otra ruta sí se puede registrar aparte.`
            : msg || "No se pudo completar la operación",
          variant: "destructive",
        })
        return
      }

      if (ventaEncolada) {
        showToastPill("Venta guardada sin conexión. Se enviará al volver la señal.")
        setSuccessDialog({
          open: true,
          // Se dice que "puede quedar en revisión" porque quien decide es el
          // servidor, y sin señal todavía no contestó. Prometer que quedó
          // registrada sería mentir en el caso en que supere el umbral.
          msg: "La venta quedó guardada en el teléfono y se enviará automáticamente cuando vuelva la señal. Si supera el límite de la unidad, pasará a revisión de secretaría.",
        })
        setReciboVenta({ ...datosRecibo, sinSenal: true })
        resetFormularioVenta()
        return
      }

      // NOTA: `enviarOEncolar` de arriba YA envio la venta al servidor. Aqui
      // antes habia una segunda llamada directa a `crear_venta_atomica` que
      // quedo por error al agregar el soporte offline: creaba un SEGUNDO
      // prestamo, ademas sin llave de idempotencia, asi que la proteccion
      // contra duplicados no podia detectarlo. Ese bloque se elimino.

      // ── El servidor mandó la venta a revisión ──────────────────────────
      // Nada se creó: ni cliente, ni préstamo, ni cronograma. La solicitud ya
      // quedó en la bandeja de secretaría; acá solo falta avisarle a quien
      // tiene que aprobarla y decírselo al vendedor.
      const respuesta = (resultadoVenta ?? {}) as { enviado_a_revision?: boolean; motivo?: string }
      if (respuesta.enviado_a_revision) {
        // El push es lo único que llega al teléfono con la app cerrada; el
        // badge y el toast solo funcionan si la persona la tiene abierta.
        void avisarSolicitudPendiente({
          etiqueta: esRenovacion ? "Renovación" : "Venta",
          monto: valorNum,
          cliente: nombreParaEtiqueta,
          rutaId: p_ruta_id,
        })

        showToastPill(MENSAJE_REVISION)
        setSuccessDialog({ open: true, msg: respuesta.motivo ? `${MENSAJE_REVISION}. ${respuesta.motivo}.` : MENSAJE_REVISION })
        setSuccessAlert(MENSAJE_REVISION)
        setFormAlert(null)
        setTimeout(() => setSuccessAlert(null), 6000)

        resetFormularioVenta()
        return
      }

      console.log("[v0] registrar_venta OK:", resultadoVenta)

      // El cliente sale de la lista EN EL ACTO, sin esperar a que vuelva la
      // consulta.
      //
      // `resetFormularioVenta` ya dispara un refetch, pero ese pasa por un
      // rebote de 300ms y por la red: durante ese rato el cliente al que se le
      // acaba de vender seguia figurando como disponible, y en la calle eso
      // alcanza para intentar venderle dos veces. Quitarlo de la lista es
      // instantaneo y no depende de nada; el refetch que viene detras confirma.
      if (!isNewClient && selectedClient) {
        setClientOptions((prev) => prev.filter((c) => c.id !== selectedClient))
      }

      const successMsg = esRetroactiva
        ? `Se registró la venta de $${Number(valor || 0).toLocaleString()} para ${nombreParaEtiqueta}, contada en el reporte del ${fmtFecha(diaVenta)}.`
        : `Se registró la venta de $${Number(valor || 0).toLocaleString()} para ${nombreParaEtiqueta}.`
      showToastPill("Venta registrada exitosamente")
      setReciboVenta(datosRecibo)
      setSuccessDialog({ open: true, msg: successMsg })
      setSuccessAlert(successMsg)
      setFormAlert(null)
      setTimeout(() => setSuccessAlert(null), 6000)

      resetFormularioVenta()
      // Solo acá, y no en los caminos de revisión o de cola offline: en esos
      // dos todavía no existe ninguna venta que refrescar.
      onCreated?.()
    } catch (error) {
      console.error('[v0] Error creating venta:', error)
      toast({
        title: "Error al crear la venta",
        // El mensaje REAL, no uno genérico: si la venta no entra, el vendedor
        // tiene enfrente al cliente y necesita saber qué pasó.
        description: mensajeDeError(error),
        variant: "destructive",
      })
    } finally {
      setIsCreating(false)
      creandoVentaRef.current = false
    }
  }

  /**
   * El día en que DE VERDAD arranca el cobro.
   *
   * `diaVenta + 1` no alcanza: en frecuencia diaria el cronograma no pone
   * cuotas en domingo (script 067), así que un domingo se corre al lunes. Una
   * de cada siete ventas caería justo ahí, y decir una fecha que después no
   * coincide con el plan es peor que no decir ninguna.
   */
  const primerCobro = (() => {
    const base = sumarDias(diaVenta, iniciaPagosHoy ? 0 : 1)
    // El préstamo de empleado es diario por definición.
    const diaria = prestamoEmpleado || frecuenciaPago === "daily"
    const [y, m, d] = base.split("-").map(Number)
    const esDomingo = new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0
    return diaria && esDomingo ? sumarDias(base, 1) : base
  })()

  // ── Piezas del diseño (CrearVenta.jsx) ─────────────────────────────────
  const cvErr = (id: string) => (formErrors.has(id) ? " cv-input--err" : "")
  const valorNumVista = Number.parseFloat(valor) || 0
  const esTransfer = tipoVenta === "transferencia" || tipoVenta === "mixto"

  return (
    <div className="cv-root">
      <div className="cv-frame">
      {/* ── ESTA VENTA NO ES DE HOY ─────────────────────────────────────
          Va de primero y no se va nunca. El formulario es largo: quien lo
          llena de arriba abajo pierde de vista lo que eligió al abrirlo, y
          equivocarse acá no se nota hasta que la caja de ese día no cuadra.
          Se dicen las dos consecuencias que sorprenden: el cronograma
          arranca desde ese día y la caja de ese día —y las siguientes—
          cambian. La fecha exacta de la primera cuota NO se promete acá:
          depende de la frecuencia y del "inicia pagos", que se eligen más
          abajo, y ahí sí se dice con todas las letras. */}
      {esRetroactiva && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="text-[12px] md:text-sm font-semibold">
            Esta venta se contará en el reporte del {fmtFecha(diaVenta)}
          </p>
          <p className="mt-0.5 text-[11px] md:text-xs leading-snug opacity-90">
            No en el de hoy: el cronograma arranca desde ese día y el capital sale
            de la caja de ese día, así que la caja del {fmtFecha(diaVenta)} y las de
            los días siguientes cambian.
          </p>
        </div>
      )}

      {/* ── Banners de feedback ────────────────────────────────────────
          Avisos persistentes que complementan los toasts. Quedan en la
          cabecera del formulario, encima del titulo, para que sean
          visibles tras el scroll automatico que disparamos en
          `handleCreateVenta`. */}
      {formAlert && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Faltan campos obligatorios</AlertTitle>
          <AlertDescription>
            <p className="mb-1">Por favor diligencia los siguientes campos resaltados en rojo:</p>
            <ul className="list-disc list-inside space-y-0.5">
              {formAlert.split("||").map((campo) => (
                <li key={campo} className="text-[11px] md:text-sm">
                  {campo}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {successAlert && (
        <Alert
          role="status"
          className="border-success bg-success-light/40 text-success [&>svg]:text-success"
        >
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle className="font-semibold">Venta registrada exitosamente</AlertTitle>
          <AlertDescription className="text-foreground/90">
            {successAlert}
          </AlertDescription>
        </Alert>
      )}

      {/* Toast pill flotante — mismo patron que register-transaction.tsx */}
      {toastPill && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium bg-success text-white animate-in fade-in slide-in-from-bottom-4">
          <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {toastPill}
        </div>
      )}

      {/* Dialog modal de campos faltantes */}
      <Dialog
        open={errorDialog.open}
        onOpenChange={(open) => setErrorDialog((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader className="items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <DialogTitle className="text-base font-semibold text-center">
              Faltan campos por diligenciar
            </DialogTitle>
            <DialogDescription className="text-sm text-center text-foreground/80">
              Por favor completa los siguientes campos antes de registrar la venta:
            </DialogDescription>
          </DialogHeader>
          <ul className="mt-1 space-y-1 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3">
            {errorDialog.fields.map((campo) => (
              <li key={campo} className="flex items-center gap-2 text-sm text-foreground">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                {campo}
              </li>
            ))}
          </ul>
          <DialogFooter className="mt-2">
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => {
                setErrorDialog({ open: false, fields: [] })
                if (typeof window !== "undefined") {
                  window.scrollTo({ top: 0, behavior: "smooth" })
                }
              }}
            >
              Entendido, voy a corregirlo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog modal de confirmacion de venta exitosa */}
      <Dialog
        open={successDialog.open}
        onOpenChange={(open) => setSuccessDialog((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="max-w-sm text-center">
          <DialogHeader className="items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15">
              <CheckCircle2 className="h-6 w-6 text-success" />
            </div>
            <DialogTitle className="text-base font-semibold">
              Venta registrada exitosamente
            </DialogTitle>
            <DialogDescription className="text-sm text-foreground/80">
              {successDialog.msg}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2 flex-col gap-2 sm:flex-col sm:justify-center sm:space-x-0">
            {reciboVenta && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setSuccessDialog((prev) => ({ ...prev, open: false }))
                  setCompartirRecibo(true)
                }}
              >
                <MessageCircle className="mr-2 h-4 w-4" /> Compartir recibo de la venta
              </Button>
            )}
            {/* AL ACEPTAR SE VA A LA RUTA POR COBRAR.
                Antes el diálogo se cerraba y dejaba el formulario de Nueva
                Venta vacío en pantalla: para ver el cliente que se acababa de
                vender —y cobrarle el adelanto, que es lo que sigue— había que
                buscar el módulo de pagos en el menú.

                `onCancel` es lo que el contenedor usa para volver a pagos
                (app/page.tsx). Si no viniera, el diálogo se cierra y ya: no se
                deja al cobrador atrapado en una pantalla sin salida. */}
            <Button
              className="w-full"
              onClick={() => {
                setSuccessDialog({ open: false, msg: "" })
                setReciboVenta(null)
                onCancel?.()
              }}
            >
              {onCancel ? "Ir a la ruta" : "Aceptar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {reciboVenta && (
        <CompartirComprobanteDialog
          open={compartirRecibo}
          onOpenChange={(v) => {
            setCompartirRecibo(v)
            // Al cerrar vuelve el diálogo de éxito, con su "Ir a la ruta".
            if (!v) setSuccessDialog((prev) => ({ ...prev, open: true }))
          }}
          construirImagen={() => construirReciboVenta(reciboVenta)}
          mensajeChat={`Recibo de ${reciboVenta.esRenovacion ? "renovación" : "venta"} — ${reciboVenta.nombre}`}
          currentUser={{ id: getUsuarioSesion().id ?? 0, nombre: getUsuarioSesion().nombre }}
          titulo="Compartir el recibo"
        />
      )}

      {/* Dialog de confirmacion: la venta supera el umbral de la ruta */}
      <Dialog open={showRevisionDialog} onOpenChange={(open) => { if (!open) handleRevisionChoice(false) }}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader className="items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
              <AlertCircle className="h-6 w-6 text-amber-600" />
            </div>
            <DialogTitle className="text-base font-semibold">Venta supera el umbral de la ruta</DialogTitle>
            <DialogDescription className="text-sm text-foreground/80">
              {MENSAJE_REVISION}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2 flex-col-reverse sm:flex-row gap-2">
            <Button variant="outline" className="w-full" onClick={() => handleRevisionChoice(false)}>
              Cancelar
            </Button>
            <Button className="w-full" onClick={() => handleRevisionChoice(true)}>
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* ── Encabezado ─────────────────────────────────────────────────── */}
      <header className="cv-header">
        <button type="button" className="cv-back" onClick={onCancel} aria-label="Volver">
          <ChevronLeft size={28} strokeWidth={1.75} />
        </button>
        <h1 className="cv-title">Crear Venta</h1>
        <button
          type="button"
          className={`cv-new${isNewClient ? " cv-new--on" : ""}`}
          onClick={() => {
            // Se cambia de cliente: el formulario se limpia por completo.
            // Antes los datos del cliente anterior quedaban vivos en el
            // estado (solo dejaban de verse), y el mensaje de exito podia
            // anunciar la venta a nombre del cliente equivocado.
            resetFormularioVenta()
            setIsNewClient(!isNewClient)
          }}
        >
          <UserPlus size={26} strokeWidth={1.75} />
          {isNewClient ? "Cliente existente" : "Nuevo cliente"}
        </button>
      </header>

      <div className="cv-body">
        {/* ── Condiciones especiales ──────────────────────────────────────
            Sigue arriba de todo: es la primera decisión de la venta (¿es
            normal, arranca hoy o ya venía corriendo?) y gobierna lo que se
            pide más abajo. */}
        <div className="cv-legacy">
          <label
            htmlFor="condicionesEspeciales"
            className={`flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
              condicionesEspeciales
                ? "bg-brand/10 border-brand/40 text-foreground"
                : "bg-muted/50 border-border hover:bg-muted"
            }`}
          >
            <Checkbox
              id="condicionesEspeciales"
              checked={condicionesEspeciales}
              onCheckedChange={(checked) => {
                const v = checked as boolean
                setCondicionesEspeciales(v)
                // Al apagar, se limpia TODO lo que había dentro. Dejarlo
                // activo pero escondido haría que la venta saliera con
                // condiciones que ya no se ven en pantalla.
                if (!v) {
                  setIniciaPagosHoy(false)
                  setVentaHomologada(false)
                  setFechaInicioHomologada("")
                  setMarcasHomologacion({})
                  setCuotasOmitidas(new Set())
                  setPagosManuales([])
                }
              }}
              className="h-4 w-4 md:h-5 md:w-5"
            />
            <span className="text-[11px] md:text-sm font-medium">
              Condiciones especiales
              <span className="ml-1 font-normal opacity-80">
                (arranca hoy, o ya venía corriendo)
              </span>
            </span>
          </label>

        </div>
        {condicionesEspeciales && (
          <Seccion icon={SlidersHorizontal} title="Condiciones especiales">
            <div className="cv-legacy space-y-2">
          {/* Cuando arranca el cobro */}
          {!ventaHomologada && (
            <label
              htmlFor="iniciaPagosHoy"
              className={`flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
                iniciaPagosHoy
                  ? "bg-amber-100 border-amber-400 text-amber-800"
                  : "bg-muted/50 border-border hover:bg-muted"
              }`}
            >
              <Checkbox
                id="iniciaPagosHoy"
                checked={iniciaPagosHoy}
                onCheckedChange={(checked) => setIniciaPagosHoy(checked as boolean)}
                className="h-4 w-4 md:h-5 md:w-5"
              />
              {/* Con una venta fechada hacia atrás, "hoy" y "mañana" mienten:
                  la primera cuota cuelga del día de la VENTA. Se dicen las
                  fechas con todas las letras en vez de un adverbio que ya no
                  apunta a donde parece. */}
              <span className="text-[11px] md:text-sm font-medium">
                {esRetroactiva ? `Inicia pagos el ${fmtFecha(diaVenta)}` : "Inicia pagos hoy"}
                <span className="ml-1 font-normal opacity-80">
                  {esRetroactiva
                    ? `(la primera cuota queda el ${fmtFecha(primerCobro)})`
                    : "(por defecto la primera cuota es mañana)"}
                </span>
              </span>
            </label>
          )}

          {/* ── Venta homologada (crédito que ya venía corriendo) ────────── */}
          <label
            htmlFor="ventaHomologada"
            className={`flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
              ventaHomologada
                ? "bg-violet-100 border-violet-400 text-violet-800"
                : "bg-muted/50 border-border hover:bg-muted"
            }`}
          >
            <Checkbox
              id="ventaHomologada"
              checked={ventaHomologada}
              onCheckedChange={(checked) => {
                const v = checked as boolean
                setVentaHomologada(v)
                if (v) setIniciaPagosHoy(false)
                else {
                  setFechaInicioHomologada("")
                  setMarcasHomologacion({})
                  setCuotasOmitidas(new Set())
                  setPagosManuales([])
                }
              }}
              className="h-4 w-4 md:h-5 md:w-5"
            />
            <span className="text-[11px] md:text-sm font-medium">
              Venta homologada
              <span className="ml-1 font-normal opacity-80">
                (crédito que ya venía corriendo en otro sistema)
              </span>
            </span>
          </label>

          {ventaHomologada && (
            <div className="rounded-lg border border-violet-300 bg-violet-50/60 p-3 space-y-3">
              <p className="text-[11px] md:text-sm text-violet-900">
                Indica cuándo arrancó el crédito y marca qué días pagó y cuáles no,
                <strong> hasta ayer</strong>. Con eso el saldo, la mora y el conteo de cuotas
                quedan reales al día de hoy. Estos pagos <strong>no entran en la caja</strong>:
                esa plata se recibió en el otro sistema.
              </p>
              <p className="text-[11px] md:text-sm text-violet-900">
                La lista sale del cronograma, pero no manda: puedes <strong>quitar</strong> las
                fechas que no apliquen y <strong>agregar</strong> pagos con la fecha y el monto
                reales, si el cliente abonó días seguidos o distinto a la cuota.
              </p>
              <p className="text-[11px] md:text-sm text-violet-900">
                La cuota de <strong>hoy</strong> no se marca aquí: queda pendiente y el cobrador
                le registra el pago o el no pago en la ruta, como a cualquier otro cliente.
              </p>

              <div className="grid gap-1.5">
                <Label htmlFor="fechaInicioHomologada" className="text-[11px] md:text-sm">
                  Fecha de la primera cuota
                </Label>
                <Input
                  id="fechaInicioHomologada"
                  type="date"
                  max={ayerColombia()}
                  value={fechaInicioHomologada}
                  onChange={(e) => {
                    // Otra fecha de inicio = otro cronograma: las marcas y las
                    // filas quitadas apuntaban a cuotas que ya no existen.
                    setFechaInicioHomologada(e.target.value)
                    setMarcasHomologacion({})
                    setCuotasOmitidas(new Set())
                  }}
                  className="h-8 md:h-10 text-[11px] md:text-sm"
                />
                <p className="text-[10px] md:text-xs text-violet-800/80">
                  Tiene que ser una fecha anterior a hoy. Si el crédito arranca hoy no es una
                  homologación: es una venta normal con &quot;Inicia pagos hoy&quot;.
                </p>
              </div>

              {cuotasHomologacion.length === 0 && fechaInicioHomologada && (
                <p className="text-[11px] md:text-sm text-violet-900">
                  {fechaInicioHomologada >= todayColombia()
                    ? "Esa fecha no deja ninguna cuota vencida. Elige una fecha anterior a hoy, o desmarca la casilla y usa \"Inicia pagos hoy\"."
                    : "Completa el valor, las cuotas y la tasa para ver las cuotas ya vencidas."}
                </p>
              )}

              {cuotasVigentes.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] md:text-sm font-medium text-violet-900">
                      {cuotasVigentes.length} cuota{cuotasVigentes.length === 1 ? "" : "s"} vencida{cuotasVigentes.length === 1 ? "" : "s"} hasta ayer
                    </span>
                    <Button
                      type="button" variant="outline" size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setMarcasHomologacion({})}
                    >
                      Marcar todas como pagadas
                    </Button>
                    <Button
                      type="button" variant="outline" size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => {
                        const todas: Record<number, { tipo: "pago" | "no_pago"; monto: string }> = {}
                        for (const c of cuotasVigentes) todas[c.numero_cuota] = { tipo: "no_pago", monto: "0" }
                        setMarcasHomologacion((p) => ({ ...p, ...todas }))
                      }}
                    >
                      Marcar todas como no pago
                    </Button>
                    <Button
                      type="button" variant="outline" size="sm"
                      className="h-7 text-[11px] text-destructive hover:text-destructive"
                      onClick={() => setCuotasOmitidas(new Set(cuotasHomologacion.map((c) => c.numero_cuota)))}
                    >
                      Quitar todas
                    </Button>
                  </div>

                  <div className="max-h-72 overflow-y-auto rounded-md border border-violet-200 bg-background">
                    <table className="w-full text-[11px] md:text-sm">
                      <thead className="sticky top-0 bg-violet-100 text-violet-900">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-medium">#</th>
                          <th className="px-2 py-1.5 text-left font-medium">Vencía</th>
                          <th className="px-2 py-1.5 text-right font-medium">Cuota</th>
                          <th className="px-2 py-1.5 text-center font-medium">¿Pagó?</th>
                          <th className="px-2 py-1.5 text-right font-medium">Abonó</th>
                          <th className="px-2 py-1.5 w-8" aria-label="Quitar" />
                        </tr>
                      </thead>
                      <tbody>
                        {cuotasVigentes.map((c) => {
                          const m = marcaDe(c.numero_cuota, c.valor_cuota)
                          const pago = m.tipo === "pago"
                          return (
                            <tr key={c.numero_cuota} className="border-t border-violet-100">
                              <td className="px-2 py-1 text-muted-foreground">{c.numero_cuota}</td>
                              <td className="px-2 py-1">{fmtFecha(c.fecha_pago)}</td>
                              <td className="px-2 py-1 text-right">{fmtMoneda(c.valor_cuota)}</td>
                              <td className="px-2 py-1">
                                <div className="flex justify-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setMarcasHomologacion((p) => ({
                                      ...p, [c.numero_cuota]: { tipo: "pago", monto: String(c.valor_cuota) },
                                    }))}
                                    className={`rounded px-2 py-0.5 text-[10px] md:text-xs font-medium transition-colors ${
                                      pago ? "bg-green-600 text-white" : "bg-muted text-muted-foreground hover:bg-green-100"
                                    }`}
                                  >
                                    Pagó
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setMarcasHomologacion((p) => ({
                                      ...p, [c.numero_cuota]: { tipo: "no_pago", monto: "0" },
                                    }))}
                                    className={`rounded px-2 py-0.5 text-[10px] md:text-xs font-medium transition-colors ${
                                      !pago ? "bg-amber-600 text-white" : "bg-muted text-muted-foreground hover:bg-amber-100"
                                    }`}
                                  >
                                    No pagó
                                  </button>
                                </div>
                              </td>
                              <td className="px-2 py-1 text-right">
                                <Input
                                  type="text" inputMode="decimal" disabled={!pago}
                                  value={mostrarMonto(pago ? m.monto : "0")}
                                  onChange={(e) => setMarcasHomologacion((p) => ({
                                    ...p, [c.numero_cuota]: { tipo: "pago", monto: leerMonto(e.target.value) },
                                  }))}
                                  className="h-7 w-24 ml-auto text-right text-[11px] md:text-sm"
                                />
                              </td>
                              <td className="px-1 py-1">
                                <button
                                  type="button"
                                  onClick={() => setCuotasOmitidas((p) => new Set(p).add(c.numero_cuota))}
                                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                  title="Quitar esta fecha del historial"
                                  aria-label={`Quitar la cuota ${c.numero_cuota} del historial`}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* Filas quitadas: siempre hay vuelta atrás. */}
              {cuotasOmitidas.size > 0 && (
                <p className="text-[11px] md:text-sm text-violet-900">
                  {cuotasOmitidas.size} fecha{cuotasOmitidas.size === 1 ? "" : "s"} quitada
                  {cuotasOmitidas.size === 1 ? "" : "s"} del historial.{" "}
                  <button
                    type="button"
                    onClick={() => setCuotasOmitidas(new Set())}
                    className="font-semibold underline underline-offset-2 hover:text-violet-700"
                  >
                    Restaurar
                  </button>
                </p>
              )}

              {/* ── Pagos adicionales ─────────────────────────────────────
                  Fuera del bloque de la tabla a propósito: si se quitaron
                  todas las cuotas, este es el único lugar donde se puede
                  cargar la historia. Fecha y monto libres — el cliente pudo
                  abonar días seguidos o montos que no son la cuota. */}
              {fechaInicioHomologada && (
                <div className="space-y-2 rounded-md border border-dashed border-violet-300 p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] md:text-sm font-medium text-violet-900">
                      Pagos adicionales
                      <span className="ml-1 font-normal opacity-80">
                        (fechas y montos que no siguen el cronograma)
                      </span>
                    </span>
                    <Button
                      type="button" variant="outline" size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setPagosManuales((p) => [
                        ...p,
                        { id: proximoIdPagoManual.current++, fecha: "", monto: "" },
                      ])}
                    >
                      + Agregar pago
                    </Button>
                  </div>

                  {pagosManuales.length === 0 ? (
                    <p className="text-[10px] md:text-xs text-violet-800/80">
                      Úsalo si el cliente abonó en días que no son los del cronograma, o si
                      prefieres quitar las cuotas de arriba y dejar un solo pago consolidado.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {pagosManuales.map((p) => (
                        <div key={p.id} className="flex items-center gap-1.5">
                          <Input
                            type="date"
                            max={ayerColombia()}
                            value={p.fecha}
                            onChange={(e) => setPagosManuales((prev) => prev.map(
                              (x) => (x.id === p.id ? { ...x, fecha: e.target.value } : x),
                            ))}
                            className="h-7 flex-1 min-w-0 text-[11px] md:text-sm"
                          />
                          <Input
                            type="text" inputMode="decimal" placeholder="$ 0"
                            value={mostrarMonto(p.monto)}
                            onChange={(e) => setPagosManuales((prev) => prev.map(
                              (x) => (x.id === p.id ? { ...x, monto: leerMonto(e.target.value) } : x),
                            ))}
                            className="h-7 w-28 shrink-0 text-right text-[11px] md:text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => setPagosManuales((prev) => prev.filter((x) => x.id !== p.id))}
                            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            title="Quitar este pago"
                            aria-label="Quitar este pago"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* El resumen cuenta las dos fuentes: cronograma y manuales. */}
              {(cuotasVigentes.length > 0 || pagosManuales.length > 0) && (
                <div className="flex flex-wrap justify-between gap-2 rounded-md bg-violet-100 px-3 py-2 text-[11px] md:text-sm text-violet-900">
                  <span>Ya abonado: <strong>{fmtMoneda(resumenHomologacion.pagado)}</strong></span>
                  <span>No pagos: <strong>{resumenHomologacion.noPagos}</strong></span>
                  <span>
                    Saldo al crearla:{" "}
                    <strong>
                      {fmtMoneda(Math.max(0, (Number.parseFloat(valorAPagar) || 0) - resumenHomologacion.pagado))}
                    </strong>
                  </span>
                </div>
              )}
            </div>
          )}

            </div>
          </Seccion>
        )}

        {camara && (
        <CamaraEnApp
          titulo={camara.titulo}
          inputId={camara.inputId}
          onCerrar={() => setCamara(null)}
          onFoto={(file) => {
            // Los manejadores esperan el evento del input: se les pasa uno con
            // la foto, y el `value = ""` que hacen cae en un objeto suelto.
            const ev = { target: { files: [file], value: "" } } as unknown as React.ChangeEvent<HTMLInputElement>
            if (camara.destino === "cedula") void handleCedulaCapture(ev)
            else if (camara.destino === "reverso") void handleRespaldoCapture(ev)
            else if (camara.destino === "local") void handleFotoLocal(ev)
            else { void handleComprobante(ev); clearFieldError("evidencia") }
          }}
        />
      )}

      {/* ── Datos del cliente ─────────────────────────────────────────── */}
        <Seccion icon={User} title="Datos del cliente">
          {isNewClient ? (
            <>
              <div className="cv-grid-cliente">
                {/* La captura de la cédula: dispara la cámara y la lectura
                    (nombre y documento) con GPT-4o. */}
                <input type="file" accept="image/*" capture="environment" onChange={handleCedulaCapture} className="cv-file" id="cedula-upload" />
                <label
                  htmlFor="cedula-upload"
                  onClick={(e) => { e.preventDefault(); if (!procesandoCedula) setCamara({ titulo: "Foto de la cédula", inputId: "cedula-upload", destino: "cedula" }) }}
                  className={`cv-photo${cedulaImage ? " cv-photo--done" : ""}${procesandoCedula ? " cv-photo--busy" : ""}`}
                  title={procesandoCedula ? "Procesando cédula..." : "Toca para capturar la cédula"}
                >
                  {cedulaImage && !procesandoCedula && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={cedulaImage} alt="Cédula" />
                  )}
                  {procesandoCedula ? (
                    <><Loader2 size={40} className="animate-spin" color="#1f6fe0" />Leyendo…</>
                  ) : cedulaImage ? (
                    <span className="cv-photo-tag">Cédula ✓ · cambiar</span>
                  ) : (
                    <><Camera size={52} fill="#1f6fe0" color="#fff" strokeWidth={1.6} />Captura{!cedulaObligatoria && <span className="cv-opt">(opcional)</span>}</>
                  )}
                </label>

                <div className="cv-field">
                  <CvLabel req>N.º de documento</CvLabel>
                  <div className="cv-control">
                    <input
                      id="documento"
                      className={`cv-input cv-input--pr${docBloqueado ? " cv-input--locked" : ""}${cvErr("documento")}`}
                      placeholder={datosBloqueados ? "De la cédula" : "N.º de documento"}
                      value={documento}
                      readOnly={docBloqueado}
                      disabled={procesandoCedula}
                      onChange={(e) => { setDocumento(e.target.value); clearFieldError("documento") }}
                    />
                    {docBloqueado && <span className="cv-ico-r"><Candado /></span>}
                  </div>
                </div>
                <div className="cv-field">
                  <CvLabel req>Nombre completo</CvLabel>
                  <div className="cv-control">
                    <input
                      id="nombreCompleto"
                      className={`cv-input${nombreBloqueado ? " cv-input--locked cv-input--dim cv-input--pr" : ""}${cvErr("nombreCompleto")}`}
                      placeholder={datosBloqueados ? "Lo llena la cédula" : "Nombre completo"}
                      value={nombreCompleto}
                      readOnly={nombreBloqueado}
                      disabled={procesandoCedula}
                      onChange={(e) => { setNombreCompleto(e.target.value); clearFieldError("nombreCompleto") }}
                    />
                    {nombreBloqueado && <span className="cv-ico-r"><Candado /></span>}
                  </div>
                </div>
                <div className="cv-field">
                  <CvLabel req>Alias 1</CvLabel>
                  <input
                    id="apodo"
                    className={`cv-input uppercase placeholder:normal-case${cvErr("apodo")}`}
                    placeholder="Apodo o referencia"
                    value={apodo}
                    onChange={(e) => { setApodo(e.target.value.toUpperCase()); clearFieldError("apodo") }}
                  />
                </div>
                <div className="cv-field">
                  <CvLabel req>Teléfono</CvLabel>
                  {/* El indicativo va pegado al número: son un solo dato. */}
                  <div className="cv-telefono">
                    <div className="cv-control cv-indicativo">
                      <select
                        aria-label="Indicativo del país"
                        className="cv-input cv-indicativo-sel"
                        value={indicativo}
                        onChange={(e) => cambiarIndicativo(e.target.value)}
                      >
                        {INDICATIVOS.map((i) => (
                          <option key={i.codigo} value={i.codigo}>{i.codigo} · {i.pais}</option>
                        ))}
                      </select>
                      <span className="cv-indicativo-cod">{indicativo}</span>
                      <ChevronDown size={16} strokeWidth={1.75} className="cv-chevron" style={{ right: 8 }} />
                    </div>
                    <div className="cv-control" style={{ flex: 1 }}>
                      <input
                        id="telefono"
                        type="tel"
                        className={`cv-input cv-input--pr${telefonoError || formErrors.has("telefono") ? " cv-input--err" : ""}`}
                        placeholder={`${requiredPhoneDigits} dígitos`}
                        value={telefono}
                        maxLength={requiredPhoneDigits}
                        onChange={(e) => {
                          const val = e.target.value.replace(/\D/g, "")
                          setTelefono(val)
                          validatePhone(val, "tel1")
                          if (val) clearFieldError("telefono")
                        }}
                      />
                      <span className="cv-ico-r"><MessageCircle size={26} color="#6b7480" strokeWidth={1.75} /></span>
                    </div>
                  </div>
                  {telefonoError && <span className="cv-error">{telefonoError}</span>}
                </div>
              </div>

              <div className="cv-grid-2">
                <div className="cv-field">
                  <CvLabel opt="(opcional)">Teléfono 2</CvLabel>
                  <input
                    id="telefono2"
                    type="tel"
                    className={`cv-input${telefono2Error ? " cv-input--err" : ""}`}
                    placeholder={`${requiredPhoneDigits} dígitos`}
                    value={telefono2}
                    maxLength={requiredPhoneDigits}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "")
                      setTelefono2(val)
                      validatePhone(val, "tel2")
                    }}
                  />
                  {telefono2Error && <span className="cv-error">{telefono2Error}</span>}
                </div>
                <div />
              </div>

              {/* El reverso: al activarlo se fotografía y la IA lee el
                  domicilio, que va a "Dirección del DNI". */}
              <label className="cv-check">
                <input
                  id="leer-direccion"
                  type="checkbox"
                  checked={leerDireccion}
                  onChange={(e) => setLeerDireccion(e.target.checked)}
                />
                <span className="cv-check-text">
                  <CvLabel>Leer la dirección del reverso del documento <Info size={22} color="#1f6fe0" strokeWidth={1.75} /></CvLabel>
                  <span className="cv-hint" style={{ paddingLeft: 0 }}>
                    Al activar esta opción se habilita la captura del reverso para leer la dirección.
                  </span>
                </span>
              </label>
              {leerDireccion && (
                <>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleRespaldoCapture}
                    className="cv-file"
                    id="cedula-respaldo-upload"
                    disabled={procesandoRespaldo}
                  />
                  <label
                    htmlFor="cedula-respaldo-upload"
                    className="cv-reverso"
                    onClick={(e) => { e.preventDefault(); if (!procesandoRespaldo) setCamara({ titulo: "Reverso del documento", inputId: "cedula-respaldo-upload", destino: "reverso" }) }}
                  >
                    {procesandoRespaldo
                      ? <Loader2 size={20} className="animate-spin" />
                      : <Camera size={22} fill="#1f6fe0" color="#fff" strokeWidth={1.6} />}
                    {procesandoRespaldo ? "Leyendo la dirección…" : "Fotografiar el reverso"}
                  </label>
                </>
              )}

              <div className="cv-grid-2">
                <div className="cv-field">
                  <CvLabel>Dirección del DNI</CvLabel>
                  <div className="cv-control">
                    <span className="cv-ico-l"><Pin /></span>
                    <input
                      id="direccionResidencia"
                      className="cv-input cv-input--pl cv-input--pr cv-input--locked uppercase placeholder:normal-case"
                      placeholder="La lee el reverso"
                      value={direccionResidencia}
                      readOnly
                    />
                    <span className="cv-ico-r"><Candado /></span>
                  </div>
                </div>
                <div className="cv-field">
                  <CvLabel>Dirección de domicilio (si es diferente)</CvLabel>
                  <div className="cv-control">
                    <span className="cv-ico-l"><Pin /></span>
                    <input
                      id="direccionDomicilio"
                      className="cv-input cv-input--pl uppercase placeholder:normal-case"
                      placeholder="Donde vive, si no es la del DNI"
                      value={direccionDomicilio}
                      onChange={(e) => setDireccionDomicilio(e.target.value.toUpperCase())}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="cv-legacy">
            <div className="space-y-1 md:space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="clientSearch" className="text-[10px] md:text-sm">
                  Cliente
                </Label>
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id="soloSinPrestamo"
                    checked={soloSinPrestamo}
                    onCheckedChange={(checked) => setSoloSinPrestamo(checked === true)}
                    className="h-3.5 w-3.5 md:h-4 md:w-4"
                  />
                  <Label htmlFor="soloSinPrestamo" className="text-[9px] md:text-xs text-muted-foreground cursor-pointer">
                    Solo sin prestamo activo
                  </Label>
                </div>
              </div>
              {/* Se dice en palabras qué puede hacer la unidad. Sin esto, un
                  vendedor que ve en la lista a alguien que ya tiene crédito no
                  sabe si es un error o algo permitido. */}
              {multiplesPrestamos && (
                <p className="text-[9px] md:text-xs text-muted-foreground">
                  Esta unidad permite varios préstamos al mismo cliente: el nuevo corre en paralelo
                  con el que ya tiene.
                </p>
              )}
              {/* Combobox (Popover + Command) y no un Select.
                  El Select de Radix esta pensado para elegir con el teclado:
                  se queda con las pulsaciones para su propia busqueda y
                  maneja el foco el mismo. Con un campo de texto adentro eso
                  choca, y en el celular era peor — al abrirse el teclado la
                  pantalla cambia de tamaño y el desplegable se cerraba a la
                  primera letra. Popover + Command si esta hecho para
                  contener un buscador. */}
              <Popover open={clientPickerOpen} onOpenChange={(open) => {
                setClientPickerOpen(open)
                // Al abrir sin nada cargado se traen los clientes de la ruta.
                if (open && clientOptions.length === 0 && !loadingClients) {
                  setClientSearch("")
                }
              }}>
                <PopoverTrigger asChild>
                  <Button
                    id="clientSearch"
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={clientPickerOpen}
                    className="w-full justify-between h-7 md:h-10 text-[10px] md:text-sm font-normal px-2 md:px-3"
                  >
                    <span className={`truncate ${selectedClientLabel ? "" : "text-muted-foreground"}`}>
                      {loadingClients && !clientPickerOpen
                        ? "Cargando..."
                        : selectedClientLabel || "Seleccione un cliente..."}
                    </span>
                    <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="p-0 w-[var(--radix-popover-trigger-width)]"
                  align="start"
                  // En el celular el teclado virtual roba el foco al abrir.
                  // Sin esto, Radix lo devuelve al boton y el campo pierde el
                  // cursor apenas se toca.
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  <Command shouldFilter={false}>
                    {/* shouldFilter en false: el filtrado lo hace el servidor
                        con `ilike` sobre el apodo. Si tambien filtrara cmdk,
                        escondería resultados que el servidor si devolvio. */}
                    <CommandInput
                      placeholder="Buscar por apodo..."
                      value={clientSearch}
                      onValueChange={(v) => setClientSearch(v.toUpperCase())}
                      className="text-[11px] md:text-sm uppercase"
                    />
                    <CommandList className="max-h-52">
                      {loadingClients && (
                        <div className="flex items-center justify-center py-3 text-muted-foreground text-[10px] gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" /> Buscando...
                        </div>
                      )}
                      {!loadingClients && clientOptions.length === 0 && (
                        <div className="py-3 text-center text-muted-foreground text-[10px] md:text-sm">
                          No se encontraron clientes en esta ruta
                        </div>
                      )}
                      {!loadingClients && clientOptions.length > 0 && (
                        <CommandGroup>
                          {clientOptions.map((c) => (
                            <CommandItem
                              key={c.id}
                              value={c.id}
                              onSelect={() => {
                                // Al elegir otro cliente se limpian los datos
                                // del anterior (incluidos los de un intento de
                                // cliente nuevo abandonado).
                                limpiarDatosCliente()
                                setSelectedClient(c.id)
                                setSelectedClientLabel((c.apodo || c.nombre_completo).toUpperCase())
                                setClientPickerOpen(false)
                              }}
                              className="text-[10px] md:text-sm"
                            >
                              <Check
                                className={`mr-2 h-3.5 w-3.5 shrink-0 ${selectedClient === c.id ? "opacity-100" : "opacity-0"}`}
                              />
                              {/* El numero delante y con ancho fijo: asi los
                                  nombres quedan alineados y la columna se lee
                                  de un vistazo. `tabular-nums` para que el 9 y
                                  el 1 ocupen lo mismo. */}
                              {c.numero != null && (
                                <span className="mr-1.5 w-7 shrink-0 text-right font-semibold tabular-nums text-muted-foreground">
                                  {c.numero}
                                </span>
                              )}
                              <span className="font-medium truncate">{(c.apodo || c.nombre_completo).toUpperCase()}</span>
                              {c.apodo && (
                                <span className="ml-2 text-muted-foreground text-[9px] truncate">{c.nombre_completo}</span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            </div>
          )}
        </Seccion>

        {/* ── Datos del comercio (solo cliente nuevo) ─────────────────────
            EL ALIAS 2 YA NO SE PIDE EN LA VENTA (30-sep-2026): es una
            configuración interna que se pone después desde Control de
            Clientes o el editor de ventas. Sin él, a un cliente que ya existe
            esta sección no le pide nada, así que no se muestra. */}
        {isNewClient && (
        <Seccion icon={Store} title="Datos del comercio">
            <div className="cv-grid-comercio">
              {/* El nombre del ESTABLECIMIENTO, no el tipo: es lo que el
                  cobrador reconoce en la calle ("Panadería Mi Rey"). Se
                  guarda en `clients.tipo_comercio`, la misma columna de
                  siempre: el resto de la app lo sigue leyendo de ahí. */}
              <div className="cv-field cv-span-2">
                <CvLabel req>Nombre del establecimiento</CvLabel>
                <div className="cv-control">
                  <span className="cv-ico-l"><Store size={24} fill="#1f6fe0" color="#1f6fe0" strokeWidth={1.5} /></span>
                  <input
                    id="tipoComercio"
                    className={`cv-input cv-input--pl uppercase placeholder:normal-case${cvErr("tipoComercio")}`}
                    placeholder="Ej: Panadería Mi Rey"
                    value={tipoComercio}
                    onChange={(e) => { setTipoComercio(e.target.value.toUpperCase()); clearFieldError("tipoComercio") }}
                  />
                </div>
              </div>
              <div className="cv-local">
                <CvLabel opt="(opcional)">Foto del local</CvLabel>
                <input type="file" accept="image/*" capture="environment" onChange={handleFotoLocal} className="cv-file" id="foto-local" disabled={subiendoFotoLocal} />
                <label
                  htmlFor="foto-local"
                  onClick={(e) => { e.preventDefault(); if (!subiendoFotoLocal) setCamara({ titulo: "Foto del local", inputId: "foto-local", destino: "local" }) }}
                  className={`cv-photo${fotoLocalUrl ? " cv-photo--done" : ""}${subiendoFotoLocal ? " cv-photo--busy" : ""}`}
                >
                  {fotoLocalUrl && !subiendoFotoLocal && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={fotoLocalUrl} alt="Local" />
                  )}
                  {subiendoFotoLocal
                    ? <><Loader2 size={32} className="animate-spin" color="#1f6fe0" />Subiendo…</>
                    : fotoLocalUrl
                      ? <span className="cv-photo-tag">{esFotoPendiente(fotoLocalUrl) ? "Guardada sin señal" : "Cargada ✓"}</span>
                      : <><Camera size={40} fill="#1f6fe0" color="#fff" strokeWidth={1.6} />Foto del local</>}
                </label>
              </div>
              <div className="cv-field cv-span-2">
                <CvLabel req>Dirección del comercio</CvLabel>
                <div className="cv-control">
                  <span className="cv-ico-l"><Pin /></span>
                  <input
                    id="direccion"
                    className={`cv-input cv-input--pl uppercase placeholder:normal-case${cvErr("direccion")}`}
                    placeholder="Donde se le cobra"
                    value={direccion}
                    onChange={(e) => { setDireccion(e.target.value.toUpperCase()); clearFieldError("direccion") }}
                  />
                </div>
              </div>
              {bloqueMapa}
            </div>
        </Seccion>
        )}

        {/* ── Ubicación del cliente (renovación) ──────────────────────────
            A un cliente que ya existe no se le piden los datos del comercio,
            pero sí se puede corregir dónde está. */}
        {!isNewClient && selectedClient && (
          <Seccion icon={MapPinned} title="Ubicación del cliente">
            <div className="cv-grid-2">{bloqueMapa}</div>
          </Seccion>
        )}

        {/* ── Datos de la venta ─────────────────────────────────────────── */}
        <Seccion icon={CircleDollarSign} relleno title="Datos de la venta">
          <div className="cv-field">
            <CvLabel req>Tipo de venta</CvLabel>
            <div className="cv-seg" role="radiogroup">
              {([
                ["efectivo", "Efectivo", CircleDollarSign],
                ["transferencia", "Transferencia", ArrowLeftRight],
                ["mixto", "Mixto", Shuffle],
              ] as const).map(([id, label, Icono]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={tipoVenta === id}
                  onClick={() => {
                    setTipoVenta(id)
                    if (id === "efectivo") setCuentaId("")
                    if (id !== "mixto") { setVentaEfectivo(""); setVentaTransferencia("") }
                  }}
                >
                  <Icono size={24} strokeWidth={1.75} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* La cuenta, en transferencia y en mixta. */}
          {esTransfer && (
            <div className="cv-field">
              <CvLabel>Cuenta de transferencia</CvLabel>
              <div className="cv-control">
                <select
                  id="cuentaId"
                  className="cv-input cv-input--tint"
                  value={cuentaId}
                  onChange={(e) => setCuentaId(e.target.value)}
                  disabled={loadingCuentas}
                >
                  <option value="">{loadingCuentas ? "Cargando cuentas…" : cuentas.length ? "Seleccione una cuenta" : "No hay cuentas para esta ruta"}</option>
                  {cuentas.map((c) => <option key={c.id} value={c.id}>{(c as { etiqueta?: string }).etiqueta ?? c.nombre}</option>)}
                </select>
                <ChevronDown size={20} strokeWidth={1.75} className="cv-chevron" />
              </div>
            </div>
          )}

          <div className="cv-grid-3">
            <div className="cv-field">
              <CvLabel req>Valor</CvLabel>
              <div className="cv-control">
                <input
                  id="amount"
                  inputMode="decimal"
                  placeholder="0"
                  className={`cv-input${cvErr("amount")}`}
                  value={mostrarMonto(valor)}
                  onChange={(e) => {
                    const crudo = leerMonto(e.target.value)
                    setValor(crudo)
                    if (crudo) clearFieldError("amount")
                  }}
                />
              </div>
            </div>
            <div className="cv-field">
              <CvLabel req>N.º de cuotas</CvLabel>
              <input
                id="dias"
                type="number"
                inputMode="numeric"
                placeholder="Cuotas"
                className={`cv-input cv-input--tint${cvErr("dias")}`}
                value={dias}
                onChange={(e) => { setDias(e.target.value); if (e.target.value) clearFieldError("dias") }}
              />
            </div>
            <div className="cv-field">
              <CvLabel req={!prestamoEmpleado}>Interés (%)</CvLabel>
              {prestamoEmpleado ? (
                <div className="cv-control">
                  <input className="cv-input cv-input--locked cv-input--dim cv-input--pr" value="Sin interés" readOnly />
                  <span className="cv-ico-r"><Candado /></span>
                </div>
              ) : (
                <input
                  id="interestRate"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  className={`cv-input${cvErr("tasaInteres")}`}
                  value={tasaInteres}
                  onChange={(e) => { setTasaInteres(e.target.value); if (e.target.value) clearFieldError("tasaInteres") }}
                />
              )}
            </div>
          </div>

          {/* MIXTA: cuánto de cada forma. Escribir uno completa el otro. */}
          {tipoVenta === "mixto" && (() => {
            const ef = Number.parseFloat(ventaEfectivo) || 0
            const tr = Number.parseFloat(ventaTransferencia) || 0
            const cuadra = Math.round(ef + tr) === Math.round(valorNumVista)
            const escribir = (txt: string, cual: "ef" | "tr") => {
              const crudo = leerMonto(txt)
              const n = Number.parseFloat(crudo) || 0
              const resto = valorNumVista - n > 0 ? String(valorNumVista - n) : ""
              if (cual === "ef") { setVentaEfectivo(crudo); setVentaTransferencia(resto) }
              else { setVentaTransferencia(crudo); setVentaEfectivo(resto) }
              clearFieldError("mixto")
            }
            return (
              <div className="cv-grid-2">
                <div className="cv-field">
                  <CvLabel req>En efectivo</CvLabel>
                  <div className="cv-control">
                        <input inputMode="decimal" className={`cv-input${cvErr("mixto")}`} value={mostrarMonto(ventaEfectivo)} onChange={(e) => escribir(e.target.value, "ef")} />
                  </div>
                </div>
                <div className="cv-field">
                  <CvLabel req>Por transferencia</CvLabel>
                  <div className="cv-control">
                        <input inputMode="decimal" className={`cv-input${cvErr("mixto")}`} value={mostrarMonto(ventaTransferencia)} onChange={(e) => escribir(e.target.value, "tr")} />
                  </div>
                  {!cuadra && (ef > 0 || tr > 0) && (
                    <span className="cv-error">
                      Suman ${Math.round(ef + tr).toLocaleString("es-CO")} y el valor es ${Math.round(valorNumVista).toLocaleString("es-CO")}.
                    </span>
                  )}
                </div>
              </div>
            )
          })()}

          <div className="cv-grid-2">
            <div className="cv-field">
              <CvLabel req>Frecuencia de pago</CvLabel>
              <div className="cv-control">
                <select
                  id="frequency"
                  className={`cv-input cv-input--tint${cvErr("frequency")}`}
                  value={frecuenciaPago}
                  onChange={(e) => { setFrecuenciaPago(e.target.value); clearFieldError("frequency") }}
                >
                  <option value="">Seleccione</option>
                  <option value="daily">Diaria</option>
                  <option value="weekly">Semanal</option>
                  <option value="biweekly">Quincenal</option>
                  <option value="monthly">Mensual</option>
                </select>
                <ChevronDown size={20} strokeWidth={1.75} className="cv-chevron" />
              </div>
            </div>
            <div className="cv-field">
              <CvLabel>Valor de cuota</CvLabel>
              <input className="cv-input cv-input--locked cv-input--dim" value={mostrarMonto(valorCuota) || "$ 0"} readOnly />
            </div>
          </div>

          {/* Día de cobro (no diaria) y método de interés (si la unidad
              tiene más de uno): mismos campos de siempre, con el diseño. */}
          {((frecuenciaPago && frecuenciaPago !== "daily") || (!prestamoEmpleado && amortizacionesDisponibles.length > 1)) && (
            <div className="cv-grid-2">
              {frecuenciaPago && frecuenciaPago !== "daily" ? (
                <div className="cv-field">
                  <CvLabel req={frecuenciaPago === "weekly"}>Día de cobro</CvLabel>
                  <div className="cv-control">
                    <select
                      id="dayOfWeek"
                      className={`cv-input cv-input--tint${cvErr("diaSemana")}`}
                      value={diaSemana}
                      onChange={(e) => { setDiaSemana(e.target.value); clearFieldError("diaSemana") }}
                    >
                      {/* Domingo NO se ofrece: no se cobra ese día (script 067). */}
                      <option value="">Seleccione día</option>
                      <option value="lunes">Lunes</option>
                      <option value="martes">Martes</option>
                      <option value="miercoles">Miércoles</option>
                      <option value="jueves">Jueves</option>
                      <option value="viernes">Viernes</option>
                      <option value="sabado">Sábado</option>
                    </select>
                    <ChevronDown size={20} strokeWidth={1.75} className="cv-chevron" />
                  </div>
                </div>
              ) : <div />}
              {!prestamoEmpleado && amortizacionesDisponibles.length > 1 ? (
                <div className="cv-field">
                  <CvLabel req>Método de interés</CvLabel>
                  <div className="cv-control">
                    <select
                      id="tipoAmortizacion"
                      className={`cv-input cv-input--tint${cvErr("tipoAmortizacion")}`}
                      value={tipoAmortizacion}
                      onChange={(e) => { setTipoAmortizacion(e.target.value); clearFieldError("tipoAmortizacion") }}
                    >
                      <option value="">Seleccione método</option>
                      {amortizacionesDisponibles.map((a) => <option key={a.valor} value={a.valor}>{a.etiqueta}</option>)}
                    </select>
                    <ChevronDown size={20} strokeWidth={1.75} className="cv-chevron" />
                  </div>
                  {tipoAmortizacion && (
                    <span className="cv-hint">{AMORTIZACIONES.find((a) => a.valor === tipoAmortizacion)?.ayuda}</span>
                  )}
                </div>
              ) : <div />}
            </div>
          )}

          {/* Pago adelantado y préstamo de empleado: los mismos de siempre. */}
          <div className="cv-chips">
            <label className={`cv-chip${pagoAdelantado ? " cv-chip--on" : ""}`}>
              <input
                id="pagoAdelantado"
                type="checkbox"
                checked={pagoAdelantado}
                onChange={(e) => {
                  setPagoAdelantado(e.target.checked)
                  if (e.target.checked && valorCuota) setValorPago(valorCuota)
                }}
              />
              Pago adelantado
            </label>
            <label className={`cv-chip${prestamoEmpleado ? " cv-chip--on" : ""}`}>
              <input
                id="prestamoEmpleado"
                type="checkbox"
                checked={prestamoEmpleado}
                onChange={(e) => setPrestamoEmpleado(e.target.checked)}
              />
              Préstamo empleado
            </label>
          </div>
          <div className="cv-legacy">
          {pagoAdelantado && (
              <div className="space-y-2 md:space-y-3">
                <div className="grid gap-2 md:gap-4 grid-cols-1 md:grid-cols-3">
                  <div className="space-y-1 md:space-y-2">
                    <Label htmlFor="numeroCuotas" className="text-[10px] md:text-sm">
                      Número de Cuotas
                    </Label>
                    <Select
                      value={numeroCuotas.toString()}
                      onValueChange={(value) => {
                        const num = Number.parseInt(value)
                        setNumeroCuotas(num)
                        if (!otroValor) {
                          setValorPago((cuotaValue * num).toString())
                        }
                      }}
                      disabled={otroValor}
                    >
                      <SelectTrigger id="numeroCuotas" className="h-7 md:h-10 text-[10px] md:text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                          <SelectItem key={num} value={num.toString()} className="text-[10px] md:text-sm">
                            {num} {num === 1 ? "cuota" : "cuotas"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-end">
                    <div className="flex items-center gap-1.5 md:gap-2 h-7 md:h-10">
                      <Checkbox
                        id="otroValor"
                        checked={otroValor}
                        onCheckedChange={(checked) => {
                          setOtroValor(checked as boolean)
                          if (!checked) {
                            setValorPago((cuotaValue * numeroCuotas).toString())
                          } else {
                            setValorPago("")
                          }
                        }}
                      />
                      <Label htmlFor="otroValor" className="text-[10px] md:text-sm font-medium cursor-pointer">
                        Otro valor
                      </Label>
                    </div>
                  </div>

                  <div className="space-y-1 md:space-y-2">
                    <Label htmlFor="valorPago" className="text-[10px] md:text-sm">
                      Valor pago
                    </Label>
                    <Input
                      id="valorPago"
                      type="text"
                      inputMode="decimal"
                      placeholder="$ 0"
                      value={mostrarMonto(valorPago)}
                      onChange={(e) => setValorPago(leerMonto(e.target.value))}
                      readOnly={!otroValor}
                      className="h-7 md:h-10 text-[10px] md:text-sm"
                    />
                  </div>
                </div>
              </div>
            )}

          </div>

          <button
            type="button"
            className="cv-sim"
            onClick={() => { calcularAmortizacion(); setShowSimulacion(true) }}
          >
            <Calculator size={24} color="#1f6fe0" strokeWidth={1.75} />
            Simular amortización
          </button>
        </Seccion>

        {/* ── Evidencia de entrega (obligatoria) ────────────────────────── */}
        <Seccion icon={Camera} relleno title="Evidencia de entrega del crédito">
          <div className="cv-info">
            <Info size={20} color="#fff" fill="#1f6fe0" />
            Es obligatorio subir una foto para poder crear la venta.
          </div>
          {/* LA CÁMARA DIRECTO. `capture` solo abre la cámara si el campo
              acepta ÚNICAMENTE imágenes: con "image/*,application/pdf",
              Android lo ignora y muestra la galería / el selector de archivos.
              Por eso son dos campos: el recuadro grande saca la foto, y el
              enlace de abajo deja elegir de la galería o subir un PDF (un
              comprobante de transferencia que llegó por WhatsApp). */}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => { void handleComprobante(e); clearFieldError("evidencia") }}
            className="cv-file"
            id="comprobante-venta"
            disabled={subiendoComprobante}
          />
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => { void handleComprobante(e); clearFieldError("evidencia") }}
            className="cv-file"
            id="comprobante-venta-galeria"
            disabled={subiendoComprobante}
          />
          <label
            htmlFor="comprobante-venta"
            onClick={(e) => { e.preventDefault(); if (!subiendoComprobante) setCamara({ titulo: "Evidencia de entrega", inputId: "comprobante-venta", destino: "evidencia" }) }}
            className={`cv-evid${comprobanteUrl ? " cv-evid--done" : ""}${formErrors.has("evidencia") ? " cv-evid--err" : ""}`}
          >
            {subiendoComprobante
              ? <Loader2 size={44} className="animate-spin" color="#1f6fe0" />
              : <Camera size={52} fill={comprobanteUrl ? "#16a34a" : "#1f6fe0"} color="#fff" strokeWidth={1.6} />}
            <span className="cv-evid-text">
              <span className="cv-evid-title">
                {subiendoComprobante
                  ? "Subiendo…"
                  : comprobanteUrl
                    ? esFotoPendiente(comprobanteUrl)
                      ? "Guardada sin señal · sube con la venta"
                      : "Foto cargada · toca para reemplazar"
                    : "Tomar foto de la entrega del dinero"}
              </span>
              <span className="cv-evid-sub">En efectivo: foto entregando el dinero al cliente.</span>
              <span className="cv-evid-sub">En transferencia: foto del comprobante de transferencia.</span>
            </span>
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", alignItems: "center" }}>
            <label htmlFor="comprobante-venta-galeria" className="cv-hint" style={{ cursor: "pointer", color: "#1f6fe0", textDecoration: "underline" }}>
              o elegir de la galería / subir PDF
            </label>
            {comprobanteUrl && (
              <button type="button" className="cv-hint" style={{ border: 0, background: "none", cursor: "pointer", color: "#dc2626" }} onClick={() => setComprobanteUrl(null)}>
                Quitar la foto
              </button>
            )}
          </div>
        </Seccion>

        {/* ── Pie ────────────────────────────────────────────────────────── */}
        <div className="cv-foot">
          <button type="button" className="cv-submit" onClick={handleCreateVenta} disabled={isCreating || !comprobanteUrl}>
            {isCreating ? "Creando…" : "Crear Venta"}
          </button>
          {!comprobanteUrl && (
            <span className="cv-hint" style={{ textAlign: "center" }}>Sube la evidencia de entrega para habilitar el botón.</span>
          )}
          <button type="button" className="cv-cancel" onClick={onCancel} disabled={isCreating}>
            Cancelar
          </button>
        </div>
      </div>

      {/* ── Simulación de amortización ─────────────────────────────────── */}
      <Dialog open={showSimulacion} onOpenChange={setShowSimulacion}>
        <DialogContent className="max-w-2xl" style={{ fontFamily: "var(--font-nunito-sans), 'Nunito Sans', sans-serif" }}>
          <DialogHeader>
            <DialogTitle style={{ color: "#0f3a80", fontSize: 21, fontWeight: 800 }}>Simulación de amortización</DialogTitle>
            <DialogDescription>
              {etiquetaAmortizacion(tipoAmortizacion)} · {frecuenciaPago ? ({ daily: "Diaria", weekly: "Semanal", biweekly: "Quincenal", monthly: "Mensual" } as Record<string, string>)[frecuenciaPago] : "sin frecuencia"}
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 18px", fontSize: 15 }}>
            <span style={{ color: "#1c222b", fontWeight: 600 }}>Capital</span><b>{mostrarMonto(valor) || "$ 0"}</b>
            <span style={{ color: "#1c222b", fontWeight: 600 }}>Interés</span><b>{prestamoEmpleado ? "Sin interés" : `${tasaInteres || 0} %`}</b>
            <span style={{ color: "#1c222b", fontWeight: 600 }}>Total a devolver</span><b>{mostrarMonto(valorAPagar) || "$ 0"}</b>
            <span style={{ color: "#1c222b", fontWeight: 600 }}>Cuotas</span><b>{dias || "—"}</b>
            <span style={{ color: "#1c222b", fontWeight: 600 }}>Valor de cuota</span><b style={{ color: "#16a34a" }}>{mostrarMonto(valorCuota) || "$ 0"}</b>
          </div>
          {showAmortization && amortizacionTable.length > 0 && (
            <div className="max-h-[50vh] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="text-[10px] md:text-sm">
                    <TableHead className="text-[10px] md:text-sm">Cuota</TableHead>
                    <TableHead className="text-[10px] md:text-sm">Fecha</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Saldo Inicial</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Interés</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Capital</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Cuota</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Saldo Final</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {amortizacionTable.map((row) => (
                    <TableRow key={row.cuota} className="text-[10px] md:text-sm">
                      <TableCell className="text-[10px] md:text-sm">{row.cuota}</TableCell>
                      <TableCell className="text-[10px] md:text-sm">{row.fecha}</TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right">
                        {formatCurrency(row.saldoInicial)}
                      </TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right">{formatCurrency(row.interes)}</TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right">{formatCurrency(row.capital)}</TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right font-semibold">
                        {formatCurrency(row.cuotaPago)}
                      </TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right">
                        {formatCurrency(row.saldoFinal)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowSimulacion(false)} style={{ background: "#0f3a80" }}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  )
}


// ── Recibo de la venta ─────────────────────────────────────────────────────

interface DatosReciboVenta {
  esRenovacion: boolean
  /** En una renovación, para traer el nombre real y el documento del cliente. */
  clienteId: string | null
  nombre: string
  documento: string
  valor: number
  tasa: number
  totalAPagar: number
  cuotas: number
  valorCuota: number
  frecuencia: string
  primerPago: string
  abono: number
  entrega: string
  efectivo: number | null
  transferencia: number | null
  /** El día de la venta (YYYY-MM-DD), el que cuenta en el reporte. */
  dia: string
  hora: string
  rutaNombre: string
  vendedor: string
  /** Quedó en la cola del teléfono: todavía no llegó al servidor. */
  sinSenal: boolean
}

/**
 * Dibuja el recibo con el mismo motor que el de pago y el cierre de caja
 * (`lib/imagen-comprobante.ts`). En una renovación el formulario no trae el
 * nombre completo ni el documento, así que se buscan; sin señal queda el
 * alias, que es lo que se tiene.
 */
async function construirReciboVenta(d: DatosReciboVenta) {
  let nombre = d.nombre
  let documento = d.documento
  if (d.clienteId && !d.sinSenal) {
    try {
      const { data } = await createClient()
        .from("clients").select("nombre_completo, documento").eq("id", d.clienteId).maybeSingle()
      const c = data as { nombre_completo?: string | null; documento?: string | null } | null
      if (c?.nombre_completo?.trim()) nombre = c.nombre_completo.trim()
      if (c?.documento?.trim()) documento = c.documento.trim()
    } catch (err) {
      console.warn("[v0] Recibo de venta sin datos del cliente:", err)
    }
  }
  // Mixto en tres renglones: en uno solo no cabe en el ancho del recibo.
  const entrega =
    d.entrega === "mixto"
      ? [
          { label: "Entrega", valor: "Mixto" },
          { label: "  En efectivo", valor: fmtMoneda(d.efectivo) },
          { label: "  En transferencia", valor: fmtMoneda(d.transferencia) },
        ]
      : [{ label: "Entrega", valor: d.entrega === "transferencia" ? "Transferencia" : "Efectivo" }]
  const secciones: SeccionComprobante[] = [
    {
      titulo: "Cliente",
      filas: [
        { label: "Nombre", valor: nombre.toUpperCase() },
        ...(documento ? [{ label: "Documento", valor: documento }] : []),
        { label: "Tipo", valor: d.esRenovacion ? "Renovación" : "Venta nueva" },
      ],
    },
    {
      titulo: "Venta",
      filas: [
        { label: "Valor entregado", valor: fmtMoneda(d.valor), destacado: true },
        ...(d.tasa > 0 ? [{ label: "Interés", valor: `${d.tasa}%` }] : []),
        { label: "Total a pagar", valor: fmtMoneda(d.totalAPagar), destacado: true },
        { label: "Cuotas", valor: `${d.cuotas} de ${fmtMoneda(d.valorCuota)}` },
        { label: "Frecuencia", valor: etiquetaFrecuencia(d.frecuencia) },
        ...(d.primerPago ? [{ label: "Primer pago", valor: fmtFecha(d.primerPago) }] : []),
        ...entrega,
      ],
    },
    ...(d.abono > 0
      ? [{
          titulo: "Abono inicial",
          filas: [
            { label: "Abonó", valor: fmtMoneda(d.abono) },
            { label: "Saldo", valor: fmtMoneda(Math.max(0, d.totalAPagar - d.abono)), destacado: true },
          ],
        }]
      : []),
  ]
  return renderComprobanteImagen({
    titulo: d.esRenovacion ? "Recibo de renovación" : "Recibo de venta",
    subtitulo: d.rutaNombre,
    meta: `${fmtFecha(d.dia)}  ·  ${d.hora}${d.sinSenal ? "  ·  Pendiente de enviar" : ""}`,
    secciones,
    logoUrl: `${window.location.origin}/opad-logo.png`,
    nombreArchivo: `recibo-venta-${nombre.replace(/[^\w]+/g, "-").toLowerCase()}-${d.dia}.png`,
    pie: d.vendedor ? `Vendió: ${d.vendedor}` : "Generado por Feelpay",
  })
}
