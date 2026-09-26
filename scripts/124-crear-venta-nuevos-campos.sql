-- ============================================================================
-- 124 - Crear Venta: domicilio, foto del local y venta mixta
-- ============================================================================
-- LO QUE SE PIDIO
-- El modulo Crear Venta se rehizo con el diseño nuevo, y el dueño decidio:
--   * TRES direcciones: la del DNI (la que lee el reverso, que ya es
--     `direccion_residencia`, script 122), la de DOMICILIO si es diferente
--     (NUEVA) y la del comercio (la `direccion` de siempre, donde se cobra).
--   * FOTO DEL LOCAL, opcional (NUEVA).
--   * Tipo de venta MIXTO: parte en efectivo y parte por transferencia, cada
--     una con su valor, que suman el valor de la venta (NUEVO).
--   * La EVIDENCIA de entrega es obligatoria en toda venta. Se guarda donde
--     ya se guardaba el comprobante (`loans.comprobante_url`, script 115):
--     no necesita columna.
--
-- QUE HACE
--   1-2. Las columnas nuevas, en NULL para todo lo que ya existe.
--   3.   Si la base tuviera una regla (CHECK) sobre `loans.tipo_venta` que no
--        acepte 'mixto', la reemplaza por una que si. NOT VALID: no revisa
--        las ventas viejas, solo las nuevas.
--   4.   Que `crear_venta_atomica` guarde los campos nuevos. Se parchea la
--        funcion VIVA como en los scripts 107, 115 y 122, contando columnas
--        y valores antes y despues: si no quedan parejos, ABORTA sin tocar.
--
-- LA CAJA NO CAMBIA. Una venta mixta sale de la caja por su valor completo,
-- igual que hoy una de transferencia: el resumen del dia no distingue el tipo
-- de venta. Los dos montos quedan guardados para consulta.
--
-- MIENTRAS NO SE CORRA
-- La app ya manda los campos nuevos. Sin este script la funcion no los lee:
-- la venta se crea igual y solo se pierden esos datos. Una venta mixta
-- quedaria con tipo 'mixto' si la base no tiene la regla del paso 3.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 7 no escriben nada.
-- Requiere los scripts 115 (`_comas_nivel_cero`) y 122.
-- ============================================================================


-- ── PASO 1) Reglas que hoy hay sobre el tipo de venta (SOLO LECTURA) ─────
SELECT conname, pg_get_constraintdef(oid) AS regla
  FROM pg_constraint
 WHERE conrelid = 'public.loans'::regclass
   AND contype = 'c'
   AND pg_get_constraintdef(oid) ILIKE '%tipo_venta%';


-- ── PASO 2) Las columnas del cliente ─────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS direccion_domicilio TEXT,
  ADD COLUMN IF NOT EXISTS foto_local_url TEXT;


-- ── PASO 3) Las columnas de la venta mixta ───────────────────────────────
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS venta_efectivo NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS venta_transferencia NUMERIC(15,2);


-- ── PASO 4) Que el tipo de venta acepte 'mixto' ──────────────────────────
DO $tipo$
DECLARE
  v_con record;
  v_habia boolean := false;
BEGIN
  FOR v_con IN
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'public.loans'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%tipo_venta%'
  LOOP
    v_habia := true;
    IF v_con.def ILIKE '%mixto%' THEN
      RAISE NOTICE 'La regla % ya acepta mixto.', v_con.conname;
    ELSE
      EXECUTE format('ALTER TABLE public.loans DROP CONSTRAINT %I', v_con.conname);
      EXECUTE 'ALTER TABLE public.loans ADD CONSTRAINT loans_tipo_venta_check '
           || 'CHECK (tipo_venta IN (''efectivo'', ''transferencia'', ''mixto'')) NOT VALID';
      RAISE NOTICE 'Regla % reemplazada: ahora acepta mixto.', v_con.conname;
    END IF;
  END LOOP;
  IF NOT v_habia THEN
    RAISE NOTICE 'No hay regla sobre tipo_venta: mixto ya se puede guardar.';
  END IF;
END;
$tipo$;


-- ── PASO 5) `crear_venta_atomica` guarda los datos del cliente ───────────
-- Dos columnas nuevas al COMIENZO del INSERT INTO clients, y sus dos valores
-- al comienzo de su VALUES. Se ubica el VALUES de ESE insert por posicion
-- (el primero que viene despues de `INSERT INTO clients`), no con una
-- expresion que pueda enganchar el de otro INSERT.
DO $cli$
DECLARE
  v_src   text;
  v_ini   int;
  v_par   int;
  v_val   int;
  v_ret   int;
  v_nuevo text;
  v_cols  text;
  v_vals  text;
  v_ca    int;
  v_va    int;
  v_cd    int;
  v_vd    int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.crear_venta_atomica';
  END IF;
  IF position('direccion_domicilio' in v_src) > 0 THEN
    RAISE NOTICE 'crear_venta_atomica ya guardaba el domicilio. Nada que cambiar.';
    RETURN;
  END IF;

  v_ini := position('INSERT INTO clients' in v_src);
  IF v_ini = 0 THEN
    RAISE EXCEPTION 'No encuentro INSERT INTO clients en la funcion';
  END IF;
  -- El parentesis de las columnas, el VALUES y el RETURNING de ESE insert.
  v_par := v_ini + position('(' in substring(v_src from v_ini)) - 1;
  v_val := v_ini + position(') VALUES (' in substring(v_src from v_ini)) - 1;
  v_ret := v_ini + position('RETURNING' in substring(v_src from v_ini)) - 1;
  IF v_par <= v_ini OR v_val <= v_par OR v_ret <= v_val THEN
    RAISE EXCEPTION 'El INSERT INTO clients no tiene la forma esperada; revise a mano';
  END IF;

  v_cols := substring(v_src from v_par + 1 for v_val - v_par - 1);
  v_vals := substring(v_src from v_val + 10 for v_ret - v_val - 10);
  v_ca := public._comas_nivel_cero(v_cols);
  v_va := public._comas_nivel_cero(v_vals);
  RAISE NOTICE 'INSERT INTO clients, antes: % columnas · % valores', v_ca, v_va;
  IF v_ca <> v_va THEN
    RAISE EXCEPTION 'El INSERT ya venia desparejo (% vs %). NO lo toco.', v_ca, v_va;
  END IF;

  -- Se arma de atras hacia adelante para no mover las posiciones.
  v_nuevo := substring(v_src from 1 for v_val + 9)
          || ' NULLIF(p_cliente->>''direccion_domicilio'',''''), NULLIF(p_cliente->>''foto_local_url'',''''), '
          || substring(v_src from v_val + 10);
  v_nuevo := substring(v_nuevo from 1 for v_par)
          || ' direccion_domicilio, foto_local_url, '
          || substring(v_nuevo from v_par + 1);

  -- Volver a contar sobre el texto nuevo.
  v_ini := position('INSERT INTO clients' in v_nuevo);
  v_par := v_ini + position('(' in substring(v_nuevo from v_ini)) - 1;
  v_val := v_ini + position(') VALUES (' in substring(v_nuevo from v_ini)) - 1;
  v_ret := v_ini + position('RETURNING' in substring(v_nuevo from v_ini)) - 1;
  v_cols := substring(v_nuevo from v_par + 1 for v_val - v_par - 1);
  v_vals := substring(v_nuevo from v_val + 10 for v_ret - v_val - 10);
  v_cd := public._comas_nivel_cero(v_cols);
  v_vd := public._comas_nivel_cero(v_vals);
  RAISE NOTICE 'INSERT INTO clients, despues: % columnas · % valores', v_cd, v_vd;
  IF v_cd <> v_vd OR v_cd <> v_ca + 2 THEN
    RAISE EXCEPTION 'El parche dejo el INSERT desparejo (% vs %; antes %). NO se aplica.', v_cd, v_vd, v_ca;
  END IF;

  EXECUTE v_nuevo;
  RAISE NOTICE 'crear_venta_atomica ahora guarda domicilio y foto del local.';
END;
$cli$;


-- ── PASO 6) `crear_venta_atomica` guarda los montos de la venta mixta ────
DO $loan$
DECLARE
  v_src   text;
  v_ini   int;
  v_par   int;
  v_val   int;
  v_ret   int;
  v_nuevo text;
  v_cols  text;
  v_vals  text;
  v_ca    int;
  v_va    int;
  v_cd    int;
  v_vd    int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica';
  IF position('venta_efectivo' in v_src) > 0 THEN
    RAISE NOTICE 'crear_venta_atomica ya guardaba la venta mixta. Nada que cambiar.';
    RETURN;
  END IF;

  v_ini := position('INSERT INTO loans' in v_src);
  IF v_ini = 0 THEN
    RAISE EXCEPTION 'No encuentro INSERT INTO loans en la funcion';
  END IF;
  v_par := v_ini + position('(' in substring(v_src from v_ini)) - 1;
  v_val := v_ini + position(') VALUES (' in substring(v_src from v_ini)) - 1;
  v_ret := v_ini + position('RETURNING' in substring(v_src from v_ini)) - 1;
  IF v_par <= v_ini OR v_val <= v_par OR v_ret <= v_val THEN
    RAISE EXCEPTION 'El INSERT INTO loans no tiene la forma esperada; revise a mano';
  END IF;

  v_cols := substring(v_src from v_par + 1 for v_val - v_par - 1);
  v_vals := substring(v_src from v_val + 10 for v_ret - v_val - 10);
  v_ca := public._comas_nivel_cero(v_cols);
  v_va := public._comas_nivel_cero(v_vals);
  RAISE NOTICE 'INSERT INTO loans, antes: % columnas · % valores', v_ca, v_va;
  IF v_ca <> v_va THEN
    RAISE EXCEPTION 'El INSERT ya venia desparejo (% vs %). NO lo toco.', v_ca, v_va;
  END IF;

  v_nuevo := substring(v_src from 1 for v_val + 9)
          || ' NULLIF(p_loan->>''venta_efectivo'','''')::numeric, NULLIF(p_loan->>''venta_transferencia'','''')::numeric, '
          || substring(v_src from v_val + 10);
  v_nuevo := substring(v_nuevo from 1 for v_par)
          || ' venta_efectivo, venta_transferencia, '
          || substring(v_nuevo from v_par + 1);

  v_ini := position('INSERT INTO loans' in v_nuevo);
  v_par := v_ini + position('(' in substring(v_nuevo from v_ini)) - 1;
  v_val := v_ini + position(') VALUES (' in substring(v_nuevo from v_ini)) - 1;
  v_ret := v_ini + position('RETURNING' in substring(v_nuevo from v_ini)) - 1;
  v_cols := substring(v_nuevo from v_par + 1 for v_val - v_par - 1);
  v_vals := substring(v_nuevo from v_val + 10 for v_ret - v_val - 10);
  v_cd := public._comas_nivel_cero(v_cols);
  v_vd := public._comas_nivel_cero(v_vals);
  RAISE NOTICE 'INSERT INTO loans, despues: % columnas · % valores', v_cd, v_vd;
  IF v_cd <> v_vd OR v_cd <> v_ca + 2 THEN
    RAISE EXCEPTION 'El parche dejo el INSERT desparejo (% vs %; antes %). NO se aplica.', v_cd, v_vd, v_ca;
  END IF;

  EXECUTE v_nuevo;
  RAISE NOTICE 'crear_venta_atomica ahora guarda los montos de la venta mixta.';
END;
$loan$;


-- ── PASO 7) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- Todo en true.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
           AND table_name = 'clients' AND column_name = 'direccion_domicilio') AS col_domicilio,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
           AND table_name = 'clients' AND column_name = 'foto_local_url')      AS col_foto_local,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
           AND table_name = 'loans' AND column_name = 'venta_efectivo')        AS col_venta_mixta,
  position('direccion_domicilio' IN (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica')) > 0     AS la_venta_guarda_domicilio,
  position('venta_efectivo' IN (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica')) > 0     AS la_venta_guarda_mixta;
