"use client"

import {
  DollarSign, Plus, TrendingUp, BarChart3, Users,
  LayoutDashboard, ClipboardList, CheckCircle, Route, MapPin,
  ListChecks, FileText, Link2, Eye, ShoppingBag, MessageSquare, BarChart2, ShieldCheck, AlertTriangle, FolderOpen,
  SlidersHorizontal, ScanSearch,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AuthenticatedUser } from "./views/login-view"
import type { PermissionsMap } from "@/lib/modules-catalog"

type NavItem = { id: string; icon: React.ElementType; label: string; colorClass: string }

interface MobileBottomNavProps {
  currentView: string
  onViewChange: (view: string) => void
  currentUser?: AuthenticatedUser | null
  userPermissions?: PermissionsMap | null
  moduleBadgeCounts?: Record<string, number>
}

const VENDEDOR_ITEMS: NavItem[] = [
  { id: "daily-summary",        icon: BarChart3,       label: "Resumen",   colorClass: "nav-item-summary"  },
  { id: "register-payment",     icon: DollarSign,      label: "Pagos",     colorClass: "nav-item-payment"  },
  { id: "new-loan",             icon: Plus,            label: "Venta",     colorClass: "nav-item-sale"     },
  { id: "register-transaction", icon: TrendingUp,      label: "Gastos",    colorClass: "nav-item-expense"  },
  { id: "view-clients",         icon: Users,           label: "Clientes",  colorClass: "nav-item-home"     },
]

const ADMIN_ITEMS: NavItem[] = [
  { id: "admin-dashboard",        icon: LayoutDashboard, label: "Dashboard", colorClass: "nav-item-home"     },
  { id: "admin-route-detail",     icon: ClipboardList,   label: "Rutas",     colorClass: "nav-item-summary"  },
  { id: "movimientos-revision",   icon: ShieldCheck,     label: "Revisión",  colorClass: "nav-item-payment"  },
  { id: "admin-route-monitor",    icon: Route,           label: "Monitor",   colorClass: "nav-item-expense"  },
  { id: "configure-route",        icon: MapPin,          label: "Ordenar",   colorClass: "nav-item-sale"     },
]

const SECRETARIA_ITEMS: NavItem[] = [
  { id: "movimientos-revision",      icon: ShieldCheck, label: "Revisión",  colorClass: "nav-item-payment"  },
  { id: "payment-control",           icon: ListChecks,  label: "Control",   colorClass: "nav-item-summary"  },
  { id: "secretary-reports",         icon: FileText,    label: "Reportes",  colorClass: "nav-item-home"     },
  { id: "secretary-admin-reportes",  icon: FileText,    label: "Rep. Admin",colorClass: "nav-item-expense"  },
  { id: "user-route-management",     icon: Link2,       label: "Gestión",   colorClass: "nav-item-sale"     },
]

const GERENCIA_ITEMS: NavItem[] = [
  { id: "secretary-reports", icon: FileText, label: "Reportes", colorClass: "nav-item-home" },
]

const LIQUIDADOR_ITEMS: NavItem[] = [
  { id: "admin-reportes", icon: FileText, label: "Rep. diarios", colorClass: "nav-item-home" },
]

// Lookup completo de todos los módulos posibles (para permisos cross-rol)
const ALL_NAV_ITEMS: NavItem[] = [
  // Asesor
  { id: "daily-summary",        icon: BarChart3,       label: "Resumen",   colorClass: "nav-item-summary"  },
  { id: "register-payment",     icon: DollarSign,      label: "Pagos",     colorClass: "nav-item-payment"  },
  { id: "new-loan",             icon: Plus,            label: "Venta",     colorClass: "nav-item-sale"     },
  { id: "register-transaction", icon: TrendingUp,      label: "Gastos",    colorClass: "nav-item-expense"  },
  { id: "view-clients",         icon: Users,           label: "Clientes",  colorClass: "nav-item-home"     },
  { id: "view-expenses-income", icon: Eye,             label: "Ver G.",    colorClass: "nav-item-summary"  },
  { id: "view-loans",           icon: ShoppingBag,     label: "Ventas",    colorClass: "nav-item-clients"  },
  // Admin
  { id: "admin-dashboard",        icon: LayoutDashboard, label: "Dashboard", colorClass: "nav-item-home"     },
  { id: "admin-route-detail",     icon: ClipboardList,   label: "Rutas",     colorClass: "nav-item-summary"  },
  { id: "pending-authorizations", icon: CheckCircle,     label: "Autoriz.",  colorClass: "nav-item-payment"  },
  { id: "admin-route-monitor",    icon: Route,           label: "Monitor",   colorClass: "nav-item-expense"  },
  { id: "configure-route",        icon: MapPin,          label: "Ordenar",   colorClass: "nav-item-sale"     },
  { id: "admin-reportes",         icon: FileText,        label: "Rep. A.",   colorClass: "nav-item-home"     },
  // Secretaria
  { id: "secretary-authorizations", icon: CheckCircle, label: "Autoriz.",  colorClass: "nav-item-payment"  },
  { id: "movimientos-revision",    icon: ShieldCheck,  label: "Revisión",  colorClass: "nav-item-payment"  },
  { id: "multas",                  icon: AlertTriangle, label: "Multas",   colorClass: "nav-item-expense"  },
  { id: "documentos",              icon: FolderOpen,    label: "Documentos", colorClass: "nav-item-clients"  },
  { id: "payment-control",         icon: ListChecks,   label: "Control",   colorClass: "nav-item-summary"  },
  { id: "sale-editor",             icon: SlidersHorizontal, label: "C. Total", colorClass: "nav-item-payment" },
  { id: "loan-audit",              icon: ScanSearch,   label: "Auditoría", colorClass: "nav-item-summary"  },
  { id: "secretary-reports",       icon: FileText,     label: "Reportes",  colorClass: "nav-item-home"     },
  { id: "secretary-admin-reportes",icon: FileText,     label: "Rep. Admin",colorClass: "nav-item-expense"  },
  { id: "user-route-management",   icon: Link2,        label: "Gestión",   colorClass: "nav-item-sale"     },
  // Socio Admin
  { id: "socio-admin-reportes",    icon: FileText,     label: "Reportes",  colorClass: "nav-item-home"     },
  // General
  { id: "chat",        icon: MessageSquare, label: "Chat",     colorClass: "nav-item-summary"  },
  { id: "reportes-bi", icon: BarChart2,     label: "Power BI", colorClass: "nav-item-summary"  },
]

const COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" }

export function MobileBottomNav({ currentView, onViewChange, currentUser, userPermissions, moduleBadgeCounts }: MobileBottomNavProps) {
  const rol = (currentUser?.rol ?? "").toLowerCase()

  const navItems = (() => {
    // Con permisos explícitos: mostrar los que el usuario tiene enabled+inMobileNav de cualquier módulo
    if (userPermissions) {
      return ALL_NAV_ITEMS
        .filter((item) => userPermissions[item.id]?.enabled === true)
        .filter((item) => userPermissions[item.id]?.inMobileNav === true)
        .slice(0, 5)
    }

    // Sin permisos: arrays por rol (comportamiento actual)
    return (
      ["admin", "administrador"].includes(rol)   ? ADMIN_ITEMS :
      ["secretaria", "secretario"].includes(rol) ? SECRETARIA_ITEMS :
      rol === "gerencia"                         ? GERENCIA_ITEMS :
      rol === "liquidador"                       ? LIQUIDADOR_ITEMS :
                                                   VENDEDOR_ITEMS
    )
  })()

  const colsClass = COLS[navItems.length] ?? "grid-cols-5"

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-border md:hidden safe-area-inset-bottom">
      <div className={`grid ${colsClass} gap-1 p-1`}>
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = currentView === item.id
          const unread = moduleBadgeCounts?.[item.id] ?? 0
          return (
            <Button
              key={item.id}
              variant="ghost"
              onClick={() => onViewChange(item.id)}
              // 48px de alto. Es el minimo que se puede tocar con seguridad:
              // 44px es lo que recomiendan iOS y Android para un objetivo de
              // dedo, asi que por debajo de esto habria que empezar a fallar
              // toques. Adentro: icono 24 + etiqueta 12 con interlineado
              // ajustado = 38px, o sea que todavia respira.
              className={`relative h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 px-1 ${item.colorClass} ${
                isActive ? "nav-item-active" : "nav-item-inactive"
              }`}
              style={{
                boxShadow: isActive
                  ? "0 6px 16px rgba(58, 124, 165, 0.7), 0 2px 4px rgba(58, 124, 165, 0.5), inset 0 1px 0 rgba(255,255,255,0.25)"
                  : "0 5px 14px rgba(58, 124, 165, 0.55), 0 2px 4px rgba(58, 124, 165, 0.4), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
            >
              {/* 24px, el estandar de una barra inferior. Empezaron en 32. */}
              <Icon className="h-6 w-6 shrink-0" />
              {/* `leading-none`: sin eso la linea mide 16px en vez de 12 y son
                  4px que en un boton de 48 ya se notan. La etiqueta se queda —
                  quitarla ahorraria 12px mas, pero el cobrador identifica los
                  modulos por el nombre, no por el dibujo. */}
              <span className="text-xs font-semibold leading-none">{item.label}</span>
              {unread > 0 && (
                // El circulo pasa de 16 a 20px: con la letra mas grande (ver
                // el piso de tamano en globals.css) un "9+" quedaba rozando el
                // borde.
                <span className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold leading-none shadow">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
