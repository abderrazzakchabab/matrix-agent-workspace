-- 0002_runs_events_memory.sql
-- Runs, specialist agents, run events, workflow checkpoints, outbox deliveries,
-- pgvector memory, and GitHub installation/link data with tenant-scoped RLS.

-- pgvector is enabled by the fixture init script; ensure it is available for
-- databases migrated without that bootstrap.
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS specialist_agents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  model text NOT NULL,
  gateway_provider text NOT NULL,
  system_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  tools_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  timeout_ms integer NOT NULL DEFAULT 120000,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS specialist_agents_workspace_idx ON specialist_agents (workspace_id);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text,
  prompt_hash text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  cancel_requested_at timestamptz,
  terminal_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_workspace_idx ON runs (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_workspace_idempotency_key_idx
  ON runs (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_specialists (
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  specialist_id text NOT NULL REFERENCES specialist_agents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  output jsonb,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (run_id, specialist_id),
  CONSTRAINT run_specialists_ordinal_unique UNIQUE (run_id, ordinal)
);

CREATE TABLE IF NOT EXISTS run_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility text NOT NULL DEFAULT 'room_and_owner',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_events_run_sequence_unique UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events (run_id);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  checkpoint_key text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, checkpoint_key)
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  aggregate_key text NOT NULL,
  destination text NOT NULL,
  event_sequence bigint NOT NULL,
  delivery_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  provider_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_messages_delivery_key_unique UNIQUE (delivery_key)
);
CREATE INDEX IF NOT EXISTS outbox_messages_workspace_idx ON outbox_messages (workspace_id);
CREATE INDEX IF NOT EXISTS outbox_messages_status_idx ON outbox_messages (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS agent_memories (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_run_id text REFERENCES runs(id) ON DELETE SET NULL,
  source_event_id text REFERENCES run_events(id) ON DELETE SET NULL,
  text_hash text NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  classification text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_memories_workspace_idx ON agent_memories (workspace_id);
CREATE INDEX IF NOT EXISTS agent_memories_text_hash_idx ON agent_memories (text_hash);
CREATE INDEX IF NOT EXISTS agent_memories_embedding_idx ON agent_memories
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS github_installations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  owner text NOT NULL,
  repository_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_ciphertext text,
  token_iv text,
  token_auth_tag text,
  token_key_version text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_installations_workspace_installation_unique
    UNIQUE (workspace_id, installation_id)
);
CREATE INDEX IF NOT EXISTS github_installations_workspace_idx ON github_installations (workspace_id);

CREATE TABLE IF NOT EXISTS github_links (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  oauth_subject text NOT NULL,
  access_token_ciphertext text NOT NULL,
  access_token_iv text NOT NULL,
  access_token_auth_tag text NOT NULL,
  token_key_version text NOT NULL,
  refresh_token_ciphertext text,
  refresh_token_iv text,
  refresh_token_auth_tag text,
  refresh_token_key_version text,
  expires_at timestamptz,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_links_user_subject_unique UNIQUE (user_id, oauth_subject)
);
CREATE INDEX IF NOT EXISTS github_links_user_idx ON github_links (user_id);

-- ── Row-level security ─────────────────────────────────────────────────────

ALTER TABLE specialist_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_specialists ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_links ENABLE ROW LEVEL SECURITY;

-- specialist_agents: members of the owning workspace.
DROP POLICY IF EXISTS specialist_agents_select ON specialist_agents;
CREATE POLICY specialist_agents_select ON specialist_agents FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS specialist_agents_insert ON specialist_agents;
CREATE POLICY specialist_agents_insert ON specialist_agents FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS specialist_agents_update ON specialist_agents;
CREATE POLICY specialist_agents_update ON specialist_agents FOR UPDATE
  USING (workspace_id = ANY (app_workspace_ids()))
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS specialist_agents_delete ON specialist_agents;
CREATE POLICY specialist_agents_delete ON specialist_agents FOR DELETE
  USING (workspace_id = ANY (app_workspace_ids()));

-- runs: members of the owning workspace; only the owner can insert.
DROP POLICY IF EXISTS runs_select ON runs;
CREATE POLICY runs_select ON runs FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS runs_insert ON runs;
CREATE POLICY runs_insert ON runs FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()) AND owner_id = app_user_id());
DROP POLICY IF EXISTS runs_update ON runs;
CREATE POLICY runs_update ON runs FOR UPDATE
  USING (workspace_id = ANY (app_workspace_ids()))
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS runs_delete ON runs;
CREATE POLICY runs_delete ON runs FOR DELETE
  USING (workspace_id = ANY (app_workspace_ids()));

-- run_specialists, run_events, workflow_checkpoints: scoped via their run's workspace.
DROP POLICY IF EXISTS run_specialists_select ON run_specialists;
CREATE POLICY run_specialists_select ON run_specialists FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS run_specialists_insert ON run_specialists;
CREATE POLICY run_specialists_insert ON run_specialists FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS run_specialists_update ON run_specialists;
CREATE POLICY run_specialists_update ON run_specialists FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS run_specialists_delete ON run_specialists;
CREATE POLICY run_specialists_delete ON run_specialists FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));

DROP POLICY IF EXISTS run_events_select ON run_events;
CREATE POLICY run_events_select ON run_events FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS run_events_insert ON run_events;
CREATE POLICY run_events_insert ON run_events FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS run_events_update ON run_events;
CREATE POLICY run_events_update ON run_events FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS run_events_delete ON run_events;
CREATE POLICY run_events_delete ON run_events FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));

DROP POLICY IF EXISTS workflow_checkpoints_select ON workflow_checkpoints;
CREATE POLICY workflow_checkpoints_select ON workflow_checkpoints FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS workflow_checkpoints_insert ON workflow_checkpoints;
CREATE POLICY workflow_checkpoints_insert ON workflow_checkpoints FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS workflow_checkpoints_update ON workflow_checkpoints;
CREATE POLICY workflow_checkpoints_update ON workflow_checkpoints FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));
DROP POLICY IF EXISTS workflow_checkpoints_delete ON workflow_checkpoints;
CREATE POLICY workflow_checkpoints_delete ON workflow_checkpoints FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM runs r WHERE r.id = run_id AND r.workspace_id = ANY (app_workspace_ids())
  ));

-- outbox_messages: members of the owning workspace.
DROP POLICY IF EXISTS outbox_messages_select ON outbox_messages;
CREATE POLICY outbox_messages_select ON outbox_messages FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS outbox_messages_insert ON outbox_messages;
CREATE POLICY outbox_messages_insert ON outbox_messages FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS outbox_messages_update ON outbox_messages;
CREATE POLICY outbox_messages_update ON outbox_messages FOR UPDATE
  USING (workspace_id = ANY (app_workspace_ids()))
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS outbox_messages_delete ON outbox_messages;
CREATE POLICY outbox_messages_delete ON outbox_messages FOR DELETE
  USING (workspace_id = ANY (app_workspace_ids()));

-- agent_memories: members of the owning workspace (source filters are applied
-- by the repository query on top of these RLS policies).
DROP POLICY IF EXISTS agent_memories_select ON agent_memories;
CREATE POLICY agent_memories_select ON agent_memories FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS agent_memories_insert ON agent_memories;
CREATE POLICY agent_memories_insert ON agent_memories FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS agent_memories_update ON agent_memories;
CREATE POLICY agent_memories_update ON agent_memories FOR UPDATE
  USING (workspace_id = ANY (app_workspace_ids()))
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS agent_memories_delete ON agent_memories;
CREATE POLICY agent_memories_delete ON agent_memories FOR DELETE
  USING (workspace_id = ANY (app_workspace_ids()));

-- github_installations: members of the owning workspace.
DROP POLICY IF EXISTS github_installations_select ON github_installations;
CREATE POLICY github_installations_select ON github_installations FOR SELECT
  USING (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS github_installations_insert ON github_installations;
CREATE POLICY github_installations_insert ON github_installations FOR INSERT
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS github_installations_update ON github_installations;
CREATE POLICY github_installations_update ON github_installations FOR UPDATE
  USING (workspace_id = ANY (app_workspace_ids()))
  WITH CHECK (workspace_id = ANY (app_workspace_ids()));
DROP POLICY IF EXISTS github_installations_delete ON github_installations;
CREATE POLICY github_installations_delete ON github_installations FOR DELETE
  USING (workspace_id = ANY (app_workspace_ids()));

-- github_links: owned by their user.
DROP POLICY IF EXISTS github_links_select ON github_links;
CREATE POLICY github_links_select ON github_links FOR SELECT
  USING (user_id = app_user_id());
DROP POLICY IF EXISTS github_links_insert ON github_links;
CREATE POLICY github_links_insert ON github_links FOR INSERT
  WITH CHECK (user_id = app_user_id());
DROP POLICY IF EXISTS github_links_update ON github_links;
CREATE POLICY github_links_update ON github_links FOR UPDATE
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());
DROP POLICY IF EXISTS github_links_delete ON github_links;
CREATE POLICY github_links_delete ON github_links FOR DELETE
  USING (user_id = app_user_id());

-- ── Security-definer helpers (run as table owner, bypass RLS) ──────────────

-- Transactional, per-run event sequence allocation. Locks the run row so
-- concurrent appends serialize, then takes MAX(sequence) + 1. The caller's
-- tenant context is explicitly checked because SECURITY DEFINER bypasses RLS.
CREATE OR REPLACE FUNCTION append_run_event(
  p_run_id text,
  p_id text,
  p_event_type text,
  p_event_version integer,
  p_payload jsonb,
  p_visibility text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id text;
  v_next bigint;
BEGIN
  SELECT workspace_id INTO v_workspace_id FROM runs WHERE id = p_run_id;
  IF v_workspace_id IS NULL
     OR v_workspace_id <> ALL (COALESCE(app_workspace_ids(), ARRAY[]::text[]))
  THEN
    RAISE EXCEPTION 'run % is not in an accessible workspace', p_run_id;
  END IF;

  -- Serialize concurrent appends to the same run.
  PERFORM 1 FROM runs WHERE id = p_run_id FOR UPDATE;

  SELECT COALESCE(MAX(sequence), 0) + 1 INTO v_next
    FROM run_events WHERE run_id = p_run_id;

  INSERT INTO run_events (id, run_id, sequence, event_type, event_version, payload, visibility)
  VALUES (p_id, p_run_id, v_next, p_event_type, p_event_version, p_payload, p_visibility);

  RETURN v_next;
END;
$$;

-- Compare-and-swap checkpoint update: bump the version only when the caller's
-- expected version matches, returning whether the update was applied.
CREATE OR REPLACE FUNCTION update_checkpoint(
  p_run_id text,
  p_checkpoint_key text,
  p_expected_version integer,
  p_state jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id text;
  v_updated boolean;
BEGIN
  SELECT workspace_id INTO v_workspace_id FROM runs WHERE id = p_run_id;
  IF v_workspace_id IS NULL
     OR v_workspace_id <> ALL (COALESCE(app_workspace_ids(), ARRAY[]::text[]))
  THEN
    RAISE EXCEPTION 'run % is not in an accessible workspace', p_run_id;
  END IF;

  UPDATE workflow_checkpoints
     SET state = p_state, version = version + 1, updated_at = now()
   WHERE run_id = p_run_id
     AND checkpoint_key = p_checkpoint_key
     AND version = p_expected_version;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- ── Grants for the application role ────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON specialist_agents TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON runs TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON run_specialists TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON run_events TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_checkpoints TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_messages TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_memories TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON github_installations TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON github_links TO matrix_app;

GRANT EXECUTE ON FUNCTION append_run_event(text, text, text, integer, jsonb, text) TO matrix_app;
GRANT EXECUTE ON FUNCTION update_checkpoint(text, text, integer, jsonb) TO matrix_app;
