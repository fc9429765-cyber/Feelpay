-- ============================================================================
-- 127 - La meta de un credito semanal es la de SU dia, no la de todos
-- ============================================================================
-- LO QUE SE REPORTO
-- "La ruta 196 le aparece un debido cobrar de 3 millones pero en realidad es
--  de 1.300.000." Y la regla que se pidio: "solo lo que se debe pagar en ese
--  dia, no lo de todas sus ventas".
--
-- LA CUENTA, MEDIDA (ruta 196, miercoles 30/09)
--   La 196 es 100% SEMANAL: sus 24 creditos pagan lunes o martes. El
--   miercoles el cronograma no tiene NINGUNA cuota, y aun asi la meta daba
--   $2.948.267 — todo de `meta_atrasados`.
--
-- LA CAUSA: la regla del script 112 ("el atrasado tambien es debido cobrar
-- hoy"). Un credito sin cuota hoy pero con cuotas vencidas aporta UNA cuota
-- a la meta de hoy. Se penso para rutas DIARIAS —al cliente atrasado de la
-- 151 se lo visita todos los dias—, pero se aplicaba a cualquier frecuencia:
-- en la 196 metia el miercoles a 16 clientes semanales morosos, algunos con
-- atrasos desde el 7 y el 15 de septiembre, cada uno con su cuota semanal
-- completa.
--
-- EL ARREGLO: la regla del 112 queda SOLO para creditos diarios (y los de
-- empleado, que se cobran como diarios). Un credito semanal, quincenal o
-- mensual cuenta en la meta unicamente el dia que su cronograma lo dice.
--
-- Con esto, la 196 hoy (sin cuotas programadas) tiene meta 0; el lunes 28
-- sigue en $3.211.700, que es lo que el cronograma programaba ese dia.
--
-- QUE NO CAMBIA
--   * La vista es la del 123 TAL CUAL, con esa unica condicion agregada.
--   * El agregado del 112 solo existe para HOY, asi que los dias pasados
--     conservan exactamente su meta: ningun cierre firmado cambia.
--   * Las rutas solo diarias (151, 202, 204, 205...) no cambian nada.
--   * No se toca ni una fila: ni `payment_plan` ni `gestiones`.
--
-- CREATE OR REPLACE y no DROP: mismas columnas en el mismo orden, la vista
-- `vista_monitoreo_recaudos` que cuelga de esta no se toca.
--
-- Corre los pasos EN ORDEN. Los pasos 1, 4 y 5 no escriben nada.
-- ============================================================================


-- ── PASO 1) La foto de ANTES (SOLO LECTURA) ─────────────────────────────
-- Guarde estos numeros: el PASO 4 los compara. Hoy la 196 debe bajar a 0 de
-- atrasados; las rutas solo diarias tienen que quedar IGUAL.
SELECT ruta, fecha_pago, meta_pagos, meta_atrasados
  FROM public.resumen_diario_v2
 WHERE fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY ruta;


-- ── PASO 2) La vista, con la regla del 112 solo para diarios ────────────
CREATE OR REPLACE VIEW public.resumen_diario_v2 AS
WITH cierres AS (
  SELECT g.loan_id,
         MAX(g.fecha_gestion) AS fecha_cierre
    FROM public.gestiones g
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','cancelacion','abono_venta','reversa')
   GROUP BY g.loan_id
),
saldados AS (
  SELECT c.loan_id, c.fecha_cierre
    FROM cierres c
    JOIN public.v_loan_financiero f ON f.loan_id = c.loan_id
   WHERE COALESCE(f.saldo, 0) <= 0
),
canceladas AS (
  SELECT g.fecha_gestion AS fecha, g.ruta,
         COUNT(DISTINCT g.loan_id) AS cantidad_canceladas,
         COALESCE(SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                           WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END), 0) AS valor_canceladas
    FROM public.gestiones g
    JOIN saldados s ON s.loan_id = g.loan_id
                   AND s.fecha_cierre = g.fecha_gestion
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','cancelacion','abono_venta','reversa')
   GROUP BY g.fecha_gestion, g.ruta
),
por_cliente AS (
  SELECT g.fecha_gestion AS fecha, g.ruta, g.loan_id,
         SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                  WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END)        AS neto,
         bool_or(g.tipo = 'no_pago')                                       AS hubo_no_pago,
         SUM(CASE WHEN l.tipo_amortizacion = 'aleman' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS capital,
         SUM(CASE WHEN l.tipo_amortizacion = 'americano' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS intereses,
         SUM(CASE
               WHEN lower(COALESCE(NULLIF(g.metodo_pago,''), ref.metodo_pago, 'efectivo')) = 'transferencia' THEN 0
               WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
               WHEN g.tipo = 'reversa' THEN -g.monto
               ELSE 0 END)                                                 AS efectivo,
         SUM(CASE
               WHEN lower(COALESCE(NULLIF(g.metodo_pago,''), ref.metodo_pago, 'efectivo')) <> 'transferencia' THEN 0
               WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
               WHEN g.tipo = 'reversa' THEN -g.monto
               ELSE 0 END)                                                 AS transferencia,
         SUM(CASE WHEN g.origen = 'campo' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS neto_campo,
         MAX(g.fecha_hora)                                                 AS ultimo_movimiento
    FROM public.gestiones g
    LEFT JOIN public.loans l       ON l.id   = g.loan_id
    LEFT JOIN public.gestiones ref ON ref.id = g.referencia_gestion_id
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta','reversa')
   GROUP BY g.fecha_gestion, g.ruta, g.loan_id
),
pagos AS (
  SELECT fecha, ruta,
         SUM(neto)                                                    AS valor_pago,
         COUNT(*) FILTER (WHERE neto > 0)                             AS cantidad_pagos,
         COUNT(*) FILTER (WHERE neto <= 0 AND hubo_no_pago)           AS cantidad_no_pagos,
         SUM(capital)                                                 AS pago_capital,
         SUM(intereses)                                               AS pago_intereses,
         SUM(efectivo)                                                AS pago_efectivo,
         SUM(transferencia)                                           AS pago_transferencia,
         SUM(neto_campo)                                              AS valor_pago_campo,
         SUM(neto) - SUM(neto_campo)                                  AS valor_pago_ajuste,
         COUNT(*) FILTER (WHERE neto_campo > 0)                       AS cantidad_pagos_campo,
         (MAX(ultimo_movimiento) AT TIME ZONE 'America/Bogota')::time AS hora_ultimo_movimiento
    FROM por_cliente
   GROUP BY fecha, ruta
),
meta_plan AS (
  -- Arreglo del script 114: lo anulado no suma nunca; lo cancelado deja de
  -- sumar el dia despues de cancelarse.
  SELECT pp.fecha_pago AS fecha, pp.ruta,
         SUM(pp.valor_cuota) AS meta_pagos
    FROM public.payment_plan pp
    JOIN public.loans l ON l.id = pp.loan_id
    LEFT JOIN LATERAL (
      SELECT MAX(g.fecha_gestion) AS dia_cierre
        FROM public.gestiones g
       WHERE g.loan_id = pp.loan_id
         AND g.estado = 'aplicada'
    ) fin ON true
   WHERE l.estado NOT IN ('cancelado', 'anulado')
      OR (l.estado = 'cancelado' AND pp.fecha_pago <= fin.dia_cierre)
   GROUP BY pp.fecha_pago, pp.ruta
),
atrasados AS (
  SELECT (now() AT TIME ZONE 'America/Bogota')::date AS fecha,
         l.ruta,
         SUM(LEAST(ref.cuota_ref, f.saldo)) AS meta_atrasados
    FROM public.loans l
    JOIN public.v_loan_financiero f ON f.loan_id = l.id
    JOIN LATERAL (
      SELECT COALESCE(
               MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra),
               MAX(pp.valor_cuota)
             ) AS cuota_ref
        FROM public.payment_plan pp
       WHERE pp.loan_id = l.id
    ) ref ON ref.cuota_ref > 0
   WHERE l.estado = 'activo'
     -- Script 127: solo los DIARIOS. Un semanal se cobra el dia de su cuota;
     -- sumarlo cada dia que no la tiene inflaba la meta (ruta 196).
     AND (COALESCE(l.frecuencia_pago, 'daily') = 'daily'
          OR COALESCE(l.prestamo_empleado, false))
     AND COALESCE(f.saldo, 0) > 0
     AND NOT EXISTS (
       SELECT 1 FROM public.payment_plan pp
        WHERE pp.loan_id = l.id
          AND pp.fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date)
     AND EXISTS (
       SELECT 1 FROM public.payment_plan pp
        WHERE pp.loan_id = l.id
          AND pp.fecha_pago < (now() AT TIME ZONE 'America/Bogota')::date
          AND pp.estado IN ('pendiente','parcial','no_pago'))
   GROUP BY l.ruta
),
meta AS (
  SELECT COALESCE(p.fecha, a.fecha) AS fecha,
         COALESCE(p.ruta,  a.ruta)  AS ruta,
         COALESCE(p.meta_pagos, 0) + COALESCE(a.meta_atrasados, 0) AS meta_pagos,
         COALESCE(a.meta_atrasados, 0)                             AS meta_atrasados
    FROM meta_plan p
    FULL JOIN atrasados a ON a.fecha = p.fecha AND a.ruta = p.ruta
),
gastos AS (
  SELECT (g.fechahorasol AT TIME ZONE 'America/Bogota')::date AS fecha, g.ruta,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Ingreso'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_ingresos,
         COUNT(*) FILTER (WHERE g.tipo = 'Ingreso'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_ingresos,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Gasto'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_gastos,
         COUNT(*) FILTER (WHERE g.tipo = 'Gasto'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_gastos,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Retiro'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_retiros,
         COUNT(*) FILTER (WHERE g.tipo = 'Retiro'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_retiros
    FROM public.gastosregistros g
   GROUP BY (g.fechahorasol AT TIME ZONE 'America/Bogota')::date, g.ruta
),
fuente_ventas AS (
  -- ── LO UNICO NUEVO ─────────────────────────────────────────────────────
  -- Las ventas del dia: los prestamos creados ese dia (como siempre) MAS las
  -- renovaciones, que son plata nueva entregada sobre un credito vivo. Las dos
  -- salen de la caja y las dos cuentan como venta.
  SELECT (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS fecha,
         l.ruta, l.valor, COALESCE(l.origen, 'normal') AS origen
    FROM public.loans l
  UNION ALL
  SELECT g.fecha_gestion, g.ruta,
         COALESCE(NULLIF(g.detalle->>'valor_entregado','')::numeric, 0),
         'renovacion'
    FROM public.gestiones g
   WHERE g.tipo = 'ajuste'
     AND g.estado = 'aplicada'
     AND g.detalle->>'clase' = 'renovacion'
),
ventas AS (
  SELECT v.fecha, v.ruta,
         COUNT(*)                                                          AS cantidad_ventas,
         COALESCE(SUM(v.valor), 0)                                         AS valor_ventas,
         COUNT(*) FILTER (WHERE v.origen = 'homologado')                   AS cantidad_ventas_homologadas,
         COALESCE(SUM(v.valor) FILTER (WHERE v.origen = 'homologado'), 0)  AS valor_ventas_homologadas,
         COALESCE(SUM(v.valor) FILTER (WHERE v.origen <> 'homologado'), 0) AS valor_ventas_caja
    FROM fuente_ventas v
   GROUP BY v.fecha, v.ruta
),
base AS (
  SELECT COALESCE(p.fecha, m.fecha, g.fecha, v.fecha) AS fecha_pago,
         COALESCE(p.ruta,  m.ruta,  g.ruta,  v.ruta)  AS ruta,
         COALESCE(m.meta_pagos, 0)          AS meta_pagos,
         COALESCE(m.meta_atrasados, 0)      AS meta_atrasados,
         COALESCE(p.valor_pago, 0)          AS valor_pago,
         COALESCE(p.cantidad_pagos, 0)      AS cantidad_pagos,
         COALESCE(p.cantidad_no_pagos, 0)   AS cantidad_no_pagos,
         COALESCE(c.cantidad_canceladas, 0) AS cantidad_canceladas,
         COALESCE(c.valor_canceladas, 0)    AS valor_canceladas,
         COALESCE(p.pago_capital, 0)        AS pago_capital,
         COALESCE(p.pago_intereses, 0)      AS pago_intereses,
         COALESCE(p.pago_efectivo, 0)       AS pago_efectivo,
         COALESCE(p.pago_transferencia, 0)  AS pago_transferencia,
         COALESCE(p.valor_pago_campo, 0)     AS valor_pago_campo,
         COALESCE(p.valor_pago_ajuste, 0)    AS valor_pago_ajuste,
         COALESCE(p.cantidad_pagos_campo, 0) AS cantidad_pagos_campo,
         p.hora_ultimo_movimiento,
         COALESCE(g.valor_ingresos, 0)      AS valor_ingresos,
         COALESCE(g.cantidad_ingresos, 0)   AS cantidad_ingresos,
         COALESCE(g.valor_gastos, 0)        AS valor_gastos,
         COALESCE(g.cantidad_gastos, 0)     AS cantidad_gastos,
         COALESCE(g.valor_retiros, 0)       AS valor_retiros,
         COALESCE(g.cantidad_retiros, 0)    AS cantidad_retiros,
         COALESCE(v.cantidad_ventas, 0)     AS cantidad_ventas,
         COALESCE(v.valor_ventas, 0)        AS valor_ventas,
         COALESCE(v.cantidad_ventas_homologadas, 0) AS cantidad_ventas_homologadas,
         COALESCE(v.valor_ventas_homologadas, 0)    AS valor_ventas_homologadas,
         COALESCE(v.valor_ventas_caja, 0)           AS valor_ventas_caja
    FROM pagos p
    FULL JOIN meta   m ON m.fecha = p.fecha AND m.ruta = p.ruta
    FULL JOIN gastos g ON g.fecha = COALESCE(p.fecha, m.fecha)
                      AND g.ruta  = COALESCE(p.ruta,  m.ruta)
    FULL JOIN ventas v ON v.fecha = COALESCE(p.fecha, m.fecha, g.fecha)
                      AND v.ruta  = COALESCE(p.ruta,  m.ruta,  g.ruta)
    LEFT JOIN canceladas c ON c.fecha = COALESCE(p.fecha, m.fecha, g.fecha, v.fecha)
                          AND c.ruta  = COALESCE(p.ruta,  m.ruta,  g.ruta,  v.ruta)
)
SELECT b.*,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)   AS efectivo,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)
       - (b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
          - b.valor_gastos - b.valor_retiros)               AS caja_anterior,
       b.cantidad_ingresos AS recuento_ingresos,
       b.cantidad_gastos   AS recuento_gastos,
       b.cantidad_retiros  AS recuento_retiros
  FROM base b
 ORDER BY b.fecha_pago DESC, b.ruta;


-- ── PASO 3) Permisos de la vista ────────────────────────────────────────
GRANT SELECT ON public.resumen_diario_v2 TO anon, authenticated;


-- ── PASO 4) La foto de DESPUES (SOLO LECTURA) ───────────────────────────
-- Compare con el PASO 1. La 196 queda en la meta de su cronograma de hoy.
SELECT ruta, fecha_pago, meta_pagos, meta_atrasados
  FROM public.resumen_diario_v2
 WHERE fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY ruta;


-- ── PASO 5) Los dias pasados no cambiaron (SOLO LECTURA) ────────────────
-- La meta de los ultimos 7 dias (sin hoy) contra la suma directa del
-- cronograma con la misma regla del 114. `diferencias` tiene que dar 0.
SELECT COUNT(*) AS diferencias
  FROM public.resumen_diario_v2 r
  JOIN (
    SELECT pp.fecha_pago, pp.ruta, SUM(pp.valor_cuota) AS meta
      FROM public.payment_plan pp
      JOIN public.loans l ON l.id = pp.loan_id
      LEFT JOIN LATERAL (
        SELECT MAX(g.fecha_gestion) AS dia_cierre
          FROM public.gestiones g
         WHERE g.loan_id = pp.loan_id AND g.estado = 'aplicada'
      ) fin ON true
     WHERE l.estado NOT IN ('cancelado', 'anulado')
        OR (l.estado = 'cancelado' AND pp.fecha_pago <= fin.dia_cierre)
     GROUP BY pp.fecha_pago, pp.ruta
  ) d ON d.fecha_pago = r.fecha_pago AND d.ruta = r.ruta
 WHERE r.fecha_pago >= (now() AT TIME ZONE 'America/Bogota')::date - 7
   AND r.fecha_pago <  (now() AT TIME ZONE 'America/Bogota')::date
   AND round(r.meta_pagos, 2) <> round(d.meta, 2);
