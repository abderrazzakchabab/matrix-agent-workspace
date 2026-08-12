-- 0001_identity_and_bindings.sql
-- Identity, sessions, rooms, bindings, and workspaces with tenant-scoped
-- row-level security keyed by the `app.user_id` and `app.workspace_ids` GUCs.

-- Application role: subject to RLS, intentionally not a table owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'matrix_app') THEN
    EXECUTE 'CREATE ROLE matrix_app LOGIN PASSWORD ''matrix_app_password''';
  END IF;
END
$$;

-- ── Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  matrix_user_id text NOT NULL,
  homeserver_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_homeserver_matrix_unique UNIQUE (homeserver_url, matrix_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  session_id_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matrix_access_token_ciphertext text NOT NULL,
  matrix_access_token_iv text NOT NULL,
  matrix_access_token_auth_tag text NOT NULL,
  token_key_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS rooms (
  room_id text NOT NULL,
  homeserver_url text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, homeserver_url)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'viewer',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_bindings (
  room_id text NOT NULL,
  homeserver_url text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_id, homeserver_url),
  FOREIGN KEY (room_id, homeserver_url) REFERENCES rooms(room_id, homeserver_url)
);

-- ── Row-level security ─────────────────────────────────────────────────────

-- Helper accessors. After a SET LOCAL custom GUC commits, the GUC reverts to an
-- empty string rather than unset; treat empty as unset so policies default to
-- denying access. These run as the invoker and read the invoker's own GUCs.
CREATE OR REPLACE FUNCTION app_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), ''); $$;

CREATE OR REPLACE FUNCTION app_workspace_ids()
RETURNS text[]
LANGUAGE sql
STABLE
AS $$ SELECT NULLIF(current_setting('app.workspace_ids', true), '')::text[]; $$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_bindings ENABLE ROW LEVEL SECURITY;

-- users: each user can only see/update their own row.
DROP POLICY IF EXISTS users_select ON users;
CREATE POLICY users_select ON users FOR SELECT
  USING (id = app_user_id());

DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_update ON users FOR UPDATE
  USING (id = app_user_id())
  WITH CHECK (id = app_user_id());

-- sessions: owned by their user.
DROP POLICY IF EXISTS sessions_select ON sessions;
CREATE POLICY sessions_select ON sessions FOR SELECT
  USING (user_id = app_user_id());

DROP POLICY IF EXISTS sessions_insert ON sessions;
CREATE POLICY sessions_insert ON sessions FOR INSERT
  WITH CHECK (user_id = app_user_id());

DROP POLICY IF EXISTS sessions_update ON sessions;
CREATE POLICY sessions_update ON sessions FOR UPDATE
  USING (user_id = app_user_id());

DROP POLICY IF EXISTS sessions_delete ON sessions;
CREATE POLICY sessions_delete ON sessions FOR DELETE
  USING (user_id = app_user_id());

-- rooms: visible only to a user with a binding to that room.
DROP POLICY IF EXISTS rooms_select ON rooms;
CREATE POLICY rooms_select ON rooms FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM room_bindings rb
    WHERE rb.room_id = rooms.room_id
      AND rb.homeserver_url = rooms.homeserver_url
      AND rb.user_id = app_user_id()
  ));

-- workspaces: visible to members (via app.workspace_ids); the owner may update.
DROP POLICY IF EXISTS workspaces_select ON workspaces;
CREATE POLICY workspaces_select ON workspaces FOR SELECT
  USING (id = ANY (app_workspace_ids()));

DROP POLICY IF EXISTS workspaces_update ON workspaces;
CREATE POLICY workspaces_update ON workspaces FOR UPDATE
  USING (owner_id = app_user_id());

-- workspace_members: visible to the member or co-members of accessible workspaces.
DROP POLICY IF EXISTS workspace_members_select ON workspace_members;
CREATE POLICY workspace_members_select ON workspace_members FOR SELECT
  USING (
    user_id = app_user_id()
    OR workspace_id = ANY (app_workspace_ids())
  );

-- room_bindings: owned by their user.
DROP POLICY IF EXISTS room_bindings_select ON room_bindings;
CREATE POLICY room_bindings_select ON room_bindings FOR SELECT
  USING (user_id = app_user_id());

DROP POLICY IF EXISTS room_bindings_insert ON room_bindings;
CREATE POLICY room_bindings_insert ON room_bindings FOR INSERT
  WITH CHECK (user_id = app_user_id() AND workspace_id = ANY (app_workspace_ids()));

DROP POLICY IF EXISTS room_bindings_update ON room_bindings;
CREATE POLICY room_bindings_update ON room_bindings FOR UPDATE
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id() AND workspace_id = ANY (app_workspace_ids()));

DROP POLICY IF EXISTS room_bindings_delete ON room_bindings;
CREATE POLICY room_bindings_delete ON room_bindings FOR DELETE
  USING (user_id = app_user_id());

-- ── Security-definer helpers (run as the table owner, bypass RLS) ──────────

CREATE OR REPLACE FUNCTION upsert_matrix_user(p_matrix_user_id text, p_homeserver_url text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id text;
BEGIN
  v_id := 'usr_' || gen_random_uuid()::text;
  INSERT INTO users (id, matrix_user_id, homeserver_url)
  VALUES (v_id, p_matrix_user_id, p_homeserver_url)
  ON CONFLICT (homeserver_url, matrix_user_id) DO UPDATE
    SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION lookup_session(p_hash text)
RETURNS TABLE (
  id text,
  user_id text,
  matrix_user_id text,
  homeserver_url text,
  ciphertext text,
  iv text,
  auth_tag text,
  key_version text,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.user_id, u.matrix_user_id, u.homeserver_url,
         s.matrix_access_token_ciphertext, s.matrix_access_token_iv,
         s.matrix_access_token_auth_tag, s.token_key_version,
         s.expires_at, s.revoked_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.session_id_hash = p_hash;
$$;

CREATE OR REPLACE FUNCTION app_workspace_ids_for_user(p_user_id text)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(workspace_id), '{}'::text[])
  FROM workspace_members
  WHERE user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION create_workspace(
  p_id text, p_owner_id text, p_name text, p_policy jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO workspaces (id, owner_id, name, policy, status)
  VALUES (p_id, p_owner_id, p_name, p_policy, 'active');
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (p_id, p_owner_id, 'owner');
END;
$$;

CREATE OR REPLACE FUNCTION ensure_room(
  p_room_id text, p_homeserver_url text, p_display_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO rooms (room_id, homeserver_url, display_name)
  VALUES (p_room_id, p_homeserver_url, p_display_name)
  ON CONFLICT (room_id, homeserver_url) DO UPDATE
    SET display_name = EXCLUDED.display_name;
END;
$$;

-- ── Grants for the application role ────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO matrix_app;
GRANT SELECT, UPDATE ON users TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO matrix_app;
GRANT SELECT ON rooms TO matrix_app;
GRANT SELECT ON workspaces TO matrix_app;
GRANT SELECT ON workspace_members TO matrix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON room_bindings TO matrix_app;

GRANT EXECUTE ON FUNCTION upsert_matrix_user(text, text) TO matrix_app;
GRANT EXECUTE ON FUNCTION lookup_session(text) TO matrix_app;
GRANT EXECUTE ON FUNCTION app_workspace_ids_for_user(text) TO matrix_app;
GRANT EXECUTE ON FUNCTION create_workspace(text, text, text, jsonb) TO matrix_app;
GRANT EXECUTE ON FUNCTION ensure_room(text, text, text) TO matrix_app;
GRANT EXECUTE ON FUNCTION app_user_id() TO matrix_app;
GRANT EXECUTE ON FUNCTION app_workspace_ids() TO matrix_app;
