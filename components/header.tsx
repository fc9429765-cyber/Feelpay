"use client"

import { Bell, User, Menu, PanelLeftClose, PanelLeft, MapPin, MapPinOff, Loader2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { OfflineIndicator } from "@/components/offline-indicator"
import { useState, useEffect } from "react"
import { useEstadoGps } from "@/lib/use-gps"
import { useClientesAsignados } from "@/lib/use-clientes-asignados"
import type { SelectedRuta } from "./route-selector"
import type { AuthenticatedUser } from "./views/login-view"


interface HeaderProps {
  title: string
  onMenuClick?: () => void
  onSidebarToggle?: () => void
  isSidebarOpen?: boolean
  selectedRuta?: SelectedRuta | null
  onChangeRuta?: () => void
  currentUser?: AuthenticatedUser | null
  onLogout?: () => void
  onViewChange?: (view: string) => void
  /**
   * Pendientes por módulo. Solo se usa para poner un punto sobre el botón de
   * menú: en móvil, módulos como el chat no caben en la barra inferior
   * (`defaultMobileNavRoles: []`) y viven detrás de la hamburguesa, así que
   * su burbuja no se veía nunca sin abrir el menú.
   */
  moduleBadgeCounts?: Record<string, number>
  /**
   * Si viene, se muestra junto al nombre de la ruta cuántos clientes tiene
   * asignados (con préstamo activo). Solo lo pide el Resumen del Día.
   */
  mostrarClientesAsignados?: boolean
}

export function Header({
  title,
  onMenuClick,
  onSidebarToggle,
  isSidebarOpen,
  selectedRuta,
  onChangeRuta,
  currentUser,
  onLogout,
  onViewChange,
  moduleBadgeCounts,
  mostrarClientesAsignados,
}: HeaderProps) {
  const hayPendientes = Object.values(moduleBadgeCounts ?? {}).some((n) => n > 0)
  const [currentDateTime, setCurrentDateTime] = useState(new Date())
  // El estado del GPS sale de un solo lugar (`lib/use-gps.ts`), compartido con
  // el modulo de pagos. Antes cada uno lo averiguaba por su cuenta y aca se
  // preguntaba UNA vez al abrir: el cobrador daba el permiso en la pantalla de
  // pagos y esta pastilla seguia en rojo, porque nadie le avisaba.
  const { estado: gpsStatus, volverAPedir: attemptLocation } = useEstadoGps()

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentDateTime(new Date())
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  // Derived ruta values from props (single source of truth managed in app/page.tsx)
  const isGerencia = (currentUser?.rol ?? "").toLowerCase() === "gerencia"
  const ruta = selectedRuta?.id ?? null
  const nombreruta = isGerencia ? "" : (selectedRuta?.nombre ?? "")
  const ciudad = isGerencia ? "" : (selectedRuta?.ciudad ?? "")
  const pais = isGerencia ? "" : (selectedRuta?.pais ?? "")
  const clientesAsignados = useClientesAsignados(mostrarClientesAsignados && !isGerencia ? ruta : null)
  // "👥 42": el número de clientes con préstamo activo en la ruta.
  const chipClientes = mostrarClientesAsignados && clientesAsignados != null ? (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-brand/10 px-1.5 py-px font-bold text-brand"
      title={`${clientesAsignados} clientes asignados (con préstamo activo en la ruta)`}
    >
      <Users className="h-3 w-3" />
      {clientesAsignados}
    </span>
  ) : null

  const formatDateTime = (date: Date) => {
    // FORMATO CORTO, PERO CON EL DIA DE LA SEMANA.
    //
    // Era "miércoles, 9 de septiembre de 2026, 07:01:22" — 44 caracteres que
    // en un telefono empujaban todo lo demas fuera del encabezado. Ahora es
    // "mié 09/09/26 · 07:01", que cabe y dice lo mismo: el dia de la semana
    // (que el cobrador usa para saber a quien le toca), la fecha y la hora.
    // Los segundos se van: nadie los mira y cambiaban el ancho cada segundo.
    const options: Intl.DateTimeFormatOptions = {
      weekday: "short",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }

    // `es-CO` devuelve "mié, 09/09/26, 07:01"; se cambia la ultima coma por un
    // punto medio para que se vea que la hora es otra cosa que la fecha.
    return date
      .toLocaleDateString("es-CO", options)
      .replace(/,([^,]*)$/, " ·$1")
  }

  const formattedDateTime = formatDateTime(currentDateTime)

  return (
    <header className="flex h-12 md:h-16 items-center justify-between border-b border-border bg-card/80 backdrop-blur-md px-2 md:px-6">
      <div className="flex items-center gap-1.5 md:gap-2">
        <Button variant="ghost" size="icon" className="md:hidden h-8 w-8 relative" onClick={onMenuClick}>
          <Menu className="h-4 w-4" />
          {hayPendientes && (
            <span
              className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-card"
              aria-label="Tienes avisos sin ver"
            />
          )}
        </Button>

        <Button variant="ghost" size="icon" className="hidden md:flex h-10 w-10" onClick={onSidebarToggle}>
          {isSidebarOpen ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeft className="h-5 w-5" />}
        </Button>

        <h1 className="text-sm md:text-xl font-semibold text-card-foreground truncate">{title}</h1>

        <div className="hidden md:flex ml-4 text-xs text-muted-foreground gap-2 items-center">
          {nombreruta ? (
            <>
              <span className="font-semibold text-primary">Ruta: {ruta}</span>
              <span className="text-muted-foreground/50">•</span>
              <span className="font-semibold text-primary">{nombreruta}</span>
              {chipClientes}
              {ciudad && (
                <>
                  <span className="text-muted-foreground/50">•</span>
                  <span className="font-semibold text-primary">{ciudad}</span>
                </>
              )}
              {pais && (
                <>
                  <span className="text-muted-foreground/50">•</span>
                  <span className="font-semibold text-primary">{pais}</span>
                </>
              )}
              {onChangeRuta && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onChangeRuta}
                  className="ml-1 h-6 gap-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-brand hover:bg-brand/10"
                  title="Cambiar de ruta"
                >
                  <MapPin className="h-3 w-3" />
                  Cambiar Ruta
                </Button>
              )}
              <span className="text-muted-foreground/50">•</span>
            </>
          ) : !isGerencia && onChangeRuta ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onChangeRuta}
              className="h-6 gap-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-brand border-brand/40 hover:bg-brand/10"
              title="Seleccionar ruta de trabajo"
            >
              <MapPin className="h-3 w-3" />
              Seleccionar Ruta
            </Button>
          ) : null}
          <span className="font-medium whitespace-nowrap">{formattedDateTime}</span>
        </div>
      </div>

      <div className="flex items-center gap-1 md:gap-4">
        <div className="flex md:hidden text-[9px] text-muted-foreground mr-1 flex-col items-end">
          {nombreruta ? (
            <div className="flex items-center gap-1">
              {/* EN EL TELEFONO SOLO LA UNIDAD Y LA CIUDAD.
                  Iban tambien el numero de ruta y el pais: cuatro datos en
                  una linea de 10px que se cortaba antes de terminar. El pais
                  es el mismo todo el dia para quien esta cobrando, y el
                  numero ya va en el nombre de la unidad. Lo que queda es lo
                  que cambia y lo que se necesita: que unidad y que ciudad. */}
              <span className="font-semibold text-primary text-[10px]">
                {nombreruta}
                {ciudad ? ` - ${ciudad}` : ""}
              </span>
              {chipClientes}
              {onChangeRuta && (
                <button
                  type="button"
                  onClick={onChangeRuta}
                  className="rounded-full p-0.5 text-brand hover:bg-brand/10"
                  title="Cambiar de ruta"
                  aria-label="Cambiar de ruta"
                >
                  <MapPin className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          ) : !isGerencia && onChangeRuta ? (
            <button
              type="button"
              onClick={onChangeRuta}
              className="flex items-center gap-1 rounded-full border border-brand/40 px-2 py-0.5 text-[10px] font-semibold text-brand hover:bg-brand/10"
              title="Seleccionar ruta de trabajo"
            >
              <MapPin className="h-2.5 w-2.5" />
              Seleccionar Ruta
            </button>
          ) : null}
          <span className="font-medium whitespace-nowrap">{formattedDateTime}</span>
        </div>

        {/* Conexión y operaciones pendientes de sincronizar. Este componente
            monta el motor de sincronización automática de la cola offline. */}
        <OfflineIndicator />

        {/* Location status indicator */}
        {gpsStatus === "checking" && (
          <div
            title="Verificando ubicación..."
            className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="hidden sm:inline">Ubicación</span>
          </div>
        )}
        {gpsStatus === "granted" && (
          <div
            title="Ubicación detectada correctamente"
            className="flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success"
          >
            <MapPin className="h-3 w-3" />
            <span className="hidden sm:inline">Ubicación</span>
          </div>
        )}
        {(gpsStatus === "denied" || gpsStatus === "unavailable") && (
          <button
            type="button"
            onClick={attemptLocation}
            title={
              gpsStatus === "denied"
                ? "No se pudo obtener la ubicación — clic para solicitarla"
                : "Ubicación no disponible — clic para reintentar"
            }
            className="flex animate-pulse items-center gap-1 rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive transition-opacity hover:animate-none hover:opacity-80 cursor-pointer"
          >
            <MapPinOff className="h-3 w-3" />
            <span className="hidden sm:inline">Sin ubicación</span>
          </button>
        )}

        <Button variant="ghost" size="icon" className="relative h-8 w-8 md:h-10 md:w-10">
          <Bell className="h-3.5 w-3.5 md:h-5 md:w-5" />
          <span className="absolute right-1 top-1 h-1.5 w-1.5 md:h-2 md:w-2 rounded-full bg-accent" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="hidden md:flex gap-1 md:gap-2 px-1.5 md:px-4 h-8 md:h-10">
              <Avatar className="h-5 w-5 md:h-8 md:w-8">
                {currentUser?.foto_url && <AvatarImage src={currentUser.foto_url} alt={currentUser.nombre} />}
                <AvatarFallback className="bg-brand-gradient text-brand-foreground text-[10px] md:text-xs font-bold">
                  {currentUser?.nombre
                    ? currentUser.nombre
                        .split(" ")
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((p) => p.charAt(0))
                        .join("")
                        .toUpperCase()
                    : <User className="h-2.5 w-2.5 md:h-4 md:w-4" />}
                </AvatarFallback>
              </Avatar>
              <span className="text-[11px] md:text-sm font-medium hidden sm:inline truncate max-w-[120px]">
                {currentUser?.nombre ?? "Usuario"}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 md:w-56">
            <DropdownMenuLabel className="text-xs md:text-sm">
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold leading-tight truncate">
                  {currentUser?.nombre ?? "Mi Cuenta"}
                </span>
                {currentUser?.rol && (
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {currentUser.rol}
                  </span>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs md:text-sm cursor-pointer" onClick={() => onViewChange?.("mi-perfil")}>Perfil</DropdownMenuItem>
            <DropdownMenuItem className="text-xs md:text-sm">Configuracion</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-xs md:text-sm text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer"
              onClick={() => onLogout?.()}
            >
              Cerrar Sesion
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
