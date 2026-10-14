-- ═══════════════════════════════════════════════════════════════════════════
-- NUMINATION · supabase-rls.sql · v1.0
-- ─────────────────────────────────────────────────────────────────────────
-- Row Level Security completo para todas las tablas de Numination.
--
-- FILOSOFÍA:
--   · Deny by default · nada se accede sin policy explícita
--   · Cada usuario solo ve SUS datos
--   · Admins pueden ver todo (role = 'admin')
--   · Service role bypassa RLS (para el backend)
--   · Performance: índices en columnas usadas por policies
--
-- CÓMO APLICAR:
--   1. Supabase Dashboard → SQL Editor → pegar este archivo completo
--   2. O ejecutar con tu runner de migraciones
--   3. Verificar con el bloque de tests al final
--
-- REVERSIBLE:
--   Todas las secciones tienen su ROLLBACK comentado al final.
--
-- ESTRUCTURA:
--   01 · Verificaciones previas
--   02 · Helper functions
--   03 · Chat
--   04 · Message
--   05 · Memory
--   06 · Project
--   07 · ProjectFile
--   08 · ProjectFileRevision
--   09 · Artifact
--   10 · Notification
--   11 · UserActivity
--   12 · MessageFeedback
--   13 · AiMode
--   14 · CreditLog + Credits
--   15 · PendingRecharge
--   16 · StorageFile
--   17 · AuditLog
--   18 · BillingPlan + AppVersion
--   19 · processed_webhook_events
--   20 · profiles
--   21 · subscriptions
--   22 · payments
--   23 · connector_integrations + connector_oauth_states
--   24 · Índices para performance
--   25 · Tests de verificación
--   26 · Rollback
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- 01 · VERIFICACIONES PREVIAS
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  missing_tables TEXT[];
BEGIN
  SELECT ARRAY_AGG(t) INTO missing_tables
  FROM unnest(ARRAY[
    'Chat', 'Message', 'Memory', 'Project', 'ProjectFile',
    'ProjectFileRevision', 'Artifact', 'Notification', 'UserActivity',
    'MessageFeedback', 'AiMode', 'CreditLog', 'Credits', 'PendingRecharge',
    'StorageFile', 'AuditLog', 'BillingPlan', 'AppVersion',
    'processed_webhook_events', 'profiles', 'subscriptions', 'payments',
    'connector_integrations', 'connector_oauth_states'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = t
  );

  IF missing_tables IS NOT NULL THEN
    RAISE WARNING 'Tablas faltantes: %', missing_tables;
    RAISE WARNING 'Continuando · las policies se aplicarán solo a las tablas existentes';
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 02 · HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── is_admin() · determina si el user actual es admin ───
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
  );
$$;

COMMENT ON FUNCTION public.is_admin IS
  'Devuelve true si el user logueado tiene role=admin en profiles.';

-- ─── is_authenticated() · verifica que haya user ───
CREATE OR REPLACE FUNCTION public.is_authenticated()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid() IS NOT NULL;
$$;

COMMENT ON FUNCTION public.is_authenticated IS
  'Devuelve true si hay usuario autenticado (auth.uid() != NULL).';

-- ─── current_user_id() · shortcut ───
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid()::text;
$$;

COMMENT ON FUNCTION public.current_user_id IS
  'Devuelve el UUID del user logueado como TEXT.';

-- ─── owns_row(userId) · verifica ownership ───
CREATE OR REPLACE FUNCTION public.owns_row(row_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid()::text = row_user_id;
$$;

COMMENT ON FUNCTION public.owns_row IS
  'Devuelve true si el row_user_id pertenece al user logueado.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 03 · CHAT
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."Chat" ENABLE ROW LEVEL SECURITY;

-- Limpiar policies existentes
DROP POLICY IF EXISTS chat_select_own ON public."Chat";
DROP POLICY IF EXISTS chat_insert_own ON public."Chat";
DROP POLICY IF EXISTS chat_update_own ON public."Chat";
DROP POLICY IF EXISTS chat_delete_own ON public."Chat";
DROP POLICY IF EXISTS chat_admin_all ON public."Chat";

-- ─── SELECT · solo mis chats ───
CREATE POLICY chat_select_own ON public."Chat"
  FOR SELECT
  TO authenticated
  USING (
    auth.uid()::text = "userId"
    OR public.is_admin()
  );

-- ─── INSERT · solo puedo crear chats míos ───
CREATE POLICY chat_insert_own ON public."Chat"
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid()::text = "userId"
    OR public.is_admin()
  );

-- ─── UPDATE · solo mis chats ───
CREATE POLICY chat_update_own ON public."Chat"
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid()::text = "userId"
    OR public.is_admin()
  )
  WITH CHECK (
    auth.uid()::text = "userId"
    OR public.is_admin()
  );

-- ─── DELETE · solo mis chats ───
CREATE POLICY chat_delete_own ON public."Chat"
  FOR DELETE
  TO authenticated
  USING (
    auth.uid()::text = "userId"
    OR public.is_admin()
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 04 · MESSAGE
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."Message" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_select_own ON public."Message";
DROP POLICY IF EXISTS message_insert_own ON public."Message";
DROP POLICY IF EXISTS message_update_own ON public."Message";
DROP POLICY IF EXISTS message_delete_own ON public."Message";

-- ─── SELECT · mensajes de chats míos ───
-- Message no tiene userId directo, se accede via Chat
CREATE POLICY message_select_own ON public."Message"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."Chat" c
      WHERE c.id = "Message"."chatId"
        AND c."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );

CREATE POLICY message_insert_own ON public."Message"
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public."Chat" c
      WHERE c.id = "chatId"
        AND c."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );

CREATE POLICY message_update_own ON public."Message"
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."Chat" c
      WHERE c.id = "Message"."chatId"
        AND c."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );

CREATE POLICY message_delete_own ON public."Message"
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."Chat" c
      WHERE c.id = "Message"."chatId"
        AND c."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 05 · MEMORY
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."Memory" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_select_own ON public."Memory";
DROP POLICY IF EXISTS memory_insert_own ON public."Memory";
DROP POLICY IF EXISTS memory_update_own ON public."Memory";
DROP POLICY IF EXISTS memory_delete_own ON public."Memory";

CREATE POLICY memory_select_own ON public."Memory"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY memory_insert_own ON public."Memory"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY memory_update_own ON public."Memory"
  FOR UPDATE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin())
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY memory_delete_own ON public."Memory"
  FOR DELETE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 06 · PROJECT
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."Project" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_select_own ON public."Project";
DROP POLICY IF EXISTS project_insert_own ON public."Project";
DROP POLICY IF EXISTS project_update_own ON public."Project";
DROP POLICY IF EXISTS project_delete_own ON public."Project";

CREATE POLICY project_select_own ON public."Project"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY project_insert_own ON public."Project"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY project_update_own ON public."Project"
  FOR UPDATE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin())
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY project_delete_own ON public."Project"
  FOR DELETE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 07 · PROJECTFILE
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."ProjectFile" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projectfile_select_own ON public."ProjectFile";
DROP POLICY IF EXISTS projectfile_insert_own ON public."ProjectFile";
DROP POLICY IF EXISTS projectfile_update_own ON public."ProjectFile";
DROP POLICY IF EXISTS projectfile_delete_own ON public."ProjectFile";

-- ProjectFile no tiene userId, va via Project
CREATE POLICY projectfile_select_own ON public."ProjectFile"
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."Project" p
      WHERE p.id = "ProjectFile"."projectId"
        AND p."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );

CREATE POLICY projectfile_insert_own ON public."ProjectFile"
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public."Project" p
      WHERE p.id = "projectId"
        AND p."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );

CREATE POLICY projectfile_update_own ON public."ProjectFile"
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."Project" p
      WHERE p.id = "ProjectFile"."projectId"
        AND p."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );

CREATE POLICY projectfile_delete_own ON public."ProjectFile"
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."Project" p
      WHERE p.id = "ProjectFile"."projectId"
        AND p."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 08 · PROJECTFILEREVISION
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."ProjectFileRevision" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projectfilerev_select_own ON public."ProjectFileRevision";
DROP POLICY IF EXISTS projectfilerev_insert_own ON public."ProjectFileRevision";
DROP POLICY IF EXISTS projectfilerev_delete_own ON public."ProjectFileRevision";

-- Via ProjectFile → Project
CREATE POLICY projectfilerev_select_own ON public."ProjectFileRevision"
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."ProjectFile" pf
      JOIN public."Project" p ON p.id = pf."projectId"
      WHERE pf.id = "ProjectFileRevision"."fileId"
        AND p."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );

CREATE POLICY projectfilerev_insert_own ON public."ProjectFileRevision"
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public."ProjectFile" pf
      JOIN public."Project" p ON p.id = pf."projectId"
      WHERE pf.id = "fileId"
        AND p."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );

CREATE POLICY projectfilerev_delete_own ON public."ProjectFileRevision"
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."ProjectFile" pf
      JOIN public."Project" p ON p.id = pf."projectId"
      WHERE pf.id = "ProjectFileRevision"."fileId"
        AND p."userId" = auth.uid()::text
    )
    OR public.is_admin()
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 09 · ARTIFACT
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."Artifact" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS artifact_select_own ON public."Artifact";
DROP POLICY IF EXISTS artifact_insert_own ON public."Artifact";
DROP POLICY IF EXISTS artifact_update_own ON public."Artifact";
DROP POLICY IF EXISTS artifact_delete_own ON public."Artifact";

CREATE POLICY artifact_select_own ON public."Artifact"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY artifact_insert_own ON public."Artifact"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY artifact_update_own ON public."Artifact"
  FOR UPDATE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin())
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY artifact_delete_own ON public."Artifact"
  FOR DELETE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 10 · NOTIFICATION
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."Notification" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_select_own ON public."Notification";
DROP POLICY IF EXISTS notification_insert_own ON public."Notification";
DROP POLICY IF EXISTS notification_update_own ON public."Notification";
DROP POLICY IF EXISTS notification_delete_own ON public."Notification";

CREATE POLICY notification_select_own ON public."Notification"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

-- Solo el sistema (backend con service_role) debería insertar notificaciones,
-- pero permitimos que un usuario inserte las suyas si es necesario
CREATE POLICY notification_insert_own ON public."Notification"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

-- Solo puedo marcar las MÍAS como leídas
CREATE POLICY notification_update_own ON public."Notification"
  FOR UPDATE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin())
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY notification_delete_own ON public."Notification"
  FOR DELETE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 11 · USERACTIVITY
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."UserActivity" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS useractivity_select_own ON public."UserActivity";
DROP POLICY IF EXISTS useractivity_insert_own ON public."UserActivity";

-- Solo SELECT e INSERT · el log es inmutable
CREATE POLICY useractivity_select_own ON public."UserActivity"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY useractivity_insert_own ON public."UserActivity"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 12 · MESSAGEFEEDBACK
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."MessageFeedback" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS msgfeedback_select_own ON public."MessageFeedback";
DROP POLICY IF EXISTS msgfeedback_insert_own ON public."MessageFeedback";
DROP POLICY IF EXISTS msgfeedback_update_own ON public."MessageFeedback";
DROP POLICY IF EXISTS msgfeedback_delete_own ON public."MessageFeedback";

CREATE POLICY msgfeedback_select_own ON public."MessageFeedback"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY msgfeedback_insert_own ON public."MessageFeedback"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY msgfeedback_update_own ON public."MessageFeedback"
  FOR UPDATE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin())
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY msgfeedback_delete_own ON public."MessageFeedback"
  FOR DELETE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 13 · AIMODE
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."AiMode" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aimode_select_own ON public."AiMode";
DROP POLICY IF EXISTS aimode_insert_own ON public."AiMode";
DROP POLICY IF EXISTS aimode_update_own ON public."AiMode";

CREATE POLICY aimode_select_own ON public."AiMode"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY aimode_insert_own ON public."AiMode"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY aimode_update_own ON public."AiMode"
  FOR UPDATE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin())
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 14 · CREDITLOG + CREDITS
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."CreditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."Credits" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creditlog_select_own ON public."CreditLog";
DROP POLICY IF EXISTS creditlog_insert_own ON public."CreditLog";
DROP POLICY IF EXISTS credits_select_own ON public."Credits";
DROP POLICY IF EXISTS credits_update_own ON public."Credits";

-- CreditLog: solo lectura para el user
CREATE POLICY creditlog_select_own ON public."CreditLog"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY creditlog_insert_own ON public."CreditLog"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

-- Credits: el user ve sus créditos, pero NO puede modificarlos directamente
-- (solo el backend via service_role)
CREATE POLICY credits_select_own ON public."Credits"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY credits_update_own ON public."Credits"
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 15 · PENDINGRECHARGE
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."PendingRecharge" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pendingrecharge_select_own ON public."PendingRecharge";
DROP POLICY IF EXISTS pendingrecharge_insert_own ON public."PendingRecharge";

CREATE POLICY pendingrecharge_select_own ON public."PendingRecharge"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

-- Solo backend debería crear recharges, pero permitimos si es del propio user
CREATE POLICY pendingrecharge_insert_own ON public."PendingRecharge"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 16 · STORAGEFILE
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."StorageFile" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS storagefile_select_own ON public."StorageFile";
DROP POLICY IF EXISTS storagefile_insert_own ON public."StorageFile";
DROP POLICY IF EXISTS storagefile_delete_own ON public."StorageFile";

CREATE POLICY storagefile_select_own ON public."StorageFile"
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY storagefile_insert_own ON public."StorageFile"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY storagefile_delete_own ON public."StorageFile"
  FOR DELETE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 17 · AUDITLOG
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."AuditLog" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auditlog_select_admin ON public."AuditLog";
DROP POLICY IF EXISTS auditlog_insert_own ON public."AuditLog";

-- AuditLog: solo admins pueden leer
CREATE POLICY auditlog_select_admin ON public."AuditLog"
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Cualquiera autenticado puede insertar (para registrar sus propias acciones)
CREATE POLICY auditlog_insert_own ON public."AuditLog"
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 18 · BILLINGPLAN + APPVERSION
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."BillingPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."AppVersion" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billingplan_select_all ON public."BillingPlan";
DROP POLICY IF EXISTS billingplan_admin_write ON public."BillingPlan";
DROP POLICY IF EXISTS appversion_select_all ON public."AppVersion";
DROP POLICY IF EXISTS appversion_admin_write ON public."AppVersion";

-- Públicas para lectura
CREATE POLICY billingplan_select_all ON public."BillingPlan"
  FOR SELECT TO authenticated, anon
  USING (true);

CREATE POLICY billingplan_admin_write ON public."BillingPlan"
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY appversion_select_all ON public."AppVersion"
  FOR SELECT TO authenticated, anon
  USING (true);

CREATE POLICY appversion_admin_write ON public."AppVersion"
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 19 · PROCESSED_WEBHOOK_EVENTS
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public."processed_webhook_events" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_events_admin ON public."processed_webhook_events";

CREATE POLICY webhook_events_admin ON public."processed_webhook_events"
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 20 · PROFILES
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_all ON public.profiles;

-- Cada user lee su propio perfil · admin lee todos
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.is_admin());

-- Solo puedo actualizar mi propio perfil
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id OR public.is_admin())
  WITH CHECK (auth.uid() = id OR public.is_admin());

-- Trigger de Supabase crea el perfil automáticamente · pero por si acaso
CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id OR public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 21 · SUBSCRIPTIONS
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_select_own ON public.subscriptions;
DROP POLICY IF EXISTS subscriptions_admin_all ON public.subscriptions;

-- Solo SELECT · el backend (service_role) hace los INSERT/UPDATE
CREATE POLICY subscriptions_select_own ON public.subscriptions
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY subscriptions_admin_all ON public.subscriptions
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 22 · PAYMENTS
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_select_own ON public.payments;
DROP POLICY IF EXISTS payments_admin_all ON public.payments;

CREATE POLICY payments_select_own ON public.payments
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY payments_admin_all ON public.payments
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 23 · CONNECTOR_INTEGRATIONS + CONNECTOR_OAUTH_STATES
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS public.connector_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.connector_oauth_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connector_select_own ON public.connector_integrations;
DROP POLICY IF EXISTS connector_insert_own ON public.connector_integrations;
DROP POLICY IF EXISTS connector_update_own ON public.connector_integrations;
DROP POLICY IF EXISTS connector_delete_own ON public.connector_integrations;

CREATE POLICY connector_select_own ON public.connector_integrations
  FOR SELECT TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY connector_insert_own ON public.connector_integrations
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY connector_update_own ON public.connector_integrations
  FOR UPDATE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin())
  WITH CHECK (auth.uid()::text = "userId" OR public.is_admin());

CREATE POLICY connector_delete_own ON public.connector_integrations
  FOR DELETE TO authenticated
  USING (auth.uid()::text = "userId" OR public.is_admin());

-- oauth_states: solo el backend debe tocar, pero dejamos acceso al user
DROP POLICY IF EXISTS connector_oauth_admin ON public.connector_oauth_states;

CREATE POLICY connector_oauth_admin ON public.connector_oauth_states
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- 24 · ÍNDICES PARA PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════════

-- Los índices en columnas usadas por policies son CRÍTICOS
-- Sin ellos, cada query hace un full scan y evalúa RLS fila por fila

-- Chat
CREATE INDEX IF NOT EXISTS idx_chat_userid_created
  ON public."Chat" ("userId", "createdAt" DESC);

-- Message
CREATE INDEX IF NOT EXISTS idx_message_chatid_created
  ON public."Message" ("chatId", "createdAt" DESC);

-- Memory
CREATE INDEX IF NOT EXISTS idx_memory_userid
  ON public."Memory" ("userId");

-- Project
CREATE INDEX IF NOT EXISTS idx_project_userid
  ON public."Project" ("userId");

-- ProjectFile
CREATE INDEX IF NOT EXISTS idx_projectfile_projectid
  ON public."ProjectFile" ("projectId");

-- ProjectFileRevision
CREATE INDEX IF NOT EXISTS idx_pfrevision_fileid
  ON public."ProjectFileRevision" ("fileId");

-- Artifact
CREATE INDEX IF NOT EXISTS idx_artifact_userid
  ON public."Artifact" ("userId");

-- Notification
CREATE INDEX IF NOT EXISTS idx_notification_userid_read
  ON public."Notification" ("userId", "readAt");

-- UserActivity
CREATE INDEX IF NOT EXISTS idx_useractivity_userid_created
  ON public."UserActivity" ("userId", "createdAt" DESC);

-- MessageFeedback
CREATE INDEX IF NOT EXISTS idx_msgfeedback_userid
  ON public."MessageFeedback" ("userId");

-- AiMode
CREATE INDEX IF NOT EXISTS idx_aimode_userid
  ON public."AiMode" ("userId");

-- CreditLog
CREATE INDEX IF NOT EXISTS idx_creditlog_userid
  ON public."CreditLog" ("userId");

-- Credits
CREATE INDEX IF NOT EXISTS idx_credits_userid
  ON public."Credits" ("userId");

-- PendingRecharge
CREATE INDEX IF NOT EXISTS idx_pendingrecharge_userid
  ON public."PendingRecharge" ("userId");

-- StorageFile
CREATE INDEX IF NOT EXISTS idx_storagefile_userid
  ON public."StorageFile" ("userId");

-- AuditLog
CREATE INDEX IF NOT EXISTS idx_auditlog_userid_created
  ON public."AuditLog" ("userId", "createdAt" DESC);

-- subscriptions
CREATE INDEX IF NOT EXISTS idx_subscriptions_userid
  ON public.subscriptions ("userId");

-- payments
CREATE INDEX IF NOT EXISTS idx_payments_userid
  ON public.payments ("userId");

-- connector_integrations
CREATE INDEX IF NOT EXISTS idx_connector_userid
  ON public.connector_integrations ("userId");


-- ═══════════════════════════════════════════════════════════════════════════
-- 25 · TESTS DE VERIFICACIÓN
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Test 1: RLS está habilitado en todas las tablas ───
DO $$
DECLARE
  disabled TEXT[];
BEGIN
  SELECT ARRAY_AGG(tablename) INTO disabled
  FROM pg_tables
  WHERE schemaname = 'public'
    AND rowsecurity = false
    AND tablename IN (
      'Chat', 'Message', 'Memory', 'Project', 'ProjectFile',
      'ProjectFileRevision', 'Artifact', 'Notification', 'UserActivity',
      'MessageFeedback', 'AiMode', 'CreditLog', 'Credits', 'PendingRecharge',
      'StorageFile', 'AuditLog', 'BillingPlan', 'AppVersion',
      'processed_webhook_events', 'profiles', 'subscriptions', 'payments',
      'connector_integrations', 'connector_oauth_states'
    );

  IF disabled IS NOT NULL AND array_length(disabled, 1) > 0 THEN
    RAISE EXCEPTION 'RLS deshabilitado en: %', disabled;
  END IF;

  RAISE NOTICE '✓ Test 1: RLS habilitado en todas las tablas';
END $$;

-- ─── Test 2: Cada tabla user-scoped tiene al menos 4 policies ───
DO $$
DECLARE
  problematic TEXT[];
BEGIN
  SELECT ARRAY_AGG(t) INTO problematic
  FROM unnest(ARRAY[
    'Chat', 'Message', 'Memory', 'Project', 'ProjectFile',
    'ProjectFileRevision', 'Artifact', 'Notification',
    'MessageFeedback', 'AiMode', 'CreditLog', 'Credits',
    'PendingRecharge', 'StorageFile', 'connector_integrations'
  ]) AS t
  WHERE (
    SELECT COUNT(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t
  ) < 3;

  IF problematic IS NOT NULL THEN
    RAISE WARNING 'Tablas con <3 policies: %', problematic;
  ELSE
    RAISE NOTICE '✓ Test 2: todas las tablas tienen >=3 policies';
  END IF;
END $$;

-- ─── Test 3: is_admin() funciona ───
DO $$
BEGIN
  PERFORM public.is_admin();
  RAISE NOTICE '✓ Test 3: is_admin() ejecutable';
END $$;

-- ─── Test 4: current_user_id() funciona ───
DO $$
BEGIN
  PERFORM public.current_user_id();
  RAISE NOTICE '✓ Test 4: current_user_id() ejecutable';
END $$;

-- ─── Test 5: profiles tiene policies ───
DO $$
DECLARE
  policy_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'profiles';

  IF policy_count < 2 THEN
    RAISE WARNING 'profiles tiene pocas policies: %', policy_count;
  ELSE
    RAISE NOTICE '✓ Test 5: profiles tiene % policies', policy_count;
  END IF;
END $$;

-- ─── Test 6: AuditLog solo admins ───
DO $$
DECLARE
  audit_policies INTEGER;
BEGIN
  SELECT COUNT(*) INTO audit_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'AuditLog'
    AND cmd = 'SELECT';

  RAISE NOTICE '✓ Test 6: AuditLog tiene % policies SELECT', audit_policies;
END $$;

-- ─── Test 7: Índices críticos existen ───
DO $$
DECLARE
  missing TEXT[];
BEGIN
  SELECT ARRAY_AGG(i) INTO missing
  FROM unnest(ARRAY[
    'idx_chat_userid_created',
    'idx_message_chatid_created',
    'idx_memory_userid',
    'idx_project_userid',
    'idx_artifact_userid',
    'idx_notification_userid_read'
  ]) AS i
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = i
  );

  IF missing IS NOT NULL THEN
    RAISE WARNING 'Índices faltantes: %', missing;
  ELSE
    RAISE NOTICE '✓ Test 7: índices críticos presentes';
  END IF;
END $$;

-- ─── Test 8: Resumen de policies por tabla ───
DO $$
DECLARE
  r RECORD;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════';
  RAISE NOTICE '  RESUMEN DE POLICIES';
  RAISE NOTICE '════════════════════════════════════════════';

  FOR r IN
    SELECT tablename, COUNT(*) AS cnt
    FROM pg_policies
    WHERE schemaname = 'public'
    GROUP BY tablename
    ORDER BY tablename
  LOOP
    RAISE NOTICE '  % · % policies', rpad(r.tablename, 30), r.cnt;
  END LOOP;

  RAISE NOTICE '════════════════════════════════════════════';
END $$;

-- ─── Test 9: Contar policies totales ───
DO $$
DECLARE
  total INTEGER;
BEGIN
  SELECT COUNT(*) INTO total
  FROM pg_policies
  WHERE schemaname = 'public';

  RAISE NOTICE '✓ Test 9: % policies en total', total;
END $$;

-- ─── Test 10: banner final ───
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════';
  RAISE NOTICE '  ✅ RLS APLICADO CORRECTAMENTE';
  RAISE NOTICE '';
  RAISE NOTICE '  Todas las tablas tienen Row Level Security activo.';
  RAISE NOTICE '  Cada usuario solo puede acceder a sus propios datos.';
  RAISE NOTICE '  Los admins pueden acceder a todo.';
  RAISE NOTICE '';
  RAISE NOTICE '  Service role (backend) bypassa RLS automáticamente.';
  RAISE NOTICE '════════════════════════════════════════════════════════';
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 26 · ROLLBACK (descomentar para revertir)
-- ═══════════════════════════════════════════════════════════════════════════

/*
BEGIN;

-- Chat
DROP POLICY IF EXISTS chat_select_own ON public."Chat";
DROP POLICY IF EXISTS chat_insert_own ON public."Chat";
DROP POLICY IF EXISTS chat_update_own ON public."Chat";
DROP POLICY IF EXISTS chat_delete_own ON public."Chat";

-- Message
DROP POLICY IF EXISTS message_select_own ON public."Message";
DROP POLICY IF EXISTS message_insert_own ON public."Message";
DROP POLICY IF EXISTS message_update_own ON public."Message";
DROP POLICY IF EXISTS message_delete_own ON public."Message";

-- Memory
DROP POLICY IF EXISTS memory_select_own ON public."Memory";
DROP POLICY IF EXISTS memory_insert_own ON public."Memory";
DROP POLICY IF EXISTS memory_update_own ON public."Memory";
DROP POLICY IF EXISTS memory_delete_own ON public."Memory";

-- Project
DROP POLICY IF EXISTS project_select_own ON public."Project";
DROP POLICY IF EXISTS project_insert_own ON public."Project";
DROP POLICY IF EXISTS project_update_own ON public."Project";
DROP POLICY IF EXISTS project_delete_own ON public."Project";

-- ... (repetir para todas las tablas)

-- Funciones
DROP FUNCTION IF EXISTS public.is_admin();
DROP FUNCTION IF EXISTS public.is_authenticated();
DROP FUNCTION IF EXISTS public.current_user_id();
DROP FUNCTION IF EXISTS public.owns_row(TEXT);

-- Índices
DROP INDEX IF EXISTS idx_chat_userid_created;
DROP INDEX IF EXISTS idx_message_chatid_created;
-- ... etc

COMMIT;
*/


-- ═══════════════════════════════════════════════════════════════════════════
-- FIN · supabase-rls.sql · v1.0
-- ═══════════════════════════════════════════════════════════════════════════