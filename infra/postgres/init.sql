-- Enable pgvector extension for embedding storage and similarity search.
CREATE EXTENSION IF NOT EXISTS vector;

-- Application role used by the control plane. It is intentionally NOT a table
-- owner so that PostgreSQL row-level security is enforced against it. Tables are
-- owned by the bootstrap `matrix` role; migrations grant matrix_app the DML it
-- needs. (Also created idempotently by migrations for pre-existing databases.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'matrix_app') THEN
    EXECUTE 'CREATE ROLE matrix_app LOGIN PASSWORD ''matrix_app_password''';
  END IF;
END
$$;
