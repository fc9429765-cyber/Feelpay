"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion"
import { Loader2, Plus, Pencil, Trash2, Users, Route as RouteIcon, Link2, Eye, EyeOff, MapPin, Globe2, CheckCircle2, Shield, Smartphone, RotateCcw, Save, Info, MessageSquare, BarChart2, Gauge, Upload, Bike, AlertCircle } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { MONEDAS, getMoneda, monedaPorPais } from "@/lib/monedas"
import { ALL_MODULES, MODULE_GROUPS, getDefaultModulesForRole, isDefaultMobileNav } from "@/lib/modules-catalog"
import { AMORTIZACIONES, mostrarMonto, leerMonto } from "@/lib/gestion-core"
import { verPines } from "@/lib/pin-lock"
import { CuentasRuta } from "@/components/cuentas-ruta"
import { getUsuarioSesion, conceptosElegiblesAMano } from "@/lib/movimientos"
import type { ModuleDefinition } from "@/lib/modules-catalog"

// ─── Tipos ───────────────────────────────────────────────────────────────────

type Usuario = {
  id: number
  usuario: string
  nombre: string
  rol: string
  activo: boolean
  acceso_modulo_reporte: boolean | null
  /** La calcula la base a partir del PIN (script 074): no puede mentir. */
  pin_cambiado?: boolean | null
}

type Ruta = {
  id: number
  nombre: string
  ciudad: string | null
  pais: string | null
  /** ISO 4217 ('ARS', 'USD'...). NULL = todavia no le han elegido moneda. */
  moneda?: string | null
}

const ROLES = ["vendedor", "secretaria", "gerencia", "admin", "liquidador", "socioadmin"] as const

const ROL_LABELS: Record<string, string> = {
  vendedor:   "Vendedor",
  admin:      "Administrador",
  secretaria: "Secretaria",
  gerencia:   "Gerencia",
  liquidador: "Liquidador",
  socioadmin: "Socio Admin",
}

const ROL_BADGE: Record<string, string> = {
  vendedor:   "bg-blue-100   text-blue-800   dark:bg-blue-900/40   dark:text-blue-300",
  admin:      "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  secretaria: "bg-green-100  text-green-800  dark:bg-green-900/40  dark:text-green-300",
  gerencia:   "bg-amber-100  text-amber-800  dark:bg-amber-900/40  dark:text-amber-300",
  liquidador: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  socioadmin: "bg-teal-100   text-teal-800   dark:bg-teal-900/40   dark:text-teal-300",
}

// ─── Tab Usuarios ─────────────────────────────────────────────────────────────

function UsuariosTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Usuario | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [showPass, setShowPass] = useState(false)

  const [fNombre, setFNombre] = useState("")
  const [fUsuario, setFUsuario] = useState("")
  const [fPassword, setFPassword] = useState("")
  // El PIN de bloqueo. Al editar, vacio = no cambiarlo (mismo trato que
  // la contraseña). Al crear, vacio = 0000.
  const [fPin, setFPin] = useState("")
  const [fRol, setFRol] = useState<string>("vendedor")
  const [fActivo, setFActivo] = useState(true)
  const [fAccesoReporte, setFAccesoReporte] = useState(false)

  const fetchUsuarios = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("usuarios")
        .select("id, usuario, nombre, rol, activo, acceso_modulo_reporte, pin_cambiado")
        .order("nombre", { ascending: true })
      if (error) throw error
      setUsuarios(data ?? [])
    } catch (err) {
      console.error("[v0] Error fetching usuarios:", err)
      toast({ title: "Error", description: "No se pudieron cargar los usuarios", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchUsuarios() }, [fetchUsuarios])

  const openCreate = () => {
    setEditing(null)
    setFNombre(""); setFUsuario(""); setFPassword(""); setFPin(""); setFRol("vendedor")
    setFActivo(true); setFAccesoReporte(false); setShowPass(false)
    setShowForm(true)
  }

  const openEdit = (u: Usuario) => {
    setEditing(u)
    setFNombre(u.nombre); setFUsuario(u.usuario); setFPassword(""); setFPin("")
    setFRol(u.rol); setFActivo(u.activo)
    setFAccesoReporte(u.acceso_modulo_reporte ?? false)
    setShowPass(false); setShowForm(true)
  }

  // ── Ver los PIN ─────────────────────────────────────────────────────────
  // `pines` en null = ocultos. Se piden al servidor con la contraseña de quien
  // mira y viven SOLO en memoria: al salir del módulo se olvidan, y hay que
  // volver a demostrarlo. No se guardan en localStorage a propósito — sería
  // dejar los 18 PIN escritos en el teléfono, que es justo lo que el servidor
  // está evitando.
  const [pines, setPines] = useState<Record<string, string> | null>(null)
  const [pidiendoClave, setPidiendoClave] = useState(false)
  const [claveVer, setClaveVer] = useState("")
  const [cargandoPines, setCargandoPines] = useState(false)

  const revelarPines = async () => {
    const sesion = getUsuarioSesion()
    if (!sesion.usuario) {
      toast({ title: "Sesión no encontrada", description: "Vuelve a entrar.", variant: "destructive" })
      return
    }
    setCargandoPines(true)
    try {
      const r = await verPines(sesion.usuario, claveVer)
      if (!r.ok) {
        toast({ title: "No se pudo", description: r.error ?? "Intenta de nuevo.", variant: "destructive" })
        return
      }
      setPines(r.pines)
      setPidiendoClave(false)
      setClaveVer("")
    } finally {
      setCargandoPines(false)
    }
  }

  const handleSave = async () => {
    if (!fNombre.trim() || !fUsuario.trim()) {
      toast({ title: "Campos requeridos", description: "Nombre y usuario son obligatorios", variant: "destructive" })
      return
    }
    if (!editing && !fPassword.trim()) {
      toast({ title: "Contraseña requerida", description: "Ingresa una contraseña para el nuevo usuario", variant: "destructive" })
      return
    }
    // Cuatro dígitos o nada. Al editar, vacío significa "no lo cambies" —
    // igual que la contraseña, que ya se comporta así.
    if (fPin.trim() && !/^[0-9]{4}$/.test(fPin.trim())) {
      toast({ title: "PIN inválido", description: "El PIN tiene que ser de 4 dígitos.", variant: "destructive" })
      return
    }
    setSaving(true)
    try {
      const supabase = createClient()
      if (editing) {
        const payload: Record<string, unknown> = {
          nombre: fNombre.trim(), usuario: fUsuario.trim(),
          rol: fRol, activo: fActivo, acceso_modulo_reporte: fAccesoReporte,
        }
        if (fPassword.trim()) payload.password = fPassword.trim()
        if (fPin.trim()) {
          payload.pin = fPin.trim()
          // Ponerle otro PIN a alguien tiene que devolverle los intentos: si
          // se quedó afuera por olvidarlo, cambiárselo es justamente la
          // forma de rescatarlo.
          payload.pin_fallos = 0
        }
        const { error } = await supabase.from("usuarios").update(payload).eq("id", editing.id)
        if (error) throw error
        toast({ title: "Usuario actualizado" })
      } else {
        const { error } = await supabase.from("usuarios").insert({
          nombre: fNombre.trim(), usuario: fUsuario.trim(),
          password: fPassword.trim(), rol: fRol,
          activo: fActivo, acceso_modulo_reporte: fAccesoReporte,
          // Sin PIN escrito, el que trae por defecto.
          pin: fPin.trim() || "0000",
        })
        if (error) throw error
        toast({ title: "Usuario creado" })
      }
      setShowForm(false)
      fetchUsuarios()
    } catch (err: any) {
      const msg: string = err?.message ?? "Error desconocido"
      console.error("[v0] Error saving usuario:", msg)
      toast({
        title: "Error",
        description: msg.toLowerCase().includes("unique") ? "El nombre de usuario ya existe" : msg,
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (confirmDeleteId === null) return
    try {
      const supabase = createClient()
      const { error } = await supabase.from("usuarios").delete().eq("id", confirmDeleteId)
      if (error) throw error
      toast({ title: "Usuario eliminado" })
      setConfirmDeleteId(null)
      fetchUsuarios()
    } catch (err: any) {
      console.error("[v0] Error deleting usuario:", err)
      toast({ title: "Error", description: "No se pudo eliminar el usuario", variant: "destructive" })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {loading ? "Cargando..." : `${usuarios.length} usuario${usuarios.length !== 1 ? "s" : ""} registrados`}
        </p>
        <div className="flex items-center gap-1.5">
          {/* Ver los PIN NO es leer una columna: es pedírselos al servidor
              demostrando quién eres. Por eso hay un botón y no salen solos. */}
          <Button
            size="sm"
            variant={pines ? "secondary" : "outline"}
            className="gap-1.5 h-8 text-xs"
            onClick={() => (pines ? setPines(null) : setPidiendoClave(true))}
          >
            {pines ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {pines ? "Ocultar PINs" : "Ver PINs"}
          </Button>
          <Button size="sm" onClick={openCreate} className="gap-1.5 h-8 text-xs">
            <Plus className="h-3.5 w-3.5" /> Nuevo usuario
          </Button>
        </div>
      </div>

      <Dialog open={pidiendoClave} onOpenChange={(o) => { if (!o) { setPidiendoClave(false); setClaveVer("") } }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Shield className="h-4 w-4 text-brand" /> Confirma que eres tú
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-[11px] leading-snug text-muted-foreground">
              Los PIN no viajan al teléfono por su cuenta. Escribe tu contraseña
              para que el servidor te los entregue.
            </p>
            <div className="space-y-1">
              <Label className="text-xs">Tu contraseña</Label>
              <Input
                type="password"
                autoComplete="current-password"
                value={claveVer}
                onChange={(e) => setClaveVer(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && claveVer) void revelarPines() }}
                className="h-9 text-sm"
                autoFocus
              />
            </div>
            <Button size="sm" className="w-full" disabled={!claveVer || cargandoPines} onClick={() => void revelarPines()}>
              {cargandoPines ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Ver los PIN
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Nombre</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Usuario</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Rol</th>
                <th className="px-3 py-2 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">PIN</th>
                <th className="px-3 py-2 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell">Activo</th>
                <th className="px-3 py-2 text-center text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Reportes</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {usuarios.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    No hay usuarios registrados
                  </td>
                </tr>
              )}
              {usuarios.map((u) => (
                <tr key={u.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5 font-medium text-sm">{u.nombre}</td>
                  <td className="px-3 py-2.5 text-muted-foreground font-mono text-xs hidden sm:table-cell">{u.usuario}</td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${ROL_BADGE[u.rol] ?? "bg-muted text-muted-foreground"}`}>
                      {ROL_LABELS[u.rol] ?? u.rol}
                    </span>
                  </td>
                  {/* Mientras no se hayan revelado, se dice lo que se sabe
                      sin verlos: si sigue en el que viene por defecto o si la
                      persona ya lo cambió. Eso llega sin pedir contraseña. */}
                  <td className="px-3 py-2.5 text-center">
                    {pines ? (
                      <span className="font-mono text-sm font-semibold tracking-[0.2em]">
                        {pines[String(u.id)] ?? "—"}
                      </span>
                    ) : u.pin_cambiado ? (
                      <span className="text-[10px] text-muted-foreground">cambiado</span>
                    ) : (
                      <span className="text-[10px] font-medium text-warning">0000</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center hidden md:table-cell">
                    <span className={`inline-block h-2 w-2 rounded-full ${u.activo ? "bg-green-500" : "bg-red-400"}`} title={u.activo ? "Activo" : "Inactivo"} />
                  </td>
                  <td className="px-3 py-2.5 text-center hidden lg:table-cell">
                    <span className={`inline-block h-2 w-2 rounded-full ${u.acceso_modulo_reporte ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} title={u.acceso_modulo_reporte ? "Con acceso" : "Sin acceso"} />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Editar" onClick={() => openEdit(u)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" title="Eliminar" onClick={() => setConfirmDeleteId(u.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Formulario crear / editar */}
      <Dialog open={showForm} onOpenChange={(o) => !saving && setShowForm(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar usuario" : "Nuevo usuario"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <Label className="text-xs">Nombre completo</Label>
              <Input value={fNombre} onChange={(e) => setFNombre(e.target.value)} placeholder="Juan Pérez" className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Nombre de usuario</Label>
              <Input value={fUsuario} onChange={(e) => setFUsuario(e.target.value)} placeholder="jperez" autoComplete="off" className="h-9 text-sm font-mono" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{editing ? "Nueva contraseña (vacío = no cambiar)" : "Contraseña"}</Label>
              <div className="relative">
                <Input
                  type={showPass ? "text" : "password"}
                  value={fPassword}
                  onChange={(e) => setFPassword(e.target.value)}
                  placeholder={editing ? "••••••••" : "Mínimo 4 caracteres"}
                  autoComplete="new-password"
                  className="h-9 text-sm pr-9"
                />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                {editing ? "Nuevo PIN de bloqueo (vacío = no cambiar)" : "PIN de bloqueo"}
              </Label>
              <Input
                inputMode="numeric"
                value={fPin}
                onChange={(e) => setFPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
                placeholder={editing ? "••••" : "0000"}
                autoComplete="off"
                className="h-9 text-sm font-mono tracking-[0.3em]"
              />
              <p className="text-[10px] leading-snug text-muted-foreground">
                {editing
                  ? "Cambiárselo también le devuelve los intentos, por si se quedó afuera."
                  : "Cuatro dígitos. Si lo dejas vacío queda en 0000."}
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Rol</Label>
              <Select value={fRol} onValueChange={setFRol}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r} className="text-sm">{ROL_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={fActivo} onCheckedChange={(v) => setFActivo(v === true)} className="h-4 w-4" />
                <span className="text-sm">Usuario activo</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={fAccesoReporte} onCheckedChange={(v) => setFAccesoReporte(v === true)} className="h-4 w-4" />
                <span className="text-sm">Acceso a Reportes</span>
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setShowForm(false)} disabled={saving}>Cancelar</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editing ? "Guardar cambios" : "Crear usuario"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmar eliminación */}
      <Dialog open={confirmDeleteId !== null} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Eliminar usuario</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            ¿Confirmas la eliminación? También se eliminarán sus asignaciones de rutas.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancelar</Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>Eliminar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Tab Rutas ────────────────────────────────────────────────────────────────
//
// Aquí vive TODA la configuración de una ruta. Antes estaba partida en dos
// pestañas: "Rutas" tenía nombre, ciudad y país, y "Aprobaciones" los umbrales
// de revisión, la geocerca y los métodos de interés. Configurar una unidad
// obligaba a saltar entre pestañas y a acordarse de en cuál vivía cada cosa —
// y los métodos de interés nunca fueron un umbral de aprobación, así que ahí
// no los encontraba nadie.

type RutaConfigRow = {
  ruta_id: number
  venta_nueva_habilitado: boolean
  venta_nueva_umbral: number | null
  venta_renovacion_habilitado: boolean
  venta_renovacion_umbral: number | null
  abono_habilitado: boolean
  abono_umbral_cuotas: number | null
  geocerca_habilitada: boolean
  geocerca_radio_metros: number | null
  amortizaciones_habilitadas: string[] | null
  amortizacion_default: string | null
  cedula_obligatoria: boolean
  /** ¿Ve el cuadro de Resumen Semanal abajo del Resumen del Día? (scripts/121) */
  resumen_semanal?: boolean
  /** ¿Puede esta unidad venderle otra vez a quien ya tiene un credito? */
  multiples_prestamos: boolean
  cierre_atrasado_minutos: number | null
  /** Logo propio de la unidad: va en el encabezado de sus recibos. */
  logo_url: string | null
  /** La moto de la unidad. Las tres en NULL = no tiene (ver scripts/120). */
  moto_placa: string | null
  moto_fecha_compra: string | null
  moto_foto_url: string | null
}

/**
 * `limite` es el tope GENERAL del concepto, el mismo para todas las rutas.
 * Se trae acá porque es lo que rige mientras la ruta no configure el suyo, y
 * sin él esta pantalla no podía decir la verdad sobre lo que pasa hoy.
 */
type CatalogItem = { id: number; nombre: string; limite: number | null; solo_sistema?: boolean | null }

type ItemFormRow = { habilitado: boolean; umbral: string }

const ITEM_TIPOS = [
  { tipo: "ingreso" as const, label: "Ingresos" },
  { tipo: "gasto" as const, label: "Gastos" },
  { tipo: "retiro" as const, label: "Retiros" },
]

// Una ruta sin fila de configuración ve los dos métodos, como siempre.
const AMORTIZACIONES_DEFAULT = ["aleman", "americano"]

function RutasTab() {
  const { toast } = useToast()
  const [rutas, setRutas] = useState<Ruta[]>([])
  const [configs, setConfigs] = useState<Map<number, RutaConfigRow>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Ruta | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // Datos de la ruta
  //
  // `fUnidad` es el ID de la ruta, y se escribe a mano a proposito. En esta
  // base el id ES el numero de unidad: 112 es "112 JP", 168 es "Unid 168".
  // Dejarselo a la secuencia del BIGSERIAL no funciona, porque esas filas se
  // cargaron con el id explicito y eso NO hace avanzar la secuencia: la ruta
  // de la unidad 196 salio con id 3. Y peor, cuando la secuencia llegue a 112
  // el INSERT fallaria por llave duplicada contra una unidad que ya existe.
  const [fUnidad, setFUnidad] = useState("")
  const [fNombre, setFNombre] = useState("")
  const [fCiudad, setFCiudad] = useState("")
  const [fPais, setFPais] = useState("")
  const [fMoneda, setFMoneda] = useState("")

  // Catálogos de items: son globales, se cargan una vez y no cambian por ruta.
  const [ingresoItems, setIngresoItems] = useState<CatalogItem[]>([])
  const [gastoItems, setGastoItems] = useState<CatalogItem[]>([])
  const [retiroItems, setRetiroItems] = useState<CatalogItem[]>([])

  // Umbrales de revisión de secretaría
  const [fVentaNuevaHab, setFVentaNuevaHab] = useState(false)
  const [fVentaNuevaUmbral, setFVentaNuevaUmbral] = useState("")
  const [fVentaRenovacionHab, setFVentaRenovacionHab] = useState(false)
  const [fVentaRenovacionUmbral, setFVentaRenovacionUmbral] = useState("")
  const [fAbonoHab, setFAbonoHab] = useState(false)
  const [fAbonoUmbralCuotas, setFAbonoUmbralCuotas] = useState("")
  const [fGeocercaHab, setFGeocercaHab] = useState(false)
  const [fGeocercaRadio, setFGeocercaRadio] = useState("100")
  // Encendida por defecto: es como se comportó siempre la app.
  const [fCedulaObligatoria, setFCedulaObligatoria] = useState(true)
  const [fResumenSemanal, setFResumenSemanal] = useState(false)
  const [fMultiplesPrestamos, setFMultiplesPrestamos] = useState(false)
  // El limite de tiempo para cerrar un dia viejo (scripts/113). Se guarda
  // como texto mientras se escribe: un `number` obligaria a decidir que es
  // un campo vacio mientras el usuario borra para teclear otro numero.
  const [fCierreLimite, setFCierreLimite] = useState(false)
  const [fCierreMinutos, setFCierreMinutos] = useState("15")
  const [fLogoUrl, setFLogoUrl] = useState("")
  const [subiendoLogo, setSubiendoLogo] = useState(false)
  // La moto de la unidad
  const [fMotoPlaca, setFMotoPlaca] = useState("")
  const [fMotoFecha, setFMotoFecha] = useState("")
  const [fMotoFotoUrl, setFMotoFotoUrl] = useState("")
  const [subiendoMoto, setSubiendoMoto] = useState(false)
  // Métodos de interés que usa la unidad, y cuál llega preseleccionado en la
  // venta. Antes el formulario ofrecía siempre los dos y ninguno marcado.
  const [fAmortizaciones, setFAmortizaciones] = useState<string[]>(AMORTIZACIONES_DEFAULT)
  const [fAmortizacionDefault, setFAmortizacionDefault] = useState<string>("")
  const [itemForm, setItemForm] = useState<Map<string, ItemFormRow>>(new Map())

  const itemsByTipo: Record<string, CatalogItem[]> = {
    ingreso: ingresoItems,
    gasto: gastoItems,
    retiro: retiroItems,
  }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [rutasRes, configsRes, ingresosRes, gastosRes, retirosRes] = await Promise.all([
        supabase.from("rutas").select("id, nombre, ciudad, pais, moneda").order("id", { ascending: true }),
        supabase.from("ruta_config_umbrales").select("*"),
        // `*` en ingresos por `solo_sistema` (script 083). Pedirla por nombre
        // reventaría la consulta con 42703 donde el script no haya corrido.
        supabase.from("ingresos").select("*").order("nombre"),
        supabase.from("gastos").select("id, nombre, limite").order("nombre"),
        supabase.from("retiros").select("id, nombre, limite").order("nombre"),
      ])
      // `moneda` es una columna nueva (scripts/118). Mientras no exista, la
      // consulta entera falla con 42703 y la pestaña de Rutas se queda VACIA.
      // Es el mismo cuidado que ya se tiene arriba con `ingresos`.
      let rutasData = rutasRes.data
      if (rutasRes.error) {
        const code = (rutasRes.error as { code?: string }).code
        if (code === "42703" || /moneda/i.test(rutasRes.error.message)) {
          console.warn("[v0] rutas.moneda no existe todavia (falta scripts/118)")
          const r = await supabase
            .from("rutas")
            .select("id, nombre, ciudad, pais")
            .order("id", { ascending: true })
          if (r.error) throw r.error
          rutasData = r.data
        } else {
          throw rutasRes.error
        }
      }
      setRutas((rutasData as Ruta[]) ?? [])
      setConfigs(new Map(((configsRes.data as RutaConfigRow[]) ?? []).map((c) => [c.ruta_id, c])))
      // Los conceptos que solo escribe el sistema no se listan acá tampoco:
      // el umbral de aprobación no los toca —`registrar_gestion` inserta la
      // multa directo, con estadoadmin 'NA'— así que configurarles un tope
      // sería letra muerta que se lee como si hiciera algo.
      setIngresoItems(conceptosElegiblesAMano((ingresosRes.data as CatalogItem[]) ?? []))
      setGastoItems((gastosRes.data as CatalogItem[]) ?? [])
      setRetiroItems((retirosRes.data as CatalogItem[]) ?? [])
    } catch (err) {
      console.error("[v0] Error fetching rutas:", err)
      toast({ title: "Error", description: "No se pudieron cargar las rutas", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Deja el formulario con la configuración de una ruta, o con los defaults
  // si todavía no tiene fila (ruta nueva o nunca configurada).
  const cargarConfig = (c: RutaConfigRow | undefined) => {
    setFVentaNuevaHab(c?.venta_nueva_habilitado ?? false)
    setFVentaNuevaUmbral(c?.venta_nueva_umbral?.toString() ?? "")
    setFVentaRenovacionHab(c?.venta_renovacion_habilitado ?? false)
    setFVentaRenovacionUmbral(c?.venta_renovacion_umbral?.toString() ?? "")
    setFAbonoHab(c?.abono_habilitado ?? false)
    setFAbonoUmbralCuotas(c?.abono_umbral_cuotas?.toString() ?? "")
    setFGeocercaHab(c?.geocerca_habilitada ?? false)
    setFGeocercaRadio(c?.geocerca_radio_metros?.toString() ?? "100")
    setFCedulaObligatoria(c?.cedula_obligatoria ?? true)
    setFResumenSemanal(c?.resumen_semanal ?? false)
    setFMultiplesPrestamos(c?.multiples_prestamos ?? false)
    const min = Number(c?.cierre_atrasado_minutos) || 0
    setFCierreLimite(min > 0)
    setFCierreMinutos(min > 0 ? String(min) : "15")
    setFLogoUrl(c?.logo_url ?? "")
    setFMotoPlaca(c?.moto_placa ?? "")
    setFMotoFecha(c?.moto_fecha_compra ?? "")
    setFMotoFotoUrl(c?.moto_foto_url ?? "")
    const amort = c?.amortizaciones_habilitadas
    setFAmortizaciones(amort && amort.length > 0 ? amort : AMORTIZACIONES_DEFAULT)
    setFAmortizacionDefault(c?.amortizacion_default ?? "")
  }

  /**
   * EL LOGO DE LA UNIDAD, SUBIDO DESDE ACA.
   *
   * Es OTRA imagen que la foto de perfil: la foto es de la PERSONA que entra
   * (sale en el encabezado y en el menu) y el logo es de la UNIDAD (sale en el
   * encabezado de sus recibos). Viven en columnas distintas —
   * `usuarios.foto_url` y `ruta_config_umbrales.logo_url`— y ninguna pisa a la
   * otra.
   *
   * Va al mismo `/api/upload-photo` que el resto de imagenes de la app, en la
   * carpeta `logos/<unidad>`, y NO guarda por su cuenta: llena el campo para
   * que se vea la vista previa y se confirma con Guardar, como todo lo demas
   * del formulario.
   */
  const handleSubirLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast({ title: "Archivo invalido", description: "Selecciona una imagen.", variant: "destructive" })
      return
    }
    // HEIC/HEIF no lo pinta el navegador: el recibo saldria sin logo y nadie
    // sabria por que.
    if (/heic|heif/i.test(file.type)) {
      toast({
        title: "Formato no compatible",
        description: "Las imagenes HEIC/HEIF no se ven en el recibo. Usa JPG o PNG.",
        variant: "destructive",
      })
      return
    }
    setSubiendoLogo(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("folder", `logos/${fUnidad || "sin-unidad"}`)
      const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? "No se pudo subir la imagen")
      setFLogoUrl(json.url)
      toast({ title: "Logo cargado", description: "Dale a Guardar para dejarlo en la unidad." })
    } catch (err) {
      console.error("[v0] Error subiendo el logo de la unidad:", err)
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "No se pudo subir el logo",
        variant: "destructive",
      })
    } finally {
      setSubiendoLogo(false)
    }
  }

  /**
   * LA FOTO DE LA MOTO.
   *
   * Mismo camino que el logo —`/api/upload-photo`, carpeta propia— y las
   * mismas dos validaciones, que no son de adorno: sin la primera se puede
   * subir un PDF y la vista previa queda rota, y HEIC/HEIF es lo que sale por
   * defecto de un iPhone y el navegador NO lo pinta, asi que la foto se veria
   * en blanco sin que nadie sepa por que.
   *
   * No guarda por su cuenta: llena el campo para la vista previa y se
   * confirma con Guardar, como todo lo demas del formulario.
   */
  const handleSubirFotoMoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast({ title: "Archivo invalido", description: "Selecciona una imagen.", variant: "destructive" })
      return
    }
    if (/heic|heif/i.test(file.type)) {
      toast({
        title: "Formato no compatible",
        description: "Las imagenes HEIC/HEIF no se ven en el navegador. Usa JPG o PNG.",
        variant: "destructive",
      })
      return
    }
    setSubiendoMoto(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("folder", `motos/${fUnidad || "sin-unidad"}`)
      const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? "No se pudo subir la imagen")
      setFMotoFotoUrl(json.url)
      toast({ title: "Foto cargada", description: "Dale a Guardar para dejarla en la unidad." })
    } catch (err) {
      console.error("[v0] Error subiendo la foto de la moto:", err)
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "No se pudo subir la foto",
        variant: "destructive",
      })
    } finally {
      setSubiendoMoto(false)
    }
  }

  const openCreate = () => {
    setEditing(null); setFUnidad(""); setFNombre(""); setFCiudad(""); setFPais(""); setFMoneda("")
    cargarConfig(undefined)
    setItemForm(new Map())
    setShowForm(true)
  }

  const openEdit = async (r: Ruta) => {
    setEditing(r); setFUnidad(String(r.id)); setFNombre(r.nombre); setFCiudad(r.ciudad ?? ""); setFPais(r.pais ?? "")
    // Si la ruta no tiene moneda, se propone la del pais en vez de dejar el
    // campo vacio: es lo que el dueño va a elegir el 99% de las veces.
    setFMoneda(r.moneda ?? monedaPorPais(r.pais, r.ciudad) ?? "")
    cargarConfig(configs.get(r.id))
    setItemForm(new Map())
    setShowForm(true)

    // Los umbrales por item son muchos y solo importan para la ruta abierta:
    // se traen al abrir el diálogo, no en la carga general.
    setLoadingItems(true)
    try {
      const { data } = await createClient()
        .from("ruta_item_umbrales")
        .select("item_tipo, item_id, habilitado, umbral")
        .eq("ruta_id", r.id)
      const map = new Map<string, ItemFormRow>()
      for (const row of (data ?? []) as { item_tipo: string; item_id: number; habilitado: boolean; umbral: number | null }[]) {
        map.set(`${row.item_tipo}:${row.item_id}`, { habilitado: row.habilitado, umbral: row.umbral?.toString() ?? "" })
      }
      setItemForm(map)
    } finally {
      setLoadingItems(false)
    }
  }

  /**
   * `umbralActual` es lo que la fila está MOSTRANDO, que puede venir heredado
   * del tope general. Sin pasarlo, encender el interruptor sobre un concepto
   * heredado dejaba el umbral vacío y la ruta terminaba con un tope nulo.
   */
  const toggleItemHabilitado = (key: string, habilitado: boolean, umbralActual: string) => {
    setItemForm((prev) => {
      const next = new Map(prev)
      next.set(key, { habilitado, umbral: next.get(key)?.umbral ?? umbralActual })
      return next
    })
  }

  const setItemUmbralValue = (key: string, umbral: string) => {
    setItemForm((prev) => {
      const next = new Map(prev)
      // `?? true` y no `?? false`: la casilla del umbral SOLO se ve cuando el
      // concepto pide aprobación. Con `false`, escribir un número sobre un
      // concepto heredado creaba la fila en "sin tope" — es decir, teclear un
      // tope lo QUITABA.
      next.set(key, { habilitado: next.get(key)?.habilitado ?? true, umbral })
      return next
    })
  }

  const handleSave = async () => {
    if (!fNombre.trim()) {
      toast({ title: "Campo requerido", description: "El nombre de la ruta es obligatorio", variant: "destructive" })
      return
    }

    // El número de unidad solo se valida al CREAR: al editar es la llave
    // primaria y ni siquiera se deja escribir.
    const unidadNum = Number.parseInt(fUnidad, 10)
    if (!editing) {
      if (!Number.isInteger(unidadNum) || unidadNum <= 0) {
        toast({
          title: "Número de unidad inválido",
          description: "Escribe el número de la unidad: es el ID con el que la ruta va a quedar registrada.",
          variant: "destructive",
        })
        return
      }
      if (rutas.some((r) => r.id === unidadNum)) {
        const ocupada = rutas.find((r) => r.id === unidadNum)!
        toast({
          title: "Ese número ya está en uso",
          description: `La unidad ${unidadNum} ya existe: "${ocupada.nombre}". Elige otro número.`,
          variant: "destructive",
        })
        return
      }
    }

    setSaving(true)
    try {
      const supabase = createClient()
      const payload = {
        nombre: fNombre.trim(),
        ciudad: fCiudad.trim() || null,
        pais: fPais.trim() || null,
        // Se manda solo si hay algo elegido. Asi, mientras no se corra el
        // script 118, guardar una ruta sigue funcionando: sin la columna, un
        // payload con `moneda` la rechazaria entera y no se podria ni
        // cambiarle el nombre a una unidad.
        ...(fMoneda ? { moneda: fMoneda } : {}),
      }

      // La ruta primero: si es nueva hay que conocer su id antes de poder
      // guardarle la configuración.
      let rutaId: number
      if (editing) {
        // El número de unidad NO se toca al editar: es la llave primaria, y
        // cambiarla dejaría huérfanos a los clientes, préstamos y gestiones
        // que la referencian.
        const { error } = await supabase.from("rutas").update(payload).eq("id", editing.id)
        if (error) throw error
        rutaId = editing.id
      } else {
        // El id se manda EXPLÍCITO, no se deja a la secuencia (ver el
        // comentario de `fUnidad`).
        const { data, error } = await supabase
          .from("rutas")
          .insert({ ...payload, id: unidadNum })
          .select("id")
          .single()
        if (error) throw error
        rutaId = (data as { id: number }).id
      }

      const configPayload = {
        ruta_id: rutaId,
        venta_nueva_habilitado: fVentaNuevaHab,
        venta_nueva_umbral: fVentaNuevaUmbral ? Number.parseFloat(fVentaNuevaUmbral) : null,
        venta_renovacion_habilitado: fVentaRenovacionHab,
        venta_renovacion_umbral: fVentaRenovacionUmbral ? Number.parseFloat(fVentaRenovacionUmbral) : null,
        abono_habilitado: fAbonoHab,
        abono_umbral_cuotas: fAbonoUmbralCuotas ? Number.parseInt(fAbonoUmbralCuotas, 10) : null,
        geocerca_habilitada: fGeocercaHab,
        cedula_obligatoria: fCedulaObligatoria,
        resumen_semanal: fResumenSemanal,
        multiples_prestamos: fMultiplesPrestamos,
        // Apagado = NULL (sin limite), no 0: la columna distingue "no hay
        // regla" de "hay regla de cero minutos", que no tendria sentido.
        cierre_atrasado_minutos: fCierreLimite
          ? Math.min(1440, Math.max(1, Number(fCierreMinutos) || 15))
          : null,
        // El logo propio de la unidad. Vacio = se usa el de la app.
        logo_url: fLogoUrl.trim() || null,
        // La placa va en MAYUSCULA y sin espacios: la misma moto entrando
        // como "abc12d" y "ABC 12D" seria imposible de buscar. El script 120
        // tiene la misma regla como CHECK, por debajo.
        moto_placa: fMotoPlaca.replace(/\s+/g, "").toUpperCase() || null,
        moto_fecha_compra: fMotoFecha || null,
        moto_foto_url: fMotoFotoUrl.trim() || null,
        // La columna es NOT NULL: si el campo queda vacio se guarda el
        // default en vez de mandar null y romper el upsert.
        geocerca_radio_metros: Number.parseInt(fGeocercaRadio, 10) || 100,
        amortizaciones_habilitadas: fAmortizaciones,
        // Si el predeterminado dejó de estar habilitado se guarda vacío: la
        // base rechaza un predeterminado que no esté en la lista, y con esa
        // combinación el upsert entero fallaría sin explicar por qué.
        amortizacion_default: fAmortizaciones.includes(fAmortizacionDefault)
          ? fAmortizacionDefault
          : null,
        updated_at: new Date().toISOString(),
      }
      let { error: configErr } = await supabase
        .from("ruta_config_umbrales")
        .upsert(configPayload, { onConflict: "ruta_id" })

      // ── SI TODAVIA NO SE CORRIO EL SCRIPT 120 ──────────────────────────
      // Las tres columnas de la moto son nuevas. Sin ellas el upsert entero
      // falla con 42703 y NO SE PODRIA GUARDAR NADA de la configuracion —ni
      // un umbral, ni la geocerca—. Se reintenta sin la moto y se avisa, en
      // vez de dejar la pantalla rota entre el deploy y el script.
      // ── SI TODAVIA NO SE CORRIO EL SCRIPT 121 ──────────────────────────
      // Igual que con la moto: sin la columna `resumen_semanal` el upsert
      // entero falla. Se guarda el resto y se avisa.
      if (configErr && /resumen_semanal/i.test(configErr.message)) {
        console.warn("[v0] Falta la columna resumen_semanal (scripts/121); se guarda el resto")
        const { resumen_semanal, ...sinResumen } = configPayload
        const r = await supabase
          .from("ruta_config_umbrales")
          .upsert(sinResumen, { onConflict: "ruta_id" })
        configErr = r.error
        if (!configErr && resumen_semanal) {
          toast({
            title: "El Resumen Semanal no se guardó",
            description: "Falta correr scripts/121. El resto de la configuración sí quedó.",
            variant: "destructive",
          })
        }
      }
      if (configErr && ((configErr as { code?: string }).code === "42703" || /moto_/i.test(configErr.message))) {
        console.warn("[v0] Faltan las columnas de la moto (scripts/120); se guarda el resto")
        const { moto_placa, moto_fecha_compra, moto_foto_url, ...sinMoto } = configPayload
        const r = await supabase
          .from("ruta_config_umbrales")
          .upsert(sinMoto, { onConflict: "ruta_id" })
        configErr = r.error
        if (!configErr && (moto_placa || moto_fecha_compra || moto_foto_url)) {
          toast({
            title: "La moto no se guardó",
            description: "Falta correr scripts/120. El resto de la configuración sí quedó.",
            variant: "destructive",
          })
        }
      }
      if (configErr) throw configErr

      // Solo se guardan los items que el usuario tocó. En una ruta nueva el
      // mapa viene vacío y no hay nada que escribir.
      const itemRows = ITEM_TIPOS.flatMap(({ tipo }) =>
        itemsByTipo[tipo].flatMap((item) => {
          const key = `${tipo}:${item.id}`
          const f = itemForm.get(key)
          if (!f) return []
          return [{
            ruta_id: rutaId,
            item_tipo: tipo,
            item_id: item.id,
            habilitado: f.habilitado,
            umbral: f.umbral ? Number.parseFloat(f.umbral) : null,
            updated_at: new Date().toISOString(),
          }]
        })
      )
      if (itemRows.length > 0) {
        const { error: itemsErr } = await supabase
          .from("ruta_item_umbrales")
          .upsert(itemRows, { onConflict: "ruta_id,item_tipo,item_id" })
        if (itemsErr) throw itemsErr
      }

      toast({ title: editing ? "Ruta actualizada" : "Ruta creada" })
      setShowForm(false)
      fetchAll()
    } catch (err: any) {
      console.error("[v0] Error saving ruta:", err)
      toast({ title: "Error", description: err?.message ?? "Error desconocido", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (confirmDeleteId === null) return
    try {
      const supabase = createClient()
      const { error } = await supabase.from("rutas").delete().eq("id", confirmDeleteId)
      if (error) throw error
      toast({ title: "Ruta eliminada" })
      setConfirmDeleteId(null)
      fetchAll()
    } catch (err: any) {
      console.error("[v0] Error deleting ruta:", err)
      toast({ title: "Error", description: "No se pudo eliminar la ruta", variant: "destructive" })
    }
  }

  // Qué métodos de interés usa la ruta, para la columna del listado.
  const interesDeRuta = (rutaId: number) => {
    const c = configs.get(rutaId)
    const habilitados = c?.amortizaciones_habilitadas?.length
      ? c.amortizaciones_habilitadas
      : AMORTIZACIONES_DEFAULT
    return AMORTIZACIONES
      .filter((a) => habilitados.includes(a.valor))
      .map((a) => ({ etiqueta: a.etiqueta, esDefault: a.valor === c?.amortizacion_default }))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {loading ? "Cargando..." : `${rutas.length} ruta${rutas.length !== 1 ? "s" : ""} registradas`}
        </p>
        <Button size="sm" onClick={openCreate} className="gap-1.5 h-8 text-xs">
          <Plus className="h-3.5 w-3.5" /> Nueva ruta
        </Button>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        // Listado, no tarjetas: con muchas rutas la grilla obligaba a barrer
        // la pantalla en dos ejes para encontrar una. Mismo formato que la
        // pestaña Usuarios — una fila por ruta, escaneable de arriba abajo.
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Ruta</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Ciudad</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell">País</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell">Moneda</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Interés</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rutas.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    No hay rutas registradas
                  </td>
                </tr>
              )}
              {rutas.map((r) => (
                <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                        <RouteIcon className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-sm leading-tight truncate">{r.nombre}</p>
                        {/* Ciudad y país se caen en pantallas chicas: se
                            repiten aquí para que la fila no quede coja. */}
                        <p className="text-[10px] font-bold text-muted-foreground sm:hidden">
                          Ruta #{r.id}
                          {r.ciudad ? ` · ${r.ciudad}` : ""}
                          {r.pais ? ` · ${r.pais}` : ""}
                        </p>
                        <p className="text-[10px] font-bold text-muted-foreground hidden sm:block">Ruta #{r.id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground text-xs hidden sm:table-cell">
                    {r.ciudad ? (
                      <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{r.ciudad}</span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground text-xs hidden md:table-cell">
                    {r.pais ? (
                      <span className="flex items-center gap-1"><Globe2 className="h-3 w-3" />{r.pais}</span>
                    ) : "—"}
                  </td>
                  {/* La moneda a la vista: una unidad sin moneda tiene que
                      notarse en la lista, no solo al abrirla. */}
                  <td className="px-3 py-2.5 text-xs hidden md:table-cell">
                    {r.moneda ? (
                      <span className="font-semibold tabular-nums">
                        {r.moneda}{" "}
                        <span className="font-normal text-muted-foreground">
                          {getMoneda(r.moneda).simbolo}
                        </span>
                      </span>
                    ) : (
                      <span className="text-amber-600">sin moneda</span>
                    )}
                  </td>
                  {/* Qué métodos de interés ofrece la venta en esta ruta. El
                      predeterminado va resaltado; con uno solo habilitado no
                      hace falta marcarlo porque se usa siempre. */}
                  <td className="px-3 py-2.5 hidden lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {interesDeRuta(r.id).map((a) => (
                        <span
                          key={a.etiqueta}
                          title={a.esDefault ? "Llega preseleccionado en la venta" : undefined}
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            a.esDefault
                              ? "bg-brand/15 text-brand"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {a.etiqueta}{a.esDefault ? " ·" : ""}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Editar" onClick={() => openEdit(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" title="Eliminar" onClick={() => setConfirmDeleteId(r.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Formulario: datos de la ruta + toda su configuración */}
      <Dialog open={showForm} onOpenChange={(o) => !saving && setShowForm(o)}>
        <DialogContent className="sm:max-w-lg max-h-[88vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{editing ? `Configurar ${editing.nombre}` : "Nueva ruta"}</DialogTitle>
          </DialogHeader>

          {/* El cuerpo scrollea y los botones quedan fijos abajo: la
              configuración completa no cabe en una pantalla de celular. */}
          <div className="flex-1 overflow-y-auto space-y-4 py-1 pr-1">
            {/* El numero de unidad ES el id de la ruta. Se escribe al crear y
                queda bloqueado al editar: cambiarlo dejaria huerfanos a los
                clientes, prestamos y gestiones que apuntan a esta ruta. */}
            <div className="space-y-1">
              <Label className="text-xs">
                Número de unidad <span className="text-destructive">*</span>
              </Label>
              <Input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={fUnidad}
                onChange={(e) => setFUnidad(e.target.value)}
                placeholder="196"
                disabled={!!editing}
                className="h-9 text-sm disabled:opacity-70"
              />
              <p className="text-[11px] text-muted-foreground">
                {editing
                  ? "El número de unidad no se puede cambiar: es el identificador con el que quedaron registrados sus clientes y préstamos."
                  : "Es el identificador de la ruta y tiene que coincidir con la unidad. Aparecerá como \"Ruta #\" en el listado."}
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Nombre de la ruta <span className="text-destructive">*</span></Label>
              <Input value={fNombre} onChange={(e) => setFNombre(e.target.value)} placeholder="Unid 196" className="h-9 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Ciudad</Label>
                <Input value={fCiudad} onChange={(e) => setFCiudad(e.target.value)} placeholder="Bogotá" className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">País</Label>
                <Input
                  value={fPais}
                  onChange={(e) => {
                    setFPais(e.target.value)
                    // Al escribir el país se propone su moneda, pero SOLO si
                    // todavía no hay ninguna elegida: si el dueño ya eligió
                    // una a mano, escribir el país no se la puede pisar.
                    if (!fMoneda) {
                      const sugerida = monedaPorPais(e.target.value, fCiudad)
                      if (sugerida) setFMoneda(sugerida)
                    }
                  }}
                  placeholder="Colombia"
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* ── La moneda con la que trabaja la unidad ─────────────────── */}
            <div className="space-y-1">
              <Label className="text-xs">Moneda</Label>
              <Select value={fMoneda} onValueChange={setFMoneda}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Elige la moneda" />
                </SelectTrigger>
                <SelectContent>
                  {MONEDAS.map((m) => (
                    <SelectItem key={m.codigo} value={m.codigo} className="text-sm">
                      {m.codigo} · {m.nombre} ({m.simbolo})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Con qué plata trabaja esta unidad. Solo cambia cómo se{" "}
                <strong>muestran</strong> las cifras: no convierte ningún monto
                ni hay tasa de cambio.
              </p>
            </div>

            {/* ── Cuentas para transferencias (scripts/126) ─────────────────
                Se guardan al momento, con su propio botón: ver
                components/cuentas-ruta.tsx. Una ruta nueva todavía no tiene
                id, así que primero se guarda la ruta. */}
            {editing ? (
              <CuentasRuta rutaId={editing.id} />
            ) : (
              <div className="space-y-1 border-t pt-3">
                <Label className="text-sm">Cuentas para transferencias</Label>
                <p className="text-[11px] text-muted-foreground">
                  Guarda la ruta primero; después, al configurarla, podrás agregar sus cuentas.
                </p>
              </div>
            )}

            {/* ── Métodos de interés ────────────────────────────────────── */}
            <div className="space-y-2 border-t pt-3">
              <Label className="text-sm">Métodos de interés que usa esta unidad</Label>
              <p className="text-[11px] text-muted-foreground">
                El formulario de venta solo ofrecerá los que marques aquí, y el predeterminado
                llegará ya elegido. Si la unidad usa uno solo, el vendedor ni siquiera tiene que
                escogerlo.
              </p>
              <div className="space-y-1.5">
                {AMORTIZACIONES.map((a) => {
                  const marcado = fAmortizaciones.includes(a.valor)
                  // No se puede dejar la unidad sin ningún método: sin al menos
                  // uno no se podría registrar ninguna venta.
                  const esElUltimo = marcado && fAmortizaciones.length === 1
                  return (
                    <div key={a.valor} className="rounded-md border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{a.etiqueta}</p>
                          <p className="text-[11px] text-muted-foreground">{a.ayuda}</p>
                        </div>
                        <Switch
                          checked={marcado}
                          disabled={esElUltimo}
                          onCheckedChange={(on) =>
                            setFAmortizaciones((prev) =>
                              on ? [...prev, a.valor] : prev.filter((x) => x !== a.valor),
                            )
                          }
                        />
                      </div>
                      {marcado && fAmortizaciones.length > 1 && (
                        <label className="mt-2 flex items-center gap-1.5 text-[11px] cursor-pointer">
                          <input
                            type="radio"
                            name="amortizacion-default"
                            checked={fAmortizacionDefault === a.valor}
                            onChange={() => setFAmortizacionDefault(a.valor)}
                            className="h-3 w-3"
                          />
                          Usar como predeterminado
                        </label>
                      )}
                    </div>
                  )
                })}
              </div>
              {fAmortizaciones.length === 1 && (
                <p className="text-[11px] text-muted-foreground">
                  Con un solo método habilitado no hace falta predeterminado: ese se usa siempre.
                </p>
              )}
            </div>

            {/* ── Control de aprobaciones ───────────────────────────────── */}
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
                <Label className="text-sm">Control de aprobaciones</Label>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Por encima del umbral, el movimiento pasa a revisión de secretaría en vez de
                aplicarse directo.
              </p>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-normal">Ventas nuevas</Label>
                  <Switch checked={fVentaNuevaHab} onCheckedChange={setFVentaNuevaHab} />
                </div>
                <Input
                  type="text"
                  inputMode="decimal"
                  disabled={!fVentaNuevaHab}
                  value={mostrarMonto(fVentaNuevaUmbral)}
                  onChange={(e) => setFVentaNuevaUmbral(leerMonto(e.target.value))}
                  placeholder="Umbral (ej. $ 1.000.000)"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-normal">Renovaciones</Label>
                  <Switch checked={fVentaRenovacionHab} onCheckedChange={setFVentaRenovacionHab} />
                </div>
                <Input
                  type="text"
                  inputMode="decimal"
                  disabled={!fVentaRenovacionHab}
                  value={mostrarMonto(fVentaRenovacionUmbral)}
                  onChange={(e) => setFVentaRenovacionUmbral(leerMonto(e.target.value))}
                  placeholder="Umbral (ej. $ 1.000.000)"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-normal">Abonos (cuotas pagadas de una vez)</Label>
                  <Switch checked={fAbonoHab} onCheckedChange={setFAbonoHab} />
                </div>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  disabled={!fAbonoHab}
                  value={fAbonoUmbralCuotas}
                  onChange={(e) => setFAbonoUmbralCuotas(e.target.value)}
                  placeholder="Cantidad de cuotas (ej. 3)"
                  className="h-9 text-sm"
                />
              </div>

              {/* Umbral por item de ingreso / gasto / retiro */}
              {!editing ? (
                <p className="text-[11px] text-muted-foreground pt-1">
                  Los umbrales de ingresos, gastos y retiros se configuran al editar la ruta,
                  una vez creada.
                </p>
              ) : loadingItems ? (
                <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : (
                <Accordion type="multiple" className="rounded-lg border px-3">
                  {ITEM_TIPOS.map(({ tipo, label }) => {
                    const items = itemsByTipo[tipo]
                    // Mismo criterio que las filas de adentro: cuenta los que HOY
                    // piden aprobación, heredados incluidos. Antes contaba solo
                    // los configurados en la ruta, así que un grupo entero
                    // pidiendo aprobación por el tope general decía "0 con umbral".
                    const activos = items.filter((item) => {
                      const f = itemForm.get(`${tipo}:${item.id}`)
                      return f === undefined ? item.limite != null : f.habilitado
                    }).length
                    return (
                      <AccordionItem key={tipo} value={tipo}>
                        <AccordionTrigger className="text-sm">
                          {label}
                          {activos > 0 && (
                            <span className="text-[10px] font-normal text-muted-foreground mr-auto ml-2">
                              {activos} con umbral
                            </span>
                          )}
                        </AccordionTrigger>
                        <AccordionContent>
                          {items.length === 0 ? (
                            <p className="text-xs text-muted-foreground py-1">Sin items configurados en {label.toLowerCase()}</p>
                          ) : (
                            <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                              {items.map((item) => {
                                const key = `${tipo}:${item.id}`
                                const f = itemForm.get(key)

                                // LO QUE LE PASA HOY A ESTA RUTA CON ESTE CONCEPTO.
                                //
                                // Antes el interruptor salía apagado en DOS casos
                                // opuestos: cuando la ruta dijo "sin tope" y cuando
                                // la ruta no ha dicho nada y rige el tope general.
                                // El segundo sí pide aprobación. Quien configuraba
                                // veía "apagado", entendía "no pide" y guardaba sin
                                // tocar nada — y no se escribía ninguna fila, así
                                // que todo seguía igual.
                                //
                                // Ahora la fila muestra el estado EFECTIVO. Apagar
                                // un heredado sí escribe la fila y sí lo quita.
                                const heredado = f === undefined
                                const pide = heredado ? item.limite != null : f.habilitado
                                const umbralTexto = heredado
                                  ? (item.limite?.toString() ?? "")
                                  : f.umbral
                                const umbralNum = umbralTexto.trim() === "" ? null : Number(umbralTexto)

                                return (
                                  <div key={item.id} className="space-y-1 rounded-md border border-border/60 p-2">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label className="text-xs font-normal truncate">{item.nombre}</Label>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <span className="text-[10px] text-muted-foreground">Pide aprobación</span>
                                        <Switch
                                          checked={pide}
                                          onCheckedChange={(v) => toggleItemHabilitado(key, v, umbralTexto)}
                                        />
                                      </div>
                                    </div>
                                    {pide && (
                                      <Input
                                        type="text"
                                        inputMode="decimal"
                                        value={mostrarMonto(umbralTexto)}
                                        onChange={(e) => setItemUmbralValue(key, leerMonto(e.target.value))}
                                        placeholder="Umbral en $"
                                        className="h-8 text-xs"
                                      />
                                    )}
                                    {/* Se dice en palabras qué va a pasar. El caso
                                        del CERO es el que trajo el reporte: se lee
                                        como "sin límite" y significa lo contrario. */}
                                    {!pide ? (
                                      <p className="text-[10px] leading-snug text-muted-foreground">
                                        Sin tope: nunca pide aprobación.
                                      </p>
                                    ) : umbralNum === 0 ? (
                                      <p className="text-[10px] font-medium leading-snug text-destructive">
                                        En 0 pide aprobación SIEMPRE, con cualquier valor. Para quitarle
                                        el tope, apaga el interruptor.
                                      </p>
                                    ) : umbralNum === null || Number.isNaN(umbralNum) ? (
                                      <p className="text-[10px] leading-snug text-muted-foreground">
                                        Escribe desde qué valor pide aprobación.
                                      </p>
                                    ) : (
                                      <p className="text-[10px] leading-snug text-muted-foreground">
                                        Pide aprobación si supera ${umbralNum.toLocaleString()}.
                                        {heredado && " Viene del tope general de todas las rutas."}
                                      </p>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </AccordionContent>
                      </AccordionItem>
                    )
                  })}
                </Accordion>
              )}
            </div>

            {/* ── Logo de la unidad ─────────────────────────────────────── */}
            {/* NO es la foto de perfil. La foto es de la PERSONA que entra a
                la app; esto es la marca de la UNIDAD, y es lo que sale en el
                encabezado del recibo que se le entrega al cliente. Cada
                unidad puede tener la suya. */}
            <div className="space-y-1.5 border-t pt-3">
              <Label className="text-sm">Logo de la unidad</Label>
              <div className="flex items-center gap-2">
                {/* La vista previa va primero: es lo que confirma que se
                    subio la imagen correcta antes de guardar. */}
                <div className="h-11 w-11 shrink-0 rounded border bg-white grid place-items-center overflow-hidden">
                  {fLogoUrl.trim() ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={fLogoUrl}
                      alt="Logo de la unidad"
                      className="h-full w-full object-contain"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden" }}
                    />
                  ) : (
                    <span className="text-[9px] text-muted-foreground text-center leading-tight px-0.5">Sin logo</span>
                  )}
                </div>
                <Input
                  value={fLogoUrl}
                  onChange={(e) => setFLogoUrl(e.target.value)}
                  placeholder="Sin logo — se usa el de la app"
                  className="h-9 text-sm flex-1 min-w-0"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 shrink-0 gap-1.5 text-xs"
                  disabled={subiendoLogo}
                  onClick={() => document.getElementById("logo-unidad-file")?.click()}
                >
                  {subiendoLogo
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Upload className="h-3.5 w-3.5" />}
                  {subiendoLogo ? "Subiendo..." : "Subir"}
                </Button>
                <input
                  id="logo-unidad-file"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleSubirLogo}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Va en el encabezado de los recibos de esta unidad. Si se deja vacío se usa el
                logo de la app. No tiene nada que ver con la foto de perfil del usuario.
              </p>
            </div>

            {/* ── La moto de la unidad ──────────────────────────────────── */}
            {/* Tres datos y ninguno obligatorio: una unidad sin moto es lo
                normal, no un error. Ver scripts/120. */}
            <div className="space-y-1.5 border-t pt-3">
              <Label className="text-sm">Moto de la unidad</Label>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Placa</Label>
                  {/* Se pasa a MAYUSCULA y se le quitan los espacios mientras
                      se escribe: la misma moto anotada como "abc12d" y
                      "ABC 12D" no se podria buscar. Sin `maxLength` corto
                      porque las placas no miden igual en los cuatro paises
                      (Argentina AA123BB, Colombia ABC12D). */}
                  <Input
                    value={fMotoPlaca}
                    onChange={(e) =>
                      setFMotoPlaca(e.target.value.replace(/\s+/g, "").toUpperCase())
                    }
                    placeholder="ABC12D"
                    maxLength={10}
                    className="h-9 text-sm uppercase tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Fecha de compra</Label>
                  <Input
                    type="date"
                    value={fMotoFecha}
                    onChange={(e) => setFMotoFecha(e.target.value)}
                    className="h-9 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* La vista previa primero, igual que con el logo: es lo que
                    confirma que se subio la foto correcta antes de guardar. */}
                <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded border bg-white">
                  {fMotoFotoUrl.trim() ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={fMotoFotoUrl}
                      alt="Foto de la moto"
                      className="h-full w-full object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden" }}
                    />
                  ) : (
                    <Bike className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <Input
                  value={fMotoFotoUrl}
                  onChange={(e) => setFMotoFotoUrl(e.target.value)}
                  placeholder="Sin foto"
                  className="h-9 min-w-0 flex-1 text-sm"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 shrink-0 gap-1.5 text-xs"
                  disabled={subiendoMoto}
                  onClick={() => document.getElementById("moto-foto-file")?.click()}
                >
                  {subiendoMoto
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Upload className="h-3.5 w-3.5" />}
                  {subiendoMoto ? "Subiendo..." : "Subir"}
                </Button>
                <input
                  id="moto-foto-file"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleSubirFotoMoto}
                />
              </div>

              <p className="text-[11px] text-muted-foreground">
                Ninguno de los tres es obligatorio. La placa se guarda en
                mayúscula y sin espacios, y no puede repetirse en otra unidad.
              </p>
            </div>

            {/* ── Varios prestamos al mismo cliente ─────────────────────── */}
            {/* El interruptor dice lo que PERMITE, no lo que prohibe, porque
                aca lo que se enciende es un permiso: la regla de siempre —un
                credito a la vez— es lo que rige con el apagado. */}
            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Permitir varios préstamos al mismo cliente</Label>
                <Switch checked={fMultiplesPrestamos} onCheckedChange={setFMultiplesPrestamos} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {fMultiplesPrestamos ? (
                  <>
                    Al vender, el buscador muestra también a quien ya tiene un crédito activo, y se
                    le puede registrar uno nuevo sin cancelar el anterior. Los dos corren en
                    paralelo: cada uno con su cronograma, su saldo y su cuota, y los dos salen en la
                    lista de cobro.
                  </>
                ) : (
                  <>
                    Como hasta hoy: al vender solo aparecen los clientes sin crédito activo. Para
                    darle otro hay que cancelar el que tiene o hacer una renovación.
                  </>
                )}
              </p>
            </div>

            {/* ── Tiempo para cerrar un dia atrasado ────────────────────── */}
            {/* Cuando secretaria descongela una ruta, hoy ese permiso no
                caduca. Este interruptor le pone reloj. Apagado = como hasta
                hoy, que es el defecto de todas las rutas: encender un limite
                para todo el mundo de golpe dejaria cobradores bloqueados en
                la calle sin que nadie lo hubiera decidido. Ver scripts/113. */}
            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Limitar el tiempo para cerrar un día atrasado</Label>
                <Switch checked={fCierreLimite} onCheckedChange={setFCierreLimite} />
              </div>

              {fCierreLimite && (
                <div className="flex items-center gap-2 pt-1">
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    inputMode="numeric"
                    value={fCierreMinutos}
                    onChange={(e) => setFCierreMinutos(e.target.value)}
                    className="h-9 w-24 text-sm"
                  />
                  <span className="text-sm text-muted-foreground">minutos</span>
                </div>
              )}

              <p className="text-[11px] text-muted-foreground">
                {fCierreLimite ? (
                  <>
                    Desde que la secretaría desbloquea la unidad, el cobrador tiene{" "}
                    <strong>{Number(fCierreMinutos) || 15} minutos</strong> para procesar y cerrar
                    ese día. Ve un contador en pantalla. Si se le vence, la unidad se vuelve a
                    congelar y hay que habilitarla de nuevo — lo que alcanzó a registrar no se
                    pierde.
                  </>
                ) : (
                  <>
                    Como hasta hoy: una vez desbloqueada, el cobrador tiene el tiempo que necesite
                    para terminar de cerrar el día atrasado.
                  </>
                )}
              </p>
            </div>

            {/* ── Cédula ────────────────────────────────────────────────── */}
            {/* El interruptor dice lo que EXIGE, no lo que permite, igual que
                todos los de esta pantalla: encendido = la restricción está
                puesta. Apagarlo es lo que abre la puerta. */}
            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Exigir foto de la cédula para clientes nuevos</Label>
                <Switch checked={fCedulaObligatoria} onCheckedChange={setFCedulaObligatoria} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {fCedulaObligatoria ? (
                  <>
                    Como hasta hoy: el documento y el nombre solo se llenan fotografiando la
                    cédula, y sin foto no se puede registrar un cliente nuevo. Apágalo para las
                    unidades donde el cliente no carga cédula o la señal no da para subirla: ahí
                    los dos campos se escriben a mano y la foto queda opcional.
                  </>
                ) : (
                  <>
                    El documento y el nombre se escriben a mano y la foto es opcional. El número
                    de documento sigue siendo obligatorio y único: dos clientes no pueden tener el
                    mismo, así que un dato inventado bloquea al cliente de verdad cuando llegue.
                  </>
                )}
              </p>
            </div>

            {/* ── Resumen Semanal ───────────────────────────────────────── */}
            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Resumen Semanal en el Resumen del Día</Label>
                <Switch checked={fResumenSemanal} onCheckedChange={setFResumenSemanal} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {fResumenSemanal ? (
                  <>
                    Abajo del Resumen del Día de esta unidad aparece el cuadro con la semana desde el
                    lunes: recaudado, pagos, no pagos, efectivo, transferencias y cumplimiento de la
                    meta.
                  </>
                ) : (
                  <>Apagado: el Resumen del Día de esta unidad no muestra el cuadro semanal.</>
                )}
              </p>
            </div>

            {/* ── Geocerca ──────────────────────────────────────────────── */}
            <div className="space-y-1.5 border-t pt-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Geocerca (cobrar solo donde está el cliente)</Label>
                <Switch checked={fGeocercaHab} onCheckedChange={setFGeocercaHab} />
              </div>
              <Input
                type="number"
                min={20}
                step={10}
                disabled={!fGeocercaHab}
                value={fGeocercaRadio}
                onChange={(e) => setFGeocercaRadio(e.target.value)}
                placeholder="Radio en metros (ej. 100)"
                className="h-9 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                Por debajo de 50 m el GPS de un celular falla seguido: entre edificios o bajo techo el error puede pasar
                de los 50 m y bloquearía cobros válidos. Empieza en 100 m y bájalo si en campo funciona. Los clientes sin
                ubicación guardada se pueden cobrar normal — la ubicación se captura en ese primer cobro.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" size="sm" onClick={() => setShowForm(false)} disabled={saving}>Cancelar</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {editing ? "Guardar cambios" : "Crear ruta"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmar eliminación */}
      <Dialog open={confirmDeleteId !== null} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Eliminar ruta</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-1">
            ¿Confirmas la eliminación? También se eliminarán las asignaciones de usuarios a esta ruta.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancelar</Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>Eliminar</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Tab Gerentes ─────────────────────────────────────────────────────────────

/**
 * QUÉ ADMINISTRADORES TIENE A CARGO CADA GERENTE.
 *
 * Es la misma forma que Asignaciones —se elige a la izquierda, se marca a la
 * derecha— pero entre usuarios: un gerente y sus administradores. Es lo que
 * decide a quién ve ese gerente en el Reporte Gerencial.
 *
 * Si la tabla `gerente_admins` no existe todavía (script 116 sin correr), se
 * avisa en vez de dejar una pantalla muerta.
 */
function GerentesTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [vinculos, setVinculos] = useState<{ gerente_id: number; admin_id: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [faltaTabla, setFaltaTabla] = useState(false)
  const [selectedGerente, setSelectedGerente] = useState<number | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [uRes, vRes] = await Promise.all([
        supabase.from("usuarios").select("id, usuario, nombre, rol, activo").order("nombre"),
        supabase.from("gerente_admins").select("gerente_id, admin_id"),
      ])
      if (uRes.error) throw uRes.error
      setUsuarios((uRes.data ?? []) as unknown as Usuario[])
      // LA TABLA NO EXISTE = el script 116 no se ha corrido.
      //
      // Se miran DOS codigos: `42P01` es el de Postgres, pero PostgREST NO lo
      // reenvia — responde `PGRST205` ("Could not find the table ... in the
      // schema cache"). Se comprobo contra produccion: con la tabla sin
      // crear, la respuesta es PGRST205. Mirando solo el 42P01, la pestaña
      // se veia funcionando y el aviso no salia nunca.
      if (vRes.error) {
        const code = (vRes.error as { code?: string }).code
        if (
          code === "42P01" ||
          code === "PGRST205" ||
          /does not exist|could not find the table/i.test(vRes.error.message)
        ) {
          setFaltaTabla(true)
          setVinculos([])
        } else {
          throw vRes.error
        }
      } else {
        setFaltaTabla(false)
        setVinculos((vRes.data ?? []) as unknown as { gerente_id: number; admin_id: number }[])
      }
    } catch (err) {
      console.error("[v0] Error cargando gerentes:", err)
      toast({
        title: "Error",
        description: "No se pudieron cargar los gerentes",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const gerentes = usuarios.filter((u) =>
    ["gerencia", "gerente"].includes((u.rol ?? "").toLowerCase()),
  )
  const admins = usuarios.filter((u) =>
    ["admin", "administrador"].includes((u.rol ?? "").toLowerCase()),
  )

  const seleccionar = (id: number) => {
    setSelectedGerente(id)
    setChecked(new Set(vinculos.filter((v) => v.gerente_id === id).map((v) => v.admin_id)))
    setDirty(false)
  }

  const alternar = (adminId: number) => {
    setChecked((prev) => {
      const s = new Set(prev)
      if (s.has(adminId)) s.delete(adminId)
      else s.add(adminId)
      return s
    })
    setDirty(true)
  }

  const guardar = async () => {
    if (selectedGerente == null) return
    setSaving(true)
    try {
      const supabase = createClient()
      const antes = new Set(
        vinculos.filter((v) => v.gerente_id === selectedGerente).map((v) => v.admin_id),
      )
      const agregar = [...checked].filter((id) => !antes.has(id))
      const quitar = [...antes].filter((id) => !checked.has(id))

      if (quitar.length > 0) {
        const { error } = await supabase
          .from("gerente_admins")
          .delete()
          .eq("gerente_id", selectedGerente)
          .in("admin_id", quitar)
        if (error) throw error
      }
      if (agregar.length > 0) {
        const { error } = await supabase
          .from("gerente_admins")
          .insert(agregar.map((admin_id) => ({ gerente_id: selectedGerente, admin_id })))
        if (error) throw error
      }
      setVinculos((prev) => [
        ...prev.filter((v) => v.gerente_id !== selectedGerente),
        ...[...checked].map((admin_id) => ({ gerente_id: selectedGerente, admin_id })),
      ])
      setDirty(false)
      toast({ title: "Gerente actualizado" })
    } catch (err) {
      console.error("[v0] Error guardando gerente_admins:", err)
      toast({ title: "Error", description: "No se pudo guardar", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Skeleton className="h-64 w-full" />

  if (faltaTabla) {
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-center">
          <AlertCircle className="mx-auto h-5 w-5 text-amber-600" />
          <p className="text-xs text-muted-foreground">
            Falta correr <strong>scripts/116-un-gerente-tiene-administradores.sql</strong>. Hasta
            entonces no se pueden asignar administradores a un gerente.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card>
        <CardContent className="p-3">
          <p className="mb-2 text-xs font-semibold">Gerentes</p>
          {gerentes.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted-foreground">
              No hay usuarios con rol gerencia. Créalos en la pestaña Usuarios.
            </p>
          ) : (
            <div className="space-y-1">
              {gerentes.map((g) => {
                const cuantos = vinculos.filter((v) => v.gerente_id === g.id).length
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => seleccionar(g.id)}
                    className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                      selectedGerente === g.id ? "border-brand bg-brand/10" : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="truncate">{g.nombre}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {cuantos} {cuantos === 1 ? "admin" : "admins"}
                    </Badge>
                  </button>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold">Administradores a cargo</p>
            {dirty && (
              <Button
                size="sm"
                onClick={() => void guardar()}
                disabled={saving}
                className="h-7 text-xs"
              >
                {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Guardar
              </Button>
            )}
          </div>
          {selectedGerente == null ? (
            <p className="py-6 text-center text-[11px] text-muted-foreground">
              Elige un gerente de la izquierda.
            </p>
          ) : admins.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted-foreground">
              No hay usuarios con rol admin.
            </p>
          ) : (
            <div className="space-y-1">
              {admins.map((a) => (
                <label
                  key={a.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50"
                >
                  <Checkbox
                    checked={checked.has(a.id)}
                    onCheckedChange={() => alternar(a.id)}
                    className="h-4 w-4"
                  />
                  <span className="truncate">{a.nombre}</span>
                  {!a.activo && (
                    <Badge variant="outline" className="ml-auto text-[10px]">
                      inactivo
                    </Badge>
                  )}
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Tab Asignaciones ─────────────────────────────────────────────────────────

function AsignacionesTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [rutas, setRutas] = useState<Ruta[]>([])
  const [asignaciones, setAsignaciones] = useState<{ usuario_id: number; ruta_id: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [checkedRutas, setCheckedRutas] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const [uRes, rRes, aRes] = await Promise.all([
        supabase.from("usuarios").select("id, usuario, nombre, rol, activo, acceso_modulo_reporte, pin_cambiado").order("nombre"),
        supabase.from("rutas").select("id, nombre, ciudad, pais").order("id"),
        supabase.from("usuario_rutas").select("usuario_id, ruta_id"),
      ])
      if (uRes.error) throw uRes.error
      if (rRes.error) throw rRes.error
      if (aRes.error) throw aRes.error
      setUsuarios(uRes.data ?? [])
      setRutas(rRes.data ?? [])
      setAsignaciones(aRes.data ?? [])
    } catch (err) {
      console.error("[v0] Error fetching asignaciones:", err)
      toast({ title: "Error", description: "No se pudieron cargar los datos", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Cuando cambia el usuario seleccionado, cargar sus rutas actuales
  useEffect(() => {
    if (selectedUserId === null) { setCheckedRutas(new Set()); setDirty(false); return }
    const assigned = asignaciones
      .filter((a) => a.usuario_id === selectedUserId)
      .map((a) => a.ruta_id)
    setCheckedRutas(new Set(assigned))
    setDirty(false)
  }, [selectedUserId, asignaciones])

  const toggleRuta = (rutaId: number) => {
    setCheckedRutas((prev) => {
      const next = new Set(prev)
      if (next.has(rutaId)) next.delete(rutaId)
      else next.add(rutaId)
      return next
    })
    setDirty(true)
  }

  const handleGuardar = async () => {
    if (selectedUserId === null) return
    setSaving(true)
    try {
      const supabase = createClient()
      const anteriores = new Set(
        asignaciones.filter((a) => a.usuario_id === selectedUserId).map((a) => a.ruta_id)
      )
      const agregar = [...checkedRutas].filter((id) => !anteriores.has(id))
      const quitar = [...anteriores].filter((id) => !checkedRutas.has(id))

      if (quitar.length > 0) {
        const { error } = await supabase
          .from("usuario_rutas")
          .delete()
          .eq("usuario_id", selectedUserId)
          .in("ruta_id", quitar)
        if (error) throw error
      }
      if (agregar.length > 0) {
        const { error } = await supabase
          .from("usuario_rutas")
          .insert(agregar.map((ruta_id) => ({ usuario_id: selectedUserId, ruta_id })))
        if (error) throw error
      }

      // Actualizar estado local para reflejar cambios sin re-fetch completo
      setAsignaciones((prev) => {
        const sinEste = prev.filter((a) => a.usuario_id !== selectedUserId)
        const nuevas = [...checkedRutas].map((ruta_id) => ({ usuario_id: selectedUserId, ruta_id }))
        return [...sinEste, ...nuevas]
      })
      setDirty(false)
      toast({ title: "Asignaciones guardadas" })
    } catch (err: any) {
      console.error("[v0] Error saving asignaciones:", err)
      toast({ title: "Error", description: err?.message ?? "Error al guardar", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const usuarioSeleccionado = usuarios.find((u) => u.id === selectedUserId)
  const totalAsignadas = selectedUserId
    ? asignaciones.filter((a) => a.usuario_id === selectedUserId).length
    : null

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      {/* Panel izquierdo: lista de usuarios */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-2">
          Seleccionar usuario
        </p>
        <div className="rounded-xl border border-border overflow-hidden max-h-[420px] overflow-y-auto">
          {usuarios.map((u) => {
            const isSelected = u.id === selectedUserId
            const rutasCount = asignaciones.filter((a) => a.usuario_id === u.id).length
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => setSelectedUserId(u.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-border last:border-0 transition-colors ${
                  isSelected ? "bg-brand/10 text-brand" : "hover:bg-muted/40"
                }`}
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-bold">
                  {u.nombre.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium truncate leading-tight ${isSelected ? "text-brand" : ""}`}>{u.nombre}</p>
                  <p className="text-[10px] text-muted-foreground">{ROL_LABELS[u.rol] ?? u.rol} · {rutasCount} ruta{rutasCount !== 1 ? "s" : ""}</p>
                </div>
                {isSelected && <CheckCircle2 className="h-4 w-4 shrink-0 text-brand" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Panel derecho: rutas del usuario */}
      <div className="space-y-3">
        {selectedUserId === null ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground">
            <Link2 className="h-8 w-8 opacity-30" />
            <p className="text-sm">Selecciona un usuario para gestionar sus rutas</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-sm">{usuarioSeleccionado?.nombre}</p>
                <p className="text-xs text-muted-foreground">
                  {checkedRutas.size} ruta{checkedRutas.size !== 1 ? "s" : ""} asignada{checkedRutas.size !== 1 ? "s" : ""}
                  {totalAsignadas !== null && totalAsignadas !== checkedRutas.size && (
                    <span className="ml-1 text-amber-600 dark:text-amber-400">(sin guardar)</span>
                  )}
                </p>
              </div>
              <Button
                size="sm"
                onClick={handleGuardar}
                disabled={saving || !dirty}
                className="gap-1.5 h-8 text-xs"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                Guardar
              </Button>
            </div>

            {rutas.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay rutas registradas</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {rutas.map((r) => {
                  const checked = checkedRutas.has(r.id)
                  return (
                    <label
                      key={r.id}
                      className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        checked
                          ? "border-brand/50 bg-brand/5 dark:bg-brand/10"
                          : "border-border hover:border-border/80 hover:bg-muted/20"
                      }`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleRuta(r.id)}
                        className="h-4 w-4"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{r.nombre}</p>
                        <p className="text-[10px] text-muted-foreground">
                          #{r.id}{r.ciudad ? ` · ${r.ciudad}` : ""}{r.pais ? ` · ${r.pais}` : ""}
                        </p>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Tab Permisos ─────────────────────────────────────────────────────────────

type PermRow = {
  viewId: string
  label: string
  description: string
  group: string
  enabled: boolean
  inMobileNav: boolean
}

function buildDefaultRows(rol: string): PermRow[] {
  const defaultViewIds = new Set(getDefaultModulesForRole(rol).map((m) => m.viewId))
  return ALL_MODULES.map((m) => {
    const inDefault = defaultViewIds.has(m.viewId)
    return {
      viewId: m.viewId,
      label: m.label,
      description: m.description,
      group: m.group,
      enabled: inDefault,
      inMobileNav: inDefault && isDefaultMobileNav(m, rol),
    }
  })
}

function PermisosTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [permRows, setPermRows] = useState<PermRow[]>([])
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [dirty, setDirty] = useState(false)

  const fetchUsuarios = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("usuarios")
        .select("id, usuario, nombre, rol, activo, acceso_modulo_reporte, pin_cambiado")
        .order("nombre")
      if (error) throw error
      setUsuarios(data ?? [])
    } catch (err) {
      console.error("[v0] Error fetching usuarios (permisos):", err)
      toast({ title: "Error", description: "No se pudieron cargar los usuarios", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { fetchUsuarios() }, [fetchUsuarios])

  const loadPermissions = useCallback(async (userId: number, rol: string) => {
    const defaults = buildDefaultRows(rol)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("user_permissions")
        .select("view_id, enabled, in_mobile_nav")
        .eq("user_id", userId)
      if (error) throw error

      if (!data || data.length === 0) {
        setPermRows(defaults)
        return
      }

      const dbMap: Record<string, { enabled: boolean; inMobileNav: boolean }> = {}
      data.forEach((row: { view_id: string; enabled: boolean; in_mobile_nav: boolean }) => { dbMap[row.view_id] = { enabled: row.enabled, inMobileNav: row.in_mobile_nav } })

      setPermRows(defaults.map((r) =>
        dbMap[r.viewId] !== undefined
          ? { ...r, enabled: dbMap[r.viewId].enabled, inMobileNav: dbMap[r.viewId].inMobileNav }
          : r,
      ))
    } catch (err) {
      console.error("[v0] Error loading permissions:", err)
      setPermRows(defaults)
    }
  }, [])

  const handleSelectUser = (userId: number) => {
    const u = usuarios.find((u) => u.id === userId)
    if (!u) return
    setSelectedUserId(userId)
    setDirty(false)
    loadPermissions(userId, u.rol)
  }

  const toggleEnabled = (viewId: string) => {
    setPermRows((prev) =>
      prev.map((r) =>
        r.viewId === viewId
          ? { ...r, enabled: !r.enabled, inMobileNav: r.enabled ? false : r.inMobileNav }
          : r,
      ),
    )
    setDirty(true)
  }

  const toggleMobileNav = (viewId: string) => {
    setPermRows((prev) =>
      prev.map((r) => (r.viewId === viewId ? { ...r, inMobileNav: !r.inMobileNav } : r)),
    )
    setDirty(true)
  }

  const mobileCount = permRows.filter((r) => r.enabled && r.inMobileNav).length

  const handleGuardar = async () => {
    if (selectedUserId === null) return
    setSaving(true)
    try {
      const supabase = createClient()
      await supabase.from("user_permissions").delete().eq("user_id", selectedUserId)
      if (permRows.length > 0) {
        const { error } = await supabase.from("user_permissions").insert(
          permRows.map((r) => ({
            user_id: selectedUserId,
            view_id: r.viewId,
            enabled: r.enabled,
            in_mobile_nav: r.inMobileNav,
          })),
        )
        if (error) throw error
      }
      setDirty(false)
      toast({ title: "Permisos guardados", description: "Los cambios se aplicarán en el próximo inicio de sesión del usuario." })
    } catch (err: any) {
      console.error("[v0] Error saving permissions:", err)
      toast({ title: "Error", description: err?.message ?? "No se pudieron guardar los permisos", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handleRestablecer = async () => {
    if (selectedUserId === null) return
    const u = usuarios.find((u) => u.id === selectedUserId)
    if (!u) return
    setResetting(true)
    try {
      const supabase = createClient()
      await supabase.from("user_permissions").delete().eq("user_id", selectedUserId)
      setPermRows(buildDefaultRows(u.rol))
      setDirty(false)
      toast({ title: "Permisos restablecidos", description: "Se volvieron a los valores por defecto del rol." })
    } catch (err: any) {
      console.error("[v0] Error resetting permissions:", err)
      toast({ title: "Error", description: err?.message ?? "Error al restablecer", variant: "destructive" })
    } finally {
      setResetting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const usuarioSeleccionado = usuarios.find((u) => u.id === selectedUserId)

  return (
    <div className="space-y-4">
      {/* Banner informativo */}
      <div className="flex gap-2.5 rounded-xl border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40 p-3 text-sm text-blue-800 dark:text-blue-300">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="space-y-0.5">
          <p className="font-semibold text-xs">¿Qué puedes gestionar aquí?</p>
          <p className="text-xs text-blue-700 dark:text-blue-400">
            Activa o desactiva el acceso de cada usuario a módulos de su rol. Marca cuáles aparecen como acceso directo en la barra inferior del celular (máx. 5).
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
        {/* Panel izquierdo: lista de usuarios */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-2">
            Seleccionar usuario
          </p>
          <div className="rounded-xl border border-border overflow-hidden max-h-[420px] overflow-y-auto">
            {usuarios.map((u) => {
              const isSelected = u.id === selectedUserId
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => handleSelectUser(u.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-border last:border-0 transition-colors ${
                    isSelected ? "bg-brand/10 text-brand" : "hover:bg-muted/40"
                  }`}
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-bold">
                    {u.nombre.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium truncate leading-tight ${isSelected ? "text-brand" : ""}`}>{u.nombre}</p>
                    <p className="text-[10px] text-muted-foreground">{ROL_LABELS[u.rol] ?? u.rol}</p>
                  </div>
                  {isSelected && <CheckCircle2 className="h-4 w-4 shrink-0 text-brand" />}
                </button>
              )
            })}
          </div>
        </div>

        {/* Panel derecho: módulos del usuario */}
        <div className="space-y-3">
          {selectedUserId === null ? (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground">
              <Shield className="h-8 w-8 opacity-30" />
              <p className="text-sm">Selecciona un usuario para gestionar sus permisos</p>
            </div>
          ) : (
            <>
              {/* Cabecera usuario + contador móvil */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <p className="font-semibold text-sm">{usuarioSeleccionado?.nombre}</p>
                  <p className="text-xs text-muted-foreground">{ROL_LABELS[usuarioSeleccionado?.rol ?? ""] ?? usuarioSeleccionado?.rol} · {permRows.filter(r => r.enabled).length} de {permRows.length} módulos activos</p>
                </div>
                <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                  mobileCount >= 5
                    ? "border-destructive/40 bg-destructive/5 text-destructive"
                    : "border-border bg-muted/30 text-muted-foreground"
                }`}>
                  <Smartphone className="h-3.5 w-3.5" />
                  {mobileCount}/5 accesos directos
                </div>
              </div>

              {/* Módulos agrupados */}
              <div className="space-y-3">
                {/* Cabecera de columnas fija */}
                <div className="grid grid-cols-[1fr_80px_100px] gap-2 px-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Módulo</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground text-center">Acceso</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground text-center">Acceso directo</p>
                </div>
                {MODULE_GROUPS.map((group) => {
                  const groupRows = permRows.filter((r) => r.group === group)
                  if (groupRows.length === 0) return null
                  return (
                    <div key={group} className="rounded-xl border border-border overflow-hidden">
                      <div className="px-3 py-1.5 bg-muted/60 border-b border-border">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{group}</p>
                      </div>
                      <div className="divide-y divide-border">
                        {groupRows.map((row) => {
                          const mobileDisabled = !row.enabled || (mobileCount >= 5 && !row.inMobileNav)
                          return (
                            <div
                              key={row.viewId}
                              className="grid grid-cols-[1fr_80px_100px] gap-2 items-center px-3 py-2.5 transition-colors"
                            >
                              <div className={`min-w-0 transition-opacity ${!row.enabled ? "opacity-40" : ""}`}>
                                <p className="text-sm font-medium truncate leading-tight">{row.label}</p>
                                <p className="text-[10px] text-muted-foreground truncate">{row.description}</p>
                              </div>
                              <div className="flex justify-center">
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={row.enabled}
                                  aria-label={`Acceso a ${row.label}`}
                                  onClick={() => toggleEnabled(row.viewId)}
                                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
                                    row.enabled
                                      ? "border-brand bg-brand focus-visible:ring-brand"
                                      : "border-border bg-muted focus-visible:ring-border"
                                  }`}
                                >
                                  <span
                                    className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md ring-0 transition-transform ${
                                      row.enabled ? "translate-x-5" : "translate-x-0.5"
                                    }`}
                                  />
                                </button>
                              </div>
                              <div className="flex justify-center">
                                <Checkbox
                                  checked={row.inMobileNav}
                                  disabled={mobileDisabled}
                                  onCheckedChange={() => toggleMobileNav(row.viewId)}
                                  aria-label={`Acceso directo a ${row.label}`}
                                  className="h-4 w-4"
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Botones */}
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRestablecer}
                  disabled={resetting || saving}
                  className="gap-1.5 h-8 text-xs"
                >
                  {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  Restablecer defaults
                </Button>
                <Button
                  size="sm"
                  onClick={handleGuardar}
                  disabled={saving || resetting || !dirty}
                  className="gap-1.5 h-8 text-xs"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Guardar permisos
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Tab Contactos Chat ───────────────────────────────────────────────────────

function ContactosChatTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [allowedIds, setAllowedIds] = useState<Set<number>>(new Set())
  const [hasRestrictions, setHasRestrictions] = useState(false)
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from("usuarios")
      .select("id, usuario, nombre, rol, activo")
      .eq("activo", true)
      .order("nombre")
      .then(({ data }: { data: Usuario[] | null }) => { setUsuarios((data ?? [])); setLoadingUsers(false) })
  }, [])

  const loadContacts = useCallback(async (userId: number) => {
    setLoadingContacts(true)
    setDirty(false)
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from("chat_allowed_contacts")
        .select("allowed_user_id")
        .eq("user_id", userId)
      if (!data || data.length === 0) {
        setHasRestrictions(false)
        setAllowedIds(new Set())
      } else {
        setHasRestrictions(true)
        setAllowedIds(new Set(data.map((r: { allowed_user_id: number }) => r.allowed_user_id)))
      }
    } finally {
      setLoadingContacts(false)
    }
  }, [])

  useEffect(() => {
    if (selectedUserId) loadContacts(selectedUserId)
  }, [selectedUserId, loadContacts])

  const toggleContact = (uid: number) => {
    setAllowedIds((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
    setHasRestrictions(true)
    setDirty(true)
  }

  const handleRestablecer = async () => {
    if (!selectedUserId) return
    try {
      setSaving(true)
      const supabase = createClient()
      await supabase.from("chat_allowed_contacts").delete().eq("user_id", selectedUserId)
      setHasRestrictions(false)
      setAllowedIds(new Set())
      setDirty(false)
      toast({ title: "Restablecido", description: "El usuario puede ver a todos los contactos." })
    } catch {
      toast({ title: "Error", description: "No se pudo restablecer.", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handleGuardar = async () => {
    if (!selectedUserId) return
    try {
      setSaving(true)
      const supabase = createClient()
      await supabase.from("chat_allowed_contacts").delete().eq("user_id", selectedUserId)
      if (allowedIds.size > 0) {
        await supabase.from("chat_allowed_contacts").insert(
          [...allowedIds].map((uid) => ({ user_id: selectedUserId, allowed_user_id: uid }))
        )
      }
      setDirty(false)
      toast({ title: "Guardado", description: hasRestrictions && allowedIds.size === 0 ? "El usuario no puede ver ningún contacto." : "Contactos permitidos actualizados." })
    } catch {
      toast({ title: "Error", description: "No se pudo guardar.", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const selectedUser = usuarios.find((u) => u.id === selectedUserId)
  const otherUsers = usuarios.filter((u) => u.id !== selectedUserId)

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      {/* Panel selector de usuario */}
      <div className="space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-1 mb-2">Usuarios</p>
        {loadingUsers ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
            {usuarios.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => { setSelectedUserId(u.id); setDirty(false) }}
                className={`w-full text-left rounded-lg border px-3 py-2 text-sm transition-all ${
                  selectedUserId === u.id
                    ? "border-brand bg-brand/10 font-semibold"
                    : "border-transparent hover:border-border hover:bg-muted/50"
                }`}
              >
                <p className="font-medium leading-tight">{u.nombre}</p>
                <p className={`text-[10px] mt-0.5 px-1.5 rounded-full inline-block ${ROL_BADGE[u.rol] ?? ""}`}>{ROL_LABELS[u.rol] ?? u.rol}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Panel de contactos permitidos */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        {!selectedUser ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
            <MessageSquare className="h-8 w-8 opacity-30" />
            <p className="text-sm">Selecciona un usuario para configurar<br />sus contactos de chat visibles</p>
          </div>
        ) : loadingContacts ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-sm">{selectedUser.nombre}</p>
                <p className="text-[11px] text-muted-foreground">
                  {!hasRestrictions
                    ? "Sin restricciones — ve a todos los usuarios"
                    : allowedIds.size === 0
                    ? "No puede ver ningún contacto"
                    : `Puede ver ${allowedIds.size} usuario${allowedIds.size !== 1 ? "s" : ""}`}
                </p>
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${!hasRestrictions ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                {!hasRestrictions ? "Ver todos" : "Restringido"}
              </span>
            </div>

            <div className="divide-y divide-border rounded-lg border overflow-hidden max-h-[50vh] overflow-y-auto">
              {otherUsers.map((u) => {
                const checked = !hasRestrictions || allowedIds.has(u.id)
                return (
                  <div
                    key={u.id}
                    onClick={() => toggleContact(u.id)}
                    className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors select-none"
                  >
                    <Checkbox
                      checked={checked}
                      className="h-4 w-4 shrink-0 pointer-events-none"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">{u.nombre}</p>
                      <p className={`text-[10px] mt-0.5 px-1.5 rounded-full inline-block ${ROL_BADGE[u.rol] ?? ""}`}>{ROL_LABELS[u.rol] ?? u.rol}</p>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={handleRestablecer} disabled={saving || !hasRestrictions} className="gap-1.5 h-8 text-xs">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Restablecer (ver todos)
              </Button>
              <Button size="sm" onClick={handleGuardar} disabled={saving || !dirty} className="gap-1.5 h-8 text-xs">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Guardar
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Tab Reportes BI ──────────────────────────────────────────────────────────

type BiReporte = { id: string; nombre: string; url: string; created_at: string }

function ReportesBiTab() {
  const { toast } = useToast()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)

  const [reportes, setReportes] = useState<BiReporte[]>([])
  const [loadingReportes, setLoadingReportes] = useState(true)
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null)

  const [formNombre, setFormNombre] = useState("")
  const [formUrl, setFormUrl] = useState("")
  const [savingForm, setSavingForm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [allowedIds, setAllowedIds] = useState<Set<number>>(new Set())
  const [loadingPermisos, setLoadingPermisos] = useState(false)
  const [savingPermisos, setSavingPermisos] = useState(false)
  const [dirtyPermisos, setDirtyPermisos] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from("usuarios")
      .select("id, usuario, nombre, rol, activo")
      .eq("activo", true)
      .order("nombre")
      .then(({ data }: { data: Usuario[] | null }) => { setUsuarios(data ?? []); setLoadingUsers(false) })
  }, [])

  const loadReportes = useCallback(async () => {
    setLoadingReportes(true)
    const { data } = await createClient()
      .from("bi_reportes")
      .select("id, nombre, url, created_at")
      .order("created_at", { ascending: true })
    setReportes((data ?? []) as BiReporte[])
    setLoadingReportes(false)
  }, [])

  useEffect(() => { loadReportes() }, [loadReportes])

  const loadPermisos = useCallback(async (reporteId: string) => {
    setLoadingPermisos(true)
    setDirtyPermisos(false)
    const { data } = await createClient()
      .from("bi_reporte_permisos")
      .select("user_id")
      .eq("reporte_id", reporteId)
    setAllowedIds(new Set((data ?? []).map((r: { user_id: number }) => r.user_id)))
    setLoadingPermisos(false)
  }, [])

  useEffect(() => {
    if (selectedId && selectedId !== "new") {
      const r = reportes.find((x) => x.id === selectedId)
      if (r) { setFormNombre(r.nombre); setFormUrl(r.url) }
      loadPermisos(selectedId)
    } else if (selectedId === "new") {
      setFormNombre("")
      setFormUrl("")
      setAllowedIds(new Set())
      setDirtyPermisos(false)
    }
  }, [selectedId, reportes, loadPermisos])

  const isNew = selectedId === "new"
  const selectedReporte = reportes.find((r) => r.id === selectedId)
  const formUnchanged = !isNew && formNombre === selectedReporte?.nombre && formUrl === selectedReporte?.url

  const handleGuardarReporte = async () => {
    if (!formNombre.trim() || !formUrl.trim()) return
    setSavingForm(true)
    try {
      const supabase = createClient()
      if (isNew) {
        const { data, error } = await supabase
          .from("bi_reportes")
          .insert({ nombre: formNombre.trim(), url: formUrl.trim() })
          .select("id")
          .single()
        if (error || !data) throw new Error(error?.message ?? "Error al crear el reporte")
        await loadReportes()
        setSelectedId(data.id)
        toast({ title: "Reporte creado", description: "Ahora asigna quién puede verlo." })
      } else if (selectedId) {
        const { error } = await supabase
          .from("bi_reportes")
          .update({ nombre: formNombre.trim(), url: formUrl.trim() })
          .eq("id", selectedId)
        if (error) throw new Error(error.message)
        await loadReportes()
        toast({ title: "Reporte actualizado" })
      }
    } catch (err) {
      toast({ title: "Error", description: String(err), variant: "destructive" })
    } finally {
      setSavingForm(false)
    }
  }

  const handleEliminar = async () => {
    if (!selectedId || isNew) return
    setDeleting(true)
    try {
      const { error } = await createClient().from("bi_reportes").delete().eq("id", selectedId)
      if (error) throw new Error(error.message)
      setSelectedId(null)
      await loadReportes()
      toast({ title: "Reporte eliminado" })
    } catch (err) {
      toast({ title: "Error", description: String(err), variant: "destructive" })
    } finally {
      setDeleting(false)
    }
  }

  const togglePermiso = (uid: number) => {
    setAllowedIds((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
    setDirtyPermisos(true)
  }

  const handleGuardarPermisos = async () => {
    if (!selectedId || isNew) return
    setSavingPermisos(true)
    try {
      const supabase = createClient()
      await supabase.from("bi_reporte_permisos").delete().eq("reporte_id", selectedId)
      if (allowedIds.size > 0) {
        await supabase.from("bi_reporte_permisos").insert(
          [...allowedIds].map((uid) => ({ reporte_id: selectedId, user_id: uid }))
        )
      }
      setDirtyPermisos(false)
      toast({ title: "Permisos guardados" })
    } catch {
      toast({ title: "Error", description: "No se pudo guardar.", variant: "destructive" })
    } finally {
      setSavingPermisos(false)
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      {/* Panel selector de reporte */}
      <div className="space-y-1">
        <div className="flex items-center justify-between px-1 mb-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Reportes</p>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setSelectedId("new")} title="Nuevo reporte">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {loadingReportes ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
            {reportes.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={`w-full text-left rounded-lg border px-3 py-2 text-sm truncate transition-all ${
                  selectedId === r.id
                    ? "border-brand bg-brand/10 font-semibold"
                    : "border-transparent hover:border-border hover:bg-muted/50"
                }`}
              >
                {r.nombre}
              </button>
            ))}
            {reportes.length === 0 && <p className="text-xs text-muted-foreground px-1 py-2">Sin reportes aún</p>}
          </div>
        )}
      </div>

      {/* Panel de edición + permisos */}
      <div className="rounded-xl border bg-card p-4 space-y-4">
        {!selectedId ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
            <BarChart2 className="h-8 w-8 opacity-30" />
            <p className="text-sm">Selecciona un reporte o crea uno nuevo<br />para gestionar quién puede verlo</p>
          </div>
        ) : (
          <>
            {/* Nombre + link */}
            <div className="space-y-2">
              <div className="space-y-1">
                <Label className="text-xs">Nombre del reporte</Label>
                <Input value={formNombre} onChange={(e) => setFormNombre(e.target.value)} placeholder="Ej: Recaudos" className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Link de Power BI</Label>
                <Input value={formUrl} onChange={(e) => setFormUrl(e.target.value)} placeholder="https://app.powerbi.com/view?r=..." className="h-8 text-sm" />
              </div>
              <div className="flex items-center justify-between gap-2 pt-1">
                {!isNew ? (
                  <Button variant="outline" size="sm" onClick={handleEliminar} disabled={deleting} className="gap-1.5 h-8 text-xs text-destructive hover:text-destructive">
                    {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Eliminar
                  </Button>
                ) : <span />}
                <Button
                  size="sm"
                  onClick={handleGuardarReporte}
                  disabled={savingForm || !formNombre.trim() || !formUrl.trim() || formUnchanged}
                  className="gap-1.5 h-8 text-xs"
                >
                  {savingForm ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {isNew ? "Crear reporte" : "Guardar cambios"}
                </Button>
              </div>
            </div>

            {/* Permisos de visibilidad */}
            {!isNew && (
              <div className="space-y-2 pt-2 border-t">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold">Quién puede ver este reporte</p>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                    {allowedIds.size} usuario{allowedIds.size !== 1 ? "s" : ""}
                  </span>
                </div>
                {loadingUsers || loadingPermisos ? (
                  <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                ) : (
                  <>
                    <div className="divide-y divide-border rounded-lg border overflow-hidden max-h-[40vh] overflow-y-auto">
                      {usuarios.map((u) => (
                        <div
                          key={u.id}
                          onClick={() => togglePermiso(u.id)}
                          className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors select-none"
                        >
                          <Checkbox checked={allowedIds.has(u.id)} className="h-4 w-4 shrink-0 pointer-events-none" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium leading-tight">{u.nombre}</p>
                            <p className={`text-[10px] mt-0.5 px-1.5 rounded-full inline-block ${ROL_BADGE[u.rol] ?? ""}`}>{ROL_LABELS[u.rol] ?? u.rol}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-end pt-1">
                      <Button size="sm" onClick={handleGuardarPermisos} disabled={savingPermisos || !dirtyPermisos} className="gap-1.5 h-8 text-xs">
                        {savingPermisos ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        Guardar permisos
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function GestionUsuariosRutas() {
  return (
    <div className="space-y-4 md:space-y-6">
      {/* Encabezado */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border overflow-hidden p-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
        </div>
        <div>
          <h2 className="text-base md:text-lg font-bold leading-tight">Gestión de Usuarios y Rutas</h2>
          <p className="text-[11px] text-muted-foreground">Crea y administra usuarios, rutas y sus asignaciones</p>
        </div>
      </div>

      <Tabs defaultValue="usuarios" className="space-y-4">
        <TabsList className="grid w-full grid-cols-7 h-9">
          <TabsTrigger value="usuarios" className="gap-1 text-xs">
            <Users className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Usuarios</span>
          </TabsTrigger>
          <TabsTrigger value="rutas" className="gap-1 text-xs">
            <RouteIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Rutas</span>
          </TabsTrigger>
          <TabsTrigger value="asignaciones" className="gap-1 text-xs">
            <Link2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Asignaciones</span>
          </TabsTrigger>
          <TabsTrigger value="gerentes" className="gap-1 text-xs">
            <Users className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Gerentes</span>
          </TabsTrigger>
          <TabsTrigger value="permisos" className="gap-1 text-xs">
            <Shield className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Permisos</span>
          </TabsTrigger>
          <TabsTrigger value="contactos-chat" className="gap-1 text-xs">
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Chat</span>
          </TabsTrigger>
          <TabsTrigger value="reportes-bi" className="gap-1 text-xs">
            <BarChart2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Power BI</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="usuarios">
          <UsuariosTab />
        </TabsContent>
        <TabsContent value="rutas">
          <RutasTab />
        </TabsContent>
        <TabsContent value="asignaciones">
          <AsignacionesTab />
        </TabsContent>
        <TabsContent value="gerentes">
          <GerentesTab />
        </TabsContent>
        <TabsContent value="permisos">
          <PermisosTab />
        </TabsContent>
        <TabsContent value="contactos-chat">
          <ContactosChatTab />
        </TabsContent>
        <TabsContent value="reportes-bi">
          <ReportesBiTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
