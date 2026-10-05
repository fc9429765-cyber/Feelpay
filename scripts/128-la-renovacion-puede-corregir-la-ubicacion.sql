-- ============================================================================
-- 128 - La renovacion puede CORREGIR la ubicacion del cliente
-- ============================================================================
-- LO QUE SE PIDIO
-- "En Crear Venta, ademas de poner la ubicacion del cliente automaticamente
--  con las coordenadas, que se vea un mapa con la ubicacion actual y la
--  ubicacion a registrar, y que permita poner el pin a mano." Tambien en las
--  renovaciones de clientes que ya existen.
--
-- LO QUE HABIA
-- ------------
-- `crear_venta_atomica` (script 078), en una renovacion, NUNCA pisa la
-- ubicacion guardada del cliente:
--     latitud  = COALESCE(latitud, v_lat)
-- Es lo correcto cuando la ubicacion viene sola del GPS: la referencia de la
-- geocerca no se mueve cada vez que se le vende al cliente desde otro lado.
-- Pero si el vendedor MOVIO EL PIN a proposito para corregirla, se ignoraba.
--
-- LO QUE HACE ESTE SCRIPT
-- -----------------------
-- Si el cliente viene con `ubicacion_manual = true` (la app lo manda SOLO
-- cuando el vendedor toco el pin en una renovacion) y trae coordenadas, la
-- ubicacion se REEMPLAZA y `ubicacion_capturada_at` pasa a ahora. Sin esa
-- marca, todo sigue exactamente igual que antes.
--
-- Se parchea la funcion VIVA (como el 107, 110 y 125): redefinirla entera
-- borraria lo que le agregaron los scripts posteriores. Si alguna ancla no
-- aparece UNA sola vez, se aborta sin tocar nada.
--
-- Mientras no se corra, nada se rompe: la venta entra igual y la renovacion
-- conserva la ubicacion que ya tenia el cliente.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 3 no escriben nada.
-- ============================================================================


-- ── PASO 1) Las anclas estan una sola vez (SOLO LECTURA) ────────────────
-- Tiene que decir 1 en las dos y `f` en `ya_parchado`.
SELECT (SELECT count(*) FROM regexp_matches(pg_get_functiondef(p.oid),
          'latitud\s+=\s+COALESCE\(latitud, v_lat\),', 'g'))  AS ancla_latitud,
       (SELECT count(*) FROM regexp_matches(pg_get_functiondef(p.oid),
          'longitud\s+=\s+COALESCE\(longitud, v_lon\),', 'g')) AS ancla_longitud,
       position('ubicacion_manual' in pg_get_functiondef(p.oid)) > 0 AS ya_parchado
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica'
   AND pg_get_function_identity_arguments(p.oid) =
       'p_user_id bigint, p_ruta_id bigint, p_rol text, p_cliente jsonb, p_loan jsonb, p_payment_plan jsonb';


-- ── PASO 2) Si el pin se movio a mano, la ubicacion se corrige ──────────
DO $patch$
DECLARE
  v_src text;
  v_new text;
  v_n   int;
  v_manual constant text :=
    '(COALESCE(p_cliente->>''ubicacion_manual'', '''') = ''true'' AND v_lat IS NOT NULL AND v_lon IS NOT NULL)';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica'
     AND pg_get_function_identity_arguments(p.oid) =
         'p_user_id bigint, p_ruta_id bigint, p_rol text, p_cliente jsonb, p_loan jsonb, p_payment_plan jsonb';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.crear_venta_atomica con la firma esperada; revise a mano';
  END IF;

  IF position('ubicacion_manual' in v_src) > 0 THEN
    RAISE NOTICE 'La correccion de ubicacion ya estaba puesta: no se toca nada.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_n FROM regexp_matches(v_src, 'latitud\s+=\s+COALESCE\(latitud, v_lat\),', 'g');
  IF v_n <> 1 THEN RAISE EXCEPTION 'El ancla de latitud aparece % veces; revise a mano', v_n; END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, 'longitud\s+=\s+COALESCE\(longitud, v_lon\),', 'g');
  IF v_n <> 1 THEN RAISE EXCEPTION 'El ancla de longitud aparece % veces; revise a mano', v_n; END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_src,
    'ubicacion_capturada_at\s+=\s+CASE WHEN latitud IS NULL AND v_lat IS NOT NULL', 'g');
  IF v_n <> 1 THEN RAISE EXCEPTION 'El ancla de ubicacion_capturada_at aparece % veces; revise a mano', v_n; END IF;

  v_new := regexp_replace(v_src,
    'latitud\s+=\s+COALESCE\(latitud, v_lat\),',
    'latitud  = CASE WHEN ' || v_manual || ' THEN v_lat ELSE COALESCE(latitud, v_lat) END,  -- script 128');
  v_new := regexp_replace(v_new,
    'longitud\s+=\s+COALESCE\(longitud, v_lon\),',
    'longitud = CASE WHEN ' || v_manual || ' THEN v_lon ELSE COALESCE(longitud, v_lon) END,');
  v_new := regexp_replace(v_new,
    'ubicacion_capturada_at\s+=\s+CASE WHEN latitud IS NULL AND v_lat IS NOT NULL',
    'ubicacion_capturada_at = CASE WHEN ' || v_manual || ' OR (latitud IS NULL AND v_lat IS NOT NULL)');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'El parche no cambio nada; revise a mano';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'crear_venta_atomica: la renovacion corrige la ubicacion cuando el pin se movio a mano.';
END
$patch$;


-- ── PASO 3) Que quedo bien (SOLO LECTURA) ───────────────────────────────
-- Tiene que decir `t` en las dos columnas.
SELECT position('ubicacion_manual' in pg_get_functiondef(p.oid)) > 0  AS corrige_ubicacion,
       position('apodo_2' in pg_get_functiondef(p.oid)) > 0           AS conserva_lo_del_107
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica'
   AND pg_get_function_identity_arguments(p.oid) =
       'p_user_id bigint, p_ruta_id bigint, p_rol text, p_cliente jsonb, p_loan jsonb, p_payment_plan jsonb';
