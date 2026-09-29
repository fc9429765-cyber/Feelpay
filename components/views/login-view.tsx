"use client"

import { useState } from "react"
import { entrarSinSenal, esErrorDeRed, guardarCredencialOffline, sinSenal } from "@/lib/credenciales-offline"
import { Lock, User, Loader2, Eye, EyeOff, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClient } from "@/lib/supabase/client"

export type AuthenticatedUser = {
  id: number | string
  nombre: string
  rol: string
  usuario?: string
  foto_url?: string | null
}

interface LoginViewProps {
  onLoginSuccess: (user: AuthenticatedUser) => void
  /**
   * Por qué se está pidiendo la contraseña otra vez. Hoy solo lo usa el cierre
   * diario de sesión (`lib/sesion-diaria.ts`): sin este aviso, que la app te
   * devuelva al login sin decir nada se lee como una falla, y lo primero que
   * hace la gente es reportarlo o intentar entrar tres veces creyendo que se
   * equivocó de clave.
   */
  aviso?: string | null
}

export function LoginView({ onLoginSuccess, aviso }: LoginViewProps) {
  const [usuario, setUsuario] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const u = usuario.trim()
    if (!u || !password) {
      setError("Ingresa tu usuario y contrasena")
      return
    }

    // SIN SEÑAL: se entra con la huella guardada en la última entrada con
    // señal (lib/credenciales-offline.ts). La clave nunca se guarda.
    const entrarOffline = async () => {
      const r = await entrarSinSenal(u, password)
      if ("user" in r) {
        onLoginSuccess(r.user)
      } else {
        setError(r.motivo)
      }
    }

    try {
      setLoading(true)
      if (sinSenal()) {
        await entrarOffline()
        return
      }
      const supabase = createClient()
      const { data, error: rpcError } = await supabase.rpc("login_usuario", {
        p_usuario: u,
        p_password: password,
      })

      if (rpcError && esErrorDeRed(rpcError)) {
        console.warn("[v0] login_usuario sin red, se intenta la entrada sin señal")
        await entrarOffline()
        return
      }
      if (rpcError) {
        console.error("[v0] login_usuario error:", rpcError.message)
        setError("Usuario o contrasena incorrectos")
        return
      }

      // The RPC may return either a single object or an array — normalize.
      const raw = Array.isArray(data) ? data[0] : data

      if (!raw || (raw && typeof raw === "object" && "error" in raw && raw.error)) {
        setError("Usuario o contrasena incorrectos")
        return
      }

      // Try common shapes returned by login_usuario: { id, nombre, rol } or { user_id, nombre_completo, rol }
      const user: AuthenticatedUser = {
        id: raw.id ?? raw.user_id ?? raw.usuario_id ?? raw.idusuario ?? "",
        nombre: raw.nombre ?? raw.nombre_completo ?? raw.nombre_usuario ?? raw.username ?? u,
        rol: String(raw.rol ?? raw.role ?? raw.perfil ?? "vendedor").toLowerCase(),
        usuario: raw.usuario ?? raw.username ?? u,
      }

      if (!user.id) {
        setError("La respuesta del servidor es invalida")
        return
      }

      // Para la próxima vez que no haya señal.
      await guardarCredencialOffline(u, password, user)
      onLoginSuccess(user)
    } catch (err) {
      if (esErrorDeRed(err)) {
        await entrarOffline()
        return
      }
      console.error("[v0] Login unexpected error:", err)
      setError("No se pudo iniciar sesion. Intenta de nuevo.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Decorative brand gradient backdrop — sin sombras, solo color */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -right-32 h-[420px] w-[420px] rounded-full bg-brand-gradient opacity-20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -left-32 h-[480px] w-[480px] rounded-full bg-brand-gradient opacity-15 blur-3xl"
      />

      <div className="relative w-full max-w-md">
        {/* Brand mark — logo OPAD */}
        <div className="mb-8 flex flex-col items-center gap-4">
          <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-card ring-1 ring-border overflow-hidden p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/opad-logo.png"
              alt="OPAD APP"
              className="h-full w-full object-contain"
            />
          </div>
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="font-sans text-3xl font-extrabold tracking-tight text-foreground">
              OPAD <span className="text-brand-light">APP</span>
            </h1>
            <p className="text-sm text-muted-foreground">Inicia sesion para acceder al sistema</p>
          </div>
        </div>

        {/* Card · sin sombras */}
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-6 md:p-8"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="usuario" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Usuario
            </Label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="usuario"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
                disabled={loading}
                placeholder="Tu usuario"
                className="h-11 pl-9"
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Contrasena
            </Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                placeholder="Tu contrasena"
                className="h-11 pl-9 pr-10"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={showPassword ? "Ocultar contrasena" : "Mostrar contrasena"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Por qué se cerró la sesión. En azul y no en rojo: no es un
              error de la persona, es la regla del día. Se apaga en cuanto
              escribe algo, para no dejar un aviso viejo junto a uno nuevo. */}
          {aviso && !error && (
            <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm text-info">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="leading-tight">{aviso}</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="leading-tight">{error}</p>
            </div>
          )}

          <Button
            type="submit"
            className="h-11 w-full gap-2 bg-brand-gradient text-brand-foreground text-sm font-semibold transition-opacity hover:opacity-90 border-0"
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Iniciando sesion...
              </>
            ) : (
              <>
                <Lock className="h-4 w-4" />
                Iniciar sesion
              </>
            )}
          </Button>
        </form>

        {/* Footer hint */}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Si no recuerdas tu usuario o contrasena, contacta al administrador.
        </p>
      </div>
    </main>
  )
}
