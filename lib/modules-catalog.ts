export interface ModuleDefinition {
  viewId: string
  label: string
  mobileLabel: string
  description: string
  defaultRoles: string[]
  defaultMobileNavRoles: string[]
  iconName: string
  group: string
}

// PermissionsMap: null = usar defaults de rol; objeto = configuración explícita
export type PermissionsMap = Record<string, { enabled: boolean; inMobileNav: boolean }>

export const ALL_MODULES: ModuleDefinition[] = [
  // --- ASESOR / VENDEDOR ---
  {
    viewId: "daily-summary",
    label: "Resumen del Día",
    mobileLabel: "Resumen",
    description: "Resumen diario de cobros y estado de la ruta",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "BarChart3",
    group: "Asesor",
  },
  {
    viewId: "register-payment",
    label: "Registrar Pago",
    mobileLabel: "Pagos",
    description: "Registrar pagos de cuotas de clientes",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "DollarSign",
    group: "Asesor",
  },
  {
    viewId: "new-loan",
    label: "Nueva Venta",
    mobileLabel: "Venta",
    description: "Crear nuevos préstamos o ventas",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "Plus",
    group: "Asesor",
  },
  {
    viewId: "view-clients",
    label: "Clientes",
    mobileLabel: "Clientes",
    description: "Ver y gestionar el listado de clientes",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "Users",
    group: "Asesor",
  },
  {
    viewId: "register-transaction",
    label: "Gasto e Ingreso",
    mobileLabel: "Gastos",
    description: "Registrar gastos e ingresos de la ruta",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "TrendingUp",
    group: "Asesor",
  },
  {
    viewId: "view-expenses-income",
    label: "Ver Gastos",
    mobileLabel: "Ver G.",
    description: "Consultar historial de gastos e ingresos",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: [],
    iconName: "Eye",
    group: "Asesor",
  },
  {
    viewId: "view-loans",
    label: "Ver Ventas",
    mobileLabel: "Ventas",
    description: "Consultar el listado de ventas activas",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: [],
    iconName: "ShoppingBag",
    group: "Asesor",
  },
  // --- ADMINISTRADOR ---
  {
    viewId: "admin-dashboard",
    label: "Dashboard Admin",
    mobileLabel: "Dashboard",
    description: "Panel de control general del administrador",
    defaultRoles: ["admin", "administrador"],
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "LayoutDashboard",
    group: "Administrador",
  },
  {
    viewId: "admin-route-detail",
    label: "Detalle Rutas",
    mobileLabel: "Rutas",
    description: "Ver el detalle de todas las rutas",
    defaultRoles: ["admin", "administrador"],
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "ClipboardList",
    group: "Administrador",
  },
  {
    viewId: "admin-route-monitor",
    label: "Monitoreo de Rutas",
    mobileLabel: "Monitor",
    description: "Monitorear el estado de rutas en tiempo real",
    // Secretaría también: es su pantalla de inicio (06-oct-2026). Ve las
    // rutas que tiene asignadas (ver ROLES_QUE_VEN_TODO en el monitor).
    defaultRoles: ["admin", "administrador", "secretaria", "secretario"],
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "Route",
    group: "Administrador",
  },
  {
    viewId: "reporte-administrador",
    label: "Reporte del Administrador",
    mobileLabel: "Rep. Admin",
    description: "Una línea por ruta y por día: pretendido, cobrado, canceladas y gastos",
    // Admin Y secretaria: se pidio que "un administrador o secretaria pueda
    // ver". No entra a la barra inferior del movil — son cinco lugares y ya
    // estan ocupados por lo que se usa todo el dia.
    defaultRoles: ["admin", "administrador", "secretaria", "secretario"],
    defaultMobileNavRoles: [],
    iconName: "BarChart3",
    group: "Administrador",
  },
  {
    viewId: "reporte-gerencial",
    label: "Reporte Gerencial",
    mobileLabel: "Rep. Gerencial",
    description: "Cuantas unidades cerro cada administrador en cada banda de recaudo",
    // El GERENTE es el destinatario; admin y secretaria tambien, que son
    // quienes arman y revisan la operacion.
    defaultRoles: ["gerencia", "gerente", "admin", "administrador", "secretaria", "secretario"],
    defaultMobileNavRoles: [],
    iconName: "BarChart2",
    group: "Administrador",
  },
  {
    viewId: "tasas-cambio",
    label: "Tasas de Cambio",
    mobileLabel: "Tasas",
    description: "Cuanta moneda local vale 1 USD, con su vigencia en el tiempo",
    // Se pidio para las SECRETARIAS. Admin y gerencia tambien: son quienes
    // leen los informes donde esa conversion se usa.
    defaultRoles: ["secretaria", "secretario", "admin", "administrador", "gerencia", "gerente"],
    defaultMobileNavRoles: [],
    iconName: "ArrowRightLeft",
    group: "Secretaria",
  },
  {
    viewId: "resumen-rutas",
    label: "Resumen de Rutas",
    mobileLabel: "Resumen",
    description: "Todas las unidades en una lista: moto, cobrador, cuanto debia y cuanto lleva",
    defaultRoles: ["admin", "administrador", "secretaria", "secretario", "gerencia", "gerente"],
    defaultMobileNavRoles: [],
    iconName: "LayoutList",
    group: "Administrador",
  },
  {
    viewId: "descargar-informe",
    label: "Descargar Informe",
    mobileLabel: "Informe",
    description: "El Excel de seis hojas: pagos, no pagos, ventas, gastos, ingresos y resumen",
    // Se pidio para las SECRETARIAS, y en el menu vive en SU grupo. El admin
    // tambien lo ve: es quien lo revisa. El rol es lo que manda la
    // visibilidad (ver sidebar.tsx); el grupo es solo bajo que titulo sale.
    defaultRoles: ["secretaria", "secretario", "admin", "administrador"],
    defaultMobileNavRoles: [],
    iconName: "FileSpreadsheet",
    group: "Secretaria",
  },
  {
    viewId: "configure-route",
    label: "Ordenar Ruta",
    mobileLabel: "Ordenar",
    description: "Configurar el orden de visitas de la ruta",
    // El asesor tambien: es QUIEN recorre la ruta, asi que es quien sabe en
    // que orden le queda mejor. Sigue viviendo en el grupo "Administrador"
    // del menu, pero eso ya no decide quien lo ve (ver `sidebar.tsx`).
    defaultRoles: ["admin", "administrador", "vendedor", "asesor"],
    // NO entra a la barra inferior del movil: son cinco lugares y ya estan
    // ocupados por lo que se usa todo el dia. Queda en el menu.
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "MapPin",
    group: "Administrador",
  },
  {
    viewId: "admin-reportes",
    label: "Reportes Diarios Admin",
    mobileLabel: "Rep. Admin",
    description: "Enviar y revisar reportes diarios del administrador",
    defaultRoles: ["admin", "administrador", "liquidador"],
    defaultMobileNavRoles: [],
    iconName: "FileText",
    group: "Administrador",
  },
  // --- SECRETARIA ---
  {
    viewId: "monitoreo-recaudos",
    label: "Monitoreo de Recaudos",
    mobileLabel: "Recaudos",
    description: "Cómo viene el recaudo de cada ruta, día por día",
    // Secretaría y administración: es lo que se pidió, más los roles que ya
    // ven el Monitoreo de Rutas y usan esta misma información.
    defaultRoles: ["secretaria", "secretario", "admin", "administrador"],
    // Fuera de la barra inferior: es una tabla ancha para revisar sentado, no
    // algo que se abra a cada rato en la calle.
    defaultMobileNavRoles: [],
    iconName: "TrendingUp",
    group: "Secretaria",
  },
  {
    viewId: "movimientos-revision",
    label: "Movimientos en Revisión",
    mobileLabel: "Revisión",
    // LA BANDEJA ÚNICA (05-oct-2026): reemplaza a "Autorizaciones Admin" y
    // "Autorizaciones Secretaria". Todo lo que espera visto bueno —ventas,
    // abonos, gastos, ingresos y retiros— está acá, y cada rol aprueba su paso.
    description: "Aprobar o rechazar ventas, abonos, gastos, ingresos y retiros que esperan visto bueno",
    // El admin también entra: las VENTAS que superan el umbral solo viven en
    // `solicitudes_revision`, y las dos pantallas de "Autorizaciones" leen
    // `gastosregistros`, donde una venta nunca aparece. Sin este acceso el
    // admin no tenía forma de ver una venta pendiente de aprobar. La RPC
    // `aprobar_solicitud_revision` ya acepta rol admin desde el script 044.
    defaultRoles: ["secretaria", "secretario", "admin", "administrador"],
    // Con las dos pantallas viejas fuera, toma su lugar en la barra del
    // teléfono para los dos roles.
    defaultMobileNavRoles: ["secretaria", "secretario", "admin", "administrador"],
    iconName: "ShieldCheck",
    group: "Secretaria",
  },
  {
    viewId: "multas",
    label: "Multas",
    mobileLabel: "Multas",
    description: "Ver multas por fallas vigentes y cancelarlas manualmente",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: [],
    iconName: "AlertTriangle",
    group: "Secretaria",
  },
  {
    viewId: "documentos",
    label: "Documentos",
    mobileLabel: "Documentos",
    description: "Carpetas para almacenar y organizar documentos por categoría",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: [],
    iconName: "FolderOpen",
    group: "Secretaria",
  },
  {
    viewId: "payment-control",
    label: "Control de Pagos",
    mobileLabel: "Control",
    description: "Control y seguimiento de pagos por ruta",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: ["secretaria", "secretario"],
    iconName: "ListChecks",
    group: "Secretaria",
  },
  {
    viewId: "sale-editor",
    label: "Control Total",
    mobileLabel: "Control Total",
    description: "Editar cualquier venta y su plan de pagos sin restricciones, tenga o no gestiones registradas",
    defaultRoles: ["secretaria", "secretario", "admin", "administrador"],
    defaultMobileNavRoles: [],
    iconName: "SlidersHorizontal",
    group: "Secretaria",
  },
  {
    viewId: "loan-audit",
    label: "Auditoría 360",
    mobileLabel: "Auditoría",
    description: "Ver un préstamo día por día: saldo, mora y de dónde sale cada número",
    defaultRoles: ["secretaria", "secretario", "admin", "administrador"],
    defaultMobileNavRoles: [],
    iconName: "ScanSearch",
    group: "Secretaria",
  },
  {
    viewId: "secretary-reports",
    label: "Reportes Secretaria",
    mobileLabel: "Reportes",
    description: "Subir y gestionar reportes diarios de secretaría",
    defaultRoles: ["secretaria", "secretario", "gerencia"],
    defaultMobileNavRoles: ["secretaria", "secretario", "gerencia"],
    iconName: "FileText",
    group: "Secretaria",
  },
  {
    viewId: "secretary-admin-reportes",
    label: "Reportes del Admin",
    mobileLabel: "Rep. Admin",
    description: "Revisar y aprobar reportes enviados por administradores",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: ["secretaria", "secretario"],
    iconName: "FileText",
    group: "Secretaria",
  },
  {
    viewId: "user-route-management",
    label: "Usuarios y Rutas",
    mobileLabel: "Gestión",
    description: "Crear usuarios, definir rutas y asignarlas",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: ["secretaria", "secretario"],
    iconName: "Users",
    group: "Secretaria",
  },
  // --- SOCIOADMIN ---
  {
    viewId: "socio-admin-reportes",
    label: "Reportes Socio Admin",
    mobileLabel: "Reportes",
    description: "Ver reportes del socio administrador",
    defaultRoles: ["socioadmin"],
    defaultMobileNavRoles: ["socioadmin"],
    iconName: "FileText",
    group: "Socio Administrador",
  },
  // --- GENERAL ---
  {
    viewId: "chat",
    label: "Chat",
    mobileLabel: "Chat",
    description: "Mensajería interna entre usuarios",
    defaultRoles: ["vendedor", "asesor", "admin", "administrador", "secretaria", "secretario", "gerencia", "liquidador", "socioadmin"],
    defaultMobileNavRoles: [],
    iconName: "MessageSquare",
    group: "General",
  },
  {
    viewId: "reportes-bi",
    label: "Reportes Power BI",
    mobileLabel: "Power BI",
    description: "Dashboards gerenciales en Power BI",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: [],
    iconName: "BarChart2",
    group: "General",
  },
]

/** Grupos únicos de módulos en orden de presentación */
export const MODULE_GROUPS = ["Asesor", "Administrador", "Secretaria", "Socio Administrador", "General"] as const

/** Módulos accesibles para un rol dado (según defaults) */
export function getDefaultModulesForRole(rol: string): ModuleDefinition[] {
  const r = rol.toLowerCase()
  return ALL_MODULES.filter((m) => m.defaultRoles.includes(r))
}

/** Verifica si un módulo debe aparecer en la bottom nav por defecto para un rol */
export function isDefaultMobileNav(module: ModuleDefinition, rol: string): boolean {
  return module.defaultMobileNavRoles.includes(rol.toLowerCase())
}
