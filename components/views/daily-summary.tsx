"use client"

import React from "react"
import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { MapPin, Target, Wallet, Banknote, ShoppingCart, CheckCircle, XCircle, TrendingUp, Receipt, Calendar, Clock, ArrowDownCircle, RotateCcw, CalendarDays, CalendarClock, CalendarRange, Coins, Users, PieChart, LockKeyhole, LockKeyholeOpen, Eye, X, Play, Loader2, Share2, AlertCircle } from "lucide-react"
import { renderComprobanteImagen, type SeccionComprobante } from "@/lib/imagen-comprobante"
import { CompartirComprobanteDialog } from "@/components/compartir-comprobante-dialog"
import { getUsuarioSesion } from "@/lib/movimientos"
import { fmtFecha } from "@/lib/colombia-date"
import { Button } from "@/components/ui/button"
 import { createClient } from "@/lib/supabase/client"
import { getResumenDia } from "@/lib/resumen-dia"
import { ResumenSemanal } from "@/components/resumen-semanal"
import { todayColombia, bandaCartera, etiquetaFrecuencia, fmtMonedaCien, redondearCien } from "@/lib/gestion-core"
import { getRutaUmbrales } from "@/lib/ruta-umbrales"
import { aDolares, formatearMoneda } from "@/lib/monedas"
import { Bandera } from "@/components/bandera"
import { DetalleClientesDialog } from "@/components/detalle-clientes-dialog"
import { PagosDelDiaDialog, type FuentePagos } from "@/components/pagos-del-dia-dialog"
import type { ModoDia } from "@/lib/pagos-del-dia"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type RutaDiariaEstado = "abierta" | "cerrada" | null

interface DailySummaryProps {
  onViewChange?: (view: string) => void
  rutaId?: number
  onRouteStateChange?: (estado: RutaDiariaEstado) => void
  /**
   * EL DÍA DEL QUE HABLA EL RESUMEN, "YYYY-MM-DD".
   *
   * Casi siempre viene vacío y todo es de HOY, como siempre.
   *
   * Trae fecha en un solo caso: la ruta amaneció congelada porque ayer nadie
   * cerró la caja, la secretaría la desbloqueó, y el cobrador está terminando
   * ese día antes de cerrarlo. Ahí el resumen tiene que mostrarle lo de ESE
   * día — es el número con el que va a cuadrar la caja.
   */
  fechaResumen?: string | null
}

interface GastoRegistro {
  id: number
  tipo: string
  concepto: string
  valor: number
  fechahorasol: string
  observacion?: string
}

/**
 * El icono del botón que abre el Informe de Recaudo.
 *
 * Se dibuja a mano en vez de usar el de la librería porque esos son de UN solo
 * color: heredan el color del texto y no hay forma de pintar cada barra
 * distinta. Sobre el botón blanco, tres barras del mismo azul se leían como
 * una mancha; con tres colores se reconoce como una gráfica de un vistazo.
 *
 * Los colores salen de la paleta de la app (`globals.css`), no son inventados
 * acá: si mañana cambia la marca, este icono cambia con ella.
 */
function IconoInformeRecaudo() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[22px] w-[22px]"
      aria-hidden="true"
      focusable="false"
    >
      {/* De más baja a más alta, y de ámbar a verde: se lee como algo que va
          subiendo, que es justo de lo que habla el informe. */}
      <rect x="3"  y="13" width="5" height="8"  rx="1.5" fill="var(--warning)" />
      <rect x="9.5" y="8" width="5" height="13" rx="1.5" fill="var(--info)" />
      <rect x="16" y="3"  width="5" height="18" rx="1.5" fill="var(--success)" />
    </svg>
  )
}

/**
 * "BUENOS AIRES" -> "Buenos Aires".
 *
 * En `rutas` conviven las dos formas —"ARGENTINA" y "Argentina"— y la
 * mayuscula sostenida ocupa mas ancho y se lee como si gritara. El mockup las
 * muestra capitalizadas.
 */
function capitalizar(t: string): string {
  return t
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ")
}

export function DailySummary({ onViewChange, rutaId = 1, onRouteStateChange, fechaResumen }: DailySummaryProps) {
  /**
   * EL DÍA DE NEGOCIO DE ESTA PANTALLA.
   *
   * `todayColombia()` salvo cuando se está cerrando una jornada vieja. Lo usan
   * TODAS las lecturas: el recaudo, la caja, los movimientos, el informe y los
   * ojitos.
   *
   * NO lo usan `fetchRutaDiaria` ni `handleIniciarRuta`: esos dos hablan de la
   * jornada de HOY —si está abierta, si hay que iniciarla— y esa pregunta no
   * cambia porque se esté cerrando otra. De hecho no puede: hoy no tiene fila
   * hasta que el día viejo cierre.
   *
   * Se ignora una fecha de hoy o futura, igual que en el módulo de pagos.
   */
  const diaDelResumen =
    fechaResumen && fechaResumen < todayColombia() ? fechaResumen : todayColombia()
  const esResumenAtrasado = diaDelResumen !== todayColombia()
  const [isFlipped, setIsFlipped] = useState(false)

  // Estado de la ruta diaria
  const [rutaDiariaId, setRutaDiariaId] = useState<number | null>(null)
  const [rutaDiariaEstado, setRutaDiariaEstado] = useState<RutaDiariaEstado>(null)
  const [loadingRutaDiaria, setLoadingRutaDiaria] = useState(true)
  const [processingRuta, setProcessingRuta] = useState(false)
  const [selectedDate] = useState(() =>
    new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(new Date())
  )

  // Datos reales de `resumen_diario_v2` (la plata del dia sale del libro de
  // eventos `gestiones`, no de los estados de `payment_plan`).
  const [collectedAmount, setCollectedAmount] = useState(0)
  /**
   * LA MONEDA DE LA RUTA Y LA TASA DE **ESE** DIA.
   *
   * La tasa NO es la de hoy: es la que regia el dia del resumen. Un cierre
   * del 14 tiene que seguir mostrando los dolares que valia el 14, aunque
   * hoy el dolar este al doble. Ver scripts/119.
   */
  const [monedaRuta, setMonedaRuta] = useState<string | null>(null)
  /** Para el saludo: de donde es la ruta y como se llama quien la lleva. */
  const [nombreUsuario, setNombreUsuario] = useState<string>("")
  const [rolUsuario, setRolUsuario] = useState<string>("Cobrador")
  const [paisRuta, setPaisRuta] = useState<string>("")
  const [ciudadRuta, setCiudadRuta] = useState<string>("")
  const [tasaDelDia, setTasaDelDia] = useState<number | null>(null)
  const [cargandoTasa, setCargandoTasa] = useState(false)
  const [metaAmount, setMetaAmount] = useState(0)
  const [cantidadPagos, setCantidadPagos] = useState(0)
  const [cantidadNoPagos, setCantidadNoPagos] = useState(0)
  /**
   * Qué le toca mostrar a la tabla de clientes, o `null` si está cerrada.
   *
   * Se guarda el OBJETO en el estado y no un booleano: el efecto que carga los
   * datos depende de él, así que construirlo en línea en el JSX crearía uno
   * nuevo en cada render y la consulta entraría en bucle. Creado una vez al
   * hacer clic, la identidad no cambia mientras el diálogo está abierto.
   */
  const [pagosDialog, setPagosDialog] = useState<FuentePagos | null>(null)
  const [valorIngresos, setValorIngresos] = useState(0)
  const [valorGastos, setValorGastos] = useState(0)
  const [valorRetiros, setValorRetiros] = useState(0)
  const [valorCanceladas, setValorCanceladas] = useState(0)
  // Total de ventas del dia (suma de loans creados hoy en la ruta).
  // Viene del campo `valor_ventas` en `resumen_diario_v2`.
  const [valorVentas, setValorVentas] = useState(0)
  // Efectivo del dia y caja anterior. AMBOS son columnas de la MISMA fila de
  // `resumen_diario_v2`: `efectivo` es el acumulado hasta hoy y
  // `caja_anterior` ese mismo acumulado sin el neto del dia.
  const [efectivo, setEfectivo] = useState(0)
  const [cajaAnterior, setCajaAnterior] = useState(0)
  // El dia no tuvo NINGUN movimiento y la caja viene arrastrada del ultimo
  // dia con registro. Se avisa en pantalla para que un $0 en las tarjetas
  // de movimiento no se lea como "se perdio la plata".
  const [diaSinMovimiento, setDiaSinMovimiento] = useState(false)
  // Recaudo del día partido por forma de pago (script 059).
  const [pagoEfectivo, setPagoEfectivo] = useState(0)
  const [pagoTransferencia, setPagoTransferencia] = useState(0)
  // La unidad trabaja con un solo método de interés. Mientras la config no
  // responde queda en false, o sea se muestra Capital/Intereses — el
  // comportamiento de siempre — en vez de un hueco.
  const [unidadDeUnSoloMetodo, setUnidadDeUnSoloMetodo] = useState(false)

  useEffect(() => {
    let cancelado = false
    getRutaUmbrales(rutaId)
      .then((u) => {
        if (!cancelado) setUnidadDeUnSoloMetodo(u.amortizaciones_habilitadas.length === 1)
      })
      .catch((err) => console.error("[v0] DailySummary umbrales:", err))
    return () => { cancelado = true }
  }, [rutaId])
  // Sumas de capital e intereses del recaudo del dia (aleman vs americano),
  // calculadas por la vista sobre las gestiones del dia.
  const [pagoCapital, setPagoCapital] = useState(0)
  const [pagoIntereses, setPagoIntereses] = useState(0)
  const [loadingResumen, setLoadingResumen] = useState(true)

  // Estado para el diálogo de detalle de gastos/ingresos/retiros
  const [detailDialogOpen, setDetailDialogOpen] = useState(false)
  const [detailType, setDetailType] = useState<"Ingreso" | "Gasto" | "Retiro" | null>(null)
  const [detailRecords, setDetailRecords] = useState<GastoRegistro[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  useEffect(() => {
    const fetchResumen = async () => {
      try {
        const supabase = createClient()
        const fechaHoy = diaDelResumen

        // ── Una sola query filtrada por ruta ─────────────────────────
        // RLS eliminado: filtramos explicitamente con `.eq('ruta', rutaId)`.
        //
        // `resumen_diario_v2` trae TODO el dia en una fila: la plata (desde
        // `gestiones`), los conteos y la caja anterior. Antes habia que pegar
        // tres consultas mas (el dia anterior para la caja y dos conteos
        // sobre payment_plan) y cada una traia su propia definicion.
        // `getResumenDia` trae TODO el dia en una fila: la plata (desde
        // `gestiones`), los conteos y la caja anterior.
        //
        // Y resuelve el arrastre: un dia sin NINGUN movimiento —un domingo,
        // sin cuotas venciendo ni caja— no tiene fila en la vista, y esta
        // pantalla mostraba entonces Caja Anterior $0 y Efectivo $0. La plata
        // de la ruta desaparecia cada domingo y volvia el lunes.
        const { fila: d, sinMovimiento } = await getResumenDia(supabase, rutaId, fechaHoy)
        setDiaSinMovimiento(sinMovimiento)

        setCollectedAmount(d.valor_pago ?? 0)
        setMetaAmount(d.meta_pagos ?? 0)
        // Pagos / No Pagos salen de la MISMA fuente que la plata.
        setCantidadPagos(d.cantidad_pagos ?? 0)
        setCantidadNoPagos(d.cantidad_no_pagos ?? 0)
        setValorIngresos(d.valor_ingresos ?? 0)
        setValorGastos(d.valor_gastos ?? 0)
        setValorRetiros(d.valor_retiros ?? 0)
        setValorCanceladas(d.valor_canceladas ?? 0)
        setValorVentas(d.valor_ventas ?? 0)
        setEfectivo(d.efectivo ?? 0)
        setCajaAnterior(d.caja_anterior ?? 0)
        setPagoCapital(d.pago_capital ?? 0)
        setPagoIntereses(d.pago_intereses ?? 0)
        setPagoEfectivo(d.pago_efectivo ?? 0)
        setPagoTransferencia(d.pago_transferencia ?? 0)
      } catch (err) {
        console.error("[v0] Unexpected error fetching resumen:", err)
      } finally {
        setLoadingResumen(false)
      }
    }

    fetchResumen()
    // `diaDelResumen` entra acá: al desbloquear una jornada vieja esta
    // pantalla pasa a hablar de otro día y hay que volver a leer.
  }, [rutaId, diaDelResumen])

  // La fecha de hoy en Colombia sale de `todayColombia()` (@/lib/gestion-core):
  // una sola definicion para toda la app.

  // Consultar estado de la ruta diaria al montar / cambiar rutaId.
  //
  // SELECT directo sobre `rutas_diarias` filtrando por ruta_id y fecha.
  // (RLS eliminado.)
  useEffect(() => {
    const fetchRutaDiaria = async () => {
      try {
        setLoadingRutaDiaria(true)
        const supabase = createClient()
        const fechaHoy = todayColombia()

        const { data, error } = await supabase
          .from("rutas_diarias")
          .select("id, estado")
          .eq("ruta_id", rutaId)
          .eq("fecha", fechaHoy)
          .maybeSingle()

        if (error) {
          console.error("[v0] rutas_diarias error:", error.message)
          setRutaDiariaId(null)
          setRutaDiariaEstado(null)
        } else if (data) {
          setRutaDiariaId(data.id)
          setRutaDiariaEstado(data.estado as RutaDiariaEstado)
          onRouteStateChange?.(data.estado as RutaDiariaEstado)
        } else {
          setRutaDiariaId(null)
          setRutaDiariaEstado(null)
          onRouteStateChange?.(null)
        }
      } catch (err) {
        console.error("[v0] Unexpected error fetching rutas_diarias:", err)
      } finally {
        setLoadingRutaDiaria(false)
      }
    }

    fetchRutaDiaria()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rutaId])

  // ── La moneda de la ruta y la tasa que regia el dia del resumen ─────────
  //
  // Se busca la tasa cuyo rango CONTIENE `diaDelResumen`, no la ultima
  // cargada: es lo que hace que un cierre viejo siga mostrando los dolares de
  // su dia. La misma regla de `tasa_vigente()` en scripts/119, resuelta aca
  // con un select porque ya se tiene el cliente a mano.
  useEffect(() => {
    let cancelado = false
    const cargar = async () => {
      setCargandoTasa(true)
      try {
        const supabase = createClient()
        const rRuta = await supabase.from("rutas").select("moneda, pais, ciudad").eq("id", rutaId).maybeSingle()
        // Sin el script 118 la columna no existe: se calla y no se muestra la
        // tarjeta, en vez de tumbar el resumen entero.
        const fr = rRuta.data as
          | { moneda?: string | null; pais?: string | null; ciudad?: string | null }
          | null
        const moneda = fr?.moneda ?? null
        if (cancelado) return
        setMonedaRuta(moneda)
        // La 204 tiene pais y ciudad al reves, asi que si el "pais" resulta
        // ser una ciudad conocida se usa la otra columna. Misma regla que
        // `monedaPorPais`.
        const p = (fr?.pais ?? "").trim()
        const c = (fr?.ciudad ?? "").trim()
        const pareceCiudad = /buenos aires|la plata|chaco|cuenca|quito|asunci|cali|ibarra/i.test(p)
        setPaisRuta(pareceCiudad ? c : p)
        setCiudadRuta(pareceCiudad ? p : c)

        if (!moneda || moneda === "USD") {
          setTasaDelDia(moneda === "USD" ? 1 : null)
          return
        }

        const rTasa = await supabase
          .from("tasas_cambio")
          .select("tasa, vigente_desde, vigente_hasta")
          .eq("moneda", moneda)
          .lte("vigente_desde", diaDelResumen)
          .order("vigente_desde", { ascending: false })
          .limit(1)
        if (cancelado) return

        // Sin el script 119 la tabla no existe (PGRST205). No es un error que
        // valga la pena gritar: simplemente todavia no hay tasas.
        if (rTasa.error) {
          setTasaDelDia(null)
          return
        }
        const fila = (rTasa.data ?? [])[0] as
          | { tasa: number; vigente_desde: string; vigente_hasta: string | null }
          | undefined
        // El `limit(1)` trae la mas reciente que empezo antes del dia, pero
        // puede estar YA CERRADA antes de ese dia: entonces ese dia no tiene
        // tasa y hay que decirlo, no estirar la ultima que haya.
        const sirve =
          fila && (fila.vigente_hasta === null || fila.vigente_hasta >= diaDelResumen)
        setTasaDelDia(sirve ? Number(fila!.tasa) : null)
      } catch (err) {
        console.error("[v0] Tasa del dia en el resumen:", err)
        if (!cancelado) setTasaDelDia(null)
      } finally {
        if (!cancelado) setCargandoTasa(false)
      }
    }
    void cargar()
    return () => { cancelado = true }
  }, [rutaId, diaDelResumen])

  // El nombre sale de localStorage, asi que se lee en el cliente y una sola
  // vez: en el render del servidor no existe.
  useEffect(() => {
    const n = (getUsuarioSesion().nombre ?? "").trim()
    // Solo el primer nombre: "Eilyn", no "Eilyn Margarita Rodriguez", que no
    // cabe al lado de la insignia de estado.
    setNombreUsuario(n ? n.split(/\s+/)[0] : "")
    // "Cobrador" es como se llaman ellos mismos; `vendedor` es el nombre
    // interno del rol y en la calle no lo usa nadie.
    try {
      const raw = localStorage.getItem("currentUser")
      const rol = raw ? String((JSON.parse(raw) as { rol?: string }).rol ?? "") : ""
      const bonito: Record<string, string> = {
        vendedor: "Cobrador",
        asesor: "Asesor",
        secretaria: "Secretaria",
        secretario: "Secretario",
        admin: "Administrador",
        administrador: "Administrador",
        gerencia: "Gerencia",
        gerente: "Gerencia",
      }
      setRolUsuario(bonito[rol.toLowerCase()] ?? (rol ? rol[0].toUpperCase() + rol.slice(1) : "Cobrador"))
    } catch {
      /* sesion ilegible: se queda con "Cobrador" */
    }
  }, [])

  const handleIniciarRuta = async () => {
    if (processingRuta) return
    try {
      setProcessingRuta(true)
      const supabase = createClient()
      const fechaHoy = todayColombia()

      const { data, error } = await supabase
        .from("rutas_diarias")
        .insert({
          ruta_id: rutaId,
          fecha: fechaHoy,
          estado: "abierta",
        })
        .select("id, estado")
        .single()

      if (error) {
        console.error("[v0] Error iniciando ruta:", error.message)
        return
      }

      if (data) {
        setRutaDiariaId(data.id)
        setRutaDiariaEstado("abierta")
        onRouteStateChange?.("abierta")
      }
    } catch (err) {
      console.error("[v0] Unexpected error iniciando ruta:", err)
    } finally {
      setProcessingRuta(false)
    }
  }

  // Función para cargar detalles de gastos/ingresos/retiros
  const fetchDetailRecords = async (tipo: "Ingreso" | "Gasto" | "Retiro") => {
    setDetailType(tipo)
    setDetailDialogOpen(true)
    setLoadingDetail(true)
    setDetailRecords([])

    try {
      const supabase = createClient()

      // Ventana del dia DE TRABAJO en zona Colombia (inicio y fin).
      const fechaHoy = diaDelResumen
      // El offset -05:00 es obligatorio: sin el, Postgres interpreta la
      // ventana en UTC y se pierde todo lo registrado despues de las 7 pm
      // hora Colombia.
      const startOfDay = `${fechaHoy}T00:00:00-05:00`
      const endOfDay = `${fechaHoy}T23:59:59-05:00`

      const { data, error } = await supabase
        .from("gastosregistros")
        .select("id, tipo, concepto, valor, fechahorasol, observacion")
        .eq("tipo", tipo)
        .eq("ruta", rutaId)
        .gte("fechahorasol", startOfDay)
        .lte("fechahorasol", endOfDay)
        .order("fechahorasol", { ascending: false })

      if (error) {
        console.error("[v0] Error fetching detail records:", error.message)
        return
      }

      setDetailRecords(data || [])
    } catch (err) {
      console.error("[v0] Error fetching detail:", err)
    } finally {
      setLoadingDetail(false)
    }
  }

  // ── Tarjeta trasera (Informe Recaudo): datos reales ─────────────────────
  // Frecuencias desde las cuotas del dia + loans.frecuencia_pago; "Intereses"
  // = prestamos americanos con cuota hoy. Cartera desde `v_loan_financiero`
  // (columna `cuotas_mora`: CUOTAS vencidas sin cubrir, no dias) con las
  // bandas de `bandaCartera()`. Cuotas Clientes = cuantas cuotas pago cada
  // cliente HOY (la plata neta del dia sobre el valor de su cuota, 1-3 / >3).
  // Ventas: renovacion = cliente que ya tenia otro prestamo.
  const [backCard, setBackCard] = useState({
    frequency: {
      diario: { pagos: 0, total: 0 },
      semanal: { pagos: 0, total: 0 },
      quincenal: { pagos: 0, total: 0 },
      mensual: { pagos: 0, total: 0 },
      intereses: { pagos: 0, total: 0 },
    },
    installmentsByClient: { small: 0, large: 0, fuera: 0 },
    salesReport: { nuevas: 0, renovaciones: 0, total: 0 },
    portfolioStatus: { alDia: 0, mora: 0, vencidos: 0 },
  })

  // Los préstamos que componen cada contador de la cara trasera, para poder
  // abrir "quiénes son". Se llenan en el MISMO recorrido que calcula los
  // números (ver `loadBackCard`).
  const [backIds, setBackIds] = useState<{
    freq: Record<string, string[]>
    pagaronHoy: Set<string>
    cuotas: { small: string[]; large: string[] }
    ventas: { nuevas: string[]; renovaciones: string[]; total: string[] }
    cartera: { alDia: string[]; mora: string[]; vencidos: string[] }
  }>({
    freq: { diario: [], semanal: [], quincenal: [], mensual: [], intereses: [] },
    pagaronHoy: new Set(),
    cuotas: { small: [], large: [] },
    ventas: { nuevas: [], renovaciones: [], total: [] },
    cartera: { alDia: [], mora: [], vencidos: [] },
  })

  // El detalle de personas que está abierto. `null` = ninguno.
  const [detalleClientes, setDetalleClientes] = useState<{
    titulo: string
    subtitulo?: string
    ids: string[]
    marcados?: Set<string>
    mostrarValorVenta?: boolean
    ocultarFicha?: boolean
  } | null>(null)

  const abrirDetalle = (
    titulo: string,
    ids: string[],
    extra?: {
      subtitulo?: string
      marcados?: Set<string>
      mostrarValorVenta?: boolean
      ocultarFicha?: boolean
    },
  ) => setDetalleClientes({ titulo, ids, ...extra })

  /**
   * Los dos ítems del Resumen Financiero que son personas —Canceladas y
   * Ventas— no se calculan en esta pantalla: vienen ya sumados de
   * `resumen_diario_v2`. Así que sus préstamos se resuelven al abrir el
   * ojito, repitiendo el MISMO criterio de la vista para que la lista
   * coincida con el monto.
   */
  const abrirDetalleFinanciero = async (cual: "canceladas" | "ventas") => {
    try {
      const supabase = createClient()
      const hoy = diaDelResumen

      if (cual === "ventas") {
        const { data } = await supabase
          .from("loans")
          .select("id")
          .eq("ruta", rutaId)
          .gte("fecha_creacion", `${hoy}T00:00:00-05:00`)
          .lte("fecha_creacion", `${hoy}T23:59:59-05:00`)
        // Las RENOVACIONES también son ventas desde el script 123: el resumen
        // las cuenta, así que el detalle tiene que mostrarlas.
        const { data: renov } = await supabase
          .from("gestiones")
          .select("loan_id, detalle")
          .eq("ruta", rutaId)
          .eq("fecha_gestion", hoy)
          .eq("tipo", "ajuste")
          .eq("estado", "aplicada")
        const idsRenov = ((renov ?? []) as { loan_id: string; detalle?: { clase?: string } | null }[])
          .filter((g) => g.detalle?.clase === "renovacion")
          .map((g) => g.loan_id)
        const ids = [...new Set([
          ...((data ?? []) as { id: string }[]).map((l) => l.id),
          ...idsRenov,
        ])]
        abrirDetalle("Ventas de hoy", ids, {
          subtitulo: `${ids.length} ${ids.length === 1 ? "venta" : "ventas"}`,
          mostrarValorVenta: true,
          ocultarFicha: true,
        })
        return
      }

      // Canceladas = préstamos cuyo ÚLTIMO movimiento de plata fue hoy y que
      // quedaron en cero. Es la definición de la vista (script 054).
      const { data: movs } = await supabase
        .from("gestiones")
        .select("loan_id")
        .eq("ruta", rutaId)
        .eq("fecha_gestion", hoy)
        .eq("estado", "aplicada")
        .neq("origen", "homologacion")
        .in("tipo", ["pago", "cancelacion", "abono_venta", "reversa"])
      const candidatos = [...new Set(((movs ?? []) as { loan_id: string }[]).map((g) => g.loan_id))]
      if (candidatos.length === 0) {
        abrirDetalle("Créditos cancelados hoy", [], { subtitulo: "Ninguno", ocultarFicha: true })
        return
      }
      const { data: fin } = await supabase
        .from("v_loan_financiero")
        .select("loan_id, saldo")
        .in("loan_id", candidatos)
      const ids = ((fin ?? []) as { loan_id: string; saldo: number | null }[])
        .filter((f) => Number(f.saldo ?? 0) <= 0)
        .map((f) => f.loan_id)
      // CANCELADAS VA CON LA FICHA COMPLETA, como el resto de los ojitos.
      //
      // Antes iba con `ocultarFicha`, que deja la tabla en DOS columnas
      // —nombre y frecuencia— porque se pensó para Ventas: ahí la pregunta es
      // "qué se vendió hoy y por cuánto", y la ficha del crédito estorba.
      //
      // En una cancelación la pregunta es otra: QUIÉN TERMINÓ DE PAGAR y cómo
      // le fue. Con la ficha se ve la fecha de venta, el %, en cuántas cuotas
      // lo pagó y su último pago — que es lo mismo que muestra Pagos, No pagos
      // y Pendientes. Se pidió "el mismo formato del resto del módulo".
      abrirDetalle("Créditos cancelados hoy", ids, {
        subtitulo: `${ids.length} ${ids.length === 1 ? "crédito quedó" : "créditos quedaron"} en cero`,
        // El valor prestado se conserva: en una cancelación es justo lo que se
        // quiere comparar contra lo que acabó de pagar.
        mostrarValorVenta: true,
      })
    } catch (err) {
      console.error("[v0] abrirDetalleFinanciero:", err)
    }
  }

  /** El ojito. Se apaga solo cuando el grupo está vacío. */
  const Ojito = ({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) => (
    <Button
      variant="ghost"
      size="icon"
      className="h-4 w-4 p-0 shrink-0"
      title="Ver quiénes son"
      aria-label="Ver quiénes son"
      onClick={onClick}
      disabled={disabled}
    >
      <Eye className={`h-3 w-3 ${disabled ? "text-muted-foreground/30" : "text-muted-foreground"}`} />
    </Button>
  )

  useEffect(() => {
    const loadBackCard = async () => {
      try {
        const supabase = createClient()
        const fechaHoy = diaDelResumen

        const [rowsHoyRes, activosRes, ventasHoyRes, gestionesHoyRes] = await Promise.all([
          supabase
            .from("payment_plan")
            .select("loan_id, estado, monto_pagado, loans(frecuencia_pago, tipo_amortizacion)")
            .eq("ruta", rutaId)
            .eq("fecha_pago", fechaHoy),
          // `valor_cuota` viene para poder decir CUÁNTAS CUOTAS pagó cada
          // cliente hoy, y el estado se filtra acá abajo en vez de en la
          // consulta: quien terminó de pagar hoy quedó 'cancelado' y su pago
          // tiene que contar igual.
          supabase.from("loans").select("id, valor_cuota, estado").eq("ruta", rutaId),
          supabase
            .from("loans")
            .select("id, client_id")
            .eq("ruta", rutaId)
            // Una venta anulada no cuenta como venta del día. Anular es casi
            // siempre "me equivoqué" el mismo día en que se hizo, así que cae
            // justo en este rango y engordaba el conteo con una venta que ya
            // no existe.
            .neq("estado", "anulado")
            .gte("fecha_creacion", `${fechaHoy}T00:00:00-05:00`)
            .lte("fecha_creacion", `${fechaHoy}T23:59:59-05:00`),
          // LA PLATA DE HOY, DEL LIBRO. Es el mismo criterio del script 060:
          // suman pago, cancelación y abono de venta; resta la reversa. Y las
          // homologaciones quedan fuera, que no son plata de esta ruta hoy.
          supabase
            .from("gestiones")
            .select("loan_id, tipo, monto")
            .eq("ruta", rutaId)
            .eq("fecha_gestion", fechaHoy)
            .eq("estado", "aplicada")
            .neq("origen", "homologacion")
            .in("tipo", ["pago", "cancelacion", "abono_venta", "reversa"]),
        ])

        const rowsHoy = (rowsHoyRes.data ?? []) as {
          loan_id: string
          estado: string
          monto_pagado: number | null
          loans: { frecuencia_pago: string | null; tipo_amortizacion: string | null } | null
        }[]
        // OJO: este predicado NO es el `esPagoReal` de @/lib/gestion-core.
        // Aquel evalua una GESTION ({tipo, monto, estado}); aqui las filas son
        // CUOTAS de payment_plan, cuyo `estado` es el cache de la cascada. Se
        // deja local a proposito para no forzar dos cosas distintas en el
        // mismo nombre: este cuadro cuenta cuotas del cronograma, no eventos.
        const cuotaConPago = (row: { estado: string; monto_pagado: number | null }) =>
          ["pagado", "parcial", "cancelada"].includes(row.estado) && Number(row.monto_pagado ?? 0) > 0
        const frequency = {
          diario: { pagos: 0, total: 0 },
          semanal: { pagos: 0, total: 0 },
          quincenal: { pagos: 0, total: 0 },
          mensual: { pagos: 0, total: 0 },
          intereses: { pagos: 0, total: 0 },
        }
        // Los préstamos que componen cada número, recogidos en el MISMO
        // recorrido que lo calcula: así el ojito no puede mostrar una lista
        // distinta del contador que abrió.
        const idsFreq: Record<string, string[]> = {
          diario: [], semanal: [], quincenal: [], mensual: [], intereses: [],
        }
        const idsPagaronHoy = new Set<string>()
        for (const row of rowsHoy) {
          // El mapeo frecuencia -> etiqueta vive en gestion-core (FRECUENCIAS).
          const key = etiquetaFrecuencia(row.loans?.frecuencia_pago).toLowerCase() as
            "diario" | "semanal" | "quincenal" | "mensual"
          frequency[key].total += 1
          idsFreq[key].push(row.loan_id)
          if (cuotaConPago(row)) { frequency[key].pagos += 1; idsPagaronHoy.add(row.loan_id) }
          if (row.loans?.tipo_amortizacion?.toLowerCase().trim() === "americano") {
            frequency.intereses.total += 1
            idsFreq.intereses.push(row.loan_id)
            if (cuotaConPago(row)) frequency.intereses.pagos += 1
          }
        }

        // ── CUOTAS CLIENTES: LO QUE SE COBRÓ HOY, no lo acumulado ────────
        //
        // Contaba `cuotas_cubiertas`: cuántas cuotas lleva pagas el cliente en
        // TODA la vida del crédito. Eso no es un dato del día — es el mismo
        // número mañana y pasado, y en un informe de recaudo diario se leía
        // como si midiera la jornada.
        //
        // Ahora es lo que pidió el dueño: de la plata que entró HOY, quiénes
        // pagaron entre 1 y 3 cuotas y quiénes más de 3. La cuenta es la plata
        // neta del día dividida por el valor de la cuota de ese crédito, la
        // misma división de `cuotasConDecimal` y de la regla de oro del 084.
        const todosLosCreditos = (activosRes.data ?? []) as {
          id: string; valor_cuota: number | null; estado: string | null
        }[]
        const cuotaPorLoan = new Map(
          todosLosCreditos.map((l) => [l.id, Number(l.valor_cuota) || 0]),
        )
        const netoHoyPorLoan = new Map<string, number>()
        for (const g of (gestionesHoyRes.data ?? []) as
             { loan_id: string; tipo: string; monto: number | null }[]) {
          const signo = g.tipo === "reversa" ? -1 : 1
          netoHoyPorLoan.set(
            g.loan_id,
            (netoHoyPorLoan.get(g.loan_id) ?? 0) + signo * (Number(g.monto) || 0),
          )
        }

        const installmentsByClient = { small: 0, large: 0, fuera: 0 }
        const idsCuotas = { small: [] as string[], large: [] as string[] }
        for (const [loanId, neto] of netoHoyPorLoan) {
          // Sin plata no hay cuotas que contar. Un neto en cero es un pago que
          // se anuló el mismo día: no fue un cobro.
          if (neto <= 0) continue
          const cuota = cuotaPorLoan.get(loanId) ?? 0
          const cuantas = cuota > 0 ? neto / cuota : 0
          if (cuantas >= 1 && cuantas <= 3) { installmentsByClient.small += 1; idsCuotas.small.push(loanId) }
          else if (cuantas > 3) { installmentsByClient.large += 1; idsCuotas.large.push(loanId) }
          // Menos de una cuota: abonó, pero no completó ninguna. No cae en
          // ninguna de las dos bandas que se pidieron y se cuenta aparte para
          // poder decirlo en el pie en vez de que el total mienta.
          else installmentsByClient.fuera += 1
        }

        // Cartera (prestamos activos de la ruta)
        const loanIds = todosLosCreditos.filter((l) => l.estado === "activo").map((l) => l.id)
        const portfolioStatus = { alDia: 0, mora: 0, vencidos: 0 }
        const idsCartera = { alDia: [] as string[], mora: [] as string[], vencidos: [] as string[] }
        if (loanIds.length > 0) {
          // Las cuotas PAGADAS y la mora salen de la MISMA vista, asi que
          // se piden en una sola consulta. Antes habia un viaje extra a
          // `payment_plan` para contar vencidas; ya no hace falta.
          const finRes = await supabase
            .from("v_loan_financiero")
            .select("loan_id, cuotas_mora")
            .in("loan_id", loanIds)
          const moraPorLoan = new Map<string, number>()
          for (const f of (finRes.data ?? []) as {
            loan_id: string; cuotas_mora: number | null
          }[]) {
            moraPorLoan.set(f.loan_id, Number(f.cuotas_mora ?? 0))
          }
          for (const id of loanIds) {
            // Las bandas las decide `bandaCartera()`, no una escalera local.
            const banda = bandaCartera(moraPorLoan.get(id) ?? 0)
            if (banda === "al_dia") { portfolioStatus.alDia += 1; idsCartera.alDia.push(id) }
            else if (banda === "mora") { portfolioStatus.mora += 1; idsCartera.mora.push(id) }
            else { portfolioStatus.vencidos += 1; idsCartera.vencidos.push(id) }
          }
        }

        // Ventas del dia: renovacion = el cliente ya tenia otro prestamo
        const ventasHoy = (ventasHoyRes.data ?? []) as { id: string; client_id: string }[]
        let nuevas = 0
        let renovaciones = 0
        const idsVentas = { nuevas: [] as string[], renovaciones: [] as string[] }
        if (ventasHoy.length > 0) {
          const clientIds = [...new Set(ventasHoy.map((v) => v.client_id))]
          const { data: prevLoans } = await supabase
            .from("loans")
            .select("id, client_id")
            .in("client_id", clientIds)
          const loansPorCliente = new Map<string, number>()
          for (const l of (prevLoans ?? []) as { id: string; client_id: string }[]) {
            loansPorCliente.set(l.client_id, (loansPorCliente.get(l.client_id) ?? 0) + 1)
          }
          for (const v of ventasHoy) {
            if ((loansPorCliente.get(v.client_id) ?? 1) > 1) { renovaciones += 1; idsVentas.renovaciones.push(v.id) }
            else { nuevas += 1; idsVentas.nuevas.push(v.id) }
          }
        }

        setBackCard({
          frequency,
          installmentsByClient,
          salesReport: { nuevas, renovaciones, total: ventasHoy.length },
          portfolioStatus,
        })
        setBackIds({
          freq: idsFreq,
          pagaronHoy: idsPagaronHoy,
          cuotas: idsCuotas,
          ventas: { ...idsVentas, total: ventasHoy.map((v) => v.id) },
          cartera: idsCartera,
        })
      } catch (err) {
        console.error("[v0] Error cargando informe recaudo:", err)
      }
    }

    loadBackCard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `diaDelResumen` entra acá: al desbloquear una jornada vieja esta
    // pantalla pasa a hablar de otro día y hay que volver a leer.
  }, [rutaId, diaDelResumen])

  const reportData = {
    totalPayments: cantidadPagos,
    totalPending: cantidadPagos + cantidadNoPagos,
    ...backCard,
  }

  const currentTime = new Date().toLocaleTimeString("es-CO", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Bogota",
  })

  const collectionPercentage = metaAmount > 0 ? (collectedAmount / metaAmount) * 100 : 0
  const remaining = metaAmount - collectedAmount

  /**
   * EL DIA YA SE CERRO.
   *
   * Es lo unico que convierte el recaudo en un resultado: hasta que la caja
   * no se cuadra, la cifra puede seguir subiendo y cualquier veredicto sobre
   * la meta es prematuro.
   *
   * `rutaDiariaEstado` sale de `rutas_diarias`: 'cerrada' es que el cobrador
   * ya hizo el cierre. NULL es que ni siquiera arranco, y 'abierta' es que
   * esta en la calle — en los dos casos el dia sigue abierto.
   */
  const diaCerrado = rutaDiariaEstado === "cerrada"

  /**
   * TODAVIA NO HA ENTRADO UN PESO, y el dia sigue abierto.
   *
   * EL `!diaCerrado` NO SOBRA. Una ruta ya CERRADA con recaudo en cero no es
   * "todavia no empieza": es un dia trabajado en el que no se cobro nada, y
   * ahi el veredicto rojo si corresponde. Decirle "comienza tu jornada" a
   * alguien que ya cerro la caja seria mandarlo a empezar un dia que acaba de
   * terminar.
   */
  const sinRecaudo = collectedAmount <= 0 && !diaCerrado
  /**
   * EL INFORME, COMO IMAGEN.
   *
   * Sale de `reportData` y `backCard`, o sea de los MISMOS números que se
   * están viendo: no se vuelve a consultar nada. Si se recalculara acá, el
   * informe que llega por WhatsApp podría decir algo distinto del que se miró
   * antes de mandarlo.
   *
   * Es el mismo dibujo del cierre de caja y del extracto —logo de la ruta,
   * título y la línea de fecha y hora—, así que llega algo que se reconoce.
   */
  const [compartirInforme, setCompartirInforme] = useState(false)
  const construirImagenInforme = async () => {
    const umbrales = await getRutaUmbrales(rutaId).catch(() => null)
    const money = (n: number) => fmtMonedaCien(n, monedaRuta)
    const ahora = new Date()
    const dia = ahora.toLocaleDateString("es-CO", { timeZone: "America/Bogota" })
    const hora = ahora.toLocaleTimeString("es-CO", {
      timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: true,
    })
    const c = backCard.installmentsByClient
    const cart = backCard.portfolioStatus
    const f = backCard.frequency

    const secciones: SeccionComprobante[] = [
      {
        titulo: "Caja",
        filas: [
          { label: "Caja anterior", valor: money(cajaAnterior) },
          { label: "Efectivo", valor: money(efectivo) },
        ],
      },
      {
        titulo: "Recaudo del día",
        filas: [
          // OJO: `totalPayments` NO es plata, son CLIENTES —`cantidad_pagos`
          // de la vista—. La plata es `collectedAmount`, la misma que muestra
          // la barra de la cara de adelante.
          { label: "Cobrado", valor: `${money(collectedAmount)} / ${money(metaAmount)}` },
          { label: "Clientes que pagaron", valor: `${c.small + c.large + c.fuera}` },
          { label: "Pagaron de 1 a 3 cuotas", valor: `${c.small}` },
          { label: "Pagaron más de 3 cuotas", valor: `${c.large}` },
          ...(c.fuera > 0
            ? [{ label: "Abonaron menos de una cuota", valor: `${c.fuera}` }]
            : []),
        ],
      },
      {
        titulo: "Frecuencia de pago",
        filas: [
          { label: "Diario", valor: `${f.diario.pagos}/${f.diario.total}` },
          { label: "Semanal", valor: `${f.semanal.pagos}/${f.semanal.total}` },
          { label: "Quincenal", valor: `${f.quincenal.pagos}/${f.quincenal.total}` },
          { label: "Mensual", valor: `${f.mensual.pagos}/${f.mensual.total}` },
          { label: "Intereses", valor: `${f.intereses.pagos}/${f.intereses.total}` },
        ],
      },
      {
        titulo: "Estado de la cartera",
        filas: [
          { label: "Al día", valor: `${cart.alDia}` },
          { label: "En mora", valor: `${cart.mora}` },
          { label: "Vencidos", valor: `${cart.vencidos}` },
          { label: "Total clientes", valor: `${cart.alDia + cart.mora + cart.vencidos}` },
        ],
      },
      {
        titulo: "Ventas del día",
        filas: [
          { label: "Nuevas", valor: `${backCard.salesReport.nuevas}` },
          { label: "Renovaciones", valor: `${backCard.salesReport.renovaciones}` },
          { label: "Total", valor: `${backCard.salesReport.total}` },
        ],
      },
    ]

    return renderComprobanteImagen({
      titulo: "Informe Recaudo",
      subtitulo: `Ruta ${rutaId}`,
      meta: `${dia}  ·  ${hora}`,
      secciones,
      logoUrl: umbrales?.logo_url || `${window.location.origin}/opad-logo.png`,
      nombreArchivo: `informe-recaudo-ruta-${rutaId}-${dia.replace(/\//g, "-")}.png`,
      pie: "Generado por Feelpay",
    })
  }

  const paymentPercentage = reportData.totalPending > 0 ? (reportData.totalPayments / reportData.totalPending) * 100 : 0

  // Calculate pie chart segments
  const totalPortfolio = reportData.portfolioStatus.alDia + reportData.portfolioStatus.mora + reportData.portfolioStatus.vencidos
  const alDiaPercent = totalPortfolio > 0 ? (reportData.portfolioStatus.alDia / totalPortfolio) * 100 : 0
  const moraPercent = totalPortfolio > 0 ? (reportData.portfolioStatus.mora / totalPortfolio) * 100 : 0

  return (
    <div className="flex flex-col h-full min-h-0 bg-background" style={{ perspective: "1000px" }}>
      {/* Flip card container */}
      <div
        className="relative w-full h-full transition-transform duration-700"
        style={{
          transformStyle: "preserve-3d",
          transform: isFlipped ? "rotateY(180deg)" : "rotateY(0deg)",
        }}
      >
        {/* FRONT SIDE */}
        <div
          className={`absolute inset-0 flex flex-col bg-background ${isFlipped ? "invisible" : "visible"}`}
          style={{ backfaceVisibility: "hidden" }}
        >
          {/* ── EL ENCABEZADO ────────────────────────────────────────────
              La forma del mockup: la bandera grande a la izquierda, el saludo
              en el medio y, separada por una linea, la columna de la derecha
              con la fecha, la hora y el boton de la jornada.

              El titulo "Resumen del Dia" salio: la barra de arriba de la app
              ya dice en que pantalla esta uno, y el saludo con el nombre
              cumple la misma funcion de encabezado. Eran ~28px que en esta
              pantalla —donde la regla es que todo entre sin scroll— rinden
              mas abajo.

              Los tres botones siguen aca: informe de recaudo y cierre de caja
              como iconos arriba a la derecha, y la jornada como pastilla
              ancha, que es el que se toca todos los dias. */}
          <div className="bg-brand-gradient text-brand-foreground px-3 pt-1.5 pb-1.5 rounded-b-2xl shadow-lg">
            <div className="flex items-center gap-2.5">
              {/* La bandera, grande y redonda */}
              <Bandera
                moneda={monedaRuta}
                pais={paisRuta}
                size={48}
                className="shadow-md ring-2 ring-white/70"
              />

              {/* El saludo */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-bold leading-tight">
                  ¡Hola, {nombreUsuario || "Cobrador"}!
                </p>
                {/* "Secretaria - ARGENTINA" no cabia en 390px y se cortaba
                    justo en el pais. El pais baja al renglon de la ciudad,
                    que iba medio vacio: asi los dos datos se leen enteros sin
                    gastar un renglon mas. */}
                <p className="truncate text-xs leading-tight text-brand-foreground/90">
                  {rolUsuario}
                  {paisRuta ? ` - ${capitalizar(paisRuta)}` : ""}
                </p>
                {ciudadRuta && (
                  <p className="flex items-center gap-1 text-[11px] leading-tight text-brand-foreground/80">
                    <MapPin className="h-3 w-3 shrink-0" />
                    <span className="truncate">{capitalizar(ciudadRuta)}</span>
                  </p>
                )}
              </div>

              {/* La raya que separa, como en el mockup */}
              <div className="h-12 w-px shrink-0 bg-white/30" />

              {/* La columna de la derecha: fecha, hora y la jornada */}
              <div className="flex shrink-0 flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  <div className="text-[11px] leading-tight text-brand-foreground/90">
                    <span className="flex items-center justify-end gap-1 whitespace-nowrap">
                      <Calendar className="h-3 w-3 shrink-0" />
                      {/* LA FECHA DEL ENCABEZADO ES LA DE LOS NUMEROS.
                          Cerrando una jornada vieja decia 04/09 sobre datos
                          del 03/09 — el encabezado contradiciendo a su propio
                          contenido. */}
                      {esResumenAtrasado ? fmtFecha(diaDelResumen) : selectedDate}
                    </span>
                    <span className="flex items-center justify-end gap-1 whitespace-nowrap">
                      <Clock className="h-3 w-3 shrink-0" />
                      {currentTime}
                    </span>
                  </div>

                  {/* Informe de recaudo y cierre de caja. En pastilla blanca
                      con el icono a color: en ghost sobre el degradado se
                      perdian contra el fondo y no se leian como botones. */}
                  <div className="flex flex-col gap-1">
                    <Button
                      size="icon"
                      className="h-7 w-7 rounded-full bg-white hover:bg-white/90 shadow-sm shrink-0"
                      title="Ver el Informe de Recaudo"
                      aria-label="Ver el Informe de Recaudo"
                      onClick={() => setIsFlipped(true)}
                    >
                      <IconoInformeRecaudo />
                    </Button>
                    {/* El candado dice EN QUE ESTADO esta la caja, no solo a
                        donde lleva: abierto y verde durante la jornada,
                        cerrado y rojo cuando ya se cuadro. */}
                    <Button
                      size="icon"
                      className={`h-7 w-7 rounded-full bg-white hover:bg-white/90 shadow-sm shrink-0 ${
                        rutaDiariaEstado === "cerrada" ? "text-destructive" : "text-success"
                      }`}
                      title={
                        rutaDiariaEstado === "cerrada"
                          ? "Caja cerrada — ver el cierre del dia"
                          : "Cierre de Caja"
                      }
                      aria-label="Cierre de Caja"
                      onClick={() => onViewChange?.("cierre-caja")}
                    >
                      {rutaDiariaEstado === "cerrada" ? (
                        <LockKeyhole className="h-4 w-4" />
                      ) : (
                        <LockKeyholeOpen className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* LA JORNADA, en pastilla ancha como el mockup.
                    Las tres ramas son las de siempre —sin iniciar, abierta y
                    cerrada— solo que ahora comparten forma y sitio, asi que
                    el boton no salta de lugar segun el estado. */}
                {!loadingRutaDiaria && (
                  <>
                    {rutaDiariaEstado === null && (
                      <Button
                        className="h-8 gap-1.5 rounded-full bg-white px-3 font-bold text-brand shadow-sm hover:bg-white/90"
                        onClick={handleIniciarRuta}
                        disabled={processingRuta}
                        title="Iniciar la jornada del dia"
                      >
                        {processingRuta ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4 fill-current" />
                        )}
                        <span className="text-xs">Iniciar jornada</span>
                      </Button>
                    )}
                    {rutaDiariaEstado === "abierta" && (
                      <Badge className="h-8 gap-1.5 rounded-full border-0 bg-white px-3 font-bold text-success shadow-sm">
                        <Play className="h-3.5 w-3.5 fill-current" />
                        <span className="text-xs">Jornada abierta</span>
                      </Badge>
                    )}
                    {rutaDiariaEstado === "cerrada" && (
                      <Badge className="h-8 gap-1.5 rounded-full border-0 bg-white px-3 font-bold text-foreground shadow-sm">
                        <CheckCircle className="h-3.5 w-3.5 text-success" />
                        <span className="text-xs">Jornada cerrada</span>
                      </Badge>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* EL RESUMEN TIENE QUE CABER EN UNA PANTALLA.
              Ese es el criterio de todos los tamaños de esta cara: se aprieta
              hasta que entre en un teléfono sin bajar con el dedo. `overflow-auto`
              se queda como red de seguridad para pantallas muy chicas o con el
              texto del sistema agrandado, no como la forma normal de usarlo. */}
          <div className="flex-1 px-2.5 py-1 space-y-0.5 overflow-auto">
            {/* EL DÍA DEL QUE HABLAN ESTOS NÚMEROS.
                Sin esto, el resumen de una jornada atrasada se lee como si
                fuera el de hoy — y es justo al revés de lo que pasaba antes,
                cuando mostraba ceros porque leía un día que todavía no
                empieza. Con el aviso, el número que se ve es el que se va a
                cuadrar en el cierre. */}
            {esResumenAtrasado && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p className="text-[11px] leading-snug text-foreground">
                  <span className="font-bold">Estos números son del {fmtFecha(diaDelResumen)}</span>,
                  el día que estás cerrando. Es lo que va a cuadrar en el cierre de caja.
                </p>
              </div>
            )}
            {/* Dia sin movimiento: la caja viene del ultimo dia con registro */}
            {diaSinMovimiento && (
              <p className="text-[10px] text-muted-foreground px-0.5">
                Hoy no hay movimientos registrados. El efectivo es el que quedó el último día
                con registro.
              </p>
            )}

            {/* Caja Anterior & Efectivo

                EL COLOR LO DECIDE EL SIGNO, no cuál de las dos cajas es.

                Antes Caja Anterior iba SIEMPRE en azul y Efectivo SIEMPRE en
                verde, así que una caja en rojo —plata que falta— se leía igual
                de tranquila que una en orden. La 151 lleva -$591.800 y la 1
                -$199.305, y las dos salían en el color de "todo bien".

                Verde en cero también, no solo en positivo: cero no es un
                problema, es una caja vacía. */}
            <div className="grid grid-cols-2 gap-1.5">
              <Card className="bg-card shadow-sm border-0">
                <CardContent className="px-2 py-0 flex items-center gap-1">
                  <div className={`h-5 w-5 rounded flex items-center justify-center shrink-0 ${
                    redondearCien(cajaAnterior, monedaRuta) < 0 ? "bg-destructive-light" : "bg-success-light"
                  }`}>
                    <Wallet className={`h-3.5 w-3.5 ${redondearCien(cajaAnterior, monedaRuta) < 0 ? "text-destructive" : "text-icon-wallet"}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground font-medium leading-none">Caja Anterior</p>
                    <p className={`text-lg font-bold leading-none ${
                      redondearCien(cajaAnterior, monedaRuta) < 0 ? "text-destructive" : "text-success"
                    }`}>{fmtMonedaCien(cajaAnterior, monedaRuta)}</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card shadow-sm border-0">
                <CardContent className="px-2 py-0 flex items-center gap-1">
                  <div className={`h-5 w-5 rounded flex items-center justify-center shrink-0 ${
                    redondearCien(efectivo, monedaRuta) < 0 ? "bg-destructive-light" : "bg-success-light"
                  }`}>
                    <Banknote className={`h-3.5 w-3.5 ${redondearCien(efectivo, monedaRuta) < 0 ? "text-destructive" : "text-icon-cash"}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground font-medium leading-none">Efectivo</p>
                    <p className={`text-lg font-bold leading-none ${
                      redondearCien(efectivo, monedaRuta) < 0 ? "text-destructive" : "text-success"
                    }`}>{fmtMonedaCien(efectivo, monedaRuta)}</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* ── EL COBRADO, DE PRIMERO ─────────────────────────────
                Va pegado al efectivo y ENCIMA del Resumen Financiero. Es el
                número con el que se abre el día y estaba de último, debajo de
                cinco barras: en el teléfono había que bajar con el dedo para
                ver lo primero que uno quiere ver.

                El medidor y las cifras van LADO A LADO, no apilados. Apilado
                gastaba el doble de alto para decir lo mismo, y era la razón
                principal de que el resumen no cupiera de una sola vista. Se
                quitó además el monto de la meta que salía DOS veces: una
                suelta sobre el medidor y otra en la fila de valores. */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="px-2.5 py-0.5">
                <div className="flex items-center gap-2">
                  {(() => {
                    // Rojo hasta 50%, amarillo hasta 70%, verde por encima.
                    //
                    // PERO SOLO CON LA CAJA YA CERRADA, igual que el mensaje
                    // de abajo: un 30% en rojo a media mañana es el mismo
                    // veredicto prematuro, dicho en color. Mientras el dia
                    // sigue abierto el arco va en azul cielo —avanza y se
                    // llena, sin calificar— y el color de juicio aparece
                    // cuando el numero ya dejo de moverse.
                    const gaugeColor = !diaCerrado
                      ? "var(--info)"
                      : collectionPercentage <= 50
                        ? "var(--destructive)"
                        : collectionPercentage <= 70
                          ? "var(--warning)"
                          : "var(--success)"

                    return (
                      <svg viewBox="0 0 200 110" className="h-12 w-20 shrink-0">
                        <path
                          d="M 20 100 A 80 80 0 0 1 180 100"
                          fill="none"
                          stroke="var(--border)"
                          strokeWidth="14"
                          strokeLinecap="round"
                        />
                        <path
                          d="M 20 100 A 80 80 0 0 1 180 100"
                          fill="none"
                          stroke={gaugeColor}
                          strokeWidth="14"
                          strokeLinecap="round"
                          strokeDasharray={`${(collectionPercentage / 100) * 251.2} 251.2`}
                        />
                        <text x="100" y="90" textAnchor="middle" className="text-4xl font-bold" fill={gaugeColor}>
                          {Math.round(collectionPercentage)}%
                        </text>
                      </svg>
                    )
                  })()}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Recaudo</span>
                      <span className="text-lg font-bold text-foreground tabular-nums leading-tight">
                        {fmtMonedaCien(collectedAmount, monedaRuta)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Meta</span>
                      <span className="text-sm font-semibold text-muted-foreground tabular-nums leading-tight">
                        {fmtMonedaCien(metaAmount, monedaRuta)}
                      </span>
                    </div>

                    {/* EL VEREDICTO SOLO AL CIERRE.
                        "Superaste la meta" o "Meta no superada" es un juicio
                        sobre el dia TERMINADO. Mientras la jornada esta en
                        curso el dia no acabo: a las diez de la mañana faltan
                        seis horas de cobro, y decir "no superada" ahi es
                        juzgar un partido en el primer tiempo.

                        Con la caja ya cerrada el numero deja de moverse y el
                        veredicto si significa algo.

                        Mientras tanto dice "En progreso" con el relojito. Sin meta
                        (`metaAmount === 0`) no hay nada que juzgar ni nada
                        que cobrar, y se dice. */}
                    {metaAmount <= 0 ? (
                      <p className="text-[11px] leading-tight text-muted-foreground">
                        Sin meta para hoy
                      </p>
                    ) : sinRecaudo ? (
                      /* TODAVIA NO HA ENTRADO UN PESO.
                         Va antes que "Por cobrar hoy" porque con el recaudo en
                         cero ese mensaje seria repetir la meta que ya esta
                         justo arriba. Acá lo que hay que decir es que la
                         jornada no ha empezado a moverse. */
                      <div className="flex items-start gap-1.5">
                        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                        <div className="min-w-0">
                          <p className="text-[11px] font-bold leading-tight text-info">
                            Aún sin recaudo registrado
                          </p>
                          <p className="text-[10px] leading-tight text-muted-foreground">
                            Comienza tu jornada para ver el avance
                          </p>
                        </div>
                      </div>
                    ) : !diaCerrado ? (
                      /* EN CURSO: "En progreso" con el relojito, no la cifra
                         que falta. A pedido del dueño: con la jornada andando
                         el "Por cobrar hoy: $X" se leía como una deuda del
                         cobrador; lo que importa ahí es que el día sigue. La
                         meta y el recaudo ya están justo arriba. */
                      remaining > 0 ? (
                        <div className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5 shrink-0 text-info" />
                          <p className="text-[11px] font-bold leading-tight text-info">En progreso</p>
                        </div>
                      ) : (
                        <p className="text-[11px] leading-tight text-muted-foreground">
                          Meta alcanzada — falta cerrar la caja
                        </p>
                      )
                    ) : collectedAmount >= metaAmount ? (
                      <p className="text-[11px] font-bold leading-tight text-success">
                        Superaste la meta del día
                      </p>
                    ) : (
                      <p className="text-[11px] font-bold leading-tight text-destructive">
                        Meta no superada por {fmtMonedaCien(remaining, monedaRuta)}
                      </p>
                    )}
                  </div>
                </div>

                {/* Pagos / No Pagos */}
                <div className="mt-0.5 flex items-center justify-center gap-5 border-t border-border pt-0.5">
                  <div className="flex items-center gap-1">
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span className="text-xs text-muted-foreground">Pagos:</span>
                    <span className="text-sm font-bold text-success">{cantidadPagos}</span>
                    {/* El ojito de los pagos del día: quién pagó, cuánto, y
                        cuántas cuotas alcanzó a cubrir. */}
                    <Ojito
                      disabled={cantidadPagos === 0}
                      onClick={() =>
                        setPagosDialog({ tipo: "dia", rutaId, fecha: diaDelResumen })
                      }
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <XCircle className="h-4 w-4 text-destructive" />
                    <span className="text-xs text-muted-foreground">No Pagos:</span>
                    <span className="text-sm font-bold text-destructive">{cantidadNoPagos}</span>
                    {/* El otro lado de la visita: a quién se fue a cobrar y no
                        dejó plata. Sale del MISMO colapso por cliente que los
                        pagos, así que las dos listas no se pisan — nadie puede
                        estar en las dos. */}
                    <Ojito
                      disabled={cantidadNoPagos === 0}
                      onClick={() =>
                        setPagosDialog({
                          tipo: "dia",
                          rutaId,
                          fecha: diaDelResumen,
                          modo: "no_pagos",
                        })
                      }
                    />
                  </div>
                </div>

                {/* ── Composición del recaudo del día ──────────────────
                    Dos mini-tarjetas con el porcentaje sobre el recaudo.
                    QUÉ muestran depende de cómo trabaje la unidad:

                    · Con UN SOLO método de interés, el desglose
                      Capital/Intereses es degenerado por construcción —
                      sale del `tipo_amortizacion` del préstamo, así que
                      una caja siempre marca $0 y la otra el total. En su
                      lugar se muestra la FORMA DE PAGO, que sí dice algo:
                      cuánto entró en efectivo y cuánto por transferencia.
                    · Con los dos métodos habilitados, el desglose de
                      siempre sí informa y se conserva. */}
                {(() => {
                  const totalRecaudo = collectedAmount
                  // `modo` es lo que hace que la caja tenga ojito o no.
                  //
                  // Efectivo y Transferencia SÍ lo tienen: son una propiedad
                  // del pago —`gestiones.metodo_pago`— así que se puede decir
                  // quién pagó de cada forma.
                  //
                  // Capital e Intereses NO. Ese par no parte los pagos: parte
                  // los PRÉSTAMOS por su método de interés, y la caja de cada
                  // uno es la suma de lo que pagaron los clientes de ese tipo.
                  // Un ojito ahí contestaría otra pregunta —quién tiene
                  // crédito alemán— y no la que hace la tarjeta.
                  const par: { label: string; valor: number; modo: ModoDia | null }[] =
                    unidadDeUnSoloMetodo
                      ? [
                          { label: "Efectivo", valor: pagoEfectivo, modo: "efectivo" },
                          { label: "Transferencia", valor: pagoTransferencia, modo: "transferencia" },
                        ]
                      : [
                          { label: "Capital", valor: pagoCapital, modo: null },
                          { label: "Intereses", valor: pagoIntereses, modo: null },
                        ]
                  return (
                    <div className="mt-0.5 grid grid-cols-2 gap-1.5">
                      {par.map((c) => (
                        <div key={c.label} className="rounded-md border border-border bg-card px-2 py-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground">
                              {c.label}
                              {c.modo && (
                                <Ojito
                                  disabled={c.valor === 0}
                                  onClick={() =>
                                    setPagosDialog({
                                      tipo: "dia",
                                      rutaId,
                                      fecha: diaDelResumen,
                                      modo: c.modo!,
                                      titulo: `Pagos en ${c.label.toLowerCase()}`,
                                    })
                                  }
                                />
                              )}
                            </span>
                            <span className="text-[10px] font-bold text-primary">
                              {(totalRecaudo > 0 ? (c.valor / totalRecaudo) * 100 : 0).toFixed(1)}%
                            </span>
                          </div>
                          <p className="text-sm font-bold text-foreground leading-tight tabular-nums">
                            {fmtMonedaCien(c.valor, monedaRuta)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </CardContent>
            </Card>

            {/* ── Equivalente en dolares ──────────────────────────────────
                Cuanto vale lo recaudado en USD, con la tasa que regia ESE
                dia. Solo aparece si la ruta trabaja en otra moneda: en una
                unidad que ya cobra en dolares seria repetir el mismo numero
                dos veces.

                Sin tarjeta cuando no hay tasa del dia NO: se muestra igual y
                se dice "sin tasa", porque un hueco visible manda a cargarla y
                una tarjeta ausente se lee como que la funcion no existe. */}
            {monedaRuta && monedaRuta !== "USD" && (
              <Card className="border-0 bg-gradient-to-br from-sky-50 to-blue-50 shadow-sm dark:from-sky-950/40 dark:to-blue-950/40">
                <CardContent className="px-2.5 py-0.5">
                  {/* Titulo y tasa EN EL MISMO RENGLON. El subtitulo salio
                      —decia lo mismo que el titulo con mas palabras— y la
                      tasa subio aca: en una tarjeta que solo muestra dos
                      numeros, dos renglones sueltos costaban los ~30px que
                      faltaban para que "Retiros" entrara en pantalla. */}
                  <div className="flex items-center gap-1.5">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold leading-none text-white">
                      $
                    </div>
                    <p className="text-[11px] font-semibold leading-tight text-foreground">
                      Equivalente en dólares
                    </p>
                    {tasaDelDia ? (
                      <p className="ml-auto truncate text-[10px] leading-tight text-muted-foreground">
                        1 USD ={" "}
                        <span className="font-semibold text-foreground tabular-nums">
                          {Number(tasaDelDia).toLocaleString("es-CO", { maximumFractionDigits: 6 })}
                        </span>{" "}
                        {monedaRuta}
                      </p>
                    ) : null}
                  </div>

                  {cargandoTasa ? (
                    <p className="py-2 text-center text-[11px] text-muted-foreground">
                      Buscando la tasa…
                    </p>
                  ) : tasaDelDia ? (
                    <div className="mt-0.5">
                      {/* Los dos montos, mitad y mitad. El bloque de la tasa
                          iba antes a la derecha y le robaba el ancho: en un
                          telefono de 390 el "US$ 1.431,28" salia cortado como
                          "US$ …" y la pagina se iba de lado. Ahora va debajo,
                          que es donde cabe entero. */}
                      <div
                        className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5"
                        title={`Convertido con la tasa del ${fmtFecha(diaDelResumen)}`}
                      >
                        {/* Cada lado con su bandera, como en el mockup. */}
                        <Bandera moneda={monedaRuta} pais={paisRuta} size={18} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-semibold text-muted-foreground">
                            {monedaRuta}
                          </p>
                          <p className="truncate text-sm font-bold leading-tight tabular-nums">
                            {formatearMoneda(collectedAmount, monedaRuta)}
                          </p>
                        </div>
                        <div className="h-6 w-px shrink-0 bg-border" />
                        <Bandera moneda="USD" size={18} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-semibold text-muted-foreground">
                            USD (aprox.)
                          </p>
                          <p className="truncate text-sm font-bold leading-tight tabular-nums text-blue-700 dark:text-blue-300">
                            US$ {(aDolares(collectedAmount, tasaDelDia) ?? 0).toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1.5 rounded-md border border-dashed border-amber-400 bg-amber-50/60 px-2 py-1.5 dark:bg-amber-950/20">
                      <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
                        No hay tasa de cambio cargada para el{" "}
                        {fmtFecha(diaDelResumen)}. Se registra en{" "}
                        <strong>Tasas de Cambio</strong>.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Resumen Financiero - Horizontal Bar Chart */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="px-2.5 py-0.5">
                <p className="text-xs font-semibold text-foreground">Resumen Financiero</p>
                
                {(() => {
                  const items: { label: string; value: number; color: string; textColor: string; icon: React.ElementType; detailType?: "Ingreso" | "Gasto" | "Retiro"; detalleClientes?: "canceladas" | "ventas"; maxOverride?: number }[] = [
                    { label: "Canceladas", value: valorCanceladas, color: "bg-warning", textColor: "text-icon-check", icon: CheckCircle, detalleClientes: "canceladas", maxOverride: collectedAmount },
                    { label: "Ventas", value: valorVentas, color: "bg-info", textColor: "text-icon-sales", icon: ShoppingCart, detalleClientes: "ventas" },
                    { label: "Ingresos", value: valorIngresos, color: "bg-success", textColor: "text-icon-income", icon: TrendingUp, detailType: "Ingreso" },
                    { label: "Gastos", value: valorGastos, color: "bg-destructive", textColor: "text-icon-expense", icon: Receipt, detailType: "Gasto" },
                    { label: "Retiros", value: valorRetiros, color: "bg-icon-withdrawal", textColor: "text-icon-withdrawal", icon: ArrowDownCircle, detailType: "Retiro" },
                  ]
                  const maxValue = Math.max(...items.map(i => i.value), 1)
                  
                  return (
                    <div>
                      {items.map((item) => {
                        const barMax = item.maxOverride ?? maxValue
                        const barPercent = barMax > 0 ? Math.min((item.value / barMax) * 100, 100) : 0
                        return (
                          <div key={item.label} className="flex items-center gap-1.5">
                            <item.icon className={`h-3.5 w-3.5 ${item.textColor} shrink-0`} />
                            {/* El ojo va a la IZQUIERDA del nombre y no al final
                                de la fila. Estaba pegado despues del monto, que
                                tenia ancho fijo: en movil una cifra grande se
                                desbordaba de su caja y se montaba encima del
                                ojo, tapandolo. Las filas sin detalle llevan un
                                hueco del mismo tamano para que los nombres
                                sigan alineados entre si. */}
                            {item.detailType || item.detalleClientes ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-4 w-4 p-0 shrink-0"
                                title={`Ver el detalle de ${item.label.toLowerCase()}`}
                                onClick={() =>
                                  item.detailType
                                    ? fetchDetailRecords(item.detailType)
                                    : void abrirDetalleFinanciero(item.detalleClientes!)
                                }
                              >
                                <Eye className="h-3 w-3 text-muted-foreground" />
                              </Button>
                            ) : (
                              <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                            )}
                            <span className="text-xs text-muted-foreground w-[70px] truncate">{item.label}</span>
                            <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full ${item.color} rounded-full transition-all`}
                                style={{ width: `${barPercent}%` }}
                              />
                            </div>
                            {/* min-w en vez de w: la cifra puede crecer sin
                                desbordarse, y con shrink-0 no la comprime la
                                barra. */}
                            <span className="text-xs font-bold text-foreground min-w-[62px] text-right tabular-nums whitespace-nowrap shrink-0">
                              {fmtMonedaCien(item.value, monedaRuta)}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </CardContent>
            </Card>

            {/* El Resumen Semanal: solo en las rutas que lo tienen encendido
                en su configuración (scripts/121). En las demás no pinta nada. */}
            <ResumenSemanal rutaId={rutaId} fecha={diaDelResumen} moneda={monedaRuta} />

          </div>
        </div>

        {/* BACK SIDE - Informe Recaudo */}
        <div
          className={`absolute inset-0 flex flex-col bg-background ${isFlipped ? "visible" : "invisible"}`}
          style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
        >
          {/* Header with gradient - matching front */}
          <div className="bg-brand-gradient text-brand-foreground px-4 pt-4 pb-3 rounded-b-2xl shadow-lg">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold tracking-tight">Informe Recaudo</h1>
              <div className="flex items-center gap-2">
                {/* COMPARTIR EL INFORME. Pastilla blanca sólida y con texto,
                    no un icono fantasma: sobre el degradado del encabezado un
                    ghost se confunde con el fondo. Es el mismo criterio del
                    cierre de caja. */}
                <Button
                  size="sm"
                  className="h-8 gap-1.5 rounded-full bg-white px-3 text-brand hover:bg-white/90 shadow-sm font-semibold"
                  title="Compartir el informe como imagen"
                  onClick={() => setCompartirInforme(true)}
                >
                  <Share2 className="h-4 w-4" />
                  <span className="text-xs">Compartir</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-brand-foreground hover:bg-foreground/20 h-8 w-8"
                  onClick={() => setIsFlipped(false)}
                >
                  <RotateCcw className="h-5 w-5" />
                </Button>
              </div>
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 px-3 py-2 space-y-2 overflow-auto">
            {/* La cartera va de PRIMERO. Es la foto del negocio —cuantos
                clientes hay y como estan— y responde la pregunta con la que se
                abre el informe. Lo demas (pagos del dia, frecuencias, ventas)
                es el detalle de la jornada, y estaba tapando el titular.

                Estaba de ultima: habia que recorrer todo el informe para
                llegar a ella. */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-2 bg-brand rounded-lg px-2 py-1">
                  <PieChart className="h-3 w-3 text-brand-foreground" />
                  <span className="text-xs font-semibold text-brand-foreground">Estado de la Cartera</span>
                </div>
                <div className="flex items-center justify-between">
                  {/* Pie chart */}
                  <div className="relative w-24 h-24">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                      {/* Al Dia */}
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="var(--status-al-dia)"
                        strokeWidth="20"
                        strokeDasharray={`${alDiaPercent * 2.51} 251`}
                        strokeDashoffset="0"
                      />
                      {/* Mora */}
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="var(--status-mora)"
                        strokeWidth="20"
                        strokeDasharray={`${moraPercent * 2.51} 251`}
                        strokeDashoffset={`${-alDiaPercent * 2.51}`}
                      />
                      {/* Vencidos */}
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="var(--status-vencido)"
                        strokeWidth="20"
                        strokeDasharray={`${(100 - alDiaPercent - moraPercent) * 2.51} 251`}
                        strokeDashoffset={`${-(alDiaPercent + moraPercent) * 2.51}`}
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="text-center">
                        <span className="text-[10px] text-status-al-dia font-bold">Al Día</span>
                        <p className="text-base font-bold text-status-al-dia">{reportData.portfolioStatus.alDia}</p>
                      </div>
                    </div>
                  </div>
                  {/* Legend */}
                  <div className="space-y-2">
                    {([
                      { key: "alDia",    label: "Al Día",   punto: "bg-status-al-dia",  texto: "text-status-al-dia",
                        n: reportData.portfolioStatus.alDia,    ids: backIds.cartera.alDia },
                      { key: "mora",     label: "Mora",     punto: "bg-status-mora",    texto: "text-status-mora",
                        n: reportData.portfolioStatus.mora,     ids: backIds.cartera.mora },
                      { key: "vencidos", label: "Vencidos", punto: "bg-status-vencido", texto: "text-status-vencido",
                        n: reportData.portfolioStatus.vencidos, ids: backIds.cartera.vencidos },
                    ] as const).map(({ key, label, punto, texto, n, ids }) => (
                      <div key={key} className="flex items-center gap-2">
                        <Ojito
                          disabled={n === 0}
                          onClick={() =>
                            abrirDetalle(`Cartera — ${label.toLowerCase()}`, [...ids], {
                              subtitulo: `${n} de ${totalPortfolio} ${totalPortfolio === 1 ? "cliente" : "clientes"}`,
                            })
                          }
                        />
                        <div className={`h-3 w-3 rounded-full ${punto}`} />
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <span className={`text-xs font-bold ${texto}`}>{n}</span>
                      </div>
                    ))}
                    {/* Total de la cartera: sin denominador, "12 en mora" no
                        dice si la ruta está mal o si tiene 300 clientes. */}
                    <div className="flex items-center gap-2 border-t pt-1.5">
                      <Ojito
                        disabled={totalPortfolio === 0}
                        onClick={() =>
                          abrirDetalle("Cartera completa", [
                            ...backIds.cartera.alDia,
                            ...backIds.cartera.mora,
                            ...backIds.cartera.vencidos,
                          ], { subtitulo: `${totalPortfolio} ${totalPortfolio === 1 ? "cliente" : "clientes"} con crédito activo` })
                        }
                      />
                      <div className="h-3 w-3" />
                      <span className="text-xs font-medium text-muted-foreground">Total</span>
                      <span className="text-xs font-bold text-foreground">{totalPortfolio}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Pagos Realizados - Gauge Card */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  {/* Circular progress gauge */}
                  <div className="relative w-20 h-20">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="var(--border)"
                        strokeWidth="10"
                      />
                      <circle
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke="url(#pagosGradient2)"
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={`${paymentPercentage * 2.51} 251`}
                      />
                      <defs>
                        <linearGradient id="pagosGradient2" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="var(--success)" />
                          <stop offset="100%" stopColor="var(--success)" />
                        </linearGradient>
                      </defs>
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-base font-bold text-brand">{Math.round(paymentPercentage)}%</span>
                    </div>
                  </div>
                  {/* Pagos stats.
                      PAGOS CONTRA NO PAGOS. El denominador era
                      `pagos + no pagos`, así que un día sin ningún no pago
                      imprimía "1/1", "2/2", "3/3" — pasó de verdad: ruta 1 el
                      21 y el 25/08, ruta 197 el 21 y el 22/08. Se leía como
                      "1 de 1 cliente" cuando la ruta tiene once.

                      Ahora el segundo número son los NO pagos, con el color
                      que cada uno tiene en toda la app. Los rótulos van
                      debajo y coloreados: sin ellos, "8 / 7" se lee como "8
                      de 7", que es justo el malentendido del que se viene. */}
                  <div className="flex-1 pl-4">
                    <p className="text-sm text-muted-foreground font-medium">Pagos Realizados</p>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-3xl font-bold text-success tabular-nums">
                        {cantidadPagos}
                      </span>
                      <span className="text-2xl font-light text-muted-foreground">/</span>
                      <span className="text-3xl font-bold text-destructive tabular-nums">
                        {cantidadNoPagos}
                      </span>
                    </div>
                    <p className="text-[10px] leading-none">
                      <span className="font-semibold text-success">pagos</span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="font-semibold text-destructive">no pagos</span>
                    </p>
                    <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-muted">
                      {/* La barra reparte los dos, no mide un avance contra un
                          total: si hoy hubo 8 pagos y 4 no pagos, se ve dos
                          tercios verde y un tercio rojo. */}
                      <div className="bg-success h-full transition-all" style={{ width: `${paymentPercentage}%` }} />
                      <div className="bg-destructive h-full transition-all" style={{ width: `${100 - paymentPercentage}%` }} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Frecuencia de Pago y Cuotas Clientes, una debajo de la otra.
                Antes iban lado a lado, a media pantalla. La tarjeta de cuotas
                pasó al diseño de filas con barra y no cabe en media columna:
                el número grande y la barra quedaban encimados. */}
            <div className="grid grid-cols-1 gap-2">
              {/* Frecuencia de Pago */}
              <Card className="bg-card shadow-sm border-0">
                <CardContent className="p-2">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="h-5 w-5 rounded-full bg-info-light flex items-center justify-center">
                      <Clock className="h-2.5 w-2.5 text-icon-calendar" />
                    </div>
                    <span className="text-xs font-semibold text-foreground">Frecuencia de Pago</span>
                  </div>
                  {/* Las cinco filas son iguales salvo el ícono, así que se
                      recorren: el ojito se define una vez y no cinco. */}
                  <div className="space-y-0.5">
                    {([
                      { key: "diario",    label: "Diario",    Icono: CheckCircle,   tono: "text-success" },
                      { key: "semanal",   label: "Semanal",   Icono: CalendarDays,  tono: "text-icon-calendar" },
                      { key: "quincenal", label: "Quincenal", Icono: CalendarClock, tono: "text-icon-clock" },
                      { key: "mensual",   label: "Mensual",   Icono: CalendarRange, tono: "text-icon-withdrawal" },
                      { key: "intereses", label: "Intereses", Icono: Coins,         tono: "text-icon-wallet" },
                    ] as const).map(({ key, label, Icono, tono }) => {
                      const f = reportData.frequency[key]
                      const ids = backIds.freq[key] ?? []
                      return (
                        <div key={key} className="flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <Ojito
                              disabled={ids.length === 0}
                              onClick={() =>
                                abrirDetalle(`Frecuencia ${label.toLowerCase()}`, ids, {
                                  subtitulo: `${f.pagos} de ${f.total} ya pagaron hoy`,
                                  marcados: backIds.pagaronHoy,
                                })
                              }
                            />
                            <Icono className={`h-2.5 w-2.5 ${tono}`} />
                            <span className="text-xs text-muted-foreground">{label}:</span>
                          </div>
                          <span className="text-xs font-bold text-foreground">
                            {f.pagos}
                            <span className="text-muted-foreground font-normal">/{f.total}</span>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Cuotas Clientes: clientes agrupados por cuotas PAGADAS.
                  Empezó midiendo cuotas vencidas y el dueño lo corrigió: es
                  cuánto lleva pagado cada cliente, como decía el mockup.

                  Las bandas son las dos que pidió el dueño: de 1 a 3 cuotas
                  pagas y más de 7. NO cubren a todos los clientes de la ruta
                  —quedan fuera los que no han pagado nada y los que van entre
                  4 y 7— y eso es deliberado: se le mostró que 42 de los 138
                  se caían de la tarjeta y aun así las eligió. Por eso el pie
                  dice cuántos quedaron fuera, para que 32 + 64 no se lea como
                  la cartera entera.

                  Dice "1 a 3" y no "0,1 a 3" como se pidió literal porque la
                  cuenta es por cuotas SALDADAS, que nunca traen decimales
                  (una visita cierra una cuota, script 075): son exactamente
                  los mismos clientes, y el "0,1" haría creer que existen
                  fracciones que acá no existen.

                  Los colores van al revés de cuando esto medía vencidas:
                  llevar pocas cuotas pagadas ya no es lo verde. Pero tampoco
                  es una alarma —una venta reciente lleva pocas sin que nada
                  esté mal— así que el primer grupo es azul informativo, no
                  naranja. */}
              <Card className="bg-card shadow-sm border-0">
                <CardContent className="p-3">
                  <div className="mb-2 flex items-start gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-success-light">
                      <Users className="h-4 w-4 text-icon-users" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold leading-tight text-foreground">Cuotas Clientes</p>
                      {/* Cerrando una jornada vieja el día no es hoy, y la
                          tarjeta no puede decir que sí. */}
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        {esResumenAtrasado
                          ? `Cuántas cuotas pagó cada cliente el ${fmtFecha(diaDelResumen)}`
                          : "Cuántas cuotas pagó cada cliente HOY"}
                      </p>
                    </div>
                  </div>

                  <div className="divide-y divide-border rounded-xl border border-border">
                    {([
                      { key: "small", badge: "1-3", label: "Pagaron de 1 a 3 cuotas",
                        anillo: "bg-info-light text-info", barra: "bg-info",
                        n: reportData.installmentsByClient.small, ids: backIds.cuotas.small },
                      { key: "large", badge: "+3", label: "Pagaron más de 3 cuotas",
                        anillo: "bg-success-light text-success", barra: "bg-success",
                        n: reportData.installmentsByClient.large, ids: backIds.cuotas.large },
                    ] as const).map(({ key, badge, label, anillo, barra, n, ids }) => {
                      const total = reportData.installmentsByClient.small + reportData.installmentsByClient.large
                      // La barra compara los dos grupos entre sí. Sin total no
                      // hay nada que comparar y se deja en cero.
                      const pct = total > 0 ? (n / total) * 100 : 0
                      return (
                        <div key={key} className="flex items-center gap-2.5 p-2.5">
                          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${anillo}`}>
                            {badge}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1">
                              {/* El ojito va POR GRUPO y no uno solo arriba:
                                  se pidió poder ver los clientes de cierta
                                  cantidad de cuotas, y eso es por grupo.

                                  Abre la MISMA tabla que el ojito de Pagos en
                                  el Resumen —nombre con apodo, la plata en
                                  verde, las cuotas, el saldo y el ojo de
                                  historial— en vez del detalle genérico, que
                                  es lo que se pidió. */}
                              <Ojito
                                disabled={ids.length === 0}
                                onClick={() =>
                                  setPagosDialog({
                                    tipo: "creditos",
                                    loanIds: [...ids],
                                    titulo: label,
                                    // El día del que habla la tarjeta. Con
                                    // esto la tabla muestra lo que pagó HOY
                                    // cada uno y cuántas cuotas cubrió, en vez
                                    // del acumulado del crédito entero.
                                    fecha: diaDelResumen,
                                  })
                                }
                              />
                              <span className="truncate text-xs font-semibold text-foreground">{label}</span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div className={`${barra} h-full rounded-full transition-all`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className={`text-xl font-bold leading-none tabular-nums ${key === "small" ? "text-info" : "text-success"}`}>
                              {n}
                            </p>
                            <p className="text-[10px] text-muted-foreground">clientes</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* El total es EL DE HOY: cuánta gente puso plata. Las dos
                      filas no lo agotan —quien abonó menos de una cuota no cae
                      en ninguna— y por eso se dice aparte en vez de dejar que
                      la suma se lea como el total. */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg bg-success-light/50 px-2.5 py-1.5">
                    <Users className="h-3 w-3 text-icon-users" />
                    <span className="text-[11px] text-muted-foreground">
                      {esResumenAtrasado ? "Pagaron ese día:" : "Pagaron hoy:"}
                    </span>
                    <span className="text-[11px] font-bold text-success">
                      {reportData.installmentsByClient.small +
                        reportData.installmentsByClient.large +
                        reportData.installmentsByClient.fuera}
                    </span>
                    {reportData.installmentsByClient.fuera > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        · {reportData.installmentsByClient.fuera} abonaron menos de una cuota
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Informe Ventas */}
            <Card className="bg-card shadow-sm border-0">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-2 bg-brand rounded-lg px-2 py-1">
                  <ShoppingCart className="h-3 w-3 text-brand-foreground" />
                  <span className="text-xs font-semibold text-brand-foreground">Informe Ventas</span>
                </div>
                {/* Las barras se escalan contra la más alta, igual que en el
                    Resumen Financiero. Antes eran `n * 20px` SIN TECHO dentro
                    de un contenedor de 56px: con 3 ventas la barra ya medía
                    60px y, como el contenedor alinea al fondo y no recortaba,
                    el excedente crecía hacia arriba y se montaba sobre el
                    título "Informe Ventas". */}
                {(() => {
                  const { nuevas, renovaciones } = reportData.salesReport
                  const tope = Math.max(nuevas, renovaciones, 1)
                  // 44px de los 56 del contenedor: los 12 restantes son el
                  // número que va encima de cada barra.
                  const alto = (n: number) => `${Math.max((n / tope) * 44, 6)}px`
                  return (
                <div className="flex items-center justify-between">
                  <div className="flex items-end gap-3">
                    {/* Bar chart */}
                    <div className="flex items-end gap-2 h-14 overflow-hidden">
                      <div className="flex flex-col items-center">
                        <span className="text-xs font-bold text-info mb-1">{nuevas}</span>
                        <div className="w-8 bg-info rounded-t" style={{ height: alto(nuevas) }} />
                        <span className="text-[10px] text-muted-foreground mt-1">Nuevas</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-xs font-bold text-warning mb-1">{renovaciones}</span>
                        <div className="w-8 bg-warning rounded-t" style={{ height: alto(renovaciones) }} />
                        <span className="text-[10px] text-muted-foreground mt-1">Renov.</span>
                      </div>
                    </div>
                    {/* Los ojitos van al lado de las barras y no encima: ahí
                        arriba pelearían con el número por el mismo espacio. */}
                    <div className="flex flex-col gap-0.5 pb-4">
                      <div className="flex items-center gap-1">
                        <Ojito
                          disabled={nuevas === 0}
                          onClick={() => abrirDetalle("Ventas nuevas de hoy", backIds.ventas.nuevas, {
                            subtitulo: `${nuevas} ${nuevas === 1 ? "venta" : "ventas"}`,
                            mostrarValorVenta: true,
                            ocultarFicha: true,
                          })}
                        />
                        <span className="text-[9px] text-muted-foreground">Nuevas</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Ojito
                          disabled={renovaciones === 0}
                          onClick={() => abrirDetalle("Renovaciones de hoy", backIds.ventas.renovaciones, {
                            subtitulo: `${renovaciones} ${renovaciones === 1 ? "renovación" : "renovaciones"}`,
                            mostrarValorVenta: true,
                            ocultarFicha: true,
                          })}
                        />
                        <span className="text-[9px] text-muted-foreground">Renov.</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 border border-border rounded-lg p-2">
                    <Ojito
                      disabled={reportData.salesReport.total === 0}
                      onClick={() => abrirDetalle("Ventas de hoy", backIds.ventas.total, {
                        subtitulo: `${reportData.salesReport.total} en total`,
                        mostrarValorVenta: true,
                        ocultarFicha: true,
                      })}
                    />
                    <CalendarDays className="h-5 w-5 text-icon-calendar" />
                    <span className="text-xl font-bold text-foreground">{reportData.salesReport.total}</span>
                  </div>
                </div>
                  )
                })()}
              </CardContent>
            </Card>

          </div>
        </div>
      </div>

      {/* Quiénes son las personas detrás de cada número.
          Va ACÁ, fuera del contenedor con `perspective`/`preserve-3d`: dentro
          de una cara de la tarjeta quedaría sometido a la rotación 3D y se
          vería espejado. */}
      <DetalleClientesDialog
        open={detalleClientes !== null}
        onOpenChange={(v) => { if (!v) setDetalleClientes(null) }}
        titulo={detalleClientes?.titulo ?? ""}
        subtitulo={detalleClientes?.subtitulo}
        loanIds={detalleClientes?.ids ?? []}
        marcados={detalleClientes?.marcados}
        mostrarValorVenta={detalleClientes?.mostrarValorVenta}
        ocultarFicha={detalleClientes?.ocultarFicha}
        moneda={monedaRuta}
      />

      {/* Los pagos del dia. Va aca por la misma razon que el de arriba:
          dentro de una cara de la tarjeta lo rotaria el `preserve-3d`. */}
      <PagosDelDiaDialog
        open={pagosDialog !== null}
        onOpenChange={(v) => { if (!v) setPagosDialog(null) }}
        fuente={pagosDialog}
      />

      {/* Compartir el informe: el MISMO diálogo del cierre de caja y del
          extracto —compartir, descargar o mandar al chat— con la guarda del
          AbortError cuando alguien cancela el menú nativo.

          Va acá abajo por lo mismo que los otros dos: dentro de una cara de la
          tarjeta lo rotaría el `preserve-3d` y saldría espejado. */}
      <CompartirComprobanteDialog
        open={compartirInforme}
        onOpenChange={setCompartirInforme}
        construirImagen={construirImagenInforme}
        mensajeChat={`Informe Recaudo — Ruta ${rutaId}`}
        currentUser={{ id: getUsuarioSesion().id ?? 0, nombre: getUsuarioSesion().nombre }}
        titulo="Compartir el informe"
      />

      {/* Dialog para detalle de Ingresos/Gastos/Retiros */}
      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detailType === "Ingreso" && <TrendingUp className="h-5 w-5 text-success" />}
              {detailType === "Gasto" && <Receipt className="h-5 w-5 text-destructive" />}
              {detailType === "Retiro" && <ArrowDownCircle className="h-5 w-5 text-icon-withdrawal" />}
              {detailType}s del Día
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-auto">
            {loadingDetail ? (
              <div className="flex items-center justify-center py-8">
                <span className="text-sm text-muted-foreground">Cargando...</span>
              </div>
            ) : detailRecords.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <span className="text-sm text-muted-foreground">No hay {detailType?.toLowerCase()}s registrados hoy</span>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Hora</TableHead>
                    <TableHead className="text-xs">Concepto</TableHead>
                    <TableHead className="text-xs text-right">Valor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailRecords.map((record) => {
                    const fecha = new Date(record.fechahorasol)
                    const hora = fecha.toLocaleTimeString("es-CO", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: true,
                      timeZone: "America/Bogota",
                    })
                    return (
                      <TableRow key={record.id}>
                        <TableCell className="text-xs text-muted-foreground">{hora}</TableCell>
                        <TableCell className="text-xs">
                          <div className="truncate max-w-[150px]" title={record.concepto}>
                            {record.concepto}
                          </div>
                          {record.observacion && (
                            <div className="text-[10px] text-muted-foreground truncate max-w-[150px]" title={record.observacion}>
                              {record.observacion}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs font-medium text-right">
                          {fmtMonedaCien(record.valor, monedaRuta)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>
          
          {detailRecords.length > 0 && (
            <div className="border-t pt-3 mt-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total:</span>
                <span className="text-sm font-bold">
                  {fmtMonedaCien(detailRecords.reduce((sum, r) => sum + r.valor, 0), monedaRuta)}
                </span>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
