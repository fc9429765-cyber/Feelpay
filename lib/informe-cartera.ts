/**
 * INFORME DE CARTERA — el Excel de la cartera viva, con el MISMO formato del
 * archivo de ejemplo que mandó la empresa ("INFORME CARTERA.xlsx").
 * ---------------------------------------------------------------------------
 * Una hoja ("Sheet1"), 25 columnas, una fila por crédito activo con saldo y
 * una fila TOTAL al final. Los títulos se copian letra por letra, con sus
 * tildes y abreviaturas ("VALOR A PAGAR CON INT", "C.PAGAS", "FREC.").
 *
 * POR QUE SE ARMA EL ARCHIVO A MANO
 * ---------------------------------
 * El ejemplo tiene los títulos en NEGRITA (y "%" y "SALDO" además centrados),
 * los montos con `#,##0.00`, los documentos y teléfonos como número entero y
 * la fila TOTAL con formato de moneda. La versión libre de SheetJS escribe
 * los formatos de número pero NO las negritas. Así que el libro se arma con
 * el `styles.xml` del ejemplo —los mismos 7 estilos, en el mismo orden— y
 * cada celda apunta al estilo que tiene en el original. Para comprimirlo se
 * usa el zip que ya trae SheetJS (`XLSX.CFB`): ninguna dependencia nueva.
 *
 * DE DÓNDE SALE CADA COLUMNA
 *   PAIS                 rutas.pais (rutas.ciudad) en mayúsculas
 *   VENDEDOR             "UNID 190 - CALEB" (ver `cargarNombreVendedor`)
 *   FECHA VENTA          loans.fecha_creacion, día Colombia
 *   CONSECUTIVO          clients.numero (el consecutivo del cliente)
 *   ID. VENTA            el id del crédito, corto (es un UUID: va como texto)
 *   NOMBRE DEL CLIENTE   clients.nombre_completo
 *   APODO                el apodo del crédito (el 1 o el 2, el que eligió)
 *   IDENTIFICACIÓN       clients.documento (número si son solo dígitos)
 *   TELEFONO             clients.telefono sin el indicativo del país
 *   DIRECCION            clients.direccion (la del comercio)
 *   DIRECCIÓN RESIDENCIA clients.direccion_residencia
 *   VALOR NETO PRESTADO  loans.valor
 *   VALOR A PAGAR C/INT  v_loan_financiero.total_a_pagar (incluye renovaciones)
 *   VALOR INTERES        la diferencia de las dos anteriores
 *   %                    loans.tasa_interes
 *   V.CUOTA / CUOTAS     loans.valor_cuota / loans.numero_cuotas
 *   C.PAGAS              lo pagado sobre el valor de la cuota, con decimales
 *                        (el ejemplo trae 9.35: no redondea a cuotas enteras)
 *   C.RESTA              CUOTAS − C.PAGAS, como en el ejemplo
 *   SALDO                v_loan_financiero.saldo (el del libro de eventos)
 *   SANCIÓN              multas pendientes del crédito
 *   MORA                 cuotas en mora (v_loan_financiero.cuotas_mora)
 *   FREC. / DÍA DE PAGO  "Diario" o "SEMANAL" + el día, como en el ejemplo
 *   ULT.PAGO             fecha del último pago
 *
 * Es de SOLO LECTURA.
 */

import * as XLSX from "xlsx"
import { getSupabaseSafe } from "@/lib/api-helper"
import { tsToColombiaDate, todayColombia } from "@/lib/colombia-date"
import { cargarNombreVendedor } from "@/lib/informe-excel"

// ── Lo copiado del ejemplo ─────────────────────────────────────────────────

const TITULOS = [
  "PAIS", "VENDEDOR", "FECHA VENTA", "CONSECUTIVO", "ID. VENTA", "NOMBRE DEL CLIENTE",
  "APODO", "IDENTIFICACIÓN", "TELEFONO", "DIRECCION", "DIRECCIÓN RESIDENCIA",
  "VALOR NETO PRESTADO", "VALOR A PAGAR CON INT", "VALOR INTERES", "%", "V.CUOTA",
  "CUOTAS", "C.PAGAS", "C.RESTA", "SALDO", "SANCIÓN", "MORA", "FREC.", "DÍA DE PAGO",
  "ULT.PAGO",
]

/** Anchos de columna del ejemplo, en caracteres. */
const ANCHOS = [
  31.1796875, 22.08984375, 14.26953125, 16.90625, 16.90625, 52, 52, 18.1796875,
  15.6328125, 52, 28.453125, 21.08984375, 22, 16.90625, 6, 11.7265625, 7.81640625,
  9.08984375, 9.08984375, 16.90625, 9.08984375, 9.08984375, 8.90625, 11.90625, 13,
]

/**
 * Los estilos del ejemplo, en su mismo orden (el índice es el `s=` de cada
 * celda):
 *   0 normal · 1 negrita (títulos) · 2 moneda de la fila TOTAL ·
 *   3 `#,##0.00` · 4 `0` · 5 `0.00` · 6 negrita centrada ("%" y "SALDO")
 */
const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00_-\\ [$$-45C]"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleMedium4"/></styleSheet>`

const S_TITULO = 1
const S_TOTAL = 2
const S_MILES = 3
const S_ENTERO = 4
const S_DECIMAL = 5
const S_TITULO_CENTRO = 6

/** Estilo de cada columna en las filas de datos (A..Y), como en el ejemplo. */
const ESTILO_COLUMNA = [
  0, 0, 0, S_ENTERO, S_ENTERO, 0, 0, S_ENTERO, S_ENTERO, 0, 0,
  S_MILES, S_MILES, S_MILES, S_ENTERO, S_MILES, S_DECIMAL, S_DECIMAL, S_DECIMAL,
  S_MILES, S_DECIMAL, S_DECIMAL, 0, 0, 0,
]

/** "Diario" en minúscula y el resto en mayúscula: así viene el ejemplo. */
const FRECUENCIA: Record<string, string> = {
  daily: "Diario",
  weekly: "SEMANAL",
  biweekly: "QUINCENAL",
  monthly: "MENSUAL",
}

// ── El libro, a mano ───────────────────────────────────────────────────────

type Celda = string | number | null

const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // Caracteres de control que invalidan el XML (llegan pegados desde el teléfono).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")

const letra = (i: number) => String.fromCharCode(65 + i)

function celdaXml(col: number, fila: number, v: Celda, estilo: number): string {
  if (v === null || v === "") return ""
  const ref = `${letra(col)}${fila}`
  const s = estilo ? ` s="${estilo}"` : ""
  if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : ""
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
}

function armarXlsx(filas: Celda[][], total: Celda[]): Uint8Array {
  const n = filas.length + 2
  let data = `<row r="1">${TITULOS.map((t, i) =>
    celdaXml(i, 1, t, t === "%" || t === "SALDO" ? S_TITULO_CENTRO : S_TITULO),
  ).join("")}</row>`
  filas.forEach((f, k) => {
    const r = k + 2
    data += `<row r="${r}">${f.map((v, i) =>
      // Un documento con letras ("m5218652") va como texto, sin formato.
      celdaXml(i, r, v, typeof v === "number" ? ESTILO_COLUMNA[i] : 0),
    ).join("")}</row>`
  })
  data += `<row r="${n}">${total.map((v, i) => celdaXml(i, n, v, typeof v === "number" ? S_TOTAL : 0)).join("")}</row>`

  const cols = ANCHOS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")
  const hoja = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:Y${n}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="14.5"/><cols>${cols}</cols><sheetData>${data}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`

  const archivos: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": ESTILOS,
    "xl/worksheets/sheet1.xml": hoja,
  }

  const zip = XLSX.CFB.utils.cfb_new()
  const enc = new TextEncoder()
  for (const [ruta, txt] of Object.entries(archivos)) {
    XLSX.CFB.utils.cfb_add(zip, ruta, enc.encode(txt) as unknown as Buffer)
  }
  const out = XLSX.CFB.write(zip, { fileType: "zip", type: "array" }) as ArrayBuffer | number[] | Uint8Array
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer)
}

// ── Los datos ──────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100

/** "12.240.990" o "31576264" → número; "m5218652" se queda como texto. */
function documento(d: string | null | undefined): Celda {
  const t = (d ?? "").trim()
  if (!t) return null
  const limpio = t.replace(/[.\s-]/g, "")
  return /^\d{1,15}$/.test(limpio) ? Number(limpio) : t
}

/** "+54 91123035447" → 91123035447. El indicativo no va: el ejemplo no lo trae. */
function telefono(t: string | null | undefined): Celda {
  const s = (t ?? "").trim()
  if (!s) return null
  const sinIndicativo = s.startsWith("+") && s.includes(" ") ? s.slice(s.indexOf(" ") + 1) : s
  const dig = sinIndicativo.replace(/\D/g, "")
  // Hay fichas con el teléfono guardado como SOLO el indicativo ("593"): no
  // es un número que se pueda marcar, y en el informe confunde. Va vacío.
  if (dig.length <= 4) return null
  return dig.length <= 15 ? Number(dig) : sinIndicativo
}

export interface ResultadoCartera {
  blob: Blob
  nombre: string
  creditos: number
}

export async function generarInformeCartera(rutaIds: number[]): Promise<ResultadoCartera> {
  const sb = await getSupabaseSafe()

  const [vendedor, resRutas] = await Promise.all([
    cargarNombreVendedor(sb),
    sb.from("rutas").select("id, ciudad, pais"),
  ])
  const pais = new Map(
    ((resRutas.data ?? []) as { id: number; ciudad: string | null; pais: string | null }[]).map((r) => {
      const p = (r.pais ?? "").trim().toUpperCase()
      const c = (r.ciudad ?? "").trim().toUpperCase()
      return [r.id, p && c ? `${p} (${c})` : p || c]
    }),
  )

  // Los créditos activos, por páginas: PostgREST corta en 1.000 filas.
  const loans: Record<string, unknown>[] = []
  for (let desde = 0; ; desde += 1000) {
    let q = sb
      .from("loans")
      .select(
        "id, ruta, fecha_creacion, valor, valor_a_pagar, valor_cuota, numero_cuotas, tasa_interes, " +
          "frecuencia_pago, dia_semana, apodo_elegido, ordenvisita, " +
          "clients(numero, nombre_completo, apodo, apodo_2, documento, telefono, direccion, direccion_residencia)",
      )
      .eq("estado", "activo")
      .order("ruta")
      .order("fecha_creacion")
      .range(desde, desde + 999)
    if (rutaIds.length > 0) q = q.in("ruta", rutaIds)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    loans.push(...((data ?? []) as unknown as Record<string, unknown>[]))
    if (!data || data.length < 1000) break
  }

  // El saldo, lo pagado y la mora, de la misma vista que usa toda la app.
  const ids = loans.map((l) => String(l.id))
  const fin = new Map<string, Record<string, unknown>>()
  const multas = new Map<string, number>()
  const LOTE = 150
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE)
    const [rf, rm] = await Promise.all([
      sb
        .from("v_loan_financiero")
        .select("loan_id, total_a_pagar, total_pagado, saldo, cuotas_mora, fecha_ultimo_pago")
        .in("loan_id", lote),
      sb.from("multas").select("loan_id, valor").eq("estado", "pendiente").in("loan_id", lote),
    ])
    if (rf.error) throw new Error(rf.error.message)
    for (const f of (rf.data ?? []) as Record<string, unknown>[]) fin.set(String(f.loan_id), f)
    for (const m of (rm.data ?? []) as { loan_id: string; valor: number }[]) {
      multas.set(m.loan_id, (multas.get(m.loan_id) ?? 0) + (Number(m.valor) || 0))
    }
  }

  const filas: Celda[][] = []
  let totNeto = 0
  let totPagar = 0
  let totInteres = 0
  let totSaldo = 0

  for (const l of loans) {
    const f = fin.get(String(l.id))
    const saldo = Number(f?.saldo) || 0
    // Cartera = lo que todavía se debe. Un activo con saldo 0 ya no es cartera.
    if (saldo <= 0) continue
    const c = (l.clients ?? {}) as Record<string, string | number | null>
    const neto = Number(l.valor) || 0
    const aPagar = Number(f?.total_a_pagar) || Number(l.valor_a_pagar) || neto
    const cuota = Number(l.valor_cuota) || 0
    const cuotas = Number(l.numero_cuotas) || 0
    const pagado = Number(f?.total_pagado) || 0
    const pagas = cuota > 0 ? r2(pagado / cuota) : 0
    const frec = String(l.frecuencia_pago ?? "daily")
    const apodo = (Number(l.apodo_elegido) === 2 ? c.apodo_2 : c.apodo) ?? c.apodo

    filas.push([
      pais.get(Number(l.ruta)) || null,
      vendedor(Number(l.ruta)),
      l.fecha_creacion ? tsToColombiaDate(String(l.fecha_creacion)) : null,
      c.numero != null && c.numero !== "" ? Number(c.numero) : null,
      String(l.id).replace(/-/g, "").slice(0, 13),
      String(c.nombre_completo ?? "").trim() || null,
      String(apodo ?? "").trim() || null,
      documento(c.documento as string | null),
      telefono(c.telefono as string | null),
      String(c.direccion ?? "").trim() || null,
      String(c.direccion_residencia ?? "").trim() || null,
      neto,
      aPagar,
      r2(aPagar - neto),
      Number(l.tasa_interes) || 0,
      cuota,
      cuotas,
      pagas,
      r2(Math.max(0, cuotas - pagas)),
      saldo,
      multas.get(String(l.id)) ?? 0,
      Number(f?.cuotas_mora) || 0,
      FRECUENCIA[frec] ?? frec.toUpperCase(),
      frec === "daily" ? null : String(l.dia_semana ?? "").trim().toUpperCase() || null,
      f?.fecha_ultimo_pago ? String(f.fecha_ultimo_pago).slice(0, 10) : null,
    ])
    totNeto += neto
    totPagar += aPagar
    totInteres += aPagar - neto
    totSaldo += saldo
  }

  const total: Celda[] = Array(25).fill(null)
  total[0] = "TOTAL"
  total[11] = r2(totNeto)
  total[12] = r2(totPagar)
  total[13] = r2(totInteres)
  total[19] = r2(totSaldo)

  const bytes = armarXlsx(filas, total)
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
  return { blob, nombre: `INFORME CARTERA ${todayColombia()}.xlsx`, creditos: filas.length }
}
