-- ============================================================================
-- 123 - Renovar el credito desde el modulo de pagos
-- ============================================================================
-- LO QUE SE PIDIO
-- "En el modulo de pagos vamos a agregar un check de 'Renovar' para que
--  automaticamente haga un refinanciamiento del prestamo, y cuando se de el
--  pago en el comprobante diga tambien 'Cliente renovado' por X valor. Eso le
--  mantiene las cuotas y solo extiende las cuotas; el vendedor le pone los
--  dias y el valor a renovar antes de cobrar."
--
-- Y las reglas, confirmadas por el dueño:
--   * El valor a renovar es PLATA NUEVA que el cliente recibe hoy: sale de la
--     caja, como una venta, y se suma a lo que ya debe.
--   * Lleva la TASA DEL PRESTAMO.
--   * Las cuotas se RECALCULAN: el saldo nuevo se reparte entre las cuotas
--     que le quedaban mas los dias nuevos.
--   * Se hace en el mismo formulario del pago, antes de cobrar, y no se
--     combina con "Cancelada".
--
-- COMO QUEDA EL CREDITO (mismo prestamo, no uno nuevo)
--
--   total nuevo   = total a pagar de antes + valor × (1 + tasa)
--   se CONSERVAN  las cuotas que la plata ya pagada cubre ENTERAS, en orden
--   se REHACEN    las demas —las vencidas sin pagar y las que venian— mas los
--                 dias nuevos, en cuotas iguales desde mañana, con la
--                 frecuencia del credito
--
--   Ejemplo: debia 10 cuotas de 26.000 (260.000) y pago 4 → saldo 156.000.
--   Renueva 200.000 al 20% por 20 dias → +240.000. Saldo nuevo 396.000 en
--   6 + 20 = 26 cuotas de ~15.230.
--
--   La plata que ya entro NO se toca: el saldo sigue saliendo del libro. Si
--   la ultima cuota conservada estaba a medias, lo que sobra pasa a la
--   primera cuota nueva por la cascada de siempre.
--
-- LO QUE QUEDA ESCRITO
--   * Un evento `ajuste` en el libro, con monto 0 y el detalle de la
--     renovacion (`detalle.clase = 'renovacion'`): cuanto se entrego, a que
--     tasa, cuantas cuotas, y el antes y el despues del credito. Es la
--     constancia —el libro no se edita— y es lo que el resumen lee.
--   * El cronograma: se borran las cuotas no cubiertas y se crean las nuevas.
--     Un cobro que apuntaba a una cuota borrada pierde el puntero y su plata
--     vuelve a la cascada (el trigger lo permite desde el script 081).
--   * `loans`: valor (capital) + lo entregado, total a pagar, numero de
--     cuotas y valor de la cuota.
--
-- LA CAJA: LA RENOVACION ES UNA VENTA
-- El resumen del dia suma la plata entregada en VENTAS (cantidad y valor) y
-- la descuenta del efectivo, exactamente como una venta nueva. Para eso se
-- reescribe `resumen_diario_v2` (PASO 4) con UN solo cambio: la fuente de
-- las ventas junta los prestamos creados ese dia y las renovaciones.
--
-- QUE NO SE HACE
--   * Creditos AMERICANOS: no se renuevan por aca (tienen su prorroga).
--   * Un credito que no esta activo (cancelado, anulado): no se renueva.
--   * Si la ruta tiene umbral de RENOVACION y el valor lo supera, un
--     vendedor no puede renovar: lo hace secretaria o admin. Es el mismo
--     control que ya tienen las ventas de renovacion.
--
-- Corre los pasos EN ORDEN. Los pasos 1, 6 y 7 no escriben nada.
-- Requiere los scripts 081 (el trigger que deja mover el puntero de cuota)
-- y 114 (la meta que ignora lo anulado): el PASO 1 lo comprueba.
-- ============================================================================


-- ── PASO 1) Lo que tiene que estar antes (SOLO LECTURA) ──────────────────
-- Las tres tienen que dar true. Si alguna da false, NO sigas: falta correr
-- el script que dice.
SELECT
  position('cuota_objetivo' IN pg_get_functiondef('public.gestiones_inmutables'::regproc)) > 0
                                                          AS script_081_corrido,
  pg_get_viewdef('public.resumen_diario_v2'::regclass, true) ~ '''anulado'''
                                                          AS script_114_corrido,
  to_regprocedure('public.recalcular_prestamo(uuid)') IS NOT NULL
                                                          AS recalcular_existe;


-- ── PASO 2) La funcion que renueva ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.renovar_prestamo(
  p_user_id bigint,
  p_ruta_id bigint,
  p_rol     text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id          uuid;
  v_loan_id     uuid;
  v_valor       numeric;
  v_dias        int;
  v_priv        boolean;
  v_loan        record;
  v_hoy         date;
  v_fecha       date;
  v_fh          timestamptz;
  v_tasa        numeric;
  v_empleado    boolean;
  v_agregado    numeric;
  v_total_antes numeric;
  v_total_nuevo numeric;
  v_pagado      numeric;
  v_acum        numeric := 0;
  v_conservadas int := 0;
  v_base_consv  int := 0;
  v_suma_consv  numeric := 0;
  v_ultimo_num  int := 0;
  v_ultima_fec  date;
  v_borrar      uuid[] := ARRAY[]::uuid[];
  v_reprog      int;
  v_n_nuevas    int;
  v_restante    numeric;
  v_freq        text;
  v_paso        int;
  v_inicio      date;
  v_suma_gen    numeric;
  v_ratio_int   numeric;
  v_cuota_nueva numeric;
  v_umbral      record;
  v_cuota       record;
  v_recalc      jsonb;
  v_resultado   jsonb;
BEGIN
  -- La llave de la operacion es el id del evento en el libro: un reenvio de
  -- la cola no puede renovar dos veces.
  v_id := COALESCE(NULLIF(p_payload->>'idempotency_key','')::uuid,
                   NULLIF(p_payload->>'id','')::uuid);
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Falta la llave de la renovacion';
  END IF;
  IF EXISTS (SELECT 1 FROM gestiones WHERE id = v_id) THEN
    RETURN jsonb_build_object('ok', true, 'duplicado', true, 'renovacion_id', v_id);
  END IF;

  v_loan_id := NULLIF(p_payload->>'loan_id','')::uuid;
  v_valor   := NULLIF(p_payload->>'valor','')::numeric;
  v_dias    := NULLIF(p_payload->>'dias','')::int;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'Falta el credito a renovar';
  END IF;
  IF v_valor IS NULL OR v_valor <= 0 THEN
    RAISE EXCEPTION 'El valor a renovar tiene que ser mayor que cero';
  END IF;
  IF v_dias IS NULL OR v_dias < 1 THEN
    RAISE EXCEPTION 'Los dias de la renovacion tienen que ser al menos 1';
  END IF;

  v_priv := lower(COALESCE(p_rol,'')) IN ('secretaria','secretario','admin','administrador');
  v_hoy  := (now() AT TIME ZONE 'America/Bogota')::date;
  v_fecha := COALESCE(NULLIF(p_payload->>'fecha_gestion','')::date, v_hoy);
  v_fh    := COALESCE(NULLIF(p_payload->>'fecha_hora','')::timestamptz, now());

  SELECT * INTO v_loan FROM loans WHERE id = v_loan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El credito no existe';
  END IF;
  IF v_loan.estado IS DISTINCT FROM 'activo' THEN
    RAISE EXCEPTION 'Solo se renueva un credito activo (este esta %)', v_loan.estado;
  END IF;
  IF lower(COALESCE(v_loan.tipo_amortizacion,'')) = 'americano' THEN
    RAISE EXCEPTION 'Los creditos americanos no se renuevan por aca: usa la prorroga';
  END IF;

  -- El mismo control que las ventas de renovacion: sobre el umbral de la
  -- ruta, solo secretaria o admin.
  IF NOT v_priv THEN
    SELECT venta_renovacion_habilitado, venta_renovacion_umbral INTO v_umbral
      FROM ruta_config_umbrales WHERE ruta_id = COALESCE(v_loan.ruta, p_ruta_id);
    IF FOUND AND COALESCE(v_umbral.venta_renovacion_habilitado, false)
       AND v_umbral.venta_renovacion_umbral IS NOT NULL
       AND v_valor > v_umbral.venta_renovacion_umbral THEN
      RAISE EXCEPTION 'La renovacion de % supera el umbral de la ruta (%): la hace secretaria',
        v_valor, v_umbral.venta_renovacion_umbral;
    END IF;
  END IF;

  -- ── Lo que se agrega: el valor con la tasa del credito ─────────────────
  v_empleado := COALESCE(v_loan.prestamo_empleado, false)
                OR lower(COALESCE(v_loan.tipo_amortizacion,'')) = 'empleado';
  v_tasa     := CASE WHEN v_empleado THEN 0 ELSE COALESCE(v_loan.tasa_interes, 0) END;
  v_agregado := round(v_valor * (1 + v_tasa / 100.0), 2);

  v_total_antes := COALESCE(v_loan.valor_a_pagar, v_loan.valor);
  v_total_nuevo := v_total_antes + v_agregado;

  SELECT COALESCE(pagado_neto, 0) INTO v_pagado FROM v_pagos_netos WHERE loan_id = v_loan_id;
  v_pagado := COALESCE(v_pagado, 0);

  -- ── Que cuotas se conservan: las que la plata pagada cubre ENTERAS ─────
  -- En el orden en que vencen. La primera que ya no alcanza —y todas las
  -- que vienen detras— se rehacen.
  FOR v_cuota IN
    SELECT id, numero_cuota, fecha_pago, valor_cuota, es_extra
      FROM payment_plan
     WHERE loan_id = v_loan_id
     ORDER BY fecha_pago, numero_cuota
  LOOP
    IF array_length(v_borrar, 1) IS NULL
       AND v_acum + v_cuota.valor_cuota <= v_pagado + 0.005 THEN
      v_acum := v_acum + v_cuota.valor_cuota;
      v_conservadas := v_conservadas + 1;
      IF NOT v_cuota.es_extra THEN v_base_consv := v_base_consv + 1; END IF;
      v_ultimo_num := GREATEST(v_ultimo_num, v_cuota.numero_cuota);
      v_ultima_fec := v_cuota.fecha_pago;
    ELSE
      v_borrar := array_append(v_borrar, v_cuota.id);
      v_ultimo_num := GREATEST(v_ultimo_num, 0);
    END IF;
  END LOOP;
  v_suma_consv := v_acum;
  v_reprog     := COALESCE(array_length(v_borrar, 1), 0);
  v_n_nuevas   := v_reprog + v_dias;
  v_restante   := v_total_nuevo - v_suma_consv;

  IF v_restante <= 0 THEN
    RAISE EXCEPTION 'Con lo ya pagado no queda nada que repartir; revise el valor a renovar';
  END IF;

  -- ── Las cuotas nuevas: iguales, desde el proximo dia de cobro ──────────
  -- Con la frecuencia del credito. Nunca antes de la ultima cuota que se
  -- conserva (si el cliente iba adelantado).
  v_freq := lower(COALESCE(v_loan.frecuencia_pago, 'daily'));
  v_paso := CASE
    WHEN v_freq IN ('weekly','semanal') AND v_loan.dia_semana IS NOT NULL THEN 1
    WHEN v_freq IN ('weekly','semanal')     THEN 7
    WHEN v_freq IN ('biweekly','quincenal') THEN 15
    WHEN v_freq IN ('monthly','mensual')    THEN 30
    ELSE 1 END;
  v_inicio := GREATEST(v_hoy, COALESCE(v_ultima_fec, v_hoy)) + v_paso;

  -- La parte de interes de lo que queda, para repartirla en capital e
  -- interes de cada cuota nueva (lo usan Auditoria y el detalle de cuotas).
  v_ratio_int := CASE WHEN v_total_nuevo > 0
                      THEN GREATEST(0, (v_total_nuevo - (v_loan.valor + v_valor)) / v_total_nuevo)
                      ELSE 0 END;

  -- ── Rehacer el cronograma ──────────────────────────────────────────────
  -- El DELETE suelta el puntero de los cobros que apuntaban a esas cuotas
  -- (FK ON DELETE SET NULL); el trigger lo permite desde el script 081 y esa
  -- plata vuelve a la cascada, que la aplica a la primera cuota nueva.
  IF v_reprog > 0 THEN
    DELETE FROM payment_plan WHERE id = ANY(v_borrar);
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _renov_cuotas (
    numero_cuota int, fecha_pago date, valor_cuota numeric
  ) ON COMMIT DROP;
  DELETE FROM _renov_cuotas;

  INSERT INTO _renov_cuotas
  SELECT g.numero_cuota, g.fecha_pago, g.valor_cuota
    FROM public.generar_cronograma(v_restante, 0, v_n_nuevas, 'aleman',
                                   v_freq, false, v_inicio, v_loan.dia_semana) g;

  -- Que sumen EXACTO lo que queda: la diferencia de redondeo va a la ultima.
  SELECT COALESCE(SUM(valor_cuota), 0) INTO v_suma_gen FROM _renov_cuotas;
  IF v_suma_gen <> v_restante THEN
    UPDATE _renov_cuotas
       SET valor_cuota = valor_cuota + (v_restante - v_suma_gen)
     WHERE numero_cuota = v_n_nuevas;
  END IF;

  INSERT INTO payment_plan (
    loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
    saldo, estado, ruta, es_extra
  )
  SELECT v_loan_id, v_ultimo_num + r.numero_cuota, r.fecha_pago, r.valor_cuota,
         r.valor_cuota - round(r.valor_cuota * v_ratio_int, 2),
         round(r.valor_cuota * v_ratio_int, 2),
         0, 'pendiente', COALESCE(v_loan.ruta, p_ruta_id), false
    FROM _renov_cuotas r;

  SELECT valor_cuota INTO v_cuota_nueva FROM _renov_cuotas WHERE numero_cuota = 1;

  UPDATE loans
     SET valor         = v_loan.valor + v_valor,
         valor_a_pagar = v_total_nuevo,
         numero_cuotas = v_base_consv + v_n_nuevas,
         valor_cuota   = v_cuota_nueva,
         updated_at    = NOW()
   WHERE id = v_loan_id;

  -- ── La constancia en el libro ──────────────────────────────────────────
  -- Monto 0: la renovacion no es un cobro. La plata entregada va en el
  -- detalle, que es de donde la lee el resumen del dia (PASO 4).
  INSERT INTO gestiones (
    id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
    fecha_hora, monto, origen, observacion, detalle
  ) VALUES (
    v_id, v_loan_id, v_loan.client_id, COALESCE(v_loan.ruta, p_ruta_id), p_user_id,
    'ajuste', 'aplicada', v_fecha, v_fh, 0, 'campo',
    'Renovacion: se entregan ' || v_valor || ' a ' || v_n_nuevas || ' cuotas',
    jsonb_build_object(
      'clase', 'renovacion',
      'rol', p_rol,
      'valor_entregado', v_valor,
      'tasa', v_tasa,
      'total_agregado', v_agregado,
      'dias', v_dias,
      'cuotas_conservadas', v_conservadas,
      'cuotas_reprogramadas', v_reprog,
      'cuotas_nuevas', v_n_nuevas,
      'valor_cuota_nueva', v_cuota_nueva,
      'antes', jsonb_build_object(
        'valor', v_loan.valor, 'valor_a_pagar', v_total_antes,
        'numero_cuotas', v_loan.numero_cuotas, 'valor_cuota', v_loan.valor_cuota,
        'pagado', v_pagado),
      'despues', jsonb_build_object(
        'valor', v_loan.valor + v_valor, 'valor_a_pagar', v_total_nuevo,
        'numero_cuotas', v_base_consv + v_n_nuevas, 'valor_cuota', v_cuota_nueva))
  );

  v_recalc := public.recalcular_prestamo(v_loan_id);

  v_resultado := jsonb_build_object(
    'ok', true,
    'renovacion_id', v_id,
    'loan_id', v_loan_id,
    'valor_entregado', v_valor,
    'total_agregado', v_agregado,
    'cuotas_nuevas', v_n_nuevas,
    'valor_cuota_nueva', v_cuota_nueva,
    'total_a_pagar', v_total_nuevo,
    'nuevo_saldo', (v_recalc->>'nuevo_saldo')::numeric,
    'loan_estado_final', v_recalc->>'loan_estado_final'
  );
  RETURN v_resultado;
END;
$$;


-- ── PASO 3) Permisos ──────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.renovar_prestamo(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 4) El resumen del dia cuenta la renovacion como una venta ───────
-- Es la vista del script 112 con el arreglo del 114 (la meta ignora lo
-- anulado), TAL CUAL, y UN solo cambio: el CTE `ventas` lee de una fuente
-- que junta los prestamos creados ese dia y las renovaciones.
--
-- CREATE OR REPLACE y no DROP: las columnas son las mismas y en el mismo
-- orden, asi que la vista que cuelga de esta (vista_monitoreo_recaudos) no se
-- toca. Si Postgres dijera que las columnas no coinciden, la vista viva no es
-- la del 112+114: NO sigas y avisa.
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


-- ── PASO 5) Permisos de la vista ─────────────────────────────────────────
GRANT SELECT ON public.resumen_diario_v2 TO anon, authenticated;


-- ── PASO 6) Que quedo bien (SOLO LECTURA) ────────────────────────────────
-- La funcion existe y la vista lee las renovaciones: las dos en true.
SELECT
  to_regprocedure('public.renovar_prestamo(bigint,bigint,text,jsonb)') IS NOT NULL AS funcion_creada,
  pg_get_viewdef('public.resumen_diario_v2'::regclass, true) ~ 'renovacion'          AS vista_lee_renovaciones;


-- ── PASO 7) Las ventas de siempre no cambiaron (SOLO LECTURA) ────────────
-- En los dias SIN renovaciones, las ventas del resumen tienen que dar
-- EXACTAMENTE lo mismo que el conteo directo sobre `loans` (ultimos 7 dias).
-- `diferencias` tiene que dar 0.
SELECT COUNT(*) AS diferencias
  FROM public.resumen_diario_v2 r
  LEFT JOIN (
    SELECT (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS fecha, l.ruta,
           COUNT(*) AS n, COALESCE(SUM(l.valor), 0) AS v
      FROM public.loans l
     GROUP BY 1, 2
  ) d ON d.fecha = r.fecha_pago AND d.ruta = r.ruta
 WHERE r.fecha_pago >= (now() AT TIME ZONE 'America/Bogota')::date - 7
   AND NOT EXISTS (SELECT 1 FROM public.gestiones g
                    WHERE g.tipo = 'ajuste' AND g.detalle->>'clase' = 'renovacion'
                      AND g.fecha_gestion = r.fecha_pago AND g.ruta = r.ruta)
   AND (r.cantidad_ventas <> COALESCE(d.n, 0) OR r.valor_ventas <> COALESCE(d.v, 0));
