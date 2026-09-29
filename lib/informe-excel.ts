/**
 * El informe de Excel que la empresa venía descargando de otro sistema.
 * ---------------------------------------------------------------------------
 * Se replica la MISMA estructura del archivo de referencia
 * ("ResumenMon Sep 2026 (12-09-2026).xlsx"), leído hoja por hoja:
 *
 *   Pagos      13 columnas · una fila por PAGO
 *   No Pagos   13 columnas · una fila por NO PAGO
 *   Ventas     12 columnas · una fila por venta creada en el rango
 *   Gastos      5 columnas
 *   Ingresos    5 columnas
 *   Retiros     5 columnas (las mismas de Gastos e Ingresos)
 *   Resumen     el encabezado con vendedores, fechas y los totales
 *
 * TODO VA COMO TEXTO, no como número. Es lo que hace el archivo original: la
 * plata viene ya formateada ("1.200,00", "47 000,00") y las fechas como
 * "2026-09-12". Si se escribieran números, Excel los volvería a formatear con
 * la configuración regional de cada máquina y el archivo dejaría de ser
 * idéntico al que la empresa ya sabe leer.
 *
 * LOS NOMBRES DE COLUMNA SE COPIAN LETRA POR LETRA, con sus abreviaturas
 * ("Valor Prod.", "Cuotas Rest.") y sin tildes donde el original no las tiene
 * ("Alimentacion"): quien recibe el archivo lo abre con macros y filtros
 * hechos sobre esos títulos exactos.
 */

import * as XLSX from "xlsx"
import { getSupabaseSafe } from "@/lib/api-helper"
import { montoEfectivo, type Gestion } from "@/lib/gestion-core"

// ── Formato ────────────────────────────────────────────────────────────────

/**
 * La plata como la escribe el sistema viejo: punto para los miles y coma para
 * los decimales. `1200` → "1.200,00".
 */
function money(v: number | null | undefined): string {
  const n = Number(v) || 0
  return n.toLocaleString("es-CO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Un número suelto (cuotas restantes).
 *
 * VA COMO NÚMERO, NO COMO TEXTO. Se comparó celda por celda contra el archivo
 * de referencia: `Restantes` y `Pagadas` son las dos únicas columnas
 * numéricas de las hojas de gestión —la plata sí es texto ya formateado—, y
 * si aquí se manda una cadena Excel la alinea a la izquierda y no la suma.
 */
function num(v: number | null | undefined): number {
  const n = Number(v) || 0
  return Number.isInteger(n) ? n : Math.round(n * 10) / 10
}

/** "2026-09-12" a partir de un timestamp, en hora de Colombia. */
function soloFecha(ts: string | null | undefined): string {
  if (!ts) return ""
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 10)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

/** "12:13:29", en hora de Colombia. */
function soloHora(ts: string | null | undefined): string {
  if (!ts) return ""
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d)
}

const FRECUENCIAS: Record<string, string> = {
  daily: "DIARIO",
  weekly: "SEMANAL",
  biweekly: "QUINCENAL",
  monthly: "MENSUAL",
}

export interface FiltrosInforme {
  desde: string
  hasta: string
  /** Rutas a incluir. Vacío = todas las que el filtro deje pasar. */
  rutaIds: number[]
}

export interface ResultadoInforme {
  blob: Blob
  nombre: string
  /** Para avisar en pantalla cuántas filas salieron de cada hoja. */
  conteos: Record<string, number>
}

/**
 * Arma el libro completo.
 *
 * Se piden todos los datos en paralelo y se cruzan en memoria: son consultas
 * por rango de fechas y ruta, las mismas que ya usan el Resumen y la auditoría.
 * No escribe nada.
 */
export async function generarInformeExcel(
  filtros: FiltrosInforme,
): Promise<ResultadoInforme> {
  const sb = await getSupabaseSafe()
  const { desde, hasta, rutaIds } = filtros

  const desdeUtc = new Date(`${desde}T00:00:00-05:00`).toISOString()
  const hastaDt = new Date(`${hasta}T00:00:00-05:00`)
  hastaDt.setUTCDate(hastaDt.getUTCDate() + 1)
  const hastaUtc = hastaDt.toISOString()

  const enRutas = <T>(q: T): T => {
    // Sin rutas elegidas no se filtra: el `.in()` con lista vacía no devuelve
    // nada, y eso daría un informe en blanco en vez de uno completo.
    if (rutaIds.length === 0) return q
    return (q as { in: (c: string, v: number[]) => T }).in("ruta", rutaIds)
  }

  const [resGes, resMov, resVentas, resRutas, resResumen, resAdmins] = await Promise.all([
    enRutas(
      sb
        .from("gestiones")
        .select("*")
        .gte("fecha_gestion", desde)
        .lte("fecha_gestion", hasta)
        .eq("estado", "aplicada")
        .order("fecha_hora", { ascending: true }),
    ),
    enRutas(
      sb
        .from("gastosregistros")
        .select("*")
        .gte("fechahorasol", desdeUtc)
        .lt("fechahorasol", hastaUtc)
        .order("fechahorasol", { ascending: true }),
    ),
    enRutas(
      sb
        .from("loans")
        .select("*, clients(nombre_completo, apodo)")
        .gte("fecha_creacion", desdeUtc)
        .lt("fecha_creacion", hastaUtc),
    ),
    sb.from("rutas").select("id, nombre, ciudad, pais"),
    enRutas(
      sb
        .from("resumen_diario_v2")
        .select("*")
        .gte("fecha_pago", desde)
        .lte("fecha_pago", hasta),
    ),
    // Los administradores ASIGNADOS a cada ruta (Usuarios y Rutas). No se usa
    // `rutas.idadmin`: está desactualizado —la 190 dice 1 y su administrador
    // es CALEB—, y la asignación es lo que la empresa mantiene al día.
    sb.from("usuario_rutas").select("ruta_id, usuarios!inner(nombre, rol, activo)").eq("usuarios.rol", "admin"),
  ])

  if (resGes.error) throw new Error(resGes.error.message)

  const rutas = new Map(
    ((resRutas.data ?? []) as unknown as {
      id: number
      nombre: string | null
    }[]).map((r) => [r.id, r.nombre ?? String(r.id)]),
  )

  const adminsPorRuta = new Map<number, string[]>()
  for (const a of (resAdmins.data ?? []) as unknown as {
    ruta_id: number
    usuarios: { nombre: string | null; activo: boolean | null } | null
  }[]) {
    const nombre = a.usuarios?.nombre?.trim()
    if (!nombre || a.usuarios?.activo === false) continue
    const lista = adminsPorRuta.get(Number(a.ruta_id)) ?? []
    if (!lista.includes(nombre)) lista.push(nombre)
    adminsPorRuta.set(Number(a.ruta_id), lista)
  }

  /**
   * "UNID 190 - CALEB": el número de la unidad y su administrador, como lo
   * pidió la empresa. El número es el id de la ruta (en esta base el id ES la
   * unidad); el nombre, el administrador asignado (si son varios, "A / B").
   * Sin administrador asignado queda solo "UNID 190": mejor que inventarlo.
   */
  const vendedor = (rutaId: number): string => {
    const admins = adminsPorRuta.get(rutaId)
    return admins?.length ? `UNID ${rutaId} - ${admins.join(" / ")}` : `UNID ${rutaId}`
  }

  // ── Los créditos que aparecen, con su cliente y su ficha ─────────────────
  const gestiones = (resGes.data ?? []) as unknown as Gestion[]
  const loanIds = [...new Set(gestiones.map((g) => g.loan_id).filter(Boolean))]

  const LOTE = 120
  const loans = new Map<string, Record<string, unknown>>()
  const clientesPorLoan = new Map<string, string>()
  /** El nombre completo (de la cédula), aparte del apodo de "Cliente". */
  const nombresPorLoan = new Map<string, string>()
  for (let i = 0; i < loanIds.length; i += LOTE) {
    const { data } = await sb
      .from("loans")
      .select("*, clients(nombre_completo, apodo)")
      .in("id", loanIds.slice(i, i + LOTE))
    for (const l of (data ?? []) as unknown as Record<string, unknown>[]) {
      loans.set(String(l.id), l)
      const c = l.clients as { nombre_completo?: string; apodo?: string } | null
      clientesPorLoan.set(
        String(l.id),
        (c?.apodo?.trim() || c?.nombre_completo?.trim() || "").trim(),
      )
      nombresPorLoan.set(String(l.id), (c?.nombre_completo ?? "").trim())
    }
  }

  // El saldo y las cuotas que faltan, de la misma vista que usa la app.
  const fin = new Map<string, { saldo: number; restantes: number }>()
  for (let i = 0; i < loanIds.length; i += LOTE) {
    const { data } = await sb
      .from("v_loan_financiero")
      .select("loan_id, saldo, cuotas_totales, cuotas_cubiertas")
      .in("loan_id", loanIds.slice(i, i + LOTE))
    for (const f of (data ?? []) as unknown as {
      loan_id: string
      saldo: number | null
      cuotas_totales: number | null
      cuotas_cubiertas: number | null
    }[]) {
      fin.set(f.loan_id, {
        saldo: Number(f.saldo) || 0,
        restantes: Math.max(0, (Number(f.cuotas_totales) || 0) - (Number(f.cuotas_cubiertas) || 0)),
      })
    }
  }

  // ── Pagos y No Pagos ─────────────────────────────────────────────────────
  const CAB_GESTION = [
    // "Cliente" es el apodo, como en el archivo original (o el nombre si no
    // tiene apodo). "Nombre Cliente" es el nombre completo, siempre.
    "Vendedor", "Consecutivo", "Id Venta", "Cliente", "Nombre Cliente", "Observaciones",
    "Pagadas", "Tipo", "Valor", "Fecha", "Hora", "Valor Prod.", "Saldo",
    "Restantes",
  ]

  const filaGestion = (g: Gestion, tipo: string) => {
    const l = loans.get(g.loan_id) ?? {}
    const f = fin.get(g.loan_id)
    const valorCuota = Number(l.valor_cuota) || 0
    const monto = Math.abs(montoEfectivo(g))
    // "Pagadas": cuántas cuotas cubre lo que entregó. El original lo trae con
    // decimales (1.3, 0.8), o sea que NO redondea: es el monto sobre la cuota.
    const pagadas = valorCuota > 0 ? Math.round((monto / valorCuota) * 10) / 10 : 0
    return [
      vendedor(g.ruta),
      ` ${String(l.id ?? g.loan_id).replace(/-/g, "").slice(0, 14)}`,
      ` ${String(g.id).replace(/-/g, "").slice(0, 14)}`,
      clientesPorLoan.get(g.loan_id) ?? "",
      nombresPorLoan.get(g.loan_id) ?? "",
      g.observacion || null,
      tipo === "No Pago" ? 0 : pagadas,
      tipo,
      money(tipo === "No Pago" ? 0 : monto),
      g.fecha_gestion,
      soloHora(g.fecha_hora),
      money(Number(l.valor_a_pagar) || Number(l.valor) || 0),
      money(f?.saldo ?? 0),
      num(f?.restantes ?? 0),
    ]
  }

  const pagos = gestiones
    .filter((g) => g.tipo === "pago" || g.tipo === "cancelacion" || g.tipo === "abono_venta")
    .filter((g) => montoEfectivo(g) > 0)
    .map((g) => {
      const l = loans.get(g.loan_id) ?? {}
      const valorCuota = Number(l.valor_cuota) || 0
      const monto = Math.abs(montoEfectivo(g))
      // "Cuota" cuando pagó exactamente una; "Valor" cuando fue otra cantidad.
      // Es la distinción que hace el archivo original.
      const tipo = valorCuota > 0 && Math.abs(monto - valorCuota) < 0.01 ? "Cuota" : "Valor"
      return filaGestion(g, tipo)
    })

  const noPagos = gestiones
    .filter((g) => g.tipo === "no_pago")
    .map((g) => filaGestion(g, "No Pago"))

  // ── Ventas ───────────────────────────────────────────────────────────────
  const CAB_VENTAS = [
    "Vendedor", "Consecutivo", "Frecuencia", "Id Venta", "Cliente", "Nombre Cliente",
    "Valor Producto", "Cuotas", "Intereses", "Valor Cuota", "Fecha Venta",
    "Cuotas Rest.", "Saldo",
  ]

  const ventas = ((resVentas.data ?? []) as unknown as Record<string, unknown>[]).map((l) => {
    const c = l.clients as { nombre_completo?: string; apodo?: string } | null
    const id = String(l.id).replace(/-/g, "")
    return [
      vendedor(Number(l.ruta)),
      ` ${id.slice(0, 14)}`,
      FRECUENCIAS[String(l.frecuencia_pago ?? "daily")] ?? "DIARIO",
      ` ${id.slice(0, 14)}`,
      (c?.apodo?.trim() || c?.nombre_completo?.trim() || "").trim(),
      (c?.nombre_completo ?? "").trim(),
      money(Number(l.valor) || 0),
      Number(l.numero_cuotas) || 0,
      Number(l.tasa_interes) || 0,
      money(Number(l.valor_cuota) || 0),
      soloFecha(String(l.fecha_creacion ?? "")),
      Number(l.numero_cuotas) || 0,
      money(Number(l.valor_a_pagar) || Number(l.valor) || 0),
    ]
  })

  // LAS RENOVACIONES, en la misma hoja: desde el script 123 son plata que
  // sale de la caja y el resumen las cuenta como venta. Se marcan con
  // "RENOVACION" en la columna de frecuencia para distinguirlas.
  for (const g of gestiones as unknown as (Gestion & { detalle?: Record<string, unknown> | null })[]) {
    const d = g.detalle
    if (g.tipo !== "ajuste" || !d || d.clase !== "renovacion") continue
    const id = String(g.loan_id).replace(/-/g, "")
    const despues = (d.despues ?? {}) as Record<string, unknown>
    const antes = (d.antes ?? {}) as Record<string, unknown>
    ventas.push([
      vendedor(g.ruta),
      ` ${id.slice(0, 14)}`,
      "RENOVACION",
      ` ${String(g.id).replace(/-/g, "").slice(0, 14)}`,
      clientesPorLoan.get(g.loan_id) ?? "",
      nombresPorLoan.get(g.loan_id) ?? "",
      money(Number(d.valor_entregado) || 0),
      Number(d.cuotas_nuevas) || 0,
      Number(d.tasa) || 0,
      money(Number(d.valor_cuota_nueva) || 0),
      g.fecha_gestion,
      Number(d.cuotas_nuevas) || 0,
      money((Number(despues.valor_a_pagar) || 0) - (Number(antes.pagado) || 0)),
    ])
  }

  // ── Gastos e Ingresos ────────────────────────────────────────────────────
  // El original pone " RH" detrás del vendedor en estas dos hojas. Se respeta:
  // es lo que distingue una fila de caja de una de calle en sus filtros.
  const CAB_MOV = ["Vendedor", "Fecha", "Concepto", "Valor", "Observaciones"]

  const movs = (resMov.data ?? []) as unknown as Record<string, unknown>[]
  const filaMov = (m: Record<string, unknown>) => [
    `${vendedor(Number(m.ruta))} RH`,
    soloFecha(String(m.fechahorasol ?? "")),
    String(m.concepto ?? ""),
    money(Number(m.valor) || 0),
    m.observacion || null,
  ]
  // Solo los que la contabilidad cuenta, igual que el Resumen del Día:
  // aprobados por secretaría o que nunca necesitaron aprobación.
  const cuenta = (m: Record<string, unknown>) =>
    m.estadosecre === "aprobado" || m.estadoadmin === "NA"

  const gastos = movs.filter((m) => cuenta(m) && m.tipo === "Gasto").map(filaMov)
  const ingresos = movs.filter((m) => cuenta(m) && m.tipo === "Ingreso").map(filaMov)
  const retiros = movs.filter((m) => cuenta(m) && m.tipo === "Retiro")
  const filasRetiros = retiros.map(filaMov)

  // ── Resumen ──────────────────────────────────────────────────────────────
  const res = (resResumen.data ?? []) as unknown as Record<string, unknown>[]
  const suma = (campo: string) => res.reduce((s, r) => s + (Number(r[campo]) || 0), 0)

  const rutasPresentes = [
    ...new Set([
      ...gestiones.map((g) => g.ruta),
      ...movs.map((m) => Number(m.ruta)),
      ...res.map((r) => Number(r.ruta)),
    ]),
  ].filter((r) => Number.isFinite(r))

  // La caja del primer y del último día del rango, como en el original.
  const porFecha = [...res].sort((a, b) =>
    String(a.fecha_pago).localeCompare(String(b.fecha_pago)),
  )
  const cajaInicial = porFecha.length > 0 ? Number(porFecha[0].caja_anterior) || 0 : 0
  const cajaFinal =
    porFecha.length > 0 ? Number(porFecha[porFecha.length - 1].efectivo) || 0 : 0

  const clientesUnicos = new Set(gestiones.map((g) => g.loan_id)).size

  const resumen: (string | number)[][] = [
    ["RESUMEN RUTA", ""],
    ["VENDEDOR:", rutasPresentes.map((r) => `(${vendedor(r)} RH)`).join(" ")],
    ["FECHA INICIAL:", desde],
    ["FECHA FINAL:", hasta],
    ["TOTAL CLIENTES:", clientesUnicos],
    ["RECAUDO:", money(suma("valor_pago"))],
    ["", ""],
    ["VENTAS:", money(suma("valor_ventas"))],
    ["RETIROS:", money(retiros.reduce((s, m) => s + (Number(m.valor) || 0), 0))],
    ["EGRESOS:", money(suma("valor_gastos"))],
    ["INGRESOS:", money(suma("valor_ingresos"))],
    [`CAJA INICIAL ${desde}:`, money(cajaInicial)],
    [`CAJA FINAL ${hasta}:`, money(cajaFinal)],
    ["", ""],
    ["", ""],
  ]

  // ── El libro ─────────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new()
  const agregar = (nombre: string, cab: string[] | null, filas: unknown[][]) => {
    const datos = cab ? [cab, ...filas] : filas
    const ws = XLSX.utils.aoa_to_sheet(datos)
    XLSX.utils.book_append_sheet(wb, ws, nombre)
  }

  // EL ORDEN DE LAS HOJAS ES EL DEL ORIGINAL. Quien abre el archivo espera
  // Pagos primero y Resumen al final.
  agregar("Pagos", CAB_GESTION, pagos)
  agregar("No Pagos", CAB_GESTION, noPagos)
  agregar("Ventas", CAB_VENTAS, ventas)
  agregar("Gastos", CAB_MOV, gastos)
  agregar("Ingresos", CAB_MOV, ingresos)
  agregar("Retiros", CAB_MOV, filasRetiros)
  agregar("Resumen", null, resumen)

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" })
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })

  // El nombre imita al del sistema viejo: "ResumenMon Sep 2026 (12-09-2026)".
  const d = new Date(`${hasta}T12:00:00-05:00`)
  const dia = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/Bogota" }).format(d)
  const mes = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "America/Bogota" }).format(d)
  const [a, m, di] = hasta.split("-")
  const nombre = `Resumen${dia} ${mes} ${a} (${di}-${m}-${a}).xlsx`

  return {
    blob,
    nombre,
    conteos: {
      Pagos: pagos.length,
      "No Pagos": noPagos.length,
      Ventas: ventas.length,
      Gastos: gastos.length,
      Ingresos: ingresos.length,
      Retiros: filasRetiros.length,
    },
  }
}
