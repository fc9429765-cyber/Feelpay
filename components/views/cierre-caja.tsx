"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ArrowLeft, Calendar, Clock, Wallet, Banknote, Target, ShoppingCart,
  CheckCircle, Receipt, ArrowDownCircle, TrendingUp, CreditCard,
  CalendarDays, CalendarClock, Coins, Users, AlertCircle, XCircle,
  FileDown, Lock, LockKeyhole, LockKeyholeOpen, AlertTriangle, CheckCircle2, Loader2, Share2,
} from "lucide-react"
 import { createClient } from "@/lib/supabase/client"
import { getResumenDia } from "@/lib/resumen-dia"
import { clientesSinGestionarHoy, type FrecuenciaKey } from "@/lib/dashboard-data"
import { todayColombia, bandaCartera, sumarDias } from "@/lib/gestion-core"
import { fmtFecha } from "@/lib/colombia-date"
import { contarPendientes, suscribirCola } from "@/lib/offline-queue"
import { getRutaUmbrales } from "@/lib/ruta-umbrales"
import { renderComprobanteImagen, type SeccionComprobante } from "@/lib/imagen-comprobante"
import { CompartirComprobanteDialog } from "@/components/compartir-comprobante-dialog"

interface CierreCajaProps {
  onBack: () => void
  rutaId?: number
  rutaNombre?: string
  /**
   * Avisa al contenedor que la jornada quedó cerrada. Sin esto el estado de
   * `rutas_diarias` que tiene la app arriba se queda en "abierta" hasta la
   * siguiente recarga, y el bloqueo del vendedor no entraba en vigor sino
   * hasta que cerraba y volvía a abrir la app.
   */
  onRouteStateChange?: (estado: "abierta" | "cerrada" | null) => void
  /** Hace falta para poder mandar el cierre al chat de la app. */
  currentUser?: { id: number | string; nombre: string }
  /**
   * LA JORNADA QUE SE ESTA CERRANDO, "YYYY-MM-DD". Sin ella, hoy.
   *
   * Es como se hace el CIERRE ATRASADO: la ruta que amanecio congelada porque
   * ayer nadie cerro la caja manda a esta misma pantalla con la fecha de ayer,
   * y al cerrarla la ruta queda libre para empezar el dia de hoy.
   *
   * Una fecha de hoy o futura se ignora y se cae a hoy: esta pantalla escribe
   * en `rutas_diarias`, y no hay jornada que cerrar en un dia que no ocurrio.
   */
  fechaJornada?: string
  /**
   * Se llama cuando queda cerrada una jornada de un DIA PASADO.
   *
   * No se puede reusar `onRouteStateChange`: ese avisa del estado de la ruta
   * HOY, y cerrar la caja de ayer no cierra la de hoy — al contrario, es lo
   * que habilita empezarla.
   */
  onJornadaAtrasadaCerrada?: () => void
  /**
   * SALIR DESPUES DE HABER CERRADO UN DIA VIEJO.
   *
   * Reemplaza a `onBack` solo en ese caso. El padre lo usa para RECARGAR la
   * app entera: cerrada la jornada vieja, el cobrador tiene que quedar como
   * si abriera la app por primera vez hoy —con "Iniciar Ruta" del dia de
   * HOY—, y hay demasiado estado en memoria (el de la ruta activa, la
   * jornada pendiente) como para ir reseteandolo pieza por pieza.
   *
   * La recarga va acá y no al cerrar, porque al cerrar el cobrador tiene al
   * frente el resumen y el PDF de la jornada: recargar ahi se los borra.
   */
  onSalirTrasCierreAtrasado?: () => void
}

export function CierreCaja({
  onBack, rutaId = 1, rutaNombre = "", onRouteStateChange, currentUser,
  fechaJornada, onJornadaAtrasadaCerrada, onSalirTrasCierreAtrasado,
}: CierreCajaProps) {
  const [compartirAbierto, setCompartirAbierto] = useState(false)
  const _now = new Date()

  // ── QUE DIA SE ESTA CERRANDO ───────────────────────────────────────────
  //
  // Casi siempre hoy. La excepcion es el cierre atrasado: la jornada vieja
  // que dejo la ruta congelada. Todo lo que sigue —los numeros, el papel y el
  // UPDATE de `rutas_diarias`— apunta a `fechaCierre`, no a hoy.
  const hoyColombia = todayColombia()
  const fechaCierre = fechaJornada && fechaJornada < hoyColombia ? fechaJornada : hoyColombia
  const esAtrasado = fechaCierre !== hoyColombia

  // La fecha que se muestra es la de la JORNADA; la hora es la de AHORA,
  // porque es cuando se esta firmando el cierre. En un cierre atrasado las
  // dos se separan, y por eso se dicen las dos.
  const fecha = fmtFecha(fechaCierre)
  const hora = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit", hour12: true }).format(_now)
  const hoyTexto = fmtFecha(hoyColombia)

  // Estado real de la validación
  const [pagosPendientes, setPagosPendientes] = useState<number>(0)
  // Los nombres de quienes faltan. "Faltan 4" sin decir quiénes obliga a
  // repasar la lista cliente por cliente — que es lo que se reportó.
  const [nombresPendientes, setNombresPendientes] = useState<string[]>([])
  // Los mismos que el panel de pagos cuenta en su "X de Y gestionados".
  const [totalCartera, setTotalCartera] = useState<number>(0)
  // Cuántos pagaron y cómo se reparten por frecuencia. Sale del MISMO cálculo
  // que decide si se puede cerrar, para que el reporte no se contradiga solo.
  const [resumenDelDiaRuta, setResumenDelDiaRuta] = useState<{
    pagaron: number
    porFrecuencia: Record<FrecuenciaKey, { pagos: number; total: number }>
  } | null>(null)
  const [loadingPagos, setLoadingPagos] = useState<boolean>(true)

  // Operaciones pendientes (aún mock hasta que se conecte la lógica real)
  const operacionesPendientes: { tipo: string; monto: number; estado: string }[] = []

  // La fecha de hoy en Colombia sale de `todayColombia()` (@/lib/gestion-core):
  // una sola definicion para toda la app.

  /**
   * QUIÉN QUEDÓ SIN VISITAR HOY.
   *
   * Antes esto contaba cuotas de `payment_plan` con `fecha_pago = hoy` y
   * `estado = 'pendiente'`, y por eso señalaba a la gente equivocada.
   *
   * Una cuota que vence hoy se queda en 'pendiente' aunque el cliente HAYA
   * pagado: la plata se reparte de la cuota más vieja hacia adelante, así que
   * quien viene atrasado paga y su cuota de hoy sigue sin cubrir. Medido en la
   * 151 el 25/08: el cierre reportaba 4 cobros sin marcar, y los CUATRO tenían
   * su pago registrado ese mismo día. Mientras tanto el que de verdad faltaba
   * —uno solo— no aparecía por ningún lado.
   *
   * Ahora se pregunta EXACTAMENTE lo que muestra el panel de pagos: se carga
   * con el mismo cargador y se decide con el mismo predicado. Si el panel dice
   * "42 de 42 gestionados", el cierre no tiene por qué opinar distinto.
   *
   * Y se traen los NOMBRES: "faltan 4" sin decir quiénes obliga a revisar la
   * lista cliente por cliente, que es exactamente lo que se reportó.
   */
  useEffect(() => {
    // EN UN CIERRE ATRASADO SE PREGUNTA POR EL DIA QUE SE ESTA CERRANDO.
    //
    // Antes esta pregunta se saltaba entera cuando el cierre era atrasado,
    // porque la funcion solo sabia contestar por HOY y contra una jornada de
    // ayer habria dado la respuesta de otro dia. El efecto secundario fue que
    // se perdio el bloqueo: con la ruta descongelada se podia cerrar dejando
    // clientes sin visitar, que es justo lo que este cierre tiene que impedir.
    //
    // Ahora la funcion recibe el dia (`fecha`), asi que la respuesta es la del
    // dia correcto y el requisito vuelve a correr en los dos casos.
    //
    // Y SI SE PUEDE ARREGLAR: con la ruta descongelada el cobrador termina de
    // registrar los pagos y no pagos que le faltaron de ese dia — para eso se
    // descongela. Cerrar sin eso deja el dia incompleto para siempre.
    let vigente = true
    const fetchPendientes = async () => {
      try {
        setLoadingPagos(true)
        const r = await clientesSinGestionarHoy(createClient(), { rutaId, fecha: fechaCierre })
        if (!vigente) return
        setPagosPendientes(r.sinGestionar.length)
        setNombresPendientes(r.sinGestionar)
        setTotalCartera(r.total)
        setResumenDelDiaRuta({ pagaron: r.pagaron, porFrecuencia: r.porFrecuencia })
      } catch (err) {
        console.error("[v0] Error consultando los clientes del día:", err)
        // Se deja en 0 para NO bloquear el cierre por un problema de red: el
        // cobrador quedaria sin poder cerrar por algo que no es suyo. El
        // Monitoreo sigue mostrando la verdad para quien audite.
        if (vigente) { setPagosPendientes(0); setNombresPendientes([]); setTotalCartera(0) }
      } finally {
        if (vigente) setLoadingPagos(false)
      }
    }

    fetchPendientes()
    return () => { vigente = false }
    // `fechaCierre` va en las dependencias porque ahora es lo que se consulta:
    // al descongelarse la ruta el dia cambia sin desmontar la pantalla, y sin
    // esto se quedaria mostrando los pendientes del dia anterior.
  }, [rutaId, fechaCierre])

  // Operaciones capturadas sin conexion que aun no llegan al servidor. El
  // cierre suma TODO el dia, asi que con pendientes en cola los totales
  // estarian incompletos: no se puede cerrar hasta que la cola drene.
  const [sinSincronizar, setSinSincronizar] = useState(0)
  useEffect(() => {
    const leer = () => { void contarPendientes().then(setSinSincronizar).catch(() => {}) }
    leer()
    return suscribirCola(leer)
  }, [])

  // EL REQUISITO DE "TODOS GESTIONADOS" CORRE SIEMPRE, tambien en el cierre
  // atrasado. Llevaba un `esAtrasado ||` que lo apagaba, y con eso se podia
  // cerrar dejando clientes sin visitar.
  //
  // La COLA tambien: una operacion capturada sin conexion puede ser justo de
  // ese dia, y cerrar antes de que llegue dejaria los totales cortos para
  // siempre.
  const pagosCumple = pagosPendientes === 0
  const operacionesCumple = operacionesPendientes.length === 0
  const colaCumple = sinSincronizar === 0
  const puedesCerrar = pagosCumple && operacionesCumple && colaCumple && !loadingPagos

  // ── Datos reales del cierre ────────────────────────────────────────────
  // Fuentes: resumen_diario_v2 (misma vista que Resumen del Día — los números
  // coinciden entre ambas pantallas por construcción, incluida la Caja
  // Anterior, que ahora es una columna) y v_loan_financiero (cartera, por
  // CUOTAS en mora, con las bandas de `bandaCartera()`).
  type FrecKey = "diario" | "semanal" | "quincenal" | "mensual"
  /**
   * LAS VENTAS DEL DÍA, UNA POR UNA: las nuevas y las renovaciones, con su
   * cliente y su valor. Van al informe imprimible (y a la pantalla y la
   * imagen, que salen de las mismas filas). Es la misma fuente que el "Total
   * Ventas" de `resumen_diario_v2` (script 123): préstamos creados ese día +
   * renovaciones, así que las líneas suman exactamente ese total.
   */
  const [ventasDetalle, setVentasDetalle] = useState<{ tipo: "Nueva" | "Renovación"; cliente: string; valor: number; homologada: boolean }[]>([])
  const [cierreData, setCierreData] = useState({
    cajaAnterior: 0,
    efectivoFinal: 0,
    recaudo: { total: 0, meta: 0, efectivo: 0, transferencia: 0 },
    canceladas: { valor: 0, cantidad: 0 },
    ventas: { total: 0, cantidad: 0 },
    gastos: { valor: 0, cantidad: 0 },
    retiros: { valor: 0, cantidad: 0 },
    ingresos: { valor: 0, cantidad: 0 },
    pagos: { realizados: 0, total: 0 },
    frecuencia: {
      diario: { pagos: 0, total: 0 },
      semanal: { pagos: 0, total: 0 },
      quincenal: { pagos: 0, total: 0 },
      mensual: { pagos: 0, total: 0 },
    } as Record<FrecKey, { pagos: number; total: number }>,
    cartera: { alDia: 0, mora: 0, vencidos: 0 },
  })

  useEffect(() => {
    const loadCierreData = async () => {
      try {
        const supabase = createClient()
        // El dia del cierre, que en un cierre atrasado NO es hoy.
        const fechaObjetivo = fechaCierre

        // `getResumenDia` resuelve el arrastre de la caja: un dia sin ninguna
        // fila —tipico de un domingo— dejaba este cierre en $0 aunque la ruta
        // tuviera plata. Es el mismo helper que usa el Resumen del Dia, para
        // que las dos pantallas no puedan discrepar.
        // La consulta a `payment_plan` por las cuotas que vencian hoy se
        // elimino: era la fuente de "Cant. Pagos" y del desglose por
        // frecuencia, y los dos pasaron al libro. Un viaje de red menos.
        const [resumen, loansRes, ventasRes, renovRes] = await Promise.all([
          getResumenDia(supabase, rutaId, fechaObjetivo),
          supabase.from("loans").select("id").eq("ruta", rutaId).eq("estado", "activo"),
          // Las ventas de ESE día en hora Colombia (el offset es obligatorio).
          supabase
            .from("loans")
            .select("valor, origen, fecha_creacion, apodo_elegido, clients(nombre_completo, apodo, apodo_2)")
            .eq("ruta", rutaId)
            .gte("fecha_creacion", `${fechaObjetivo}T00:00:00-05:00`)
            .lte("fecha_creacion", `${fechaObjetivo}T23:59:59-05:00`)
            .order("fecha_creacion"),
          supabase
            .from("gestiones")
            .select("detalle, loans(apodo_elegido, clients(nombre_completo, apodo, apodo_2))")
            .eq("ruta", rutaId)
            .eq("fecha_gestion", fechaObjetivo)
            .eq("tipo", "ajuste")
            .eq("estado", "aplicada"),
        ])

        type Cli = { nombre_completo?: string | null; apodo?: string | null; apodo_2?: string | null } | null
        const nombre = (c: Cli, elegido?: number | null) =>
          ((elegido === 2 ? c?.apodo_2 : null) || c?.apodo || c?.nombre_completo || "Cliente").trim().toUpperCase()
        const detalleVentas = [
          ...((ventasRes.data ?? []) as unknown as { valor: number; origen: string | null; apodo_elegido: number | null; clients: Cli }[])
            .map((l) => ({ tipo: "Nueva" as const, cliente: nombre(l.clients, l.apodo_elegido), valor: Number(l.valor) || 0, homologada: l.origen === "homologado" })),
          ...((renovRes.data ?? []) as unknown as { detalle: Record<string, unknown> | null; loans: { apodo_elegido: number | null; clients: Cli } | null }[])
            .filter((g) => g.detalle?.clase === "renovacion")
            .map((g) => ({
              tipo: "Renovación" as const,
              cliente: nombre(g.loans?.clients ?? null, g.loans?.apodo_elegido),
              valor: Number(g.detalle?.valor_entregado) || 0,
              homologada: false,
            })),
        ]
        setVentasDetalle(detalleVentas)

        const r = resumen.fila
        const valorPago = Number(r.valor_pago ?? 0)
        const valorIngresos = Number(r.valor_ingresos ?? 0)
        const valorGastos = Number(r.valor_gastos ?? 0)
        const valorRetiros = Number(r.valor_retiros ?? 0)
        const valorVentas = Number(r.valor_ventas ?? 0)
        const efectivo = Number(r.efectivo ?? 0)
        // Caja Anterior: columna de la vista.
        // POR QUE se quitó la aritmética local (`efectivo` menos el neto del
        // día): había DOS fórmulas distintas para el mismo número — esta y la
        // consulta del día anterior de daily-summary — y divergían cuando
        // hubo días sin movimiento o cuando se editó un día pasado.
        const cajaAnterior = Number(r.caja_anterior ?? 0)

        // EL DESGLOSE POR FRECUENCIA TAMBIEN SALE DEL LIBRO.
        //
        // Contaba cuotas —cuantas de las que vencian hoy quedaron en 'pagado'
        // o 'parcial'— igual que "Cant. Pagos". Al corregir ese, este habria
        // quedado contradiciendolo en el MISMO reporte: la 151 es 100% diaria,
        // asi que se habria leido "Cant. Pagos 8/12" arriba y "Frec. Pago
        // Diario 4/12" abajo.
        //
        // Ahora los dos numeros vienen del mismo calculo, el que decide si se
        // puede cerrar. `rowsHoy` ya no se usa para esto.
        const frecuencia: Record<FrecKey, { pagos: number; total: number }> =
          resumenDelDiaRuta
            ? (resumenDelDiaRuta.porFrecuencia as Record<FrecKey, { pagos: number; total: number }>)
            : { diario: { pagos: 0, total: 0 }, semanal: { pagos: 0, total: 0 },
                quincenal: { pagos: 0, total: 0 }, mensual: { pagos: 0, total: 0 } }

        const loanIds = ((loansRes.data ?? []) as { id: string }[]).map((l) => l.id)
        let cartera = { alDia: 0, mora: 0, vencidos: 0 }
        // EL ESTADO DE CARTERA DE ESE DÍA.
        //
        // Hoy sale de `v_loan_financiero`, que calcula la mora contra HOY. Un
        // cierre atrasado no la puede usar (daría la cartera de hoy con la fecha
        // de ayer), así que la RECONSTRUYE a ese día con la misma regla
        // (`carteraAlDia`). Antes la sección se omitía entera (07-oct-2026).
        if (esAtrasado) {
          cartera = await carteraAlDia(supabase, rutaId, fechaObjetivo)
        } else if (loanIds.length > 0) {
          const moraRes = await supabase.from("v_loan_financiero").select("loan_id, cuotas_mora").in("loan_id", loanIds)

          const moraPorLoan = new Map<string, number>()
          for (const m of (moraRes.data ?? []) as { loan_id: string; cuotas_mora: number | null }[]) {
            moraPorLoan.set(m.loan_id, Number(m.cuotas_mora ?? 0))
          }
          for (const id of loanIds) {
            // Las bandas las decide `bandaCartera()`, no una escalera local.
            const banda = bandaCartera(moraPorLoan.get(id) ?? 0)
            if (banda === "al_dia") cartera.alDia += 1
            else if (banda === "mora") cartera.mora += 1
            else cartera.vencidos += 1
          }
        }

        setCierreData({
          cajaAnterior,
          efectivoFinal: efectivo,
          // El recaudo partido por forma de pago (script 059).
          recaudo: {
            total: valorPago,
            meta: Number(r.meta_pagos ?? 0),
            efectivo: Number(r.pago_efectivo ?? 0),
            transferencia: Number(r.pago_transferencia ?? 0),
          },
          canceladas: { valor: Number(r.valor_canceladas ?? 0), cantidad: Number(r.cantidad_canceladas ?? 0) },
          ventas: { total: valorVentas, cantidad: Number(r.cantidad_ventas ?? 0) },
          gastos: { valor: valorGastos, cantidad: Number(r.cantidad_gastos ?? 0) },
          retiros: { valor: valorRetiros, cantidad: Number(r.cantidad_retiros ?? 0) },
          ingresos: { valor: valorIngresos, cantidad: Number(r.cantidad_ingresos ?? 0) },
          // CANT. PAGOS: sale del LIBRO, no del cronograma.
          //
          // Antes esto contaba cuotas: cuántas de las que vencían hoy habían
          // quedado en 'pagado' o 'parcial'. No es lo mismo que cuántos
          // clientes pagaron, y en una ruta con atrasos se separan mucho —
          // la plata de quien viene atrasado tapa cuotas viejas, así que la
          // de hoy sigue sin cubrir aunque el cliente sí haya pagado.
          //
          // Medido en la 151 el 25/08: el cierre decía 4/12 y ese día pagaron
          // OCHO clientes. Las cuentas: 3 cuotas 'pagado' + 1 'parcial' = 4,
          // contra 8 personas que entregaron plata.
          //
          // `cantidad_pagos` de `resumen_diario_v2` ya es "clientes que
          // terminaron el día con plata puesta" (script 070), el mismo número
          // que muestran el Resumen del Día y el Monitoreo. Y el total es la
          // cartera del día, la misma que decide si se puede cerrar.
          //
          // En un cierre ATRASADO `resumenDelDiaRuta` y `totalCartera` no se
          // piden, asi que caen solos al respaldo — que es justo lo correcto
          // ahi: `cantidad_pagos` y `cantidad_no_pagos` salen de la fila de
          // ESE dia, no de hoy.
          pagos: {
            realizados: resumenDelDiaRuta?.pagaron ?? Number(r.cantidad_pagos ?? 0),
            total: totalCartera || Number(r.cantidad_pagos ?? 0) + Number(r.cantidad_no_pagos ?? 0),
          },
          frecuencia,
          cartera,
        })
      } catch (err) {
        console.error("[v0] Error cargando datos del cierre de caja:", err)
      }
    }

    loadCierreData()
    // `totalCartera` entra en las dependencias porque el denominador de
    // "Cant. Pagos" sale de ahi. Lo pone el OTRO efecto —el que decide si se
    // puede cerrar— y llega un instante despues; sin esto, el cierre se
    // quedaria con el total de respaldo del primer render.
  }, [rutaId, totalCartera, resumenDelDiaRuta, fechaCierre, esAtrasado])

  const [cajaCerrada, setCajaCerrada] = useState(false)

  /**
   * SALIR DE ESTA PANTALLA.
   *
   * Si se acaba de cerrar un dia VIEJO, salir no es volver: es recargar la
   * app, para que el cobrador quede con "Iniciar Ruta" del dia de hoy. Va
   * envuelto en una sola funcion —y no repetido en cada boton— porque de esta
   * pantalla se sale por tres lados (la flecha del encabezado, el boton
   * "Volver" del panel de confirmacion, y el menu), y si uno solo se olvidara
   * de recargar el problema volveria justo por ahi.
   */
  const salir = () => {
    if (cajaCerrada && esAtrasado && onSalirTrasCierreAtrasado) {
      onSalirTrasCierreAtrasado()
      return
    }
    onBack()
  }

  /**
   * ¿LA JORNADA YA ESTABA CERRADA AL ENTRAR?
   *
   * `cajaCerrada` solo sabe de esta sesión: arranca en false y se pone en true
   * cuando se cierra la caja ACÁ. Así que al volver a entrar a esta pantalla
   * después de haber cerrado, el encabezado decía "Abierta" sobre una jornada
   * cerrada hace rato — y el PDF y la imagen salían con ese mismo estado.
   *
   * Se pregunta por la jornada de `fechaCierre`, que en un cierre atrasado es
   * la vieja. Ante cualquier error se deja en `null` y manda `cajaCerrada`: no
   * se puede decir "Cerrada" por una consulta que falló.
   */
  const [jornadaCerrada, setJornadaCerrada] = useState<boolean | null>(null)
  useEffect(() => {
    let vigente = true
    const leer = async () => {
      try {
        const { data, error } = await createClient()
          .from("rutas_diarias")
          .select("estado")
          .eq("ruta_id", rutaId)
          .eq("fecha", fechaCierre)
          .maybeSingle()
        if (!vigente) return
        if (error) {
          console.error("[v0] estado de la jornada:", error.message)
          setJornadaCerrada(null)
          return
        }
        const estado = (data as { estado?: string | null } | null)?.estado ?? null
        setJornadaCerrada(estado === null ? null : estado === "cerrada")
      } catch (err) {
        console.error("[v0] estado de la jornada falló:", err)
        if (vigente) setJornadaCerrada(null)
      }
    }
    void leer()
    return () => { vigente = false }
  }, [rutaId, fechaCierre])

  /**
   * LA CAJA ESTÁ CERRADA: por lo que dice la base o porque se acaba de cerrar
   * acá. Es lo que mira todo lo que se MUESTRA — la insignia, el papel, la
   * imagen y el botón del fondo. `cajaCerrada` a secas queda solo para el
   * mensaje de "lo acabás de hacer".
   */
  const estaCerrada = cajaCerrada || jornadaCerrada === true
  const [showModal, setShowModal] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [processingCierre, setProcessingCierre] = useState(false)
  const [cierreError, setCierreError] = useState<string | null>(null)

  const handleCerrarCaja = () => {
    if (!puedesCerrar) {
      setShowModal(true)
      return
    }
    setCierreError(null)
    setShowConfirm(true)
  }

  const confirmarCierre = async () => {
    if (processingCierre) return
    setProcessingCierre(true)
    setCierreError(null)
    try {
      const supabase = createClient()
      const ahora = new Date().toISOString()

      // Finalizar la jornada en rutas_diarias: estado=cerrada + hora_fin=now()
      //
      // El UPDATE apunta a `fechaCierre`, que en un cierre atrasado es la
      // jornada VIEJA — la que tiene congelada la ruta. `estado='abierta'` en
      // el WHERE es lo que impide cerrar dos veces la misma.
      const cambios: Record<string, unknown> = { estado: "cerrada", hora_fin: ahora }
      if (esAtrasado) {
        // ESTE CIERRE SI TIENE CUADRE. Es la diferencia con el "Desbloquear"
        // de la secretaría, que cierra la jornada sin cuadrarla y deja
        // `cerrada_sin_cuadre = true`. Acá se hizo el cierre de verdad, con
        // sus números, así que se marca en false y queda dicho quién y cuándo.
        cambios.cerrada_sin_cuadre = false
        cambios.observacion =
          `Cierre atrasado de la jornada del ${fecha}, hecho el ${hoyTexto} a las ${hora}` +
          (currentUser ? ` por ${currentUser.nombre} (usuario ${currentUser.id}).` : ".")
      }

      const cerrar = (campos: Record<string, unknown>) =>
        supabase
          .from("rutas_diarias")
          .update(campos)
          .eq("ruta_id", rutaId)
          .eq("fecha", fechaCierre)
          .eq("estado", "abierta")
          .select("id")

      let { data, error } = await cerrar(cambios)

      // 42703 = la columna no existe: el script 086 todavía no corrió en esta
      // base. El cierre no puede quedarse trabado por una columna de
      // trazabilidad, así que se reintenta con lo mínimo indispensable.
      if (error && (error as { code?: string }).code === "42703") {
        console.warn("[v0] rutas_diarias sin columnas del script 086; cerrando sin ellas")
        ;({ data, error } = await cerrar({ estado: "cerrada", hora_fin: ahora }))
      }

      if (error) {
        console.error("[v0] Error finalizando jornada:", error.message)
        setCierreError("No se pudo finalizar la jornada. Intenta de nuevo.")
        return
      }

      // Cero filas y sin error = ya estaba cerrada (otra pantalla, otro
      // usuario). No es un fallo: el objetivo ya se cumplió. Se sigue igual,
      // porque tratarlo como error dejaría la ruta congelada sin motivo.
      if ((data ?? []).length === 0) {
        console.warn("[v0] La jornada", fechaCierre, "de la ruta", rutaId, "ya estaba cerrada")
      }

      setCajaCerrada(true)
      setShowConfirm(false)
      if (esAtrasado) {
        // OJO: acá NO se toca el estado de la ruta de hoy. Cerrar la caja de
        // ayer no cierra la de hoy — es justamente lo que habilita iniciarla.
        // Mandar "cerrada" hacia arriba bloquearía al cobrador el día entero.
        onJornadaAtrasadaCerrada?.()
      } else {
        // La jornada quedó cerrada: para el vendedor el día se acabó y no puede
        // hacer más movimientos. Se avisa hacia arriba para que el bloqueo entre
        // en vigor de inmediato, sin esperar a que recargue la app.
        onRouteStateChange?.("cerrada")
      }
    } catch (err) {
      console.error("[v0] Unexpected error finalizando jornada:", err)
      setCierreError("Ocurrió un error al cerrar la caja.")
    } finally {
      setProcessingCierre(false)
    }
  }

  const data = { estado: estaCerrada ? "Cerrada" : "Abierta", ...cierreData }

  const paymentPct = data.pagos.total > 0 ? Math.round((data.pagos.realizados / data.pagos.total) * 100) : 0
  const rutaLabel = rutaNombre ? `Ruta ${rutaId} — ${rutaNombre}` : `Ruta ${rutaId}`

  type RowItem =
    | { type: "section"; label: string }
    | { type: "row"; icon: React.ElementType; iconColor: string; label: string; value: string }
    | { type: "subrow"; label: string; value: string }

  const rows: RowItem[] = [
    { type: "section", label: "Caja" },
    { type: "row", icon: Wallet,          iconColor: "text-icon-wallet",     label: "Caja Anterior",         value: `$${data.cajaAnterior.toLocaleString()}` },
    { type: "row", icon: Banknote,        iconColor: "text-icon-cash",       label: "Efectivo Final",         value: `$${data.efectivoFinal.toLocaleString()}` },

    { type: "section", label: "Recaudo" },
    { type: "row", icon: Target,          iconColor: "text-icon-target",     label: "Total Recaudo",          value: `$${data.recaudo.total.toLocaleString()} (${data.pagos.realizados}) / $${data.recaudo.meta.toLocaleString()}` },
    { type: "subrow", label: "Efectivo:",      value: `$${data.recaudo.efectivo.toLocaleString()}` },
    { type: "subrow", label: "Transferencia:", value: `$${data.recaudo.transferencia.toLocaleString()}` },

    // VENTAS: el total de las nuevas y el de las renovaciones (no una por
    // una, a pedido del dueño 07-oct-2026). Las dos suman el "Total Ventas".
    { type: "section", label: "Ventas" },
    ...(["Nueva", "Renovación"] as const).map((tipo) => {
      const del = ventasDetalle.filter((v) => v.tipo === tipo)
      return {
        type: "subrow" as const,
        label: tipo === "Nueva" ? "Nuevas:" : "Renovaciones:",
        value: `$${del.reduce((a, v) => a + v.valor, 0).toLocaleString()} (${del.length})`,
      }
    }),

    { type: "section", label: "Operaciones" },
    { type: "row", icon: CheckCircle,     iconColor: "text-icon-check",      label: "Canceladas",             value: `$${data.canceladas.valor.toLocaleString()} (${data.canceladas.cantidad})` },
    { type: "row", icon: ShoppingCart,    iconColor: "text-icon-sales",      label: "Total Ventas",           value: `$${data.ventas.total.toLocaleString()} (${data.ventas.cantidad})` },
    { type: "row", icon: Receipt,         iconColor: "text-icon-expense",    label: "Gastos",                 value: `$${data.gastos.valor.toLocaleString()} (${data.gastos.cantidad})` },
    { type: "row", icon: ArrowDownCircle, iconColor: "text-icon-withdrawal", label: "Retiros",                value: `$${data.retiros.valor.toLocaleString()} (${data.retiros.cantidad})` },
    { type: "row", icon: TrendingUp,      iconColor: "text-icon-income",     label: "Ingresos",               value: `$${data.ingresos.valor.toLocaleString()} (${data.ingresos.cantidad})` },

    { type: "section", label: "Pagos" },
    { type: "row", icon: CreditCard,      iconColor: "text-icon-payment",    label: "Cant. Pagos",            value: `${data.pagos.realizados} / ${data.pagos.total} (${paymentPct}%)` },
    // Los de la cartera del día que terminaron sin pagar (la resta de arriba).
    { type: "row", icon: XCircle,         iconColor: "text-status-vencido",  label: "Cant. No Pago",          value: `${Math.max(0, data.pagos.total - data.pagos.realizados)}` },

    // TAMBIÉN EN EL CIERRE ATRASADO (07-oct-2026). El desglose por frecuencia
    // sale de `clientesSinGestionarHoy` con el día del cierre, y la cartera se
    // reconstruye a ese día (`carteraAlDia`): los dos responden por la jornada
    // que se está cerrando, no por hoy.
    ...(([
      { type: "row", icon: CalendarDays,    iconColor: "text-success",         label: "Frec. Pago Diario",      value: `${data.frecuencia.diario.pagos}/${data.frecuencia.diario.total}` },
      { type: "row", icon: CalendarDays,    iconColor: "text-icon-calendar",   label: "Frec. Pago Semanal",     value: `${data.frecuencia.semanal.pagos}/${data.frecuencia.semanal.total}` },
      { type: "row", icon: CalendarClock,   iconColor: "text-icon-clock",      label: "Frec. Pago Quincenal",   value: `${data.frecuencia.quincenal.pagos}/${data.frecuencia.quincenal.total}` },
      { type: "row", icon: Coins,           iconColor: "text-icon-wallet",     label: "Frec. Pago Mensual",     value: `${data.frecuencia.mensual.pagos}/${data.frecuencia.mensual.total}` },

      // "Cuotas Vencidas por Cliente" salió del cierre (02-oct-2026, a pedido
      // del dueño): ni en la pantalla ni en el PDF ni en la imagen, que salen
      // todos de estas mismas filas.

      { type: "section", label: "Estado de Cartera" },
      { type: "row", icon: Users,           iconColor: "text-status-al-dia",   label: "Clientes Al Día",        value: `${data.cartera.alDia}` },
      { type: "row", icon: AlertCircle,     iconColor: "text-status-mora",     label: "Clientes en Mora",       value: `${data.cartera.mora}` },
      { type: "row", icon: XCircle,         iconColor: "text-status-vencido",  label: "Clientes Vencidos",      value: `${data.cartera.vencidos}` },
      { type: "row", icon: Users,           iconColor: "text-icon-wallet",     label: "Total Clientes",         value: `${data.cartera.alDia + data.cartera.mora + data.cartera.vencidos}` },
    ] as RowItem[])),
  ]

  /**
   * La linea chica bajo el titulo, la misma en el PDF y en la imagen.
   *
   * En un cierre atrasado la fecha de la JORNADA y la del CIERRE son dos, y
   * el papel tiene que decir las dos: si solo dijera una, o parece un cierre
   * de hoy con los numeros de ayer, o un cierre de ayer firmado ayer.
   */
  const metaCierre = esAtrasado
    ? `Jornada del ${fecha}  ·  cerrada el ${hoyTexto} a las ${hora}`
    : `${fecha}  ·  ${hora}`

  const handlePDF = () => {
    const win = window.open("", "_blank")
    if (!win) {
      alert("Por favor permite las ventanas emergentes para generar el PDF.")
      return
    }

    const logoUrl = `${window.location.origin}/opad-logo.png`

    // EL PAPEL SALE DE `rows`, LAS MISMAS FILAS DE LA PANTALLA.
    //
    // Antes este HTML repetia las 25 filas escritas a mano: agregar un dato al
    // cierre obligaba a acordarse de tocarlo en dos lados, y cualquier olvido
    // dejaba el papel diciendo algo distinto de la pantalla. Con el cierre
    // atrasado eso habria dolido de una: la pantalla omite la cartera de hoy
    // y el papel la habria impreso igual, bajo la fecha de ayer.
    const filasPdf = rows
      .map((r) => {
        if (r.type === "section") return `    <tr class="section"><td colspan="2">${r.label}</td></tr>`
        const clase = r.type === "subrow" ? "subrow" : "row"
        return `    <tr class="${clase}"><td class="label">${r.label}</td><td class="value">${r.value}</td></tr>`
      })
      .join("\n")

    win.document.write(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <title>Cierre de Caja - ${fecha}</title>
  <style>
    @page { size: A4; margin: 15mm 25mm; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 14px; color: #111; background: white; }
    .wrapper { max-width: 520px; margin: 0 auto; }
    .top-bar { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
    .top-bar img { width: 64px; height: 64px; object-fit: contain; }
    .top-bar .brand { display: flex; flex-direction: column; justify-content: center; }
    .top-bar .brand-name { font-size: 20px; font-weight: bold; color: #0f766e; line-height: 1.1; }
    .top-bar .brand-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .header { background: #0f766e; color: white; padding: 14px 18px; border-radius: 6px; margin-bottom: 16px; text-align: center; }
    .header h1 { font-size: 20px; font-weight: bold; margin-bottom: 4px; }
    .header .sub { font-size: 13px; opacity: 0.88; margin-bottom: 3px; }
    .header .meta { font-size: 13px; opacity: 0.88; }
    table { width: 100%; border-collapse: collapse; }
    .section td { background: #0f766e; color: white; font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.06em; padding: 6px 10px; }
    .row td { padding: 7px 10px; border-bottom: 1px solid #f0f4f8; font-size: 14px; }
    .row .label { color: #374151; }
    .row .value { color: #111; font-weight: 600; text-align: right; white-space: nowrap; }
    .subrow td { background: #f8fafc; padding: 5px 10px 5px 26px; border-bottom: 1px solid #f0f4f8; font-size: 13px; }
    .subrow .label { color: #6b7280; }
    .subrow .value { color: #374151; font-weight: 500; text-align: right; }
    .print-btn { display: block; margin: 20px auto 0; padding: 10px 28px; background: #0f766e; color: white; border: none; border-radius: 6px; font-size: 15px; cursor: pointer; }
    @media print { .print-btn { display: none; } }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="top-bar">
    <img src="${logoUrl}" alt="Logo OPAD Prime" />
    <div class="brand">
      <span class="brand-name">OPAD Prime</span>
      <span class="brand-sub">Sistema de Gestión de Cartera</span>
    </div>
  </div>
  <div class="header">
    <h1>Cierre de Caja</h1>
    <div class="sub">${rutaLabel}</div>
    <div class="meta">${metaCierre} &nbsp;&nbsp; Estado: ${data.estado}</div>
  </div>
  <table><tbody>
${filasPdf}
  </tbody></table>
  <button class="print-btn" onclick="window.print()">Guardar / Imprimir PDF</button>
</div>
</body>
</html>`)
    win.document.close()
  }


  /** Las MISMAS filas de la pantalla, agrupadas por sección, para la imagen. */
  const seccionesComprobante = (): SeccionComprobante[] => {
    const out: SeccionComprobante[] = []
    for (const r of rows) {
      if (r.type === "section") out.push({ titulo: r.label, filas: [] })
      else if (out.length > 0) out[out.length - 1].filas.push({ label: r.label, valor: r.value })
    }
    return out.filter((s) => s.filas.length > 0)
  }

  const construirImagenCierre = async () => {
    // El logo de la RUTA, con el de la app como respaldo. El PDF usaba
    // siempre el de la app, a diferencia del recibo de pago.
    const umbrales = await getRutaUmbrales(rutaId).catch(() => null)
    return renderComprobanteImagen({
      titulo: "Cierre de Caja",
      subtitulo: rutaLabel,
      meta: `${metaCierre}  ·  ${estaCerrada ? "Cerrada" : "Abierta"}`,
      secciones: seccionesComprobante(),
      logoUrl: umbrales?.logo_url || `${window.location.origin}/opad-logo.png`,
      nombreArchivo: `cierre-ruta-${rutaId}-${fecha.replace(/\//g, "-")}.png`,
      pie: esAtrasado ? "Cierre atrasado · Generado por Feelpay" : "Generado por Feelpay",
    })
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      {/* Header */}
      <div className="bg-brand-gradient text-brand-foreground px-4 pt-4 pb-3 rounded-b-2xl shadow-lg shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="text-brand-foreground hover:bg-white/20 h-8 w-8" onClick={salir}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold tracking-tight leading-tight">Cierre de Caja</h1>
              {/* SOLO EL NÚMERO DE LA RUTA.
                  Decía "Ruta 1 — Colombia", y el país no distingue nada: todas
                  las rutas de una pantalla son del mismo. Lo que sí hacía era
                  empujar el título a dos renglones en el teléfono. */}
              <p className="text-[11px] text-brand-foreground/80">Ruta {rutaId}</p>
            </div>
          </div>
          {/* LA PASTILLA DEL ESTADO, SOLA EN LA ESQUINA.
              Compartir y PDF se fueron de acá: los mismos dos botones están al
              final del reporte, que es donde se usan —terminaste de leer, lo
              mandás—. Repetirlos arriba llenaba la esquina de tres cosas y
              dejaba la que importa, el estado de la caja, apretada entre
              medio.

              EL CANDADO DICE EL ESTADO, no solo la palabra: abierto y verde
              mientras la jornada está en curso; cerrado y rojo cuando ya se
              cuadró. Sobre el degradado del encabezado el color solo no
              alcanza — verde y rojo en una pastilla blanca chiquita se parecen
              bastante de reojo y bajo el sol. */}
          <Badge
            className={`gap-1 border-0 bg-white text-xs ${estaCerrada ? "text-destructive" : "text-success"}`}
          >
            {estaCerrada ? (
              <LockKeyhole className="h-3.5 w-3.5" />
            ) : (
              <LockKeyholeOpen className="h-3.5 w-3.5" />
            )}
            {estaCerrada ? "Cerrada" : "Abierta"}
          </Badge>
        </div>
        <div className="flex items-center gap-4 text-sm text-brand-foreground/90 pl-10">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            {/* En un cierre atrasado se dice de QUE dia es la caja, porque no
                es la de hoy y todo el reporte depende de eso. */}
            <span>{esAtrasado ? `Jornada del ${fecha}` : fecha}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            <span>{hora}</span>
          </div>
        </div>
      </div>

      {/* EL AVISO DEL CIERRE ATRASADO.
          Va fuera del degradado y en ambar: quien llega aca lo hace desde una
          ruta congelada, y tiene que saber en un vistazo que esta cerrando
          OTRO dia y que al terminar la ruta queda libre. */}
      {esAtrasado && (
        <div className="mx-3 mt-2 shrink-0 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="space-y-1">
              <p className="text-[13px] font-semibold text-foreground">
                Cierre atrasado — caja del {fecha}
              </p>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Esa jornada quedo sin cerrar y por eso la ruta esta congelada. Al cerrarla
                se habilita para iniciar la de hoy ({hoyTexto}).
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
        <div className="bg-card rounded-xl shadow-sm overflow-hidden">
          {rows.map((row, i) => {
            if (row.type === "section") {
              return (
                <div key={i} className="flex items-center px-3 py-1.5 bg-brand">
                  <span className="text-[13px] font-bold text-brand-foreground uppercase tracking-widest">{row.label}</span>
                </div>
              )
            }
            if (row.type === "subrow") {
              return (
                <div key={i} className="flex items-center justify-between px-3 py-1.5 pl-9 border-b border-border bg-muted/40">
                  <span className="text-[14px] text-muted-foreground">{row.label}</span>
                  <span className="text-[14px] font-medium text-foreground">{row.value}</span>
                </div>
              )
            }
            const Icon = row.icon
            return (
              <div key={i} className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border last:border-0">
                <Icon className={`h-4 w-4 ${row.iconColor} shrink-0`} />
                <span className="text-[15px] text-foreground/80 flex-1">{row.label}</span>
                <span className="text-[15px] font-semibold text-foreground">{row.value}</span>
              </div>
            )
          })}
        </div>

        {/* Las acciones van DENTRO del scroll, al final del reporte, y no en
            una barra pegada abajo.

            El pie fijo tenía sentido para llegar rápido al botón, pero cerrar
            la caja no es una acción que se quiera a un toque de distancia
            estando a mitad del reporte: finaliza la jornada y no se deshace.
            Al fondo de todo, el gesto de bajar hasta él ES la lectura del
            cierre.

            Compartir y PDF quedan acá porque es el momento en que se usan
            —terminaste de leer, lo mandás— y siguen estando arriba en el
            encabezado para cuando se necesiten sin bajar. */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="w-full rounded-xl py-5 text-sm font-semibold flex items-center gap-2"
            onClick={() => setCompartirAbierto(true)}
          >
            <Share2 className="h-4 w-4" />
            Compartir
          </Button>
          <Button
            variant={estaCerrada ? "default" : "outline"}
            className={`w-full rounded-xl py-5 text-sm font-semibold flex items-center gap-2 ${
              estaCerrada ? "bg-success hover:bg-success/90 text-success-foreground" : ""
            }`}
            onClick={handlePDF}
          >
            <FileDown className="h-4 w-4" />
            PDF
          </Button>
        </div>

        {/* Cerrar la caja va de último y separado por una línea: es lo que
            termina la jornada, no una acción más de la fila de arriba. */}
        <div className="mt-4 border-t border-border pt-4 pb-2">
          {cajaCerrada && esAtrasado ? (
            // Se cerro la jornada vieja: la ruta acaba de quedar libre y hay
            // que decirlo, porque es lo que la persona vino a conseguir.
            <div className="rounded-xl border border-success/40 bg-success/10 px-3 py-3 text-center">
              <div className="flex items-center justify-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <span className="text-sm font-semibold text-foreground">
                  Jornada del {fecha} cerrada
                </span>
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                La ruta quedo descongelada. Ya se puede iniciar la del {hoyTexto}.
              </p>
              {/* Al volver se RECARGA la app: el dia viejo ya se cerro y el
                  cobrador tiene que ver "Iniciar Ruta" del dia de hoy, no
                  quedarse con el estado que habia en memoria. */}
              <Button
                variant="outline"
                className="mt-3 w-full rounded-xl text-sm"
                onClick={salir}
              >
                Volver
              </Button>
            </div>
          ) : estaCerrada ? (
            <div className="flex min-h-[52px] items-center justify-center gap-2 bg-muted rounded-xl py-3">
              <LockKeyhole className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">Caja cerrada</span>
            </div>
          ) : (
            <Button
              className="w-full bg-brand hover:bg-brand-light text-brand-foreground font-semibold rounded-xl py-5 text-sm flex items-center gap-2"
              onClick={handleCerrarCaja}
            >
              <Lock className="h-4 w-4" />
              {esAtrasado ? `Cerrar la caja del ${fecha}` : "Cerrar Caja y Finalizar Jornada"}
            </Button>
          )}
        </div>
      </div>

      {/* Compartir el cierre: como imagen por fuera, o al chat de la app */}
      {currentUser && (
        <CompartirComprobanteDialog
          open={compartirAbierto}
          onOpenChange={setCompartirAbierto}
          construirImagen={construirImagenCierre}
          mensajeChat={`Cierre de caja — ${rutaLabel} — ${fecha}`}
          currentUser={currentUser}
          titulo="Compartir el cierre"
        />
      )}

      {/* Modal — Requisitos no cumplidos */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 px-3 pb-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="bg-amber-500 px-4 py-3 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-white" />
              <span className="text-sm font-bold text-white">No se puede cerrar la caja</span>
            </div>
            <div className="px-4 py-4 space-y-3">
              <p className="text-xs text-gray-500">Debes resolver los siguientes pendientes antes de cerrar:</p>

              {!pagosCumple && (
                <div className="flex items-start gap-2.5 bg-amber-50 rounded-lg p-3 border border-amber-100">
                  <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-amber-800">
                      {pagosPendientes === 1 ? "Falta un cliente por visitar" : "Faltan clientes por visitar"}
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      {/* Se dice "X de Y" igual que el panel de pagos: es el
                          MISMO número, y así se ve de una que lo son. */}
                      Llevas <span className="font-bold">{totalCartera - pagosPendientes}</span> de{" "}
                      <span className="font-bold">{totalCartera}</span> gestionados.{" "}
                      {pagosPendientes === 1 ? "Falta" : "Faltan"} por marcar como pagado o no pagado:
                    </p>
                    {/* Los nombres, no solo el número. Sin esto tocaba repasar
                        la lista entera adivinando cuál era. */}
                    {nombresPendientes.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {nombresPendientes.map((n) => (
                          <li key={n} className="text-xs font-medium text-amber-900">• {n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              {!colaCumple && (
                <div className="flex items-start gap-2.5 bg-amber-50 rounded-lg p-3 border border-amber-100">
                  <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-amber-800">Operaciones sin sincronizar</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Hay <span className="font-bold">{sinSincronizar}</span> operación
                      {sinSincronizar === 1 ? "" : "es"} registrada{sinSincronizar === 1 ? "" : "s"} sin
                      conexión que aún no llegan al servidor. Los totales del cierre estarían
                      incompletos. Conéctate a internet y espera a que terminen de enviarse.
                    </p>
                  </div>
                </div>
              )}

              {!operacionesCumple && (
                <div className="flex items-start gap-2.5 bg-red-50 rounded-lg p-3 border border-red-100">
                  <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-red-800">Operaciones sin aprobar</p>
                    <ul className="mt-1 space-y-0.5">
                      {operacionesPendientes.map((op, i) => (
                        <li key={i} className="text-xs text-red-700">
                          • {op.tipo} ${op.monto.toLocaleString()} — {op.estado}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            <div className="px-4 pb-4">
              <Button
                className="w-full bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-sm"
                onClick={() => setShowModal(false)}
              >
                Entendido
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal — Confirmar cierre */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 px-3 pb-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="bg-teal-600 px-4 py-3 flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-white" />
              <span className="text-sm font-bold text-white">Confirmar cierre de caja</span>
            </div>
            <div className="px-4 py-4 space-y-2">
              {esAtrasado ? (
                <>
                  <p className="text-sm text-gray-700">
                    Vas a cerrar la caja del <span className="font-semibold">{fecha}</span>, que
                    quedó sin cerrar. Al quedar cerrada, la ruta se descongela y se puede
                    iniciar la jornada de hoy.
                  </p>
                  <p className="text-xs text-gray-400">
                    Queda registrado hoy {hoyTexto} a las {hora}
                    {currentUser ? `, a nombre de ${currentUser.nombre}` : ""}.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-700">
                    Al cerrar la caja también se <span className="font-semibold">finalizará la jornada</span> del día.
                    ¿Deseas continuar?
                  </p>
                  <p className="text-xs text-gray-400">
                    Esta acción registrará el cierre a las {hora} del {fecha}.
                  </p>
                </>
              )}
              {cierreError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5">
                  <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700">{cierreError}</p>
                </div>
              )}
            </div>
            <div className="px-4 pb-4 flex gap-2">
              <Button
                variant="outline"
                className="flex-1 rounded-xl text-sm"
                onClick={() => setShowConfirm(false)}
                disabled={processingCierre}
              >
                Cancelar
              </Button>
              <Button
                className="flex-1 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-sm gap-1.5"
                onClick={confirmarCierre}
                disabled={processingCierre}
              >
                {processingCierre && <Loader2 className="h-4 w-4 animate-spin" />}
                {processingCierre ? "Cerrando..." : "Sí, cerrar caja"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


/**
 * EL ESTADO DE CARTERA AL CIERRE DE UN DÍA PASADO.
 *
 * La misma regla de `v_loan_financiero` (scripts 043 y 100), pero con "hoy"
 * puesto en el día `dia` en vez de la fecha real:
 *   · cartera   los créditos creados hasta ese día que todavía debían algo
 *   · pagado    lo neto del libro hasta ese día (pagos − reversas)
 *   · vencido   las cuotas con vencimiento antes de `dia − 1` (la del día
 *               anterior todavía no es mora, script 100)
 *   · cuotas en mora = (vencido − pagado) / cuota de referencia, hacia arriba
 * Las bandas las pone `bandaCartera()`, igual que el cierre de hoy.
 */
async function carteraAlDia(
  supabase: ReturnType<typeof createClient>,
  rutaId: number,
  dia: string,
): Promise<{ alDia: number; mora: number; vencidos: number }> {
  const cartera = { alDia: 0, mora: 0, vencidos: 0 }
  const { data: loans } = await supabase
    .from("loans")
    .select("id, valor, valor_a_pagar, estado")
    .eq("ruta", rutaId)
    // Las ventas anuladas nunca fueron cartera.
    .not("estado", "in", "(inactivo,anulado)")
    .lte("fecha_creacion", `${dia}T23:59:59-05:00`)
  const prestamos = (loans ?? []) as { id: string; valor: number; valor_a_pagar: number | null }[]
  if (prestamos.length === 0) return cartera

  const plan = new Map<string, { fecha_pago: string; valor_cuota: number; es_extra: boolean | null }[]>()
  const pagado = new Map<string, number>()
  const ids = prestamos.map((l) => l.id)
  // POR PÁGINAS: la base devuelve hasta 1.000 filas por consulta, y un lote
  // de créditos diarios pasa de ahí en cuotas y pagos. Cortado, el pagado
  // queda corto y la mora sale inflada (medido en la 151: 29 de 83 mal).
  const todas = async <T,>(pedir: (desde: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    const filas: T[] = []
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await pedir(desde)
      if (error) throw error
      const pagina = (data ?? []) as T[]
      filas.push(...pagina)
      if (pagina.length < 1000) return filas
    }
  }
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100)
    const [cuotas, eventos] = await Promise.all([
      todas<{ loan_id: string; fecha_pago: string; valor_cuota: number; es_extra: boolean | null }>((desde) =>
        supabase.from("payment_plan").select("id, loan_id, fecha_pago, valor_cuota, es_extra")
          .in("loan_id", lote).order("id").range(desde, desde + 999)),
      todas<{ loan_id: string; tipo: string; monto: number }>((desde) =>
        supabase.from("gestiones")
          .select("id, loan_id, tipo, monto")
          .in("loan_id", lote)
          .eq("estado", "aplicada")
          .in("tipo", ["pago", "cancelacion", "abono_venta", "reversa"])
          .lte("fecha_gestion", dia)
          .order("id").range(desde, desde + 999)),
    ])
    for (const q of cuotas) {
      const l = plan.get(q.loan_id) ?? []
      l.push(q)
      plan.set(q.loan_id, l)
    }
    for (const g of eventos) {
      pagado.set(g.loan_id, (pagado.get(g.loan_id) ?? 0) + (g.tipo === "reversa" ? -1 : 1) * (Number(g.monto) || 0))
    }
  }

  const corte = sumarDias(dia, -1)
  for (const l of prestamos) {
    const neto = Math.max(0, pagado.get(l.id) ?? 0)
    const total = Number(l.valor_a_pagar ?? l.valor) || 0
    // Ya estaba cancelado ese día: no era cartera.
    if (total - neto <= 0) continue
    const cuotas = plan.get(l.id) ?? []
    const vencido = cuotas.filter((q) => q.fecha_pago < corte).reduce((a, q) => a + (Number(q.valor_cuota) || 0), 0)
    const normales = cuotas.filter((q) => !q.es_extra)
    const ref = Math.max(0, ...(normales.length ? normales : cuotas).map((q) => Number(q.valor_cuota) || 0))
    const cuotasMora = vencido - neto > 0 && ref > 0 ? Math.ceil((vencido - neto) / ref) : 0
    const banda = bandaCartera(cuotasMora)
    if (banda === "al_dia") cartera.alDia += 1
    else if (banda === "mora") cartera.mora += 1
    else cartera.vencidos += 1
  }
  return cartera
}
