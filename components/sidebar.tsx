"use client"

import React, { useState, useEffect } from "react"
import {
  DollarSign,
  ChevronLeft,
  ChevronsRight,
  Plus,
  TrendingUp,
  BarChart3,
  BarChart2,
  Eye,
  MapPin,
  Users,
  ShoppingBag,
  Route,
  ListChecks,
  LogOut,
  User as UserIcon,
  LayoutDashboard,
  ClipboardList,
  FileText,
  Download,
  Share2,
  MoreVertical,
  MessageSquare,
  ShieldCheck,
  AlertTriangle,
  FolderOpen,
  SlidersHorizontal,
  ScanSearch,
  FileSpreadsheet,
  ArrowRightLeft,
  LayoutList,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { AuthenticatedUser } from "./views/login-view"
import { ALL_MODULES, type PermissionsMap } from "@/lib/modules-catalog"
import { BotonActualizar } from "@/components/actualizar-app"

// Tipo para el evento de instalación PWA (no está en los tipos estándar de TS)
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

type NavItem = { id: string; label: string; icon: React.ElementType; colorClass: string }
type NavGroup = { group: string; items: NavItem[] }

const navGroups: NavGroup[] = [
  {
    group: "Asesor",
    items: [
      { id: "daily-summary",        label: "Resumen del Día",   icon: BarChart3,   colorClass: "sidebar-item-summary"   },
      { id: "register-payment",     label: "Registrar Pago",    icon: DollarSign,  colorClass: "sidebar-item-payment"   },
      { id: "new-loan",             label: "Nueva Venta",        icon: Plus,        colorClass: "sidebar-item-sale"      },
      { id: "view-clients",         label: "Clientes",           icon: Users,       colorClass: "sidebar-item-clients"   },
      { id: "register-transaction", label: "Gasto e Ingreso",   icon: TrendingUp,  colorClass: "sidebar-item-expense"   },
      { id: "view-expenses-income", label: "Ver Gastos",         icon: Eye,         colorClass: "sidebar-item-view"      },
      { id: "view-loans",           label: "Ver Ventas",         icon: ShoppingBag, colorClass: "sidebar-item-clients"   },
    ],
  },
  {
    group: "Administrador",
    items: [
      { id: "admin-dashboard",        label: "Dashboard",          icon: LayoutDashboard, colorClass: "sidebar-item-summary"  },
      { id: "admin-route-detail",     label: "Detalle Rutas",      icon: ClipboardList,   colorClass: "sidebar-item-clients"  },
      { id: "resumen-rutas",          label: "Resumen Rutas",      icon: LayoutList,      colorClass: "sidebar-item-clients"  },
      // LA BANDEJA ÚNICA de aprobaciones (05-oct-2026): reemplaza a "Autor.
      // Admin" y "Autor. Secret.". Va en los dos grupos: admin y secretaría
      // entran los dos, y cada uno aprueba su paso.
      { id: "movimientos-revision",   label: "Movim. Revisión",    icon: ShieldCheck,     colorClass: "sidebar-item-payment"  },
      { id: "admin-route-monitor",    label: "Monitoreo Rutas",    icon: Route,           colorClass: "sidebar-item-route"    },
      { id: "configure-route",        label: "Ordenar Ruta",       icon: MapPin,          colorClass: "sidebar-item-route"    },
      { id: "admin-reportes",         label: "Rep. diarios",       icon: FileText,        colorClass: "sidebar-item-secretary"},
      { id: "reporte-administrador",  label: "Reporte Admin",      icon: BarChart3,       colorClass: "sidebar-item-secretary"},
      { id: "reporte-gerencial",      label: "Reporte Gerencial",  icon: BarChart2,       colorClass: "sidebar-item-secretary"},
    ],
  },
  {
    group: "Secretaria",
    items: [
      { id: "monitoreo-recaudos",        label: "Mon. Recaudos",   icon: TrendingUp,    colorClass: "sidebar-item-summary"   },
      { id: "movimientos-revision",      label: "Movim. Revisión", icon: ShieldCheck,   colorClass: "sidebar-item-payment"   },
      { id: "multas",                    label: "Multas",          icon: AlertTriangle, colorClass: "sidebar-item-expense"   },
      { id: "documentos",                label: "Documentos",      icon: FolderOpen,    colorClass: "sidebar-item-clients"   },
      { id: "payment-control",           label: "Control Pagos",   icon: ListChecks,    colorClass: "sidebar-item-payment"   },
      { id: "sale-editor",               label: "Control Total",   icon: SlidersHorizontal, colorClass: "sidebar-item-payment" },
      { id: "loan-audit",                label: "Auditoría 360",   icon: ScanSearch,    colorClass: "sidebar-item-summary"   },
      { id: "secretary-reports",         label: "Reportes",        icon: FileText,    colorClass: "sidebar-item-secretary" },
      { id: "descargar-informe",         label: "Descargar Informe", icon: FileSpreadsheet, colorClass: "sidebar-item-secretary" },
      { id: "tasas-cambio",              label: "Tasas de Cambio", icon: ArrowRightLeft, colorClass: "sidebar-item-secretary" },
      { id: "secretary-admin-reportes",  label: "Rep. Admin",      icon: FileText,    colorClass: "sidebar-item-clients"   },
      { id: "user-route-management",     label: "Usuarios/Rutas",  icon: Users,       colorClass: "sidebar-item-clients"   },
      { id: "reportes-bi",               label: "Power BI",        icon: BarChart2,   colorClass: "sidebar-item-summary"   },
    ],
  },
  {
    group: "Gerencia",
    items: [
      { id: "secretary-reports", label: "Reportes",  icon: FileText,  colorClass: "sidebar-item-secretary" },
    ],
  },
  {
    group: "Liquidador",
    items: [
      { id: "admin-reportes", label: "Rep. diarios", icon: FileText,  colorClass: "sidebar-item-secretary" },
    ],
  },
  {
    group: "Socio Administrador",
    items: [
      { id: "socio-admin-reportes", label: "Reportes", icon: FileText,  colorClass: "sidebar-item-secretary" },
    ],
  },
  {
    group: "General",
    items: [
      { id: "chat", label: "Chat", icon: MessageSquare, colorClass: "sidebar-item-summary" },
    ],
  },
]

interface SidebarProps {
  currentView: string
  onViewChange: (view: string) => void
  isCollapsed?: boolean
  onToggleCollapse?: () => void
  currentUser?: AuthenticatedUser | null
  onLogout?: () => void
  userPermissions?: PermissionsMap | null
  moduleBadgeCounts?: Record<string, number>
}

export function Sidebar({
  currentView,
  onViewChange,
  isCollapsed = false,
  onToggleCollapse,
  currentUser,
  onLogout,
  userPermissions,
  moduleBadgeCounts,
}: SidebarProps) {
  const rol = (currentUser?.rol ?? "").toLowerCase()

  // ── PWA install prompt ────────────────────────────────────────────────────
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isStandalone, setIsStandalone] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [showInstallModal, setShowInstallModal] = useState(false)

  useEffect(() => {
    setIsStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
      !!(window.navigator as unknown as { standalone?: boolean }).standalone
    )
    setIsIOS(
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    )
    const handler = (e: Event) => {
      e.preventDefault()
      setInstallPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener("beforeinstallprompt", handler)
    window.addEventListener("appinstalled", () => { setInstallPrompt(null); setIsStandalone(true) })
    return () => window.removeEventListener("beforeinstallprompt", handler)
  }, [])

  const handleInstall = async () => {
    if (installPrompt) {
      await installPrompt.prompt()
      const { outcome } = await installPrompt.userChoice
      if (outcome === "accepted") setInstallPrompt(null)
    } else {
      setShowInstallModal(true)
    }
  }

  const generalGroup = navGroups.find((g) => g.group === "General")!

  // Filtrar grupos de navegación según el rol del usuario (y permisos individuales si aplica)
  const visibleGroups = (() => {
    // Con permisos explícitos: mostrar todos los módulos habilitados de cualquier grupo
    if (userPermissions) {
      const filtered = navGroups
        .map((g) => ({
          ...g,
          items: g.items.filter((item) =>
            g.group === "General" ? true : userPermissions[item.id]?.enabled === true
          ),
        }))
        .filter((g) => g.items.length > 0)
      // Asegurar que General siempre esté al final
      return [
        ...filtered.filter((g) => g.group !== "General"),
        generalGroup,
      ]
    }

    // Sin permisos propios: manda `defaultRoles` del catalogo, NO el grupo.
    //
    // Antes esto era `navGroups.filter(g => g.group === "Asesor")` y sus
    // hermanos: el grupo hacia de sustituto del rol. Con eso, la visibilidad
    // se decidia de DOS formas distintas segun si el usuario tenia permisos
    // personalizados —por `defaultRoles` en un caso, por el grupo en el otro—
    // y las dos discrepaban. Un admin sin permisos propios no veia Auditoria
    // 360 ni Control Total, aunque el catalogo se los daba, solo porque esos
    // modulos estan dibujados dentro del grupo "Secretaria".
    //
    // Ahora el grupo es lo que dice: un titulo para agrupar el menu. Quien ve
    // que sale de un solo lado.
    const rolesDe = new Map(ALL_MODULES.map((m) => [m.viewId, m.defaultRoles]))
    const roleGroup = navGroups
      .map((g) => ({
        ...g,
        items: g.items.filter((item) => (rolesDe.get(item.id) ?? []).includes(rol)),
      }))
      .filter((g) => g.items.length > 0)
    return [...roleGroup.filter((g) => g.group !== "General"), generalGroup]
  })()

  const initials = currentUser?.nombre
    ? currentUser.nombre
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p.charAt(0))
        .join("")
        .toUpperCase()
    : ""

  return (
    <>
    <aside
      className={cn(
        "h-full border-r border-sidebar-border bg-sidebar-gradient relative transition-all duration-300 flex flex-col",
        isCollapsed ? "w-16" : "w-60",
      )}
    >
      {/* Header */}
      <div className="flex h-12 md:h-16 items-center border-b border-sidebar-border px-3 md:px-6 flex-shrink-0">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="flex h-7 w-7 md:h-9 md:w-9 items-center justify-center rounded-lg bg-white/95 ring-1 ring-white/20 overflow-hidden p-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/opad-logo.png"
              alt="OPAD APP"
              className="h-full w-full object-contain"
            />
          </div>
          {!isCollapsed && (
            <div className="flex flex-col leading-tight">
              <span className="text-sm md:text-base font-extrabold tracking-tight text-sidebar-foreground">
                OPAD
              </span>
              <span className="text-[9px] md:text-[10px] font-semibold tracking-[0.18em] text-sidebar-primary uppercase">
                APP
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Collapse toggle */}
      {onToggleCollapse && (
        <Button
          variant="ghost"
          size="icon"
          className="hidden md:flex absolute -right-3 top-20 z-50 h-6 w-6 rounded-full border border-sidebar-border bg-brand text-brand-foreground hover:bg-brand-light"
          onClick={onToggleCollapse}
        >
          {isCollapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </Button>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">

        {/* Grouped Quick Access */}
        <div className="flex flex-col divide-y divide-sidebar-border">
          {visibleGroups.map(({ group, items }, gi) => (
            <div key={group} className="p-1.5 md:p-3">
              {!isCollapsed && (
                <p className="text-[9px] md:text-[10px] font-bold uppercase tracking-wider text-white/80 px-1 mb-1.5">
                  {group}
                </p>
              )}
              {isCollapsed && gi > 0 && (
                <div className="border-t border-sidebar-border mb-1" />
              )}
              <div className={cn("grid gap-1", isCollapsed ? "grid-cols-1" : "grid-cols-3")}>
                {items.map((item) => {
                  const Icon = item.icon
                  const isActive = currentView === item.id
                  const unread = moduleBadgeCounts?.[item.id] ?? 0
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onViewChange(item.id)}
                      title={item.label}
                      className={cn(
                        "relative flex flex-col items-center justify-center rounded-md transition-all active:scale-95",
                        isCollapsed ? "p-2 h-10" : "p-1.5 h-14 gap-1",
                        item.colorClass,
                        isActive
                          ? "ring-2 ring-offset-1 ring-current shadow-sm opacity-100"
                          : "opacity-60 hover:opacity-100",
                      )}
                    >
                      <Icon className={cn(isCollapsed ? "h-4 w-4" : "h-4 w-4 md:h-5 md:w-5")} />
                      {!isCollapsed && (
                        <span className="text-[8px] md:text-[9px] font-medium text-center leading-tight line-clamp-2">
                          {item.label}
                        </span>
                      )}
                      {unread > 0 && (
                        <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold leading-none shadow">
                          {unread > 9 ? "9+" : unread}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>


      </div>

      {/* Botón instalar app — desktop (aparece al fondo del sidebar cuando el browser lo permite) */}
      {installPrompt && !isCollapsed && (
        <div className="hidden md:block flex-shrink-0 px-3 pb-3">
          <button
            type="button"
            onClick={handleInstall}
            className="w-full flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs font-medium text-sidebar-foreground hover:bg-white/20 transition-colors"
          >
            <Download className="h-3.5 w-3.5 shrink-0" />
            Instalar app
          </button>
        </div>
      )}
      {installPrompt && isCollapsed && (
        <div className="hidden md:block flex-shrink-0 px-1.5 pb-3">
          <button
            type="button"
            onClick={handleInstall}
            title="Instalar app"
            className="w-full flex items-center justify-center rounded-lg border border-white/20 bg-white/10 p-2 text-sidebar-foreground hover:bg-white/20 transition-colors"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Mobile-only session footer with user info + logout */}
      {currentUser && (
        <div className="md:hidden flex-shrink-0 border-t border-sidebar-border bg-white/10 backdrop-blur-sm p-3">
          <button
            type="button"
            onClick={() => onViewChange("mi-perfil")}
            className="flex items-center gap-3 w-full text-left rounded-lg -m-1 p-1 hover:bg-white/10 transition-colors"
          >
            <Avatar className="h-10 w-10 ring-2 ring-white/30">
              {currentUser.foto_url && <AvatarImage src={currentUser.foto_url} alt={currentUser.nombre} />}
              <AvatarFallback className="bg-brand-gradient text-brand-foreground text-xs font-bold">
                {initials || <UserIcon className="h-4 w-4" />}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-1 flex-col min-w-0 leading-tight">
              <span className="truncate text-sm font-semibold text-sidebar-foreground">
                {currentUser.nombre || "Usuario"}
              </span>
              {currentUser.rol && (
                <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/70">
                  {currentUser.rol}
                </span>
              )}
            </div>
          </button>

          {/* TRAER LA VERSIÓN NUEVA A MANO.
              El aviso automático aparece solo cuando hay algo nuevo publicado;
              este botón está siempre, para cuando algo se ve raro y uno
              prefiere forzarlo sin esperar. Va en el menú y no dentro de un
              módulo: actualiza la app ENTERA, no los datos de una pantalla —
              que es lo que hacen los otros botones de refrescar y por eso
              refrescar módulo por módulo no traía los cambios. */}
          <div className="mt-3">
            <BotonActualizar className="border-white/30 bg-white/15 text-sidebar-foreground hover:bg-white/25 hover:text-sidebar-foreground" />
          </div>

          {/* Instalar app — móvil: siempre visible mientras no esté instalada */}
          {!isStandalone && (
            <div className="mt-3">
              <Button
                type="button"
                onClick={handleInstall}
                variant="outline"
                size="sm"
                className="w-full gap-2 border-white/30 bg-white/15 text-sidebar-foreground hover:bg-white/25 hover:text-sidebar-foreground font-semibold"
              >
                <Download className="h-4 w-4 shrink-0" />
                Instalar aplicación
              </Button>
            </div>
          )}

          {onLogout && (
            <Button
              type="button"
              onClick={onLogout}
              variant="outline"
              size="sm"
              className="mt-2 w-full gap-2 border-white/30 bg-white/10 text-sidebar-foreground hover:bg-white/20 hover:text-sidebar-foreground"
            >
              <LogOut className="h-4 w-4" />
              Cerrar sesion
            </Button>
          )}
        </div>
      )}
    </aside>

    {/* Modal de instalación — solo se abre cuando beforeinstallprompt no está disponible */}
    <Dialog open={showInstallModal} onOpenChange={setShowInstallModal}>
      <DialogContent className="max-w-xs sm:max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4 text-primary" />
            Instalar aplicación
          </DialogTitle>
        </DialogHeader>

        {isIOS ? (
          <div className="space-y-4 pt-1">
            <div className="flex items-start gap-3">
              <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">1</span>
              <div>
                <p className="text-sm font-semibold leading-tight">Toca el botón compartir</p>
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                  El ícono <Share2 className="inline h-3.5 w-3.5 shrink-0" /> en la barra inferior del navegador
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">2</span>
              <div>
                <p className="text-sm font-semibold leading-tight">Selecciona &quot;Agregar a pantalla de inicio&quot;</p>
                <p className="text-xs text-muted-foreground mt-0.5">Desplázate hacia abajo en el menú de opciones</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">3</span>
              <div>
                <p className="text-sm font-semibold leading-tight">Toca &quot;Agregar&quot;</p>
                <p className="text-xs text-muted-foreground mt-0.5">La app quedará disponible en tu pantalla de inicio</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            <div className="flex items-start gap-3">
              <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">1</span>
              <div>
                <p className="text-sm font-semibold leading-tight">Abre el menú del navegador</p>
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                  Toca el ícono <MoreVertical className="inline h-3.5 w-3.5 shrink-0" /> en la esquina superior derecha
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">2</span>
              <div>
                <p className="text-sm font-semibold leading-tight">Toca &quot;Instalar aplicación&quot;</p>
                <p className="text-xs text-muted-foreground mt-0.5">O &quot;Añadir a pantalla de inicio&quot; según tu navegador</p>
              </div>
            </div>
          </div>
        )}

        <Button
          type="button"
          size="sm"
          className="w-full mt-2"
          onClick={() => setShowInstallModal(false)}
        >
          Entendido
        </Button>
      </DialogContent>
    </Dialog>
    </>
  )
}
