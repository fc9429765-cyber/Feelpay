"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { DashboardLayout } from "@/components/dashboard-layout"
import { MainDashboard } from "@/components/views/main-dashboard"
import { ViewClients } from "@/components/views/view-clients"
import { NewClient } from "@/components/views/new-client"
import { InactivationRequests } from "@/components/views/inactivation-requests"
import { ViewLoans } from "@/components/views/view-loans"
import { NewLoan } from "@/components/views/new-loan"
import { MovimientosRevision } from "@/components/views/movimientos-revision"
import { MultasView } from "@/components/views/multas-view"
import { DocumentosView } from "@/components/views/documentos-view"
import { MiPerfil } from "@/components/views/mi-perfil"
import { SecretaryReports } from "@/components/views/secretary-reports"
import { SocioAdminReportes } from "@/components/views/socio-admin-reportes"
import { AdminReportes } from "@/components/views/admin-reportes"
import { SecretaryAdminReportes } from "@/components/views/secretary-admin-reportes"
import { GestionUsuariosRutas } from "@/components/views/gestion-usuarios-rutas"
import { ChatView } from "@/components/views/chat-view"
import { ReportesBi } from "@/components/views/reportes-bi"
import { DailyRoute } from "@/components/views/daily-route"
import { RegisterPayment } from "@/components/views/register-payment"
import { PaymentControl } from "@/components/views/payment-control"
import { MonitoreoRecaudos } from "@/components/views/monitoreo-recaudos"
import { SaleEditor } from "@/components/views/sale-editor"
import { LoanAudit } from "@/components/views/loan-audit"
import { RegisterTransaction } from "@/components/views/register-transaction"
import { ViewExpensesIncome } from "@/components/views/view-expenses-income"
import { DailySummary } from "@/components/views/daily-summary"
import { Movements } from "@/components/views/movements"
import { ManageUsers } from "@/components/views/manage-users"
import { ManageProfiles } from "@/components/views/manage-profiles"
import { RouteConfig } from "@/components/views/route-config"
import { ConfigItems } from "@/components/views/config-items"
import { AuthCodes } from "@/components/views/auth-codes"
import { GeneralConfig } from "@/components/views/general-config"
import { ConfigureRoute } from "@/components/views/configure-route"
import { ReporteAdministrador } from "@/components/views/reporte-administrador"
import { ReporteGerencial } from "@/components/views/reporte-gerencial"
import { DescargarInforme } from "@/components/views/descargar-informe"
import { TasasCambio } from "@/components/views/tasas-cambio"
import { ResumenRutas } from "@/components/views/resumen-rutas"
import { CierreCaja } from "@/components/views/cierre-caja"
import { AdminRouteMonitor } from "@/components/views/admin-route-monitor"
import { AdminDashboard } from "@/components/views/admin-dashboard"
import { DetalleRuta } from "@/components/views/detalle-ruta"
import { RouteSelector, type SelectedRuta } from "@/components/route-selector"
import { RutaNoIniciada } from "@/components/views/ruta-no-iniciada"
import { AvisoVersionNueva } from "@/components/actualizar-app"
import {
  marcarDiaDeSesion, limpiarDiaDeSesion, marcarActividad,
  motivoDeCaducidad, mensajeDeCaducidad,
} from "@/lib/sesion-diaria"
import { LoginView, type AuthenticatedUser } from "@/components/views/login-view"
import { LoginSplash } from "@/components/login-splash"
import { PinLockView } from "@/components/views/pin-lock-view"
import { RutaCongelada, AvisoJornadaCongelada } from "@/components/jornada-congelada"
import { buscarJornadaPendiente, puedeDescongelar, type JornadaPendiente } from "@/lib/jornada-pendiente"
import {
  requierePin, INACTIVIDAD_PIN_MS, marcarActividadPin, pasoElTiempoSinTocar,
  inactividadPin,
} from "@/lib/pin-lock"
import { SESSION_LOST_EVENT, getSupabaseSafe } from "@/lib/api-helper"
import { guardarRutasOffline, leerRutasOffline } from "@/lib/credenciales-offline"
import { limpiarCache } from "@/lib/offline-cache"
import { createClient } from "@/lib/supabase/client"
import { ALL_MODULES, isDefaultMobileNav, type PermissionsMap } from "@/lib/modules-catalog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Loader2, ShieldAlert, RefreshCw } from "lucide-react"

async function loadUserPermissions(userId: number, rol: string): Promise<PermissionsMap | null> {
  const k = `permisosOffline:${userId}`
  try {
    const { data, error } = await createClient()
      .from("user_permissions")
      .select("view_id, enabled, in_mobile_nav")
      .eq("user_id", userId)
    // SIN SEÑAL: los permisos de la última vez que se leyeron. Sin esto el
    // menú caía a los de su rol y a alguien con permisos personalizados le
    // aparecían o desaparecían módulos al perder la señal.
    if (error) {
      try {
        const raw = localStorage.getItem(k)
        if (raw) return JSON.parse(raw) as PermissionsMap
      } catch { /* sin cache */ }
      return null
    }
    // Sin filas: el usuario nunca tuvo permisos personalizados -> null le
    // indica al sidebar/mobile-nav que use los defaults de rol tal cual.
    if (!data || data.length === 0) return null

    const overrides = new Map<string, { enabled: boolean; inMobileNav: boolean }>()
    data.forEach((row) => {
      overrides.set(row.view_id, { enabled: row.enabled, inMobileNav: row.in_mobile_nav })
    })

    // Para cada modulo del catalogo: usar el override guardado si existe: si
    // no, caer al default de su rol. Sin este merge, un modulo agregado
    // DESPUES de que a este usuario se le personalizaron permisos queda
    // invisible para siempre (sin fila en user_permissions = "deshabilitado"),
    // aunque su rol lo tendria habilitado por defecto.
    const map: PermissionsMap = {}
    for (const m of ALL_MODULES) {
      const override = overrides.get(m.viewId)
      if (override) {
        map[m.viewId] = override
      } else {
        const isDefault = m.defaultRoles.includes(rol.toLowerCase())
        map[m.viewId] = { enabled: isDefault, inMobileNav: isDefault && isDefaultMobileNav(m, rol) }
      }
    }
    try { localStorage.setItem(`permisosOffline:${userId}`, JSON.stringify(map)) } catch { /* modo privado */ }
    return map
  } catch {
    return null
  }
}

async function loadUserFoto(userId: number | string): Promise<string | null> {
  try {
    const { data } = await createClient().from("usuarios").select("foto_url").eq("id", userId).maybeSingle()
    return (data as { foto_url: string | null } | null)?.foto_url ?? null
  } catch {
    return null
  }
}

const RUTA_STORAGE_KEY = "selectedRuta"
const USER_STORAGE_KEY = "currentUser"
// Cache local del último estado conocido de `rutas_diarias` para la ruta y
// fecha actual. Sirve solo para hidratar instantáneamente la UI tras un
// reload (evita el flash de "Ruta no iniciada" durante el ~0.5s que tarda
// el fetch real). El valor se sobreescribe en cuanto llega la respuesta
// fresca del servidor, así que no genera estado "fantasma" persistente.
const RUTA_ACTIVA_CACHE_KEY = "rutaActivaCache"

/**
 * Cuánto se espera por el estado de la ruta antes de seguir con lo último que
 * se supo.
 *
 * Es UN renglón de `rutas_diarias` y normalmente contesta en ~150 ms. Pero una
 * petición lenta no puede secuestrar el módulo: sin corte, `rutaActivaResolved`
 * se quedaba en false y el módulo de pagos mostraba "Verificando estado de la
 * ruta..." hasta que el servidor contestara —se midieron esperas de más de un
 * minuto— aunque el estado de hoy estuviera ahí mismo, en localStorage.
 *
 * A los 6 s se sigue con el cache, que es EXACTAMENTE lo que ya se hacía sin
 * señal, y la respuesta tardía corrige después.
 */
const ESPERA_ESTADO_RUTA_MS = 6000
type RutaActivaCache = {
  rutaId: number
  fecha: string // YYYY-MM-DD en zona Bogotá
  estado: "abierta" | "cerrada"
}

export default function Page() {
  const { toast } = useToast()
  const [currentView, setCurrentView] = useState("register-payment")
  // Que ruta abrir en el Detalle de Ruta cuando se llega desde el Resumen.
  const [rutaDetalle, setRutaDetalle] = useState<number | null>(null)
  const [viewData, setViewData] = useState<any>(null)
  // Por qué se cerró la sesión. Sin esto, que la app te devuelva al login sin
  // decir nada se lee como una falla, no como una regla.
  const [avisoSesion, setAvisoSesion] = useState<string | null>(null)
  const [rutaActivaEstado, setRutaActivaEstado] = useState<"abierta" | "cerrada" | null>(null)

  /**
   * LA JORNADA VIEJA QUE NADIE CERRÓ.
   *
   * Mientras exista, la ruta está congelada: el cobrador no empieza un día
   * nuevo dejando el anterior sin cuadrar. Ver `lib/jornada-pendiente.ts` —
   * ahí está por qué esto no se enciende hasta que corra el script 086.
   */
  const [jornadaPendiente, setJornadaPendiente] = useState<JornadaPendiente | null>(null)
  const [releerJornada, setReleerJornada] = useState(0)
  // `rutaActivaResolved` distingue entre "todavía no he resuelto el estado
  // de la ruta" (false → mostrar spinner/skeleton, NO el guard) y "ya tengo
  // respuesta definitiva" (true → renderizar guard si null/cerrada o el
  // contenido si abierta). Sin este flag, los ~500ms iniciales antes de la
  // primera respuesta del servidor caían en el guard "Ruta no iniciada"
  // y generaban un parpadeo confuso. Si hay caché válido en localStorage
  // se inicializa ya en `true` y la UI no parpadea.
  const [rutaActivaResolved, setRutaActivaResolved] = useState(false)

  // Authenticated user + selected ruta (both global). Hydrated from localStorage on mount.
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null)
  /**
   * El candado del PIN.
   *
   * Vive SOLO en memoria a proposito. Si se guardara en `localStorage`,
   * sobreviviria al cierre de la app — pero al reves de como conviene: habria
   * que acordarse de escribirlo antes de cerrar, y un cierre brusco (batería,
   * el sistema matando la pestaña) lo dejaria sin escribir y la app abriria
   * desbloqueada. Al vivir en memoria, CUALQUIER forma de cerrar lo borra, y
   * al volver a montar se arranca bloqueado. El caso seguro es el que sale
   * gratis.
   */
  const [bloqueado, setBloqueado] = useState(false)
  const [selectedRuta, setSelectedRuta] = useState<SelectedRuta | null>(null)
  const [hydrated, setHydrated] = useState(false)
  // Splash de transicion tras un login fresco (no se muestra al recargar la pagina)
  const [showSplash, setShowSplash] = useState(false)
  const [showRutaSelector, setShowRutaSelector] = useState(false)
  const [userPermissions, setUserPermissions] = useState<PermissionsMap | null>(null)

  // ── Badges de "nuevo": conteo en memoria por viewId (chat, documentos, reportes) ──
  const [moduleBadgeCounts, setModuleBadgeCounts] = useState<Record<string, number>>({})
  const bumpBadge = useCallback((viewId: string) => {
    setModuleBadgeCounts((prev) => ({ ...prev, [viewId]: (prev[viewId] ?? 0) + 1 }))
  }, [])
  // IDs de conversaciones donde participa el usuario (para filtrar mensajes ajenos)
  const myConvIdsRef = useRef<Set<string>>(new Set())
  // IDs de carpetas de Documentos accesibles (raíz + subcarpetas heredadas)
  const myCarpetaIdsRef = useRef<Set<string>>(new Set())
  // Ref del currentView para leer en handlers sin closure stale
  const currentViewRef = useRef(currentView)
  currentViewRef.current = currentView

  // Hydrate user + ruta from localStorage on mount
  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        const rawUser = localStorage.getItem(USER_STORAGE_KEY)

        // ── ¿LA SESIÓN SIGUE VIVA? ─────────────────────────────────────
        // Dos motivos: cambió el día, o pasaron dos horas sin tocar nada. Se
        // comprueba ANTES de hidratar nada: si se hidratara primero y se
        // cerrara después, habría un parpadeo del dashboard con los datos de
        // la sesión vieja. Ver `lib/sesion-diaria.ts`.
        const motivo = rawUser ? motivoDeCaducidad(true) : null
        if (motivo) {
          try {
            localStorage.removeItem(USER_STORAGE_KEY)
            localStorage.removeItem(RUTA_STORAGE_KEY)
            localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
          } catch { /* modo privado */ }
          limpiarDiaDeSesion()
          setAvisoSesion(mensajeDeCaducidad(motivo))
          setSessionPhase("idle")
          // El cache de LECTURA se va si cambió el DÍA (son datos de ayer).
          // Si solo fue inactividad, se CONSERVA: sin señal es lo único con lo
          // que el cobrador puede seguir trabajando después de volver a entrar
          // (lib/credenciales-offline.ts). La cola de escrituras vive en otra
          // base y nunca se toca.
          if (motivo === "dia") void limpiarCache()
          return
        }

        if (rawUser) {
          const parsed = JSON.parse(rawUser) as AuthenticatedUser
          if (parsed && parsed.id) {
            setCurrentUser(parsed)
            // LA SESION VOLVIO DE DISCO, asi que la app se acaba de abrir:
            // arranca bloqueada. Esto es "cerro el sistema y lo volvio a
            // abrir". La unica forma de arrancar abierta es que el login
            // ocurra en esta misma vida de la pagina — y eso pasa por
            // `handleLoginSuccess`, que apaga el candado en memoria.
            //
            // ABRIR LA APP YA NO ARMA EL CANDADO POR SI SOLA.
            //
            // Antes arrancaba bloqueada siempre que hubiera sesion guardada, y
            // eso hacia que cerrar y volver a abrir —o actualizar— costara
            // teclear el PIN aunque hubieran pasado diez segundos. Ahora la
            // unica pregunta es la de siempre: ¿cuanto lleva sin tocarse?
            //
            // La respuesta NO se reinicia al cerrar: la marca vive en
            // `localStorage`, asi que el tiempo corre con la app cerrada.
            // Volver a los diez minutos pide PIN; volver a los diez segundos,
            // no. Ver `lib/pin-lock.ts`.
            if (requierePin(parsed.rol) && pasoElTiempoSinTocar()) setBloqueado(true)
            loadUserPermissions(parsed.id, parsed.rol ?? "").then(setUserPermissions).catch(() => {})
            // Refresca la foto de perfil por si cambio desde otro dispositivo
            // desde la ultima vez que se guardo la sesion en este localStorage.
            loadUserFoto(parsed.id).then((foto_url) => {
              setCurrentUser((prev) => (prev ? { ...prev, foto_url } : prev))
              try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ ...parsed, foto_url })) } catch {}
            }).catch(() => {})
          }
        }
        const rawRuta = localStorage.getItem(RUTA_STORAGE_KEY)
        let hydratedRutaId: number | null = null
        if (rawRuta) {
          const parsedRuta = JSON.parse(rawRuta) as SelectedRuta
          if (parsedRuta && typeof parsedRuta.id === "number") {
            setSelectedRuta(parsedRuta)
            hydratedRutaId = parsedRuta.id
            // Admin recargando página con ruta virtual → ir directo al dashboard
            if (rawUser) {
              const parsedUser = JSON.parse(rawUser) as AuthenticatedUser
              const rol = (parsedUser.rol ?? "").toLowerCase()
              if (parsedRuta.id === 0 && ["admin", "administrador"].includes(rol)) {
                setCurrentView("admin-dashboard")
              } else if (rol === "liquidador") {
                setCurrentView("admin-reportes")
              } else if (["gerencia", "secretaria", "secretario"].includes(rol)) {
                setCurrentView("secretary-reports")
              } else if (rol === "socioadmin") {
                setCurrentView("socio-admin-reportes")
              }
            }
          }
        }
        // Hidratacion OPTIMISTA del estado de ruta del dia. Si el cache
        // corresponde a la misma ruta + fecha de hoy, usamos su valor
        // mientras llega la respuesta fresca del servidor. Esto elimina
        // el flash de "Ruta no iniciada" en recargas posteriores al
        // primer "Iniciar Ruta" del dia.
        const rawCache = localStorage.getItem(RUTA_ACTIVA_CACHE_KEY)
        if (rawCache && hydratedRutaId !== null) {
          try {
            const cache = JSON.parse(rawCache) as RutaActivaCache
            const fechaHoy = new Intl.DateTimeFormat("en-CA", {
              timeZone: "America/Bogota",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date())
            if (
              cache &&
              cache.rutaId === hydratedRutaId &&
              cache.fecha === fechaHoy &&
              (cache.estado === "abierta" || cache.estado === "cerrada")
            ) {
              setRutaActivaEstado(cache.estado)
              setRutaActivaResolved(true)
            } else if (cache && cache.fecha !== fechaHoy) {
              // Cache obsoleto (cambio de dia): limpiar para evitar
              // hidratar estados de ayer.
              localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
            }
          } catch {
            localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
          }
        }
      }
    } catch (err) {
      console.error("[v0] Error hydrating user/ruta from localStorage:", err)
    } finally {
      setHydrated(true)
    }
  }, [])

  // Whenever (user + ruta) is set, fix the session on Supabase so RLS policies work.
  // This MUST succeed BEFORE rendering any operational view. We distinguish
  // explicit success ("ready") from failure ("error") to avoid showing a
  // dashboard that would just hit RLS denials.
  type SessionPhase = "idle" | "applying" | "ready" | "error"
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>("idle")
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionRetryCounter, setSessionRetryCounter] = useState(0)

  useEffect(() => {
    if (!currentUser) {
      setSessionPhase("idle")
      setSessionError(null)
      return
    }

    let cancelled = false
    setSessionPhase("applying")
    setSessionError(null)

    const applySession = async () => {
      if (cancelled) return
      setSessionPhase("ready")
    }

    applySession()
    return () => {
      cancelled = true
    }
  }, [currentUser, sessionRetryCounter])

  // Backward-compatible flag for existing dependent useEffects/components.
  const sesionFixed = sessionPhase === "ready"

  const handleRetrySession = useCallback(() => {
    setSessionRetryCounter((n) => n + 1)
  }, [])

  // Wrapper de `setRutaActivaEstado` que también persiste el cache local.
  // Lo usan los hijos (DailySummary, RegisterPayment) cuando inician/cierran
  // la ruta para que la próxima recarga hidrate instantáneamente y NO se
  // muestre el flash de "Ruta no iniciada".
  const handleRutaActivaEstadoChange = useCallback(
    (estado: "abierta" | "cerrada" | null) => {
      setRutaActivaEstado(estado)
      setRutaActivaResolved(true)
      if (typeof window === "undefined") return
      try {
        if ((estado === "abierta" || estado === "cerrada") && selectedRuta) {
          const fechaHoy = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Bogota",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date())
          const cache: RutaActivaCache = {
            rutaId: selectedRuta.id,
            fecha: fechaHoy,
            estado,
          }
          localStorage.setItem(RUTA_ACTIVA_CACHE_KEY, JSON.stringify(cache))
        } else if (estado === null) {
          localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
        }
      } catch (err) {
        console.warn("[v0] No se pudo persistir rutaActivaCache (handler):", err)
      }
    },
    [selectedRuta],
  )

  /**
   * EL COBRADOR ACABA DE CERRAR UN DIA VIEJO.
   *
   * Tiene que quedar como si abriera la app por primera vez hoy: con el boton
   * de "Iniciar Ruta" del dia de HOY, que todavia no ha empezado.
   *
   * POR QUE UNA RECARGA Y NO UN setState.
   * `rutaActivaEstado` lo carga un efecto que depende solo de
   * `[selectedRuta, sesionFixed]`, asi que despues del cierre NO se vuelve a
   * correr: se queda con el ultimo valor que tuvo. Y mientras se cerraba el
   * dia viejo, el Resumen del Dia pudo haber reportado "abierta" hacia arriba.
   * Resultado: la jornada vieja desaparece, el guard de "Ruta no iniciada" se
   * destapa... y no aparece, porque el estado dice que la ruta ya esta
   * abierta. El cobrador entra a cobrar sobre un dia que nunca inicio.
   *
   * Recargar es la unica forma de garantizar que TODO vuelva a leerse del
   * servidor —el estado de hoy, la jornada pendiente, los umbrales— sin ir
   * reseteando a mano cada pedazo de estado y arriesgarse a olvidar uno.
   *
   * EL CACHE SE BORRA ANTES. Si no, la recarga vuelve a hidratar desde
   * `localStorage` el mismo "abierta" que acabamos de quitar y el problema
   * reaparece identico. El cache se repone solo en cuanto se inicie la ruta.
   */
  const terminoElCierreAtrasado = useCallback(() => {
    try {
      localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
    } catch {
      /* modo privado: la recarga igual vuelve a preguntarle al servidor */
    }
    if (typeof window !== "undefined") {
      window.location.reload()
      return
    }
    // Sin `window` (no deberia pasar en el navegador) queda el camino de
    // antes: releer la jornada pendiente.
    setReleerJornada((n) => n + 1)
  }, [])

  /**
   * LO MISMO, PERO SIN ARRANCARLE EL COMPROBANTE DE LAS MANOS.
   *
   * `terminoElCierreAtrasado` recarga de una. Eso sirve cuando el cierre lo
   * dispara algo que no deja pantalla que mirar, pero NO justo despues de
   * cerrar: ahi el cobrador tiene al frente el resumen de la jornada, el PDF
   * y la imagen para mandar al chat. Recargar en ese momento se los borra.
   *
   * Asi que al cerrar solo se BORRA EL CACHE —para que ni un refresh
   * accidental reviva el estado viejo— y la recarga se hace cuando el
   * cobrador toca "Volver", que es cuando ya termino con el comprobante.
   */
  const marcarCierreAtrasadoHecho = useCallback(() => {
    try {
      localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
    } catch {
      /* modo privado */
    }
  }, [])

  // Carga global del estado de rutas_diarias para la ruta + fecha actual.
  // Antes esto solo ocurria dentro de DailySummary, por lo que si el usuario
  // entraba directamente a Clientes Activos (register-payment) sin pasar por
  // Resumen del Dia, rutaActivaEstado se quedaba en null y aparecia el guard
  // "Ruta no iniciada" aunque ya existiera una fila con estado "abierta".
  // Ahora se sincroniza globalmente cada vez que cambia la ruta o se fija la sesion.
  useEffect(() => {
    if (!selectedRuta || !sesionFixed) {
      setRutaActivaEstado(null)
      // Solo marcamos NO resuelto si no había ruta seleccionada todavía.
      // Si la ruta cambió, dejamos `resolved` como esté para que la UI
      // no parpadee a "loading" si ya teniamos un valor previo.
      if (!selectedRuta) setRutaActivaResolved(false)
      return
    }
    let cancelled = false
    const fetchRutaActiva = async () => {
      // Fecha hoy en zona Colombia (YYYY-MM-DD)
      const fechaHoy = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date())

      // El ultimo estado conocido para ESTA ruta y ESTE dia. Es lo que se
      // usa cuando no se puede preguntar al servidor.
      const leerCacheRuta = (): "abierta" | "cerrada" | null => {
        try {
          const raw = localStorage.getItem(RUTA_ACTIVA_CACHE_KEY)
          if (!raw) return null
          const c = JSON.parse(raw) as RutaActivaCache
          if (c?.rutaId !== selectedRuta.id || c?.fecha !== fechaHoy) return null
          return c.estado === "abierta" || c.estado === "cerrada" ? c.estado : null
        } catch {
          return null
        }
      }

      // SIN CONEXION no se pregunta: se trabaja con lo ultimo que se supo.
      //
      // Antes se intentaba igual, la consulta fallaba, el resultado quedaba
      // en null y eso hacia dos danos: aparecia "Ruta no iniciada" sobre una
      // ruta que si estaba abierta, y ademas se BORRABA el cache. Con el
      // cache borrado ya no habia forma de recuperarlo sin señal, asi que el
      // cobrador quedaba encerrado fuera del modulo de pagos en pleno campo.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (cancelled) return
        setRutaActivaEstado(leerCacheRuta())
        setRutaActivaResolved(true)
        return
      }

      // Guardar el resultado y dejarlo cacheado. Se usa desde los dos
      // caminos: la consulta con corte y el reintento sin corte.
      const aplicar = (estado: "abierta" | "cerrada" | null) => {
        setRutaActivaEstado(estado)
        setRutaActivaResolved(true)
        try {
          if (estado === "abierta" || estado === "cerrada") {
            const cache: RutaActivaCache = { rutaId: selectedRuta.id, fecha: fechaHoy, estado }
            localStorage.setItem(RUTA_ACTIVA_CACHE_KEY, JSON.stringify(cache))
          } else {
            // El servidor confirmo que no hay jornada abierta hoy: aqui si
            // corresponde limpiar.
            localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
          }
        } catch (err) {
          console.warn("[v0] No se pudo persistir rutaActivaCache:", err)
        }
      }

      // SELECT directo sobre `rutas_diarias` filtrando por ruta_id + fecha.
      // RLS eliminado: el filtro por ruta es 100% a nivel app.
      const consultar = async (signal?: AbortSignal) => {
        const supabase = await getSupabaseSafe()
        let q = supabase
          .from("rutas_diarias")
          .select("estado")
          .eq("ruta_id", selectedRuta.id)
          .eq("fecha", fechaHoy)
        if (signal) q = q.abortSignal(signal)
        return q.maybeSingle()
      }

      let result: "abierta" | "cerrada" | null = null
      // Distingue "el servidor dijo que no hay fila" de "no pude preguntar".
      // Solo lo primero justifica borrar el cache.
      let respondioElServidor = false
      let seAgotoLaEspera = false
      const control = new AbortController()
      const reloj = setTimeout(() => {
        seAgotoLaEspera = true
        control.abort()
      }, ESPERA_ESTADO_RUTA_MS)
      try {
        const { data, error } = await consultar(control.signal)
        if (cancelled) return
        if (error) {
          console.error("[v0] rutas_diarias error:", error.message)
        } else {
          result = (data?.estado ?? null) as "abierta" | "cerrada" | null
          respondioElServidor = true
        }
      } catch (err) {
        if (cancelled) return
        console.warn("[v0] rutas_diarias excepcion:", err)
      } finally {
        clearTimeout(reloj)
      }

      // Si no hubo respuesta, se conserva lo ultimo que se supo en vez de
      // caer a null y mostrar el guard sobre una ruta abierta.
      if (!respondioElServidor) {
        setRutaActivaEstado(leerCacheRuta())
        setRutaActivaResolved(true)
        // La respuesta TARDIA sigue importando: se vuelve a preguntar, ahora
        // sin corte, y cuando llegue corrige lo que se mostro desde el cache.
        // Sin esto, un dispositivo sin cache se quedaria viendo "Ruta no
        // iniciada" sobre una ruta abierta hasta que recargara la app.
        if (seAgotoLaEspera) {
          console.warn(`[v0] rutas_diarias tardo mas de ${ESPERA_ESTADO_RUTA_MS} ms: se sigue con el ultimo estado conocido.`)
          void (async () => {
            try {
              const { data, error } = await consultar()
              if (cancelled || error) return
              aplicar((data?.estado ?? null) as "abierta" | "cerrada" | null)
            } catch (err) {
              console.warn("[v0] rutas_diarias (reintento sin corte):", err)
            }
          })()
        }
        return
      }

      // "NO HAY FILA" PERO ESTE TELÉFONO LA ABRIÓ SIN SEÑAL y la cola todavía
      // no la subió (al volver la red, esta consulta y el drenado corren a la
      // vez). Sin esto, el cobrador veía "Ruta no iniciada" justo al recuperar
      // señal y se le borraba el estado guardado.
      if (result === null) {
        const { hayInicioDeRutaPendiente, drenarCola } = await import("@/lib/offline-queue")
        if (await hayInicioDeRutaPendiente(selectedRuta.id, fechaHoy)) {
          if (cancelled) return
          aplicar("abierta")
          void drenarCola()
          return
        }
      }

      aplicar(result)
    }
    fetchRutaActiva()

    // Al volver la señal se vuelve a preguntar: mientras estuvo sin conexion
    // se trabajo con el ultimo estado conocido y pudo haber cambiado (otro
    // dispositivo cerro la jornada, por ejemplo).
    const alVolverLaRed = () => { fetchRutaActiva() }
    window.addEventListener("online", alVolverLaRed)

    return () => {
      cancelled = true
      window.removeEventListener("online", alVolverLaRed)
    }
  }, [selectedRuta, sesionFixed])

  const ADMIN_VIRTUAL_RUTA: SelectedRuta = { id: 0, nombre: "Todas las rutas", ciudad: null, pais: null }
  const ADMIN_ROLES = new Set(["admin", "administrador"])

  const handleLoginSuccess = useCallback(async (user: AuthenticatedUser) => {
    try {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
    } catch (err) {
      console.error("[v0] Error writing currentUser to localStorage:", err)
    }
    // El día en que se entró y el momento: uno hace que mañana se vuelva a
    // pedir, el otro que se pida tras el tope de inactividad sin tocar nada.
    marcarDiaDeSesion()
    marcarActividad()
    setAvisoSesion(null)
    setCurrentUser(user)
    // Acaba de escribir usuario y contraseña: no tiene sentido pedirle
    // ademas el PIN. El candado se arma solo la proxima vez que salga.
    setBloqueado(false)
    setShowSplash(true)
    loadUserPermissions(user.id, user.rol ?? "").then(setUserPermissions).catch(() => {})
    loadUserFoto(user.id).then((foto_url) => {
      setCurrentUser((prev) => (prev ? { ...prev, foto_url } : prev))
      try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ ...user, foto_url })) } catch {}
    }).catch(() => {})

    const isAdmin = ADMIN_ROLES.has((user.rol ?? "").toLowerCase())
    if (isAdmin) {
      try {
        localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ADMIN_VIRTUAL_RUTA))
      } catch {}
      setSelectedRuta(ADMIN_VIRTUAL_RUTA)
      setCurrentView("admin-dashboard")
      return
    }

    if ((user.rol ?? "").toLowerCase() === "liquidador") {
      try {
        localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ADMIN_VIRTUAL_RUTA))
      } catch {}
      setSelectedRuta(ADMIN_VIRTUAL_RUTA)
      setCurrentView("admin-reportes")
      return
    }

    // Resto de roles: auto-seleccionar la primera ruta asignada al usuario
    // para evitar mostrar el RouteSelector en cada login.
    try {
      const supabase = createClient()
      let rutasData: SelectedRuta[] = []

      const { data, error } = await supabase
        .from("usuario_rutas")
        .select("rutas:ruta_id(id, nombre, ciudad, pais)")
        .eq("usuario_id", user.id)

      if (!error && data) {
        rutasData = (data as any[])
          .map((row) => row.rutas)
          .filter(Boolean)
          .sort((a: SelectedRuta, b: SelectedRuta) => a.id - b.id)
        // Para poder elegir la ruta la próxima vez que se entre SIN señal.
        guardarRutasOffline(user.id, rutasData)
      } else {
        // Sin señal: las rutas de la última entrada con señal.
        rutasData = leerRutasOffline<SelectedRuta>(user.id)
      }

      const rolLower = (user.rol ?? "").toLowerCase()
      const isSecretariaOrGerencia = ["secretaria", "secretario", "gerencia"].includes(rolLower)
      const isSocioadmin = rolLower === "socioadmin"

      if (rutasData.length > 0) {
        const ruta = rutasData[0]
        try { localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ruta)) } catch {}
        setSelectedRuta(ruta)
        setShowRutaSelector(false)
        if (isSecretariaOrGerencia) setCurrentView("secretary-reports")
        else if (isSocioadmin) setCurrentView("socio-admin-reportes")
        // Vendedores y cobradores: SIEMPRE a Registrar Pago. Se pone
        // explicito y no se confia en el valor inicial del estado: cuando
        // alguien cierra sesion y entra con otro usuario sin recargar la
        // pagina, `currentView` conserva la pantalla del anterior y el
        // vendedor entraba donde lo hubiera dejado el otro.
        else setCurrentView("register-payment")
      } else {
        // Sin rutas asignadas: entrar al dashboard sin ruta
        try { localStorage.removeItem(RUTA_STORAGE_KEY) } catch {}
        setSelectedRuta(null)
        setShowRutaSelector(false)
        if (isSecretariaOrGerencia) setCurrentView("secretary-reports")
        else if (isSocioadmin) setCurrentView("socio-admin-reportes")
        else setCurrentView("register-payment")
      }
    } catch (err) {
      console.error("[v0] Error auto-selecting ruta:", err)
      try { localStorage.removeItem(RUTA_STORAGE_KEY) } catch {}
      setSelectedRuta(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * LA INACTIVIDAD, LA ÚNICA RAZÓN POR LA QUE SE PIDE EL PIN.
   *
   * Cinco minutos sin tocar la app y se arma el candado. Ni minimizar, ni
   * cerrarla, ni actualizar la disparan por sí solos — pero el tiempo que pasa
   * mientras está cerrada o en segundo plano CUENTA, porque la marca de la
   * última actividad vive en `localStorage`.
   *
   * Por eso hay dos comprobaciones y no una:
   *
   *   · El TEMPORIZADOR, para la app abierta y quieta encima de un mostrador.
   *     Ese caso no dispara ningún evento del navegador.
   *   · La comprobación AL VOLVER (`visibilitychange` y `focus`), porque el
   *     navegador estrangula los temporizadores en segundo plano y el de cinco
   *     minutos puede no haber corrido. Al volver se mira el reloj de disco,
   *     que no se estrangula.
   *
   * Las señales se escuchan en captura y con `passive` para no estorbar el
   * scroll. Cada una escribe la marca: es una escritura pequeña a
   * `localStorage` y sin ella el reloj no sobreviviría al cierre, que es
   * justamente lo que impide esquivar el candado cerrando la app.
   */
  useEffect(() => {
    if (!currentUser) return
    if (!requierePin(currentUser.rol)) return
    // Ya bloqueado no hay nada que contar: el reloj vuelve a arrancar cuando
    // la persona teclea el PIN y `bloqueado` pasa a false.
    if (bloqueado) return

    let reloj: ReturnType<typeof setTimeout> | null = null
    const parar = () => { if (reloj) { clearTimeout(reloj); reloj = null } }

    const hayAlguien = () => {
      marcarActividadPin()
      parar()
      reloj = setTimeout(() => setBloqueado(true), INACTIVIDAD_PIN_MS)
    }

    const alVolver = () => {
      if (document.visibilityState !== "visible") return
      if (pasoElTiempoSinTocar()) { setBloqueado(true); return }
      // No estuvo quieta lo suficiente: se reprograma con lo que le queda.
      parar()
      reloj = setTimeout(() => setBloqueado(true), INACTIVIDAD_PIN_MS - inactividadPin())
    }

    const senales = ["pointerdown", "keydown", "scroll", "touchstart"] as const
    for (const s of senales) document.addEventListener(s, hayAlguien, { capture: true, passive: true })
    document.addEventListener("visibilitychange", alVolver)
    window.addEventListener("focus", alVolver)

    // Se marca al entrar: acaba de abrir la app o de teclear el PIN, está acá.
    hayAlguien()
    return () => {
      parar()
      for (const s of senales) document.removeEventListener(s, hayAlguien, { capture: true })
      document.removeEventListener("visibilitychange", alVolver)
      window.removeEventListener("focus", alVolver)
    }
  }, [currentUser, bloqueado])

  const handleLogout = useCallback((opts?: { conservarCache?: boolean }) => {
    try {
      localStorage.removeItem(USER_STORAGE_KEY)
      localStorage.removeItem(RUTA_STORAGE_KEY)
    } catch (err) {
      console.error("[v0] Error clearing session:", err)
    }
    limpiarDiaDeSesion()
    setBloqueado(false)
    setCurrentUser(null)
    setSelectedRuta(null)
    setSessionPhase("idle")
    setShowSplash(false)
    setUserPermissions(null)
    setModuleBadgeCounts({})
    myConvIdsRef.current = new Set()
    myCarpetaIdsRef.current = new Set()
    // Datos cacheados para trabajar sin señal: se borran para que el
    // siguiente usuario no vea la ruta del anterior. Salvo cuando la sesión
    // venció por inactividad: es la misma persona volviendo, y sin señal ese
    // cache es con lo único que puede seguir trabajando.
    if (!opts?.conservarCache) void limpiarCache()
  }, [])

  /**
   * LA APP VUELVE AL FRENTE → ¿SIGUE SIENDO EL MISMO DÍA?
   *
   * La comprobación de la hidratación solo corre al ABRIR la app. Un teléfono
   * que se queda con la app abierta toda la noche —lo normal en el bolsillo de
   * un cobrador— nunca volvería a pasar por ahí, y a las seis de la mañana
   * seguiría dentro con la sesión de ayer.
   *
   * Se comprueba al VOLVER, no con un temporizador que dispare a medianoche.
   * A esa hora hay secretaría cuadrando caja, y sacarla del formulario a mitad
   * de un cierre no es seguridad, es perder trabajo hecho. Quien esté usando
   * la app en ese momento la termina; en cuanto la deje y vuelva, entra con
   * contraseña.
   *
   * Estos listeners van para TODOS los roles, no solo para los del PIN: la
   * regla es que nadie trabaje un día con la sesión del anterior.
   */
  useEffect(() => {
    if (!currentUser) return

    const revisar = () => {
      if (document.visibilityState === "hidden") return
      const motivo = motivoDeCaducidad(true)
      if (!motivo) return
      setAvisoSesion(mensajeDeCaducidad(motivo))
      // Por inactividad se conserva el cache de lectura (ver arriba).
      handleLogout({ conservarCache: motivo === "inactividad" })
    }

    /**
     * "SIGO ACÁ". Cualquier señal de que hay alguien del otro lado.
     *
     * Se escucha en fase de captura y con `passive` para no estorbarle a nadie
     * el scroll, y se escribe como mucho una vez por minuto: con cada toque
     * serían cientos de escrituras a `localStorage` en una jornada, para un
     * dato cuya precisión útil se mide en horas.
     */
    let ultimaMarca = 0
    const hayAlguien = () => {
      const ahora = Date.now()
      if (ahora - ultimaMarca < 60_000) return
      ultimaMarca = ahora
      marcarActividad()
    }
    const senales = ["pointerdown", "keydown", "scroll", "touchstart"] as const
    for (const s of senales) document.addEventListener(s, hayAlguien, { capture: true, passive: true })

    // Se marca al entrar: acaba de escribir su contraseña, está acá.
    marcarActividad()

    /**
     * El reloj que la saca sin tener que esperar a que vuelva al frente.
     *
     * Comprobar solo al volver dejaba un hueco: la app en primer plano y
     * quieta encima de un mostrador no dispara `visibilitychange` nunca. Cada
     * minuto es barato —compara dos números— y no interrumpe a nadie que esté
     * usando la app, porque tocar la pantalla reinicia la cuenta.
     */
    const reloj = setInterval(revisar, 60_000)

    document.addEventListener("visibilitychange", revisar)
    window.addEventListener("focus", revisar)
    return () => {
      clearInterval(reloj)
      for (const s of senales) document.removeEventListener(s, hayAlguien, { capture: true })
      document.removeEventListener("visibilitychange", revisar)
      window.removeEventListener("focus", revisar)
    }
  }, [currentUser, handleLogout])


  // ── Suscripción global de notificaciones (chat, documentos, reportes) ──────
  // Se mantiene activa durante toda la sesión, independientemente de la vista.
  useEffect(() => {
    if (!currentUser) return
    const supabase = createClient()
    const rol = (currentUser.rol ?? "").toLowerCase()

    // Cargar IDs de conversaciones propias para filtrar mensajes ajenos
    supabase
      .from("chat_participants")
      .select("conversation_id")
      .eq("user_id", currentUser.id)
      .then(({ data }: { data: { conversation_id: string }[] | null }) => {
        if (data) myConvIdsRef.current = new Set(data.map((r) => r.conversation_id))
      })
      .catch(() => {})

    // Sembrar el badge del chat con el no leído REAL al arrancar.
    //
    // Antes `moduleBadgeCounts` nacía vacío en cada recarga y solo subía si el
    // mensaje llegaba con la app abierta: quien abría la app por la mañana con
    // mensajes de la noche no veía ninguna burbuja.
    supabase
      .rpc("get_my_conversations", { p_user_id: currentUser.id })
      .then(({ data }: { data: { unread_count: number }[] | null }) => {
        const total = (data ?? []).reduce((s, c) => s + (Number(c.unread_count) || 0), 0)
        if (total > 0) setModuleBadgeCounts((prev) => ({ ...prev, chat: total }))
      })
      .catch((err: unknown) => console.error("[v0] no leidos iniciales:", err))

    // Y lo mismo con lo que espera aprobación: sin este conteo el aviso solo
    // aparecería si la solicitud entra con la app abierta, y las 7 ventas que
    // ya están pendientes seguirían sin avisar a nadie.
    if (["secretaria", "secretario", "admin", "administrador"].includes(rol)) {
      // La bandeja única junta las dos fuentes, y el aviso también: lo que
      // superó el umbral de la ruta y lo que espera en la cadena por ítem.
      Promise.all([
        supabase.from("solicitudes_revision").select("id", { count: "exact", head: true }).eq("estado", "pendiente"),
        supabase.from("gastosregistros").select("id", { count: "exact", head: true }).eq("estadoadmin", "por aprobar"),
        supabase.from("gastosregistros").select("id", { count: "exact", head: true }).eq("estadosecre", "por aprobar"),
      ])
        .then((rs: { count: number | null }[]) => {
          const count = rs.reduce((s, r) => s + (r.count ?? 0), 0)
          if (count > 0) {
            setModuleBadgeCounts((prev) => ({ ...prev, "movimientos-revision": count }))
          }
        })
        .catch((err: unknown) => console.error("[v0] pendientes de revision:", err))
    }

    // Cargar IDs de carpetas de Documentos accesibles (mismo query shape que
    // documentos-view.tsx loadCarpetas: permisos -> raíz -> subcarpetas heredadas)
    ;(async () => {
      try {
        const { data: permisos } = await supabase
          .from("documento_carpeta_permisos")
          .select("carpeta_id")
          .eq("user_id", currentUser.id)
        const allowedIds = ((permisos ?? []) as { carpeta_id: string }[]).map((p) => p.carpeta_id)

        let rootQuery = supabase.from("documento_carpetas").select("id").is("parent_id", null)
        rootQuery = allowedIds.length > 0
          ? rootQuery.or(`created_by.eq.${currentUser.id},id.in.(${allowedIds.join(",")})`)
          : rootQuery.eq("created_by", currentUser.id)
        const { data: rootData } = await rootQuery
        const rootIds = ((rootData ?? []) as { id: string }[]).map((r) => r.id)

        let subIds: string[] = []
        if (rootIds.length > 0) {
          const { data: subData } = await supabase
            .from("documento_carpetas")
            .select("id")
            .in("parent_id", rootIds)
          subIds = ((subData ?? []) as { id: string }[]).map((r) => r.id)
        }
        myCarpetaIdsRef.current = new Set([...rootIds, ...subIds])
      } catch (err) {
        console.error("[v0] Error cargando carpetas accesibles:", err)
      }
    })()

    const channel = supabase
      .channel(`notif-${currentUser.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload: { new: { sender_id: number; sender_nombre: string; body: string | null; conversation_id: string } }) => {
          const msg = payload.new
          if (msg.sender_id === currentUser.id) return
          if (!myConvIdsRef.current.has(msg.conversation_id)) return
          // Solo notificar si el usuario NO está ya en el módulo de chat
          if (currentViewRef.current !== "chat") {
            bumpBadge("chat")
            toast({
              title: `💬 ${msg.sender_nombre}`,
              description: msg.body ?? "📷 Imagen",
            })
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_participants" },
        (payload: { new: { user_id: number; conversation_id: string } }) => {
          // Registrar nuevas conversaciones donde me agregan
          if (payload.new.user_id === currentUser.id) {
            myConvIdsRef.current.add(payload.new.conversation_id)
          }
        }
      )
      // Movimientos que superaron el umbral y esperan aprobación. Hasta ahora
      // no avisaba NADA: la solicitud entraba a la base y solo se veía si a
      // alguien se le ocurría abrir la bandeja y cambiar de pestaña.
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "solicitudes_revision" },
        (payload: { new: { tipo: string; monto: number; ruta_id: number; descripcion: string | null; solicitado_por: number } }) => {
          if (!["secretaria", "secretario", "admin", "administrador"].includes(rol)) return
          const s = payload.new
          if (s.solicitado_por === currentUser.id) return
          if (currentViewRef.current !== "movimientos-revision") {
            bumpBadge("movimientos-revision")
            const etiqueta = s.tipo === "venta" ? "Venta" : s.tipo === "abono" ? "Abono" : "Gasto"
            toast({
              title: `🧾 ${etiqueta} por aprobar`,
              description: `${s.descripcion ?? "Movimiento"} — $${Number(s.monto ?? 0).toLocaleString()} (ruta ${s.ruta_id})`,
            })
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "documentos" },
        (payload: { new: { carpeta_id: string; uploaded_by: number; uploaded_by_nombre: string; nombre_archivo: string } }) => {
          const doc = payload.new
          if (doc.uploaded_by === currentUser.id) return
          if (!myCarpetaIdsRef.current.has(doc.carpeta_id)) return
          if (currentViewRef.current !== "documentos") {
            bumpBadge("documentos")
            toast({ title: "📁 Nuevo documento", description: `${doc.uploaded_by_nombre}: ${doc.nombre_archivo}` })
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "documento_carpeta_permisos" },
        (payload: { new: { user_id: number; carpeta_id: string } }) => {
          if (payload.new.user_id === currentUser.id) {
            myCarpetaIdsRef.current.add(payload.new.carpeta_id)
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "documento_carpetas" },
        (payload: { new: { id: string; parent_id: string | null } }) => {
          // Nueva subcarpeta dentro de una carpeta a la que ya tengo acceso
          if (payload.new.parent_id && myCarpetaIdsRef.current.has(payload.new.parent_id)) {
            myCarpetaIdsRef.current.add(payload.new.id)
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "informes" },
        (payload: { new: { destinatario: string; socioadmin_id: number | null; secretaria_nombre: string; nombre_reporte: string } }) => {
          const row = payload.new
          if (rol === "gerencia" && row.destinatario === "gerencia") {
            if (currentViewRef.current !== "secretary-reports") {
              bumpBadge("secretary-reports")
              toast({ title: "📄 Nuevo reporte", description: `${row.secretaria_nombre}: ${row.nombre_reporte}` })
            }
          } else if (rol === "socioadmin" && row.destinatario === "socioadmin" && row.socioadmin_id === currentUser.id) {
            if (currentViewRef.current !== "socio-admin-reportes") {
              bumpBadge("socio-admin-reportes")
              toast({ title: "📄 Nuevo reporte", description: `${row.secretaria_nombre}: ${row.nombre_reporte}` })
            }
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "admin_informes" },
        (payload: { new: { admin_nombre: string; nombre_reporte: string } }) => {
          if (rol !== "secretaria" && rol !== "secretario") return
          const row = payload.new
          if (currentViewRef.current !== "secretary-admin-reportes") {
            bumpBadge("secretary-admin-reportes")
            toast({ title: "📄 Reporte de admin", description: `${row.admin_nombre}: ${row.nombre_reporte}` })
          }
        }
      )
      .on(
        // Cierre del circuito de gastos: quien registro el movimiento se
        // entera de si se lo aprobaron o se lo rechazaron. Antes lo mandaba
        // y quedaba a ciegas, sin mas remedio que ir a buscarlo a mano.
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "gastosregistros" },
        (payload: {
          new: { adminid: number; tipo: string; concepto: string; valor: number; estadoadmin: string; estadosecre: string }
          old: { estadoadmin?: string; estadosecre?: string }
        }) => {
          const row = payload.new
          if (row.adminid !== currentUser.id) return

          // Solo interesa el momento en que pasa de "por aprobar" a resuelto.
          const eraPendiente = payload.old?.estadoadmin === "por aprobar" || payload.old?.estadosecre === "por aprobar"
          const rechazado = row.estadoadmin === "rechazado" || row.estadosecre === "rechazado"
          const aprobado = row.estadoadmin !== "por aprobar" && row.estadosecre !== "por aprobar" && !rechazado
          if (!eraPendiente || (!rechazado && !aprobado)) return

          const monto = `$${Math.round(row.valor ?? 0).toLocaleString("es-CO")}`
          if (currentViewRef.current !== "view-expenses-income") bumpBadge("view-expenses-income")
          toast({
            title: rechazado ? `❌ ${row.tipo} rechazado` : `✅ ${row.tipo} aprobado`,
            description: `${row.concepto} — ${monto}`,
            variant: rechazado ? "destructive" : undefined,
          })
        }
      )
      .subscribe()

    return () => { channel.unsubscribe() }
  // Solo se recrea al cambiar de usuario (login/logout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id])

  const handleSelectRuta = useCallback((ruta: SelectedRuta) => {
    try {
      localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ruta))
    } catch (err) {
      console.error("[v0] Error writing selectedRuta to localStorage:", err)
    }
    setSelectedRuta(ruta)
    setShowRutaSelector(false)
  }, [])

  const handleChangeRuta = useCallback(() => {
    setShowRutaSelector(true)
  }, [])

  // Permite que una vista (ej. Mi Perfil tras subir una foto) actualice el
  // usuario en memoria y en localStorage sin necesidad de volver a iniciar sesion.
  const handleUserUpdate = useCallback((updated: AuthenticatedUser) => {
    setCurrentUser(updated)
    try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updated)) } catch {}
  }, [])

  // Listener global del evento "app:session-lost" disparado por `safeQuery` en
  // `lib/api-helper.ts` cuando detecta que las variables de sesion RLS no
  // estan aplicadas o que faltan datos de sesion en localStorage. Al recibir
  // el evento, redirigimos al flujo de login/seleccion de ruta para forzar
  // que la sesion se vuelva a establecer correctamente.
  useEffect(() => {
    const onSessionLost = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string }>).detail
      console.warn(
        "[v0] app:session-lost recibido en page.tsx:",
        detail?.reason ?? "unknown",
      )
      // Si no hay user en localStorage → logout completo.
      // Si solo falta ruta: no abrir el selector automáticamente — el
      // header ya muestra "Seleccionar Ruta" cuando es necesario.
      let hasUser = false
      try {
        hasUser = !!localStorage.getItem(USER_STORAGE_KEY)
      } catch {}
      if (!hasUser) {
        handleLogout()
      }
    }
    window.addEventListener(SESSION_LOST_EVENT, onSessionLost)
    return () => {
      window.removeEventListener(SESSION_LOST_EVENT, onSessionLost)
    }
  }, [handleLogout])

  // Only admins and secretaries can change ruta from the header
  const userRol = (currentUser?.rol ?? "").toLowerCase()
  const canChangeRuta = ["admin", "administrador", "secretaria", "secretario"].includes(userRol)

  // "chat" NO está aquí a propósito: su contador ahora se DERIVA del no leído
  // real del servidor (ChatView lo reporta con onUnreadChange). Ponerlo en
  // cero al entrar sería mentir — quien abre el chat pero deja otra
  // conversación sin leer debe seguir viendo el número. `markAsRead` ya lo
  // baja solo al abrir cada conversación.
  const BADGE_VIEWS = ["documentos", "secretary-reports", "socio-admin-reportes", "secretary-admin-reportes", "movimientos-revision"]

  const handleViewChange = (view: string, data?: any) => {
    setCurrentView(view)
    setViewData(data)
    if (BADGE_VIEWS.includes(view)) {
      setModuleBadgeCounts((prev) => ({ ...prev, [view]: 0 }))
    }
  }

  const rutaId = selectedRuta?.id ?? 0
  const rutaPais = selectedRuta?.pais ?? ""

  /**
   * ¿Quedó una jornada vieja sin cerrar en esta ruta?
   *
   * Se pregunta al elegir ruta y cada vez que alguien la descongela. Acá no
   * hace falta un reloj: una jornada vieja no aparece sola a mitad del día —
   * la deja el día anterior, y para verla basta con haber abierto la app hoy.
   *
   * El reloj está en el efecto de abajo, y es para lo contrario: para enterarse
   * de que la DESCONGELARON.
   */
  useEffect(() => {
    if (!selectedRuta) { setJornadaPendiente(null); return }
    let vigente = true
    buscarJornadaPendiente(selectedRuta.id).then((j) => { if (vigente) setJornadaPendiente(j) })
    return () => { vigente = false }
  }, [selectedRuta, releerJornada])

  /**
   * MIENTRAS SIGA CONGELADA, SE VUELVE A PREGUNTAR SOLA.
   *
   * Quien desbloquea es OTRA PERSONA en OTRO TELÉFONO: la secretaría, desde el
   * aviso de arriba o desde el Monitoreo de Rutas. El cobrador está mirando una
   * pantalla que le tapa la app, y sin esto seguiría bloqueado hasta cerrarla y
   * volver a abrirla — mientras la secretaría cree que ya lo soltó.
   *
   * Solo corre cuando hay algo congelado: sin jornada pendiente no hay reloj ni
   * escuchas. Y al volver a la pantalla se pregunta de una, que es el caso
   * normal —el cobrador guarda el teléfono, llama, y vuelve.
   *
   * `setJornadaPendiente` conserva el objeto anterior cuando no cambió nada,
   * porque si devolviera uno nuevo cada vez este mismo efecto se rearmaría en
   * cada vuelta.
   */
  useEffect(() => {
    if (!selectedRuta || !jornadaPendiente) return
    let vigente = true
    const revisar = () => {
      buscarJornadaPendiente(selectedRuta.id).then((j) => {
        if (!vigente) return
        setJornadaPendiente((prev) => {
          // Se conserva el objeto anterior SOLO si de verdad no cambió nada.
          // Comparar por `id` a secas no alcanzaba desde que el desbloqueo
          // caduca (scripts/113): la misma jornada pasa de habilitada a
          // vencida sin cambiar de id, y quedándose con el objeto viejo el
          // vencimiento no se veía nunca.
          if (
            prev && j &&
            prev.id === j.id &&
            prev.desbloqueada === j.desbloqueada &&
            prev.vencida === j.vencida
          ) {
            return prev
          }
          return j
        })
      })
    }
    const alVolver = () => { if (document.visibilityState === "visible") revisar() }
    const reloj = setInterval(revisar, 45000)

    // EL VENCIMIENTO SE REVISA AL SEGUNDO EXACTO, no en la próxima vuelta del
    // reloj de 45s: si el permiso vence a las 10:15:00, esperar hasta 45
    // segundos más le regalaría al cobrador un tiempo que no tiene. El +1000
    // es para caer del lado de allá del límite y no justo encima.
    let alVencer: ReturnType<typeof setTimeout> | undefined
    if (jornadaPendiente.venceEn && !jornadaPendiente.vencida) {
      const falta = jornadaPendiente.venceEn.getTime() - Date.now()
      // `setTimeout` desborda pasados ~24.8 días y dispararía de inmediato;
      // con el tope de 1440 minutos del script 113 no puede pasar, pero el
      // guard cuesta una línea.
      if (falta > 0 && falta < 2_147_483_647) {
        alVencer = setTimeout(revisar, falta + 1000)
      }
    }
    document.addEventListener("visibilitychange", alVolver)
    window.addEventListener("focus", revisar)
    return () => {
      vigente = false
      clearInterval(reloj)
      if (alVencer) clearTimeout(alVencer)
      document.removeEventListener("visibilitychange", alVolver)
      window.removeEventListener("focus", revisar)
    }
  }, [selectedRuta, jornadaPendiente])

  // ── El vendedor no entra a nada antes de iniciar la ruta ──────────────
  //
  // Antes el guard vivia solo dentro del modulo de pagos, asi que un vendedor
  // podia registrar una venta, un gasto o mirar clientes sin haber abierto la
  // jornada. La fila de `rutas_diarias` es la que despues consultan el cierre
  // de caja y el monitoreo del admin: si no existe, ese dia no aparece por
  // ningun lado aunque se haya trabajado.
  //
  // La jornada tiene que estar ABIERTA, no solo iniciada. Cerrar la caja
  // termina el dia: el conteo ya se cuadro y se firmo, asi que cualquier
  // movimiento posterior lo descuadraria hacia atras. El vendedor queda
  // bloqueado hasta el dia siguiente, cuando vuelve a iniciar ruta.
  //
  // DOS EXCEPCIONES.
  //
  // `cierre-caja`, porque es la pantalla donde acaba de cerrar y donde esta el
  // resumen y el PDF de la jornada. Bloquearla le arrancaria el comprobante de
  // las manos en el mismo momento de generarlo, y ademas no permite hacer
  // ningun movimiento: el propio cierre solo aplica sobre una ruta 'abierta',
  // asi que volver a entrar ahi no puede reabrir ni alterar nada.
  //
  // Y el CHAT. Al cerrar la caja la app entera quedaba bloqueada, justo cuando
  // al cobrador le falta lo ultimo del dia: mandar el reporte y cuadrar con la
  // secretaria. Se quedaba sin poder escribir por donde se escribe. El chat no
  // mueve un peso —no registra pagos, ni gastos, ni ventas— asi que no hay
  // nada que descuadre por dejarlo abierto.
  //
  // Va exento en los DOS estados, no solo despues del cierre: antes de iniciar
  // la ruta tambien hace falta poder avisar que algo pasa. Un bloqueo que
  // impide pedir ayuda no protege nada.
  const rolExigeRutaIniciada = ["vendedor", "asesor"].includes(userRol)
  const VISTAS_SIN_RUTA: string[] = ["cierre-caja", "chat"]
  const puedeLevantarElCongelamiento = puedeDescongelar(userRol)

  /**
   * ¿SE ESTÁ TERMINANDO UNA JORNADA VIEJA?
   *
   * La secretaría desbloqueó la ruta y el cobrador está cerrando el día que
   * quedó abierto. Mientras eso dure, la app entera trabaja sobre ESE día: la
   * lista de pagos, las ventas y el cierre.
   *
   * POR QUÉ NO ALCANZABA CON ABRIRLE EL CIERRE. Al desbloquear, lo único que
   * podía hacer era cuadrar la caja — y a la caja le faltaba justo lo que no
   * alcanzó a registrar: los pagos y no pagos del final del día, y las ventas
   * que hizo y no cargó. Cerrar sin eso deja el día cuadrado sobre una cifra
   * incompleta, que es lo contrario de lo que el cierre existe para hacer.
   */
  const jornadaAtrasadaAbierta = jornadaPendiente?.desbloqueada
    ? jornadaPendiente.fecha
    : null

  /**
   * LA RUTA CONGELADA GANA SOBRE "no iniciada".
   *
   * Las dos tapan la pantalla, pero dicen cosas distintas y solo una es cierta:
   * con una jornada vieja sin cerrar, el botón "Iniciar Ruta" no serviría de
   * nada —y ofrecerlo sería mandar al cobrador a tocar algo que no lo va a
   * desbloquear—. El chat sigue exento en las dos.
   *
   * Y DESBLOQUEADA DEJA DE TAPAR. Mientras la jornada vieja siga abierta con
   * permiso, el cobrador entra a los módulos como cualquier día: lo que cambia
   * es a qué día se registra, no si puede registrar.
   */
  const rutaCongelada =
    rolExigeRutaIniciada &&
    !!selectedRuta &&
    !!jornadaPendiente &&
    !jornadaPendiente.desbloqueada &&
    !VISTAS_SIN_RUTA.includes(currentView)

  /**
   * Con la jornada vieja desbloqueada NO se pide iniciar la de hoy: la de
   * ayer sigue abierta y es sobre esa que se está trabajando. Pedir "Iniciar
   * Ruta" ahí mandaría a abrir un día nuevo con el anterior sin cerrar, que es
   * justo lo que el congelamiento existe para impedir.
   */
  const rutaSinIniciar =
    rolExigeRutaIniciada &&
    !!selectedRuta &&
    !jornadaPendiente &&
    !VISTAS_SIN_RUTA.includes(currentView) &&
    (!rutaActivaResolved || rutaActivaEstado !== "abierta")

  const renderView = () => {
    switch (currentView) {
      case "dashboard":
        return <MainDashboard onViewChange={handleViewChange} />
      case "daily-summary":
        return (
          <DailySummary
            onViewChange={handleViewChange}
            rutaId={rutaId}
            onRouteStateChange={handleRutaActivaEstadoChange}
            /* Solo trae valor mientras se está cerrando una jornada vieja
               desbloqueada. Sin eso es `null` y el resumen es el de hoy. */
            fechaResumen={jornadaAtrasadaAbierta}
          />
        )
      case "cierre-caja":
        return (
          <CierreCaja
            onBack={() => handleViewChange("daily-summary")}
            rutaId={rutaId}
            rutaNombre={rutaPais}
            onRouteStateChange={handleRutaActivaEstadoChange}
            currentUser={currentUser ?? undefined}
            /* EL DÍA QUE SE ESTÁ CERRANDO, se entre por donde se entre.
               Antes solo llegaba por `viewData`, o sea únicamente si se venía
               del botón "Hacer el cierre" del aviso. Entrando por el candado
               del Resumen —que es el camino de siempre— venía vacío y el
               cierre mostraba el día de hoy: todo en cero, porque hoy no tiene
               fila hasta que el día viejo cierre.

               `jornadaAtrasadaAbierta` manda, y `viewData` queda de respaldo
               para quien lo pase explícito (la secretaría desde el Monitoreo,
               que no tiene la ruta congelada en su propia sesión). */
            fechaJornada={jornadaAtrasadaAbierta ?? viewData?.fechaJornada}
            /* Cerro la jornada VIEJA: se limpia el estado cacheado ya, y la
               recarga entera se hace al salir de la pantalla — para no
               borrarle el comprobante que acaba de generar. */
            onJornadaAtrasadaCerrada={marcarCierreAtrasadoHecho}
            onSalirTrasCierreAtrasado={terminoElCierreAtrasado}
          />
        )
      case "view-clients":
        return <ViewClients />
      case "new-client":
        return <NewClient />
      case "inactivation-requests":
        return <InactivationRequests />
      case "view-loans":
        return <ViewLoans currentRutaId={rutaId} />
      case "new-loan":
        return (
          <NewLoan
            preSelectedClientId={viewData?.clientId ?? null}
            currentRutaId={rutaId}
            rutaPais={rutaPais}
            onCancel={() => handleViewChange("register-payment")}
            /* La venta que se hizo ese día y no se alcanzó a cargar. `NewLoan`
               ya sabía fechar una venta hacia atrás —lo usa Control Total
               desde el script 078— y mueve con ella la primera cuota, el abono
               inicial y la caja del día. Acá se reusa tal cual. */
            fechaVenta={jornadaAtrasadaAbierta ?? undefined}
          />
        )
      // Las dos pantallas viejas de autorizaciones se unificaron en la
      // bandeja: quien las tenga guardadas o en sus permisos llega a ella.
      case "pending-authorizations":
      case "secretary-authorizations":
      case "movimientos-revision":
        return <MovimientosRevision />
      case "monitoreo-recaudos":
        return <MonitoreoRecaudos currentUser={currentUser} />
      case "multas":
        return <MultasView />
      case "documentos":
        return <DocumentosView currentUser={currentUser!} />
      case "mi-perfil":
        return (
          <MiPerfil
            currentUser={currentUser!}
            onUserUpdate={handleUserUpdate}
            // La unidad con la que se entro: el logo es de ella, no de la
            // persona, y sin esto la tarjeta del logo no se puede mostrar.
            rutaId={rutaId}
            rutaNombre={selectedRuta?.nombre ?? null}
          />
        )
      case "daily-route":
        return <DailyRoute />
      case "reporte-administrador":
        return <ReporteAdministrador />
      case "reporte-gerencial":
        return <ReporteGerencial />
      case "descargar-informe":
        return <DescargarInforme />
      case "tasas-cambio":
        return <TasasCambio />
      case "resumen-rutas":
        return (
          <ResumenRutas
            currentUserId={currentUser?.id}
            onVerRuta={(id) => { setRutaDetalle(id); setCurrentView("admin-route-detail") }}
          />
        )
      case "configure-route":
        return <ConfigureRoute currentRutaId={rutaId} />
      case "register-payment":
        return (
          <RegisterPayment
            onViewChange={handleViewChange}
            currentRutaId={rutaId}
            rutaPais={rutaPais}
            rutaActivaEstado={rutaActivaEstado}
            rutaActivaResolved={rutaActivaResolved}
            onRouteStateChange={handleRutaActivaEstadoChange}
            /* Solo trae valor mientras se está cerrando una jornada vieja
               desbloqueada. Sin eso es `null` y todo se fecha hoy. */
            fechaGestion={jornadaAtrasadaAbierta}
          />
        )
      case "register-transaction":
        return (
          <RegisterTransaction
            onViewChange={handleViewChange}
            currentRutaId={rutaId}
            // Mientras se cierra un día atrasado, los gastos, ingresos y
            // retiros son de ESE día. Es la misma fecha que ya reciben pagos,
            // ventas, resumen y cierre.
            fechaJornada={jornadaAtrasadaAbierta}
          />
        )
      case "view-expenses-income":
        return <ViewExpensesIncome currentRutaId={rutaId} fechaJornada={jornadaAtrasadaAbierta} />
      case "movements":
        return <Movements />
      case "manage-users":
        return <ManageUsers />
      case "manage-profiles":
        return <ManageProfiles />
      case "route-config":
        return <RouteConfig />
      case "config-items":
        return <ConfigItems />
      case "auth-codes":
        return <AuthCodes />
      case "general-config":
        return <GeneralConfig />
      case "admin-route-monitor":
        return <AdminRouteMonitor currentUser={currentUser} />
      case "admin-dashboard":
        return (
          <AdminDashboard
            currentUserId={currentUser?.id}
            onVerResumenRutas={() => setCurrentView("resumen-rutas")}
          />
        )
      case "admin-route-detail":
        return (
          <DetalleRuta
            currentUserId={currentUser?.id}
            currentUserNombre={currentUser?.nombre ?? null}
            rutaInicial={rutaDetalle}
            // Volver lleva a donde se entró: el Resumen de Rutas si se llegó
            // desde ahí (trae ruta elegida), si no el dashboard del admin.
            onVolver={() => handleViewChange(rutaDetalle != null ? "resumen-rutas" : "admin-dashboard")}
            onNavegar={(view) => handleViewChange(view)}
          />
        )
      case "payment-control":
        return <PaymentControl currentRutaId={rutaId} rutaPais={rutaPais} />
      case "sale-editor":
        return <SaleEditor currentRutaId={rutaId} />
      case "loan-audit":
        return <LoanAudit currentRutaId={rutaId} />
      case "secretary-reports":
        return <SecretaryReports currentRutaId={rutaId} />
      case "socio-admin-reportes":
        return <SocioAdminReportes currentUser={currentUser!} />
      case "admin-reportes":
        return <AdminReportes currentUser={currentUser!} />
      case "secretary-admin-reportes":
        return <SecretaryAdminReportes currentUser={currentUser!} />
      case "user-route-management":
        return <GestionUsuariosRutas />
      case "chat":
        return (
          <ChatView
            currentUser={currentUser!}
            onUnreadChange={(total) =>
              setModuleBadgeCounts((prev) =>
                prev.chat === total ? prev : { ...prev, chat: total },
              )
            }
          />
        )
      case "reportes-bi":
        return <ReportesBi currentUser={currentUser!} />
      default:
        return <MainDashboard onViewChange={handleViewChange} />
    }
  }

  // Wait for localStorage hydration before deciding what to render
  if (!hydrated) {
    return <div className="min-h-screen bg-background" aria-hidden="true" />
  }

  // 1) No user → Login screen
  if (!currentUser) {
    return <LoginView onLoginSuccess={handleLoginSuccess} aviso={avisoSesion} />
  }

  // El PIN NO se devuelve acá con un `return`, aunque sea lo primero que uno
  // escribiria. Va como capa ENCIMA, al final del render. Ver el porque
  // junto al overlay.

  // Render principal: loading / error / dashboard
  let mainContent: React.ReactNode

  if (sessionPhase === "applying" || sessionPhase === "idle") {
    // Pantalla de carga mientras se fija la sesion contra Supabase. NO se
    // renderiza ninguna vista todavia para evitar fetches que choquen con RLS.
    mainContent = (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" aria-hidden="true" />
        <p className="text-sm font-medium text-muted-foreground">
          Preparando tu sesion para la ruta seleccionada...
        </p>
      </div>
    )
  } else if (sessionPhase === "error") {
    // Pantalla de error generica (rara ahora que sessionPhase pasa
    // directamente a "ready" sin tocar la base).
    mainContent = (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="h-7 w-7" aria-hidden="true" />
        </div>
        <div className="flex max-w-md flex-col gap-1">
          <h2 className="text-lg font-bold text-foreground">
            No se pudo preparar la sesion
          </h2>
          <p className="text-sm text-muted-foreground">
            Hubo un problema fijando la ruta activa para tu sesion. Por
            seguridad, no se cargara ningun dato hasta resolverlo.
          </p>
          {sessionError && (
            <p className="mt-2 break-words text-xs text-muted-foreground/80">
              <span className="font-mono">{sessionError}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={handleRetrySession} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
          <Button variant="outline" onClick={handleChangeRuta}>
            Cambiar de ruta
          </Button>
          <Button variant="ghost" onClick={() => handleLogout()}>
            Cerrar sesion
          </Button>
        </div>
      </div>
    )
  } else {
    // sessionPhase === "ready" — sesion fijada con exito, renderizar app.
    mainContent = (
      <DashboardLayout
        currentView={currentView}
        onViewChange={handleViewChange}
        selectedRuta={selectedRuta}
        onChangeRuta={canChangeRuta ? handleChangeRuta : undefined}
        currentUser={currentUser}
        onLogout={handleLogout}
        userPermissions={userPermissions}
        moduleBadgeCounts={moduleBadgeCounts}
      >
        {/* EL AVISO DE VERSIÓN NUEVA, ARRIBA DE TODO Y EN CUALQUIER MÓDULO.
            No sirve de nada ponerlo en una pantalla sola: la app se abre por la
            mañana y se queda en el módulo de pagos el resto del día. Tiene que
            aparecer donde la persona esté. */}
        <AvisoVersionNueva />
        {/* EL AVISO DE CONGELADA, para quien puede levantarla.
            A la secretaría no se le tapa la app: se le avisa y se le da el
            botón donde esté. Al cobrador se le tapa, que es el punto. */}
        {jornadaPendiente && puedeLevantarElCongelamiento && currentUser && (
          <AvisoJornadaCongelada
            jornada={jornadaPendiente}
            rutaNombre={selectedRuta?.nombre ?? ""}
            usuario={{ id: currentUser.id, nombre: currentUser.nombre }}
            onDescongelada={() => setReleerJornada((n) => n + 1)}
            /* El camino normal: se abre el cierre de caja DE ESE DIA. La
               fecha viaja por `viewData`, y `cierre-caja` esta en
               VISTAS_SIN_RUTA, asi que se puede entrar con la ruta congelada
               —que es justamente cuando hace falta. */
            onIrAlCierre={() =>
              handleViewChange("cierre-caja", { fechaJornada: jornadaPendiente.fecha })
            }
          />
        )}
        {rutaCongelada && jornadaPendiente ? (
          <RutaCongelada
            jornada={jornadaPendiente}
            onIrAlChat={() => handleViewChange("chat")}
            /* Cuando la secretaría ya habilitó, el cobrador cierra ese día él
               mismo: `cierre-caja` está en VISTAS_SIN_RUTA, así que se puede
               entrar con la ruta congelada — que es justamente cuando hace
               falta. */
            desbloqueada={jornadaPendiente.desbloqueada}
            onIrAlCierre={() =>
              handleViewChange("cierre-caja", { fechaJornada: jornadaPendiente.fecha })
            }
          />
        ) : rutaSinIniciar ? (
          <RutaNoIniciada
            rutaId={rutaId}
            resuelto={rutaActivaResolved}
            estado={rutaActivaEstado}
            onEstadoChange={handleRutaActivaEstadoChange}
            mensaje="Antes de trabajar tienes que iniciar la ruta del dia. Hasta entonces no se puede entrar a ningun modulo."
            onIrAlChat={() => handleViewChange("chat")}
          />
        ) : (
          renderView()
        )}
      </DashboardLayout>
    )
  }

  return (
    <>
      {mainContent}

      {/* EL PIN VA ENCIMA, NO EN LUGAR DE.
          Antes esto era un `return <PinLockView/>` antes del dashboard, y por
          eso se perdia el trabajo a medias: al reemplazar el arbol, React
          desmontaba el formulario y con el se iba TODO su estado. El caso que
          lo destapo: tomar la foto de la cedula en Nueva Venta. La camara
          manda la app a segundo plano, al volver aparecia el PIN, y la foto
          recien tomada ya no existia.
          Como capa, el formulario sigue montado detras y al desbloquear la
          persona vuelve exactamente a donde estaba, con su foto.
          Es opaca y va por encima de todo (los dialogos de Radix usan z-50),
          asi que quien levanta el telefono no alcanza a ver nada. */}
      {/* `requierePin` otra vez acá y no solo al armar el candado: si alguna
          vez `bloqueado` quedara en true por otro camino, una secretaria se
          encontraría una pantalla de PIN de la que no puede salir. */}
      {bloqueado && requierePin(currentUser.rol) && (
        <div className="fixed inset-0 z-[200] overflow-y-auto bg-background">
          <PinLockView
            user={currentUser}
            onDesbloqueado={() => setBloqueado(false)}
            // Salir del PIN es la misma persona yendo al login: sin señal
            // necesita el cache para seguir trabajando al volver a entrar.
            onSalir={() => handleLogout({ conservarCache: true })}
          />
        </div>
      )}

      {showSplash && (
        <LoginSplash
          userName={currentUser.nombre}
          onComplete={() => setShowSplash(false)}
        />
      )}
      <RouteSelector
        open={showRutaSelector}
        onSelect={handleSelectRuta}
        userId={currentUser.id}
        userRol={currentUser.rol}
        onClose={() => setShowRutaSelector(false)}
      />
    </>
  )
}
