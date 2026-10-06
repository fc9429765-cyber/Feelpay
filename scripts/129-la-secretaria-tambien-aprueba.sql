-- ============================================================================
-- 129 - La secretaria tambien aprueba lo que ya aprobo el admin
-- ============================================================================
-- LO QUE SE PIDIO
-- "La secretaria tambien debe aprobar: actualmente si el admin aprueba se
--  bloquea la parte de la secretaria" (Movimientos en Revision, 06-oct-2026).
--
-- LO QUE HABIA
-- ------------
-- Una solicitud de `solicitudes_revision` (venta, abono, gasto por umbral)
-- se resolvia UNA vez: la primera persona que aprobaba (admin o secretaria)
-- la cerraba, y la fila quedaba bloqueada para la otra.
--
-- LO QUE HACE ESTE SCRIPT
-- -----------------------
-- Le da a la solicitud un segundo paso, el de secretaria, en tres columnas:
--   secretaria_estado      NULL     -> el admin la resolvio y la secretaria
--                                      todavia no da su visto bueno
--                          'aprobado' / 'rechazado' -> lo que dijo secretaria
--                          'NA'     -> no le toca (historico, o el admin la
--                                      rechazo y no hay nada que revisar)
--   secretaria_por_nombre  quien
--   secretaria_at          cuando
-- El visto bueno de secretaria NO mueve plata: la venta o el pago ya se
-- aplicaron cuando el admin aprobo. Solo deja la firma.
--
-- Mientras no se corra, la bandeja abre igual; lo unico que falla es el
-- boton de visto bueno de secretaria sobre lo que ya aprobo el admin.
--
-- Corre los pasos EN ORDEN. El paso 5 no escribe nada.
-- ============================================================================


-- ── PASO 1) Columna del estado de secretaria ────────────────────────────
ALTER TABLE public.solicitudes_revision ADD COLUMN IF NOT EXISTS secretaria_estado text;


-- ── PASO 2) Quien firmo por secretaria ──────────────────────────────────
ALTER TABLE public.solicitudes_revision ADD COLUMN IF NOT EXISTS secretaria_por_nombre text;


-- ── PASO 3) Cuando firmo ────────────────────────────────────────────────
ALTER TABLE public.solicitudes_revision ADD COLUMN IF NOT EXISTS secretaria_at timestamptz;


-- ── PASO 4) Lo ya resuelto antes de hoy no le queda pendiente a nadie ──
-- Sin esto, todo lo que el admin aprobo en los ultimos 60 dias apareceria
-- de golpe esperando a secretaria.
UPDATE public.solicitudes_revision
   SET secretaria_estado = 'NA'
 WHERE estado <> 'pendiente'
   AND secretaria_estado IS NULL
   AND COALESCE(revisado_at, created_at) < TIMESTAMPTZ '2026-10-07 00:00:00-05';


-- ── PASO 5) Verificacion (SOLO LECTURA) ─────────────────────────────────
-- Tiene que mostrar las tres columnas y el conteo por estado.
SELECT estado, COALESCE(secretaria_estado, '(espera secretaria)') AS secretaria, count(*)
  FROM public.solicitudes_revision
 GROUP BY 1, 2
 ORDER BY 1, 2;
