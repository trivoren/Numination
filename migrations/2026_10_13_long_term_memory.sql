-- ═══════════════════════════════════════════════════════════════════════════
-- Long-term memory · pgvector + columnas nuevas
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Extensión vector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Columnas nuevas en Memory
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='Memory' AND column_name='embedding') THEN
    ALTER TABLE "Memory" ADD COLUMN embedding vector(1536);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='Memory' AND column_name='category') THEN
    ALTER TABLE "Memory" ADD COLUMN category TEXT DEFAULT 'other';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='Memory' AND column_name='importance') THEN
    ALTER TABLE "Memory" ADD COLUMN importance FLOAT DEFAULT 0.5;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='Memory' AND column_name='access_count') THEN
    ALTER TABLE "Memory" ADD COLUMN access_count INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='Memory' AND column_name='last_accessed_at') THEN
    ALTER TABLE "Memory" ADD COLUMN last_accessed_at TIMESTAMPTZ DEFAULT NOW();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='Memory' AND column_name='meta') THEN
    ALTER TABLE "Memory" ADD COLUMN meta JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- 3. Índices
CREATE INDEX IF NOT EXISTS idx_memory_category ON "Memory" (category);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON "Memory" (importance DESC);
CREATE INDEX IF NOT EXISTS idx_memory_last_accessed ON "Memory" (last_accessed_at DESC);

-- 4. Índice ivfflat para búsqueda rápida (cosine)
--    Se crea DESPUÉS de insertar datos (necesita filas para entrenar)
--    Si la tabla está vacía, crear el índice igual funciona pero será menos eficiente.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memory_embedding') THEN
    CREATE INDEX idx_memory_embedding ON "Memory"
      USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'No se pudo crear ivfflat (quizás tabla vacía). Se puede crear después.';
END $$;

-- 5. RPC: match_memories
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  p_user_id text
)
RETURNS TABLE (
  id text,
  "userId" text,
  content text,
  category text,
  importance float,
  access_count int,
  last_accessed_at timestamptz,
  "createdAt" timestamptz,
  meta jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m."userId",
    m.content,
    m.category,
    m.importance,
    m.access_count,
    m.last_accessed_at,
    m."createdAt",
    m.meta,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM "Memory" m
  WHERE m."userId" = p_user_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 6. RPC: increment_memory_access
CREATE OR REPLACE FUNCTION increment_memory_access(
  p_user_id text,
  p_ids text[]
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "Memory"
  SET access_count = access_count + 1,
      last_accessed_at = NOW()
  WHERE "userId" = p_user_id
    AND id = ANY(p_ids);
END;
$$;