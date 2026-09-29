-- ============================================================================
-- 125 - El pago guarda la cuenta de la transferencia y la foto
-- ============================================================================
-- LO QUE PASABA
-- -------------
-- En "Registrar Pago" el cobrador elegía la cuenta de la transferencia, tomaba
-- una foto y escribía notas, y NADA de eso llegaba a la base:
--   * la lista de cuentas era de ejemplo (Davivienda/Bancolombia/Nequi fijas)
--     y lo elegido no viajaba en el evento;
--   * la foto se quedaba en el teléfono;
--   * las notas no se leían nunca (el campo no estaba conectado).
--
-- La app ya manda las tres cosas en el payload de `registrar_gestion`:
--   observacion  → ya se guardaba en `gestiones.observacion` (script 044)
--   cuenta_id    → el id de la tabla `cuentas`
--   foto_url     → la URL en Vercel Blob (la cola la sube antes de mandar)
--
-- LO QUE HACE ESTE SCRIPT
-- -----------------------
-- Guarda `cuenta_id` y `foto_url` dentro de `gestiones.detalle` (jsonb), que
-- es donde el evento ya lleva sus datos adicionales (`rol`). No se agregan
-- columnas: el libro no cambia de forma.
--
-- Se parchea la función VIVA, como en el 110: `registrar_gestion` tiene ~600
-- líneas y varios scripts la tocaron; redefinirla entera borraría esos
-- cambios. Si el ancla no aparece UNA sola vez, se aborta sin tocar nada.
--
-- Mientras no se corra, nada se rompe: el servidor ignora los campos que no
-- conoce y el pago entra igual (sin cuenta ni foto guardadas).
--
-- Corre los pasos EN ORDEN. Los pasos 1, 3 y 4 no escriben nada.
-- ============================================================================


-- ── PASO 1) El ancla está una sola vez (SOLO LECTURA) ───────────────────
-- Tiene que decir 1 en `ancla` y `f` en `ya_parchado`.
SELECT (SELECT count(*) FROM regexp_matches(
          pg_get_functiondef(p.oid),
          'v_referencia, v_obs, v_motivo,\s+jsonb_build_object\(''rol'', p_rol\)', 'g')) AS ancla,
       position('foto_url' in pg_get_functiondef(p.oid)) > 0 AS ya_parchado
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion'
   AND pg_get_function_identity_arguments(p.oid) = 'p_user_id bigint, p_ruta_id bigint, p_rol text, p_payload jsonb';


-- ── PASO 2) Guardar cuenta y foto en `detalle` ──────────────────────────
DO $patch$
DECLARE
  v_src text;
  v_new text;
  v_n   int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion'
     AND pg_get_function_identity_arguments(p.oid) = 'p_user_id bigint, p_ruta_id bigint, p_rol text, p_payload jsonb';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.registrar_gestion(bigint,bigint,text,jsonb): corra antes el script 044';
  END IF;

  IF position('foto_url' in v_src) > 0 THEN
    RAISE NOTICE 'La cuenta y la foto ya se guardaban: no se toca nada.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_n
    FROM regexp_matches(v_src, 'v_referencia, v_obs, v_motivo,\s+jsonb_build_object\(''rol'', p_rol\)', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El ancla del INSERT del evento aparece % veces; revise a mano', v_n;
  END IF;

  v_new := regexp_replace(
    v_src,
    '(v_referencia, v_obs, v_motivo,\s+jsonb_build_object\(''rol'', p_rol\))',
    E'\\1\n'
    ||E'      -- Script 125: la cuenta de la transferencia y la foto del pago.\n'
    ||E'      || jsonb_strip_nulls(jsonb_build_object(\n'
    ||E'           ''cuenta_id'', NULLIF(p_payload->>''cuenta_id'', ''''),\n'
    ||E'           ''foto_url'',  NULLIF(p_payload->>''foto_url'', '''')))'
  );

  IF v_new = v_src THEN
    RAISE EXCEPTION 'El parche no cambió nada; revise a mano';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'registrar_gestion ahora guarda cuenta_id y foto_url en detalle.';
END
$patch$;


-- ── PASO 3) Que el parche quedó puesto (SOLO LECTURA) ───────────────────
-- Tiene que decir `t` en las dos columnas.
SELECT position('foto_url' in pg_get_functiondef(p.oid)) > 0 AS guarda_la_foto,
       position('cuota_adicional_automatica' in pg_get_functiondef(p.oid)) > 0 AS conserva_lo_del_110
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion'
   AND pg_get_function_identity_arguments(p.oid) = 'p_user_id bigint, p_ruta_id bigint, p_rol text, p_payload jsonb';


-- ── PASO 4) Después del primer pago con cuenta o foto (SOLO LECTURA) ────
SELECT g.fecha_hora, g.ruta, g.tipo, g.monto, g.metodo_pago,
       g.detalle->>'cuenta_id' AS cuenta_id,
       c.nombre               AS cuenta,
       g.detalle->>'foto_url'  AS foto_url,
       g.observacion
  FROM gestiones g
  LEFT JOIN cuentas c ON c.id::text = g.detalle->>'cuenta_id'
 WHERE g.tipo IN ('pago', 'cancelacion')
   AND (g.detalle ? 'cuenta_id' OR g.detalle ? 'foto_url' OR g.observacion IS NOT NULL)
 ORDER BY g.fecha_hora DESC
 LIMIT 20;
