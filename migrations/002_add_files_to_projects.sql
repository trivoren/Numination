-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION 002 · Add files and metadata to projects
-- ═══════════════════════════════════════════════════════════════════════════
-- Descripción:
--   Agrega columnas a la tabla `projects` para guardar:
--   · files → array de archivos creados por el usuario en modo Coder
--   · language → lenguaje principal del proyecto (detectado automáticamente)
--   · status → estado del proyecto (draft, active, archived)
--   · tags → etiquetas libres para organizar
--   · description → descripción corta
--   · settings → configuración específica (framework, etc)
--
-- Estructura esperada de `files` (JSONB array):
--   [
--     {
--       "name": "app.py",
--       "path": "/app.py",
--       "size": 1234,
--       "language": "python",
--       "created_at": "2026-10-13T15:32:11Z",
--       "updated_at": "2026-10-13T15:35:00Z"
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'projects'
  ) THEN
    RAISE EXCEPTION 'La tabla "projects" no existe. Aplica primero el schema base.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'user_id'
  ) THEN
    RAISE WARNING 'La tabla "projects" no tiene columna "user_id". Verificar schema.';
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 01 · AGREGAR COLUMNAS
-- ═══════════════════════════════════════════════════════════════════════════

-- files: array de archivos del proyecto
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '[]'::jsonb;

-- language: lenguaje principal del proyecto
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT NULL;

-- status: estado del proyecto
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- tags: etiquetas libres
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;

-- description: descripción corta
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL;

-- settings: configuración específica (framework, package manager, etc)
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;

-- created_at y updated_at (si no existen ya)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE projects ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE projects ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 02 · COMENTARIOS DE DOCUMENTACIÓN
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN projects.files IS
  'Array de archivos del proyecto. Estructura: [{name, path, size, language, created_at, updated_at}]';

COMMENT ON COLUMN projects.language IS
  'Lenguaje principal del proyecto (python, javascript, typescript, html, etc).';

COMMENT ON COLUMN projects.status IS
  'Estado del proyecto: draft, active, archived.';

COMMENT ON COLUMN projects.tags IS
  'Etiquetas libres para organizar proyectos. Estructura: ["física", "examen-2026"]';

COMMENT ON COLUMN projects.description IS
  'Descripción corta del proyecto (max 500 caracteres).';

COMMENT ON COLUMN projects.settings IS
  'Configuración específica: {framework: "react", packageManager: "pnpm", ...}';


-- ═══════════════════════════════════════════════════════════════════════════
-- 03 · CONSTRAINTS Y VALIDACIÓN
-- ═══════════════════════════════════════════════════════════════════════════

-- Función que valida la estructura de files
CREATE OR REPLACE FUNCTION validate_project_files(files_json JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
  item_count INTEGER;
  file_name TEXT;
BEGIN
  -- NULL o vacío es válido
  IF files_json IS NULL THEN
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(files_json) <> 'array' THEN
    RETURN FALSE;
  END IF;

  item_count := jsonb_array_length(files_json);
  IF item_count > 500 THEN
    RETURN FALSE;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(files_json)
  LOOP
    IF jsonb_typeof(item) <> 'object' THEN
      RETURN FALSE;
    END IF;

    IF NOT (item ? 'name') THEN
      RETURN FALSE;
    END IF;

    file_name := item ->> 'name';
    IF file_name IS NULL OR length(file_name) = 0 OR length(file_name) > 255 THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION validate_project_files IS
  'Valida que un JSONB de archivos sea array de objetos con {name} no vacío. Max 500 items.';

-- Función que valida tags
CREATE OR REPLACE FUNCTION validate_project_tags(tags_json JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
BEGIN
  IF tags_json IS NULL THEN
    RETURN TRUE;
  END IF;

  IF jsonb_typeof(tags_json) <> 'array' THEN
    RETURN FALSE;
  END IF;

  IF jsonb_array_length(tags_json) > 30 THEN
    RETURN FALSE;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(tags_json)
  LOOP
    IF jsonb_typeof(item) <> 'string' THEN
      RETURN FALSE;
    END IF;
    IF length(item #>> '{}') > 50 THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION validate_project_tags IS
  'Valida que tags sea un array de strings, max 30 items, max 50 chars cada uno.';

-- Constraint: files válido
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_files_valid'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT chk_projects_files_valid
      CHECK (validate_project_files(files));
  END IF;
END $$;

-- Constraint: tags válido
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_tags_valid'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT chk_projects_tags_valid
      CHECK (validate_project_tags(tags));
  END IF;
END $$;

-- Constraint: status válido
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_status_valid'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT chk_projects_status_valid
      CHECK (status IN ('draft', 'active', 'archived'));
  END IF;
END $$;

-- Constraint: description max 500
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_description_length'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT chk_projects_description_length
      CHECK (description IS NULL OR length(description) <= 500);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 04 · TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════

-- Trigger 1: validar files y tags antes de insert/update
CREATE OR REPLACE FUNCTION trg_validate_project_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.files IS NOT NULL AND NOT validate_project_files(NEW.files) THEN
    RAISE EXCEPTION 'Estructura inválida en projects.files. Debe ser array de objetos con {name}.';
  END IF;

  IF NEW.tags IS NOT NULL AND NOT validate_project_tags(NEW.tags) THEN
    RAISE EXCEPTION 'Estructura inválida en projects.tags. Debe ser array de strings.';
  END IF;

  IF NEW.description IS NOT NULL AND length(NEW.description) > 500 THEN
    RAISE EXCEPTION 'Descripción demasiado larga (max 500 caracteres).';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_validate ON projects;

CREATE TRIGGER trg_projects_validate
  BEFORE INSERT OR UPDATE OF files, tags, description ON projects
  FOR EACH ROW
  EXECUTE FUNCTION trg_validate_project_fields();

-- Trigger 2: auto-actualizar updated_at
CREATE OR REPLACE FUNCTION trg_projects_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION trg_projects_updated_at();

-- Trigger 3: auto-detectar language desde los archivos
CREATE OR REPLACE FUNCTION trg_projects_detect_language()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ext TEXT;
  detected TEXT;
  file_item JSONB;
BEGIN
  -- Solo auto-detectar si language es NULL y hay archivos
  IF NEW.language IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.files IS NULL OR jsonb_array_length(NEW.files) = 0 THEN
    RETURN NEW;
  END IF;

  -- Tomar el primer archivo y detectar por extensión
  file_item := NEW.files -> 0;
  ext := lower(split_part(file_item ->> 'name', '.', -1));

  detected := CASE ext
    WHEN 'py'   THEN 'python'
    WHEN 'js'   THEN 'javascript'
    WHEN 'mjs'  THEN 'javascript'
    WHEN 'cjs'  THEN 'javascript'
    WHEN 'ts'   THEN 'typescript'
    WHEN 'tsx'  THEN 'typescript'
    WHEN 'jsx'  THEN 'javascript'
    WHEN 'html' THEN 'html'
    WHEN 'htm'  THEN 'html'
    WHEN 'css'  THEN 'css'
    WHEN 'scss' THEN 'css'
    WHEN 'sass' THEN 'css'
    WHEN 'json' THEN 'json'
    WHEN 'md'   THEN 'markdown'
    WHEN 'sql'  THEN 'sql'
    WHEN 'java' THEN 'java'
    WHEN 'c'    THEN 'c'
    WHEN 'cpp'  THEN 'cpp'
    WHEN 'cs'   THEN 'csharp'
    WHEN 'go'   THEN 'go'
    WHEN 'rb'   THEN 'ruby'
    WHEN 'php'  THEN 'php'
    WHEN 'rs'   THEN 'rust'
    WHEN 'swift' THEN 'swift'
    WHEN 'kt'   THEN 'kotlin'
    WHEN 'sh'   THEN 'shell'
    WHEN 'yml'  THEN 'yaml'
    WHEN 'yaml' THEN 'yaml'
    ELSE NULL
  END;

  IF detected IS NOT NULL THEN
    NEW.language := detected;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_detect_language ON projects;

CREATE TRIGGER trg_projects_detect_language
  BEFORE INSERT OR UPDATE OF files ON projects
  FOR EACH ROW
  EXECUTE FUNCTION trg_projects_detect_language();


-- ═══════════════════════════════════════════════════════════════════════════
-- 05 · ÍNDICES
-- ═══════════════════════════════════════════════════════════════════════════

-- GIN sobre files para buscar proyectos que contienen cierto archivo
CREATE INDEX IF NOT EXISTS idx_projects_files_gin
  ON projects USING GIN (files)
  WHERE jsonb_array_length(files) > 0;

-- GIN sobre tags para filtrar proyectos por etiqueta
CREATE INDEX IF NOT EXISTS idx_projects_tags_gin
  ON projects USING GIN (tags)
  WHERE jsonb_array_length(tags) > 0;

-- GIN sobre settings para queries específicas
CREATE INDEX IF NOT EXISTS idx_projects_settings_gin
  ON projects USING GIN (settings)
  WHERE settings <> '{}'::jsonb;

-- B-tree sobre language
CREATE INDEX IF NOT EXISTS idx_projects_language
  ON projects (language)
  WHERE language IS NOT NULL;

-- B-tree sobre status
CREATE INDEX IF NOT EXISTS idx_projects_status
  ON projects (status, updated_at DESC);

-- Índice por cantidad de archivos
CREATE INDEX IF NOT EXISTS idx_projects_files_count
  ON projects ((jsonb_array_length(files)))
  WHERE jsonb_array_length(files) > 0;

-- Índice temporal
CREATE INDEX IF NOT EXISTS idx_projects_updated_at
  ON projects (updated_at DESC);

-- Índice por user + status (query muy común)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'user_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_projects_user_status
      ON projects (user_id, status, updated_at DESC);
  END IF;
END $$;

COMMENT ON INDEX idx_projects_files_gin IS
  'Buscar proyectos que contienen cierta ruta o nombre de archivo.';

COMMENT ON INDEX idx_projects_tags_gin IS
  'Buscar proyectos por etiqueta (ej: proyectos con tag "física").';


-- ═══════════════════════════════════════════════════════════════════════════
-- 06 · VISTAS DE CONSULTA
-- ═══════════════════════════════════════════════════════════════════════════

-- Vista: proyectos con metadata resumida
CREATE OR REPLACE VIEW v_projects_summary AS
SELECT
  p.id,
  p.user_id,
  p.name,
  p.description,
  p.language,
  p.status,
  p.tags,
  jsonb_array_length(p.files) AS file_count,
  p.created_at,
  p.updated_at,
  EXTRACT(EPOCH FROM (p.updated_at - p.created_at))::INTEGER AS age_seconds
FROM projects p
ORDER BY p.updated_at DESC;

COMMENT ON VIEW v_projects_summary IS
  'Vista resumida de proyectos con conteo de archivos y edad.';

-- Vista: proyectos activos con archivos
CREATE OR REPLACE VIEW v_projects_active_with_files AS
SELECT
  p.id,
  p.user_id,
  p.name,
  p.language,
  p.files,
  jsonb_array_length(p.files) AS file_count,
  p.updated_at
FROM projects p
WHERE p.status = 'active'
  AND jsonb_array_length(p.files) > 0
ORDER BY p.updated_at DESC;

-- Vista: lenguajes más usados
CREATE OR REPLACE VIEW v_projects_language_stats AS
SELECT
  language,
  COUNT(*) AS project_count,
  COUNT(DISTINCT user_id) AS unique_users,
  AVG(jsonb_array_length(files))::NUMERIC(10,2) AS avg_files_per_project
FROM projects
WHERE language IS NOT NULL
GROUP BY language
ORDER BY project_count DESC;

COMMENT ON VIEW v_projects_language_stats IS
  'Ranking de lenguajes más usados en proyectos.';

-- Vista: top tags
CREATE OR REPLACE VIEW v_projects_tags_ranking AS
SELECT
  tag,
  COUNT(*) AS project_count
FROM projects
CROSS JOIN LATERAL jsonb_array_elements_text(tags) AS tag
WHERE jsonb_array_length(tags) > 0
GROUP BY tag
ORDER BY project_count DESC;

COMMENT ON VIEW v_projects_tags_ranking IS
  'Ranking de tags más usados.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 07 · FUNCIONES DE UTILIDAD
-- ═══════════════════════════════════════════════════════════════════════════

-- Agrega un archivo a un proyecto (evita duplicados por nombre)
CREATE OR REPLACE FUNCTION add_file_to_project(
  project_id UUID,
  file_name TEXT,
  file_size INTEGER DEFAULT NULL,
  file_language TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  current_files JSONB;
  new_file JSONB;
  existing_idx INTEGER;
BEGIN
  -- Verificar que el proyecto existe
  SELECT files INTO current_files
  FROM projects
  WHERE id = project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proyecto % no encontrado', project_id;
  END IF;

  IF current_files IS NULL THEN
    current_files := '[]'::jsonb;
  END IF;

  -- Crear el nuevo archivo
  new_file := jsonb_build_object(
    'name', file_name,
    'size', COALESCE(file_size, 0),
    'language', COALESCE(file_language, 'unknown'),
    'created_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'updated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );

  -- Buscar si ya existe (por nombre)
  SELECT (jsonb_array_length(current_files) - 1) - idx
  INTO existing_idx
  FROM jsonb_array_elements(current_files) WITH ORDINALITY AS arr(elem, idx)
  WHERE elem ->> 'name' = file_name
  ORDER BY idx DESC
  LIMIT 1;

  IF existing_idx IS NOT NULL THEN
    -- Reemplazar
    current_files := jsonb_set(current_files, ARRAY[existing_idx::text], new_file);
  ELSE
    -- Agregar al final
    current_files := current_files || jsonb_build_array(new_file);
  END IF;

  UPDATE projects SET files = current_files WHERE id = project_id;

  RETURN new_file;
END;
$$;

COMMENT ON FUNCTION add_file_to_project IS
  'Agrega o actualiza un archivo en un proyecto. Devuelve el archivo creado.';

-- Remueve un archivo de un proyecto
CREATE OR REPLACE FUNCTION remove_file_from_project(
  project_id UUID,
  file_name TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  current_files JSONB;
  new_files JSONB;
BEGIN
  SELECT files INTO current_files
  FROM projects
  WHERE id = project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  SELECT jsonb_agg(elem)
  INTO new_files
  FROM jsonb_array_elements(current_files) AS elem
  WHERE elem ->> 'name' <> file_name;

  IF new_files IS NULL THEN
    new_files := '[]'::jsonb;
  END IF;

  UPDATE projects SET files = new_files WHERE id = project_id;
  RETURN TRUE;
END;
$$;

-- Agrega un tag al proyecto (si no existe)
CREATE OR REPLACE FUNCTION add_tag_to_project(
  project_id UUID,
  tag_name TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  current_tags JSONB;
BEGIN
  IF tag_name IS NULL OR length(tag_name) = 0 OR length(tag_name) > 50 THEN
    RAISE EXCEPTION 'Tag inválido (1-50 caracteres)';
  END IF;

  SELECT tags INTO current_tags
  FROM projects
  WHERE id = project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF current_tags IS NULL THEN
    current_tags := '[]'::jsonb;
  END IF;

  -- Verificar si ya existe
  IF current_tags @> to_jsonb(tag_name::text) THEN
    RETURN TRUE;
  END IF;

  UPDATE projects
  SET tags = current_tags || jsonb_build_array(tag_name)
  WHERE id = project_id;

  RETURN TRUE;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 08 · MIGRAR DATOS EXISTENTES
-- ═══════════════════════════════════════════════════════════════════════════

-- Asegurar que todos los proyectos tengan files = '[]' si es NULL
UPDATE projects
SET files = '[]'::jsonb
WHERE files IS NULL;

-- Asegurar que todos tengan tags = '[]' si es NULL
UPDATE projects
SET tags = '[]'::jsonb
WHERE tags IS NULL;

-- Asegurar que todos tengan settings = '{}' si es NULL
UPDATE projects
SET settings = '{}'::jsonb
WHERE settings IS NULL;

-- Status por defecto si es NULL
UPDATE projects
SET status = 'active'
WHERE status IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 09 · REGISTRAR MIGRACIÓN
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO schema_migrations (version, name, checksum, meta)
VALUES (
  '002',
  'add_files_to_projects',
  'v1_20261013_initial',
  jsonb_build_object(
    'table', 'projects',
    'columns', jsonb_build_array('files', 'language', 'status', 'tags', 'description', 'settings'),
    'rollback_available', true
  )
)
ON CONFLICT (version) DO UPDATE SET
  applied_at = NOW(),
  meta = schema_migrations.meta || EXCLUDED.meta;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10 · TESTS DE VERIFICACIÓN
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  missing_cols TEXT[];
BEGIN
  SELECT ARRAY_AGG(c) INTO missing_cols
  FROM unnest(ARRAY['files', 'language', 'status', 'tags', 'description', 'settings']) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = c
  );

  IF missing_cols IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: faltan columnas %', missing_cols;
  END IF;
  RAISE NOTICE '✓ Test 1: todas las columnas existen';
END $$;

DO $$
BEGIN
  IF NOT validate_project_files('[]'::jsonb) THEN
    RAISE EXCEPTION 'TEST FAILED: array vacío debería ser válido';
  END IF;
  IF NOT validate_project_files('[{"name":"app.py"}]'::jsonb) THEN
    RAISE EXCEPTION 'TEST FAILED: array con un archivo válido debería pasar';
  END IF;
  IF validate_project_files('[{"size":100}]'::jsonb) THEN
    RAISE EXCEPTION 'TEST FAILED: archivo sin name debería fallar';
  END IF;
  RAISE NOTICE '✓ Test 2: validate_project_files funciona';
END $$;

DO $$
BEGIN
  IF NOT validate_project_tags('["física","examen"]'::jsonb) THEN
    RAISE EXCEPTION 'TEST FAILED: tags válidos rechazados';
  END IF;
  IF validate_project_tags('[{"not":"a string"}]'::jsonb) THEN
    RAISE EXCEPTION 'TEST FAILED: tags con objeto debería rechazar';
  END IF;
  RAISE NOTICE '✓ Test 3: validate_project_tags funciona';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_validate'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: trigger de validación no existe';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_updated_at'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: trigger de updated_at no existe';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_detect_language'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: trigger de detección de lenguaje no existe';
  END IF;
  RAISE NOTICE '✓ Test 4: los 3 triggers existen';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_projects_files_gin'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: idx_projects_files_gin no existe';
  END IF;
  RAISE NOTICE '✓ Test 5: índices principales creados';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'v_projects_summary'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: vistas no creadas';
  END IF;
  RAISE NOTICE '✓ Test 6: vistas creadas';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'add_file_to_project'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: función add_file_to_project no existe';
  END IF;
  RAISE NOTICE '✓ Test 7: funciones auxiliares creadas';
END $$;

RAISE NOTICE '════════════════════════════════════════════════';
RAISE NOTICE 'MIGRACIÓN 002 COMPLETADA EXITOSAMENTE';
RAISE NOTICE '════════════════════════════════════════════════';


-- ═══════════════════════════════════════════════════════════════════════════
-- 11 · ROLLBACK (descomentar y ejecutar solo si querés revertir)
-- ═══════════════════════════════════════════════════════════════════════════

/*
BEGIN;

-- 1. Borrar triggers
DROP TRIGGER IF EXISTS trg_projects_detect_language ON projects;
DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
DROP TRIGGER IF EXISTS trg_projects_validate ON projects;

-- 2. Borrar funciones trigger
DROP FUNCTION IF EXISTS trg_projects_detect_language();
DROP FUNCTION IF EXISTS trg_projects_updated_at();
DROP FUNCTION IF EXISTS trg_validate_project_fields();

-- 3. Borrar funciones auxiliares
DROP FUNCTION IF EXISTS add_tag_to_project(UUID, TEXT);
DROP FUNCTION IF EXISTS remove_file_from_project(UUID, TEXT);
DROP FUNCTION IF EXISTS add_file_to_project(UUID, TEXT, INTEGER, TEXT);

-- 4. Borrar funciones de validación
DROP FUNCTION IF EXISTS validate_project_tags(JSONB);
DROP FUNCTION IF EXISTS validate_project_files(JSONB);

-- 5. Borrar vistas
DROP VIEW IF EXISTS v_projects_tags_ranking;
DROP VIEW IF EXISTS v_projects_language_stats;
DROP VIEW IF EXISTS v_projects_active_with_files;
DROP VIEW IF EXISTS v_projects_summary;

-- 6. Borrar constraints
ALTER TABLE projects DROP CONSTRAINT IF EXISTS chk_projects_description_length;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS chk_projects_status_valid;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS chk_projects_tags_valid;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS chk_projects_files_valid;

-- 7. Borrar índices
DROP INDEX IF EXISTS idx_projects_user_status;
DROP INDEX IF EXISTS idx_projects_updated_at;
DROP INDEX IF EXISTS idx_projects_files_count;
DROP INDEX IF EXISTS idx_projects_status;
DROP INDEX IF EXISTS idx_projects_language;
DROP INDEX IF EXISTS idx_projects_settings_gin;
DROP INDEX IF EXISTS idx_projects_tags_gin;
DROP INDEX IF EXISTS idx_projects_files_gin;

-- 8. Borrar columnas
ALTER TABLE projects DROP COLUMN IF EXISTS settings;
ALTER TABLE projects DROP COLUMN IF EXISTS description;
ALTER TABLE projects DROP COLUMN IF EXISTS tags;
ALTER TABLE projects DROP COLUMN IF EXISTS status;
ALTER TABLE projects DROP COLUMN IF EXISTS language;
ALTER TABLE projects DROP COLUMN IF EXISTS files;

-- 9. Borrar registro
DELETE FROM schema_migrations WHERE version = '002';

COMMIT;
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- 12 · QUERIES ÚTILES POST-MIGRACIÓN (para debugging manual)
-- ═══════════════════════════════════════════════════════════════════════════

/*
-- Ver proyectos con resumen
SELECT * FROM v_projects_summary LIMIT 20;

-- Proyectos activos con archivos
SELECT * FROM v_projects_active_with_files LIMIT 10;

-- Top lenguajes
SELECT * FROM v_projects_language_stats;

-- Top tags
SELECT * FROM v_projects_tags_ranking LIMIT 20;

-- Proyectos con más de 5 archivos
SELECT id, name, jsonb_array_length(files) AS file_count
FROM projects
WHERE jsonb_array_length(files) > 5
ORDER BY file_count DESC;

-- Buscar proyectos que contienen un archivo específico
SELECT id, name, files
FROM projects
WHERE files @> '[{"name": "app.py"}]'::jsonb;

-- Proyectos con tag "física"
SELECT id, name, tags
FROM projects
WHERE tags @> '["física"]'::jsonb;

-- Agregar archivo manualmente (test de función)
-- SELECT add_file_to_project(
--   'tu-project-uuid-aca'::uuid,
--   'main.py',
--   1024,
--   'python'
-- );

-- Ver un proyecto específico con JSON bonito
SELECT id, name, jsonb_pretty(files) AS files_pretty
FROM projects
LIMIT 1;
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- FIN MIGRACIÓN 002
-- ═══════════════════════════════════════════════════════════════════════════