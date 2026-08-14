-- 0003_github_write_controls.sql
-- Phase C: separate repository/scope write grants, mutation approvals bound
-- to exact command hashes, idempotent mutation commands, and append-only
-- audit records — all tenant-scoped with RLS. Read authorization (Phase B)
-- never implies write authorization.

-- ── Tables ────────────────────────────────────────────────────────────────

-- One repository+scope write grant per workspace; status drives the gate.
CREATE TABLE IF NOT EXISTS github_write_grants (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  granted_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  approved_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_write_grants_workspace_repo_scope_unique
    UNIQUE (workspace_id, repository, scope)
);
CREATE INDEX IF NOT EXISTS github_write_grants_workspace_idx
  ON github_write_grants (workspace_id, status);

-- Approvals are bound to the exact run, user, scope, and command hash and expire.
CREATE TABLE IF NOT EXISTS mutation_approvals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id text REFERENCES runs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  command_hash text NOT NULL,
  decision text NOT NULL,
  confirmation_text text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mutation_approvals_workspace_idx
  ON mutation_approvals (workspace_id);
CREATE INDEX IF NOT EXISTS mutation_approvals_command_hash_idx
  ON mutation_approvals (command_hash);

-- Idempotent mutation commands: one row per (workspace, idempotency key).
CREATE TABLE IF NOT EXISTS github_mutation_commands (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id text REFERENCES runs(id) ON DELETE SET NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  approval_id text REFERENCES mutation_approvals(id) ON DELETE SET NULL,
  repository text NOT NULL,
  operation text NOT NULL,
  arguments_hash text NOT NULL,
  arguments jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  provider_result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_mutation_commands_workspace_idempotency_unique
    UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS github_mutation_commands_workspace_idx
  ON github_mutation_commands (workspace_id, status);
CREATE INDEX IF NOT EXISTS github_mutation_commands_approval_idx
  ON github_mutation_commands (approval_id);

-- Append-only audit trail for grants, approvals, and mutation outcomes.
CREATE TABLE IF NOT EXISTS audit_records (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_matrix_id text,
  scope text,
  repository text,
  operation text,
  arguments_hash text,
  approval_id text,
  command_id text,
  outcome text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_records_workspace_created_idx
  ON audit_records (workspace_id, created_at DESC, id DESC);

-- ── Row-level security ─────────────────────────────────────────────────────

ALTER TABLE github_write_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_mutation_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_records ENABLE ROW LEVEL SECURITY;

-- github_write_grants: workspace-scoped; only workspace members can insert,
-- and only the granting user can be recorded as the grantor.
DROP POLICY IF EXISTS github_write_grants_select ON github_write_grants;
CREATE POLICY github_write_grants_select ON github_write_grants FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS github_write_grants_insert ON github_write_grants;
CREATE POLICY github_write_grants_insert ON github_write_grants FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()) AND granted_by = app_user_id());
DROP POLICY IF EXISTS github_write_grants_update ON github_write_grants;
CREATE POLICY github_write_grants_update ON github_write_grants FOR UPDATE
  USING (workspace_id = ANY (app_workspace_ids()))
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS github_write_grants_delete ON github_write_grants;
CREATE POLICY github_write_grants_delete ON github_write_grants FOR DELETE
  USING (workspace_id = ANY (app_workspace_ids()));

-- mutation_approvals: workspace-scoped; the approver must be the session user.
DROP POLICY IF EXISTS mutation_approvals_select ON mutation_approvals;
CREATE POLICY mutation_approvals_select ON mutation_approvals FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS mutation_approvals_insert ON mutation_approvals;
CREATE POLICY mutation_approvals_insert ON mutation_approvals FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()) AND user_id = app_user_id());
DROP POLICY IF EXISTS mutation_approvals_update ON mutation_approvals;
CREATE POLICY mutation_approvals_update ON mutation_approvals FOR UPDATE
  USING (workspace_id = ANY (app_workspace_ids()))
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS mutation_approvals_delete ON mutation_approvals;
CREATE POLICY mutation_approvals_delete ON mutation_approvals FOR DELETE
  USING (workspace_id = ANY (app_workspace_ids()));

-- github_mutation_commands: workspace-scoped; the owner is the session user.
DROP POLICY IF EXISTS github_mutation_commands_select ON github_mutation_commands;
CREATE POLICY github_mutation_commands_select ON github_mutation_commands FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS github_mutation_commands_insert ON github_mutation_commands;
CREATE POLICY github_mutation_commands_insert ON github_mutation_commands FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()) AND user_id = app_user_id());
DROP POLICY IF EXISTS github_mutation_commands_update ON github_mutation_commands;
CREATE POLICY github_mutation_commands_update ON github_mutation_commands FOR UPDATE
  USING (workspace_id = ANY (app_workspace_ids()))
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS github_mutation_commands_delete ON github_mutation_commands;
CREATE POLICY github_mutation_commands_delete ON github_mutation_commands FOR DELETE
  USING (workspace_id = ANY (app_workspace_ids()));

-- audit_records: append-only — SELECT and INSERT only, never UPDATE/DELETE.
DROP POLICY IF EXISTS audit_records_select ON audit_records;
CREATE POLICY audit_records_select ON audit_records FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS audit_records_insert ON audit_records;
CREATE POLICY audit_records_insert ON audit_records FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()) AND actor_user_id = app_user_id());

-- ── Security-definer helpers ───────────────────────────────────────────────

-- Lets the mutation worker (which knows only a command id) resolve the
-- command's owning tenant before re-entering withTenant as that owner.
-- Exposes only the tenant keys, never arguments or provider results.
CREATE OR REPLACE FUNCTION mutation_command_tenant(p_command_id text)
RETURNS TABLE(user_id text, workspace_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.user_id, c.workspace_id
    FROM github_mutation_commands c
   WHERE c.id = p_command_id;
$$;

REVOKE ALL ON FUNCTION mutation_command_tenant(text) FROM PUBLIC;

-- ── Grants for the application role ────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON github_write_grants TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mutation_approvals TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON github_mutation_commands TO matrix_app;
GRANT SELECT, INSERT ON audit_records TO matrix_app;
GRANT EXECUTE ON FUNCTION mutation_command_tenant(text) TO matrix_app;
