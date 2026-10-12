-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION 001 · Add sources to messages
-- ═══════════════════════════════════════════════════════════════════════════
-- Descripción:
--   Agrega la columna `sources` a la tabla `messages` para guardar las fuentes
--   web que citó la IA en cada respuesta. Permite que las fuentes persistan
--   cuando el usuario recarga el chat.
--
-- Estructura esperada de `sources` (JSONB array):
--   [
--     {
--       "title": "Gabo Márquez - Wikipedia",
--       "url": "https://es.wikipedia.org/wiki/Gabriel_Garcia_Marquez",
--       "snippet": "Gabriel José de la Concordia García Márquez...",
--       "source": "es.wikipedia.org",
--       "trust": 0.95,
--       "position": 0
--     }
--   ]
--
-- Autor: Álvaro García Gómez
-- Fecha: 2026-10-13
-- Versión: 1.0
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- 00 · VERIFICACIONES PREVIAS
-- ═══════════════════════════════════════════════════════════════════════════

-- Verificar que la tabla messages existe
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'messages'
  ) THEN
    RAISE EXCEPTION 'La tabla "messages" no existe. Aplica primero el schema base.';
  END IF;
END $$;

-- Verificar que la tabla messages tiene las columnas mínimas esperadas
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'id'
  ) THEN
    RAISE EXCEPTION 'La tabla "messages" no tiene columna "id".';
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 01 · CREAR TABLA DE TRACKING DE MIGRACIONES (si no existe)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms INTEGER,
  checksum    TEXT,
  applied_by  TEXT DEFAULT current_user,
  meta        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations (applied_at DESC);

COMMENT ON TABLE schema_migrations IS
  'Tracking de migraciones aplicadas. Cada fila = una migración ejecutada.';

COMMENT ON COLUMN schema_migrations.version IS
  'ID único de la migración (ej: "001", "002", "20261013_001").';

COMMENT ON COLUMN schema_migrations.checksum IS
  'SHA256 del contenido del archivo de migración. Detecta modificaciones post-aplicación.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 02 · AGREGAR COLUMNA sources
-- ═══════════════════════════════════════════════════════════════════════════

-- Columna principal (idempotente)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sources JSONB DEFAULT NULL;

-- Comentario de documentación
COMMENT ON COLUMN messages.sources IS
  'Array de fuentes web citadas por la IA en esta respuesta. NULL si no hubo búsqueda web. Estructura: [{title, url, snippet, source, trust, position}]';


-- ═══════════════════════════════════════════════════════════════════════════
-- 03 · CONSTRAINTS Y VALIDACIÓN
-- ═══════════════════════════════════════════════════════════════════════════

-- Función que valida la estructura de sources
CREATE OR REPLACE FUNCTION validate_message_sources(sources_json JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
  item_count INTEGER;
BEGIN
  -- NULL es válido (mensaje sin fuentes)
  IF sources_json IS NULL THEN
    RETURN TRUE;
  END IF;

  -- Debe ser un array
  IF jsonb_typeof(sources_json) <> 'array' THEN
    RETURN FALSE;
  END IF;

  -- Máximo 20 fuentes
  item_count := jsonb_array_length(sources_json);
  IF item_count > 20 THEN
    RETURN FALSE;
  END IF;

  -- Validar cada item
  FOR item IN SELECT * FROM jsonb_array_elements(sources_json)
  LOOP
    -- Debe ser un objeto
    IF jsonb_typeof(item) <> 'object' THEN
      RETURN FALSE;
    END IF;

    -- Debe tener title y url
    IF NOT (item ? 'title') OR NOT (item ? 'url') THEN
      RETURN FALSE;
    END IF;

    -- title y url deben ser strings no vacíos
    IF length(coalesce(item->>'title', '')) = 0 THEN
      RETURN FALSE;
    END IF;
    IF length(coalesce(item->>'url', '')) = 0 THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION validate_message_sources IS
  'Valida que un JSONB de fuentes sea un array de objetos con title+url no vacíos. Max 20 items.';

-- Constraint CHECK sobre la columna (opcional pero recomendado)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_messages_sources_valid'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT chk_messages_sources_valid
      CHECK (validate_message_sources(sources));
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 04 · TRIGGER DE VALIDACIÓN (defensa en profundidad)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trg_validate_message_sources()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sources IS NOT NULL AND NOT validate_message_sources(NEW.sources) THEN
    RAISE EXCEPTION 'Estructura inválida en messages.sources. Debe ser array de objetos con {title, url}.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_validate_sources ON messages;

CREATE TRIGGER trg_messages_validate_sources
  BEFORE INSERT OR UPDATE OF sources ON messages
  FOR EACH ROW
  EXECUTE FUNCTION trg_validate_message_sources();


-- ═══════════════════════════════════════════════════════════════════════════
-- 05 · ÍNDICES
-- ═══════════════════════════════════════════════════════════════════════════

-- Índice GIN general para buscar mensajes que tengan cierta estructura
CREATE INDEX IF NOT EXISTS idx_messages_sources_gin
  ON messages USING GIN (sources)
  WHERE sources IS NOT NULL;

-- Índice para buscar mensajes que citaron un dominio específico
CREATE INDEX IF NOT EXISTS idx_messages_sources_domains
  ON messages USING GIN ((sources -> 'source'))
  WHERE sources IS NOT NULL;

-- Índice funcional para contar mensajes con fuentes por chat
CREATE INDEX IF NOT EXISTS idx_messages_has_sources
  ON messages ((sources IS NOT NULL))
  WHERE sources IS NOT NULL;

-- Índice por cantidad de fuentes (para analytics)
CREATE INDEX IF NOT EXISTS idx_messages_sources_count
  ON messages ((jsonb_array_length(sources)))
  WHERE sources IS NOT NULL;

COMMENT ON INDEX idx_messages_sources_gin IS
  'Búsqueda de estructura de fuentes (contiene cierta URL, cierto título, etc).';

COMMENT ON INDEX idx_messages_sources_domains IS
  'Filtrar mensajes por dominio específico (ej: todos los que citaron wikipedia.org).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 06 · VISTAS DE CONSULTA
-- ═══════════════════════════════════════════════════════════════════════════

-- Vista: mensajes con fuentes (facilita queries de admin)
CREATE OR REPLACE VIEW v_messages_with_sources AS
SELECT
  m.id,
  m.chat_id,
  m.role,
  m.created_at,
  m.sources,
  jsonb_array_length(m.sources) AS source_count,
  (m.sources -> 0 ->> 'url')     AS first_source_url,
  (m.sources -> 0 ->> 'title')   AS first_source_title,
  (m.sources -> 0 ->> 'source')  AS first_source_domain
FROM messages m
WHERE m.sources IS NOT NULL
  AND jsonb_array_length(m.sources) > 0;

COMMENT ON VIEW v_messages_with_sources IS
  'Vista de mensajes que citaron fuentes web. Útil para analytics de web search.';

-- Vista: dominios más citados
CREATE OR REPLACE VIEW v_source_domains_ranking AS
SELECT
  source_item ->> 'source' AS domain,
  COUNT(*) AS citations,
  COUNT(DISTINCT m.chat_id) AS unique_chats,
  MIN(m.created_at) AS first_seen,
  MAX(m.created_at) AS last_seen
FROM messages m
CROSS JOIN LATERAL jsonb_array_elements(m.sources) AS source_item
WHERE m.sources IS NOT NULL
  AND source_item ->> 'source' IS NOT NULL
GROUP BY source_item ->> 'source'
ORDER BY citations DESC;

COMMENT ON VIEW v_source_domains_ranking IS
  'Ranking de dominios más citados por la IA. Útil para saber qué fuentes usa más.';

-- Vista: estadísticas de web search por día
CREATE OR REPLACE VIEW v_websearch_stats_daily AS
SELECT
  DATE(m.created_at AT TIME ZONE 'America/Bogota') AS day,
  COUNT(*) AS messages_with_sources,
  SUM(jsonb_array_length(m.sources)) AS total_citations,
  ROUND(AVG(jsonb_array_length(m.sources))::numeric, 2) AS avg_sources_per_message
FROM messages m
WHERE m.sources IS NOT NULL
GROUP BY DATE(m.created_at AT TIME ZONE 'America/Bogota')
ORDER BY day DESC;

COMMENT ON VIEW v_websearch_stats_daily IS
  'Estadísticas diarias de uso de web search.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 07 · FUNCIONES DE UTILIDAD
-- ═══════════════════════════════════════════════════════════════════════════

-- Extrae las URLs únicas de las fuentes de un mensaje
CREATE OR REPLACE FUNCTION extract_source_urls(sources_json JSONB)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY(
    SELECT DISTINCT (item ->> 'url')
    FROM jsonb_array_elements(sources_json) AS item
    WHERE item ->> 'url' IS NOT NULL
  );
$$;

COMMENT ON FUNCTION extract_source_urls IS
  'Devuelve un array de URLs únicas de un JSONB de fuentes.';

-- Cuenta cuántas veces se citó un dominio en los últimos N días
CREATE OR REPLACE FUNCTION count_domain_citations(domain_name TEXT, days_back INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(*)::INTEGER
  FROM messages m
  CROSS JOIN LATERAL jsonb_array_elements(m.sources) AS item
  WHERE m.sources IS NOT NULL
    AND m.created_at > NOW() - (days_back || ' days')::interval
    AND item ->> 'source' = domain_name;
$$;

COMMENT ON FUNCTION count_domain_citations IS
  'Cuenta cuántas veces se citó un dominio en los últimos N días.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 08 · REGISTRAR MIGRACIÓN
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO schema_migrations (version, name, checksum, meta)
VALUES (
  '001',
  'add_sources_to_messages',
  'v1_20261013_initial',
  jsonb_build_object(
    'table', 'messages',
    'column', 'sources',
    'type', 'jsonb',
    'rollback_available', true
  )
)
ON CONFLICT (version) DO UPDATE SET
  applied_at = NOW(),
  meta = schema_migrations.meta || EXCLUDED.meta;


-- ═══════════════════════════════════════════════════════════════════════════
-- 09 · TESTS DE VERIFICACIÓN
-- ═══════════════════════════════════════════════════════════════════════════

-- Test 1: la columna existe
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'sources'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: columna sources no existe';
  END IF;
  RAISE NOTICE '✓ Test 1: columna sources existe';
END $$;

-- Test 2: el tipo es JSONB
DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'sources';

  IF col_type <> 'jsonb' THEN
    RAISE EXCEPTION 'TEST FAILED: columna sources es % (debería ser jsonb)', col_type;
  END IF;
  RAISE NOTICE '✓ Test 2: columna sources es jsonb';
END $$;

-- Test 3: la función de validación acepta NULL
DO $$
BEGIN
  IF NOT validate_message_sources(NULL) THEN
    RAISE EXCEPTION 'TEST FAILED: NULL debería ser válido';
  END IF;
  RAISE NOTICE '✓ Test 3: validate_message_sources(NULL) = TRUE';
END $$;

-- Test 4: la función de validación acepta array válido
DO $$
BEGIN
  IF NOT validate_message_sources(
    '[{"title":"Test","url":"https://example.com"}]'::jsonb
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: array válido rechazado';
  END IF;
  RAISE NOTICE '✓ Test 4: array válido aceptado';
END $$;

-- Test 5: la función rechaza array sin title
DO $$
BEGIN
  IF validate_message_sources('[{"url":"https://example.com"}]'::jsonb) THEN
    RAISE EXCEPTION 'TEST FAILED: array sin title debería ser rechazado';
  END IF;
  RAISE NOTICE '✓ Test 5: array sin title rechazado';
END $$;

-- Test 6: los índices existen
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_messages_sources_gin'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: idx_messages_sources_gin no existe';
  END IF;
  RAISE NOTICE '✓ Test 6: índices creados';
END $$;

-- Test 7: las vistas existen
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'v_messages_with_sources'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: vista v_messages_with_sources no existe';
  END IF;
  RAISE NOTICE '✓ Test 7: vistas creadas';
END $$;

-- Test 8: el trigger existe
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_messages_validate_sources'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: trigger no existe';
  END IF;
  RAISE NOTICE '✓ Test 8: trigger creado';
END $$;

RAISE NOTICE '════════════════════════════════════════════════';
RAISE NOTICE 'MIGRACIÓN 001 COMPLETADA EXITOSAMENTE';
RAISE NOTICE '════════════════════════════════════════════════';


-- ═══════════════════════════════════════════════════════════════════════════
-- 10 · ROLLBACK (descomentar y ejecutar solo si querés revertir)
-- ═══════════════════════════════════════════════════════════════════════════

/*
BEGIN;

-- 1. Borrar trigger
DROP TRIGGER IF EXISTS trg_messages_validate_sources ON messages;
DROP FUNCTION IF EXISTS trg_validate_message_sources();

-- 2. Borrar vistas
DROP VIEW IF EXISTS v_websearch_stats_daily;
DROP VIEW IF EXISTS v_source_domains_ranking;
DROP VIEW IF EXISTS v_messages_with_sources;

-- 3. Borrar funciones
DROP FUNCTION IF EXISTS count_domain_citations(TEXT, INTEGER);
DROP FUNCTION IF EXISTS extract_source_urls(JSONB);
DROP FUNCTION IF EXISTS validate_message_sources(JSONB);

-- 4. Borrar constraint
ALTER TABLE messages DROP CONSTRAINT IF EXISTS chk_messages_sources_valid;

-- 5. Borrar índices (algunos se borran automáticamente al borrar la columna)
DROP INDEX IF EXISTS idx_messages_sources_gin;
DROP INDEX IF EXISTS idx_messages_sources_domains;
DROP INDEX IF EXISTS idx_messages_has_sources;
DROP INDEX IF EXISTS idx_messages_sources_count;

-- 6. Borrar columna
ALTER TABLE messages DROP COLUMN IF EXISTS sources;

-- 7. Borrar registro de migración
DELETE FROM schema_migrations WHERE version = '001';

COMMIT;
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- 11 · QUERIES ÚTILES POST-MIGRACIÓN (para debugging manual)
-- ═══════════════════════════════════════════════════════════════════════════

/*
-- Ver todas las migraciones aplicadas
SELECT version, name, applied_at, duration_ms
FROM schema_migrations
ORDER BY applied_at DESC;

-- Ver mensajes con fuentes (últimos 10)
SELECT id, role, created_at, source_count, first_source_title
FROM v_messages_with_sources
ORDER BY created_at DESC
LIMIT 10;

-- Top 10 dominios citados
SELECT * FROM v_source_domains_ranking LIMIT 10;

-- Estadísticas diarias
SELECT * FROM v_websearch_stats_daily LIMIT 7;

-- Mensajes que citaron Wikipedia
SELECT id, chat_id, created_at
FROM messages
WHERE sources @> '[{"source": "es.wikipedia.org"}]'::jsonb
ORDER BY created_at DESC
LIMIT 20;

-- Contar mensajes con fuentes
SELECT COUNT(*) FROM messages WHERE sources IS NOT NULL;

-- Ver estructura de un mensaje específico
SELECT id, jsonb_pretty(sources)
FROM messages
WHERE sources IS NOT NULL
LIMIT 1;
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- FIN MIGRACIÓN 001
-- ═══════════════════════════════════════════════════════════════════════════