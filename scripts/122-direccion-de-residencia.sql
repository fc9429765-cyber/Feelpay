-- ============================================================================
-- 122 - La direccion de residencia del cliente
-- ============================================================================
-- LO QUE SE PIDIO
-- "Haremos que la direccion que se lee de la cedula en el reverso vaya a un
--  campo nuevo llamado direccion de residencia (crear el campo en supabase);
--  es diferente al de direccion actual."
--
-- LAS DOS DIRECCIONES
--   * `direccion`             donde se le COBRA: el negocio, casi siempre. Es
--                             la que usa la ruta y no cambia.
--   * `direccion_residencia`  donde VIVE: la que trae impresa el respaldo del
--                             documento. Nueva, opcional.
--
-- QUE HACE ESTE SCRIPT
--   1. La columna, en NULL para todos los clientes que ya existen.
--   2. Que `crear_venta_atomica` la guarde al crear un cliente nuevo. Se
--      parchea la funcion VIVA, igual que en los scripts 107 y 115: tiene
--      varias versiones y reescribirla desde una borraria lo que agregaron
--      las otras. El parche cuenta columnas y valores del INSERT antes y
--      despues, y ABORTA sin tocar nada si no quedan parejos.
--
-- MIENTRAS NO SE CORRA
-- La app ya manda `direccion_residencia` en el payload de la venta. Sin este
-- script la funcion simplemente no lee esa clave: la venta se crea igual y
-- solo se pierde ese dato. Nada falla.
--
-- QUE NO CAMBIA
--   * Ningun monto, saldo, vista ni cronograma.
--   * `sector` y las columnas `ref1_*` siguen en la tabla con lo que ya
--     tienen. La app deja de pedirlas en la venta; no se borra historia.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 4 no escriben nada.
-- Requiere el script 115 (la funcion `_comas_nivel_cero`).
-- ============================================================================


-- ── PASO 1) Como esta la tabla hoy (SOLO LECTURA) ────────────────────────
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'clients'
 ORDER BY ordinal_position;


-- ── PASO 2) La columna ───────────────────────────────────────────────────
-- TEXT y opcional: una direccion no tiene largo fijo, y muchos documentos no
-- traen domicilio impreso.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS direccion_residencia TEXT;


-- ── PASO 3) Que `crear_venta_atomica` la guarde ──────────────────────────
DO $patch$
DECLARE
  v_src     text;
  v_nuevo   text;
  v_n       int;
  v_ins     text;
  v_cols    text;
  v_vals    text;
  v_c_antes int;
  v_v_antes int;
  v_c_dsp   int;
  v_v_dsp   int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.crear_venta_atomica: corra antes el script 078';
  END IF;

  IF to_regprocedure('public._comas_nivel_cero(text)') IS NULL THEN
    RAISE EXCEPTION 'Falta public._comas_nivel_cero: corra antes el script 115';
  END IF;

  IF position('direccion_residencia' in v_src) > 0 THEN
    RAISE NOTICE 'crear_venta_atomica ya guardaba la direccion de residencia. Nada que cambiar.';
    RETURN;
  END IF;

  -- ── Contar las dos listas del INSERT INTO clients, ANTES de tocar nada ─
  v_ins := substring(v_src from position('INSERT INTO clients' in v_src));
  v_ins := substring(v_ins from 1 for position('RETURNING' in v_ins) - 1);
  v_cols := substring(v_ins from position('(' in v_ins) + 1
                      for position(') VALUES (' in v_ins) - position('(' in v_ins) - 1);
  v_vals := substring(v_ins from position(') VALUES (' in v_ins) + 10);
  v_c_antes := public._comas_nivel_cero(v_cols);
  v_v_antes := public._comas_nivel_cero(v_vals);

  RAISE NOTICE 'INSERT INTO clients, antes: % columnas · % valores', v_c_antes, v_v_antes;
  IF v_c_antes <> v_v_antes THEN
    RAISE EXCEPTION
      'El INSERT ya venia desparejo (% columnas vs % valores). NO lo toco: revise a mano.',
      v_c_antes, v_v_antes;
  END IF;

  -- ── La columna, como PRIMERA del INSERT ────────────────────────────────
  -- Se ancla en `documento,`, la primera columna, que ningun script mueve.
  SELECT count(*) INTO v_n
    FROM regexp_matches(v_src, 'INSERT INTO clients \(\s*documento,', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El ancla de columnas engancha % veces; revise a mano', v_n;
  END IF;
  v_nuevo := regexp_replace(v_src,
    '(INSERT INTO clients \(\s*)documento,',
    '\1direccion_residencia, documento,');

  -- ── Y su valor, como PRIMER valor ──────────────────────────────────────
  -- El primer valor es el documento del payload.
  SELECT count(*) INTO v_n
    FROM regexp_matches(v_nuevo, '\) VALUES \(\s*p_cliente->>''documento'',', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El ancla de valores engancha % veces; revise a mano', v_n;
  END IF;
  v_nuevo := regexp_replace(v_nuevo,
    '(\) VALUES \(\s*)(p_cliente->>''documento'',)',
    '\1NULLIF(p_cliente->>''direccion_residencia'',''''), \2');

  -- ── Volver a contar: las dos listas TIENEN que haber subido en 1 ───────
  v_ins := substring(v_nuevo from position('INSERT INTO clients' in v_nuevo));
  v_ins := substring(v_ins from 1 for position('RETURNING' in v_ins) - 1);
  v_cols := substring(v_ins from position('(' in v_ins) + 1
                      for position(') VALUES (' in v_ins) - position('(' in v_ins) - 1);
  v_vals := substring(v_ins from position(') VALUES (' in v_ins) + 10);
  v_c_dsp := public._comas_nivel_cero(v_cols);
  v_v_dsp := public._comas_nivel_cero(v_vals);

  RAISE NOTICE 'INSERT INTO clients, despues: % columnas · % valores', v_c_dsp, v_v_dsp;
  IF v_c_dsp <> v_v_dsp OR v_c_dsp <> v_c_antes + 1 THEN
    RAISE EXCEPTION
      'El parche dejo el INSERT desparejo (% columnas vs % valores; antes %). NO se aplica.',
      v_c_dsp, v_v_dsp, v_c_antes;
  END IF;

  EXECUTE v_nuevo;
  RAISE NOTICE 'crear_venta_atomica ahora guarda direccion_residencia.';
END;
$patch$;


-- ── PASO 4) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- Las dos tienen que dar true.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'clients'
             AND column_name = 'direccion_residencia')                 AS columna_creada,
  position('direccion_residencia' IN (
    SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica')) > 0
                                                                         AS la_venta_la_guarda;
