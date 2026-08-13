import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

/**
 * Connection strings.
 *
 * - `DATABASE_URL` is the role the application runs as (`matrix_app`). It is
 *   deliberately not a table owner so PostgreSQL row-level security is enforced
 *   against it.
 * - `MIGRATIONS_DATABASE_URL` is the owner role used only to apply migrations and
 *   run fixtures; it bypasses RLS as the table owner.
 */
export function getDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    'postgresql://matrix_app:matrix_app_password@localhost:5432/matrix_test'
  );
}

export function getMigrationsDatabaseUrl(): string {
  return (
    process.env.MIGRATIONS_DATABASE_URL ??
    'postgresql://matrix:matrix_test_password@localhost:5432/matrix_test'
  );
}

let pool: Pool | undefined;
let adminPool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: getDatabaseUrl() });
  return pool;
}

export function getAdminPool(): Pool {
  if (!adminPool) adminPool = new Pool({ connectionString: getMigrationsDatabaseUrl() });
  return adminPool;
}

/**
 * Split a SQL file into individual statements, respecting single-quoted string
 * literals (with `''` escapes), dollar-quoted bodies, and `--` line comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      if (newline === -1) break;
      i = newline + 1;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error('unterminated dollar-quoted string in migration');
        current += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      if (j >= n) throw new Error('unterminated string literal in migration');
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Apply every SQL migration in order (idempotent) using the owner role. */
export async function runMigrations(): Promise<void> {
  // Resolve through node:path rather than a directory URL so Next's server
  // bundler does not try to import the SQL directory when route modules import
  // this client. Migration discovery still happens only when this function is
  // explicitly invoked by fixtures or deployment tooling.
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const client = await getAdminPool().connect();
  try {
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      for (const statement of splitSqlStatements(sql)) {
        await client.query(statement);
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction whose tenant context is set for `userId`:
 * `app.user_id` (the internal user id) and `app.workspace_ids` (workspaces the
 * user is a member of). Row-level security policies read these settings, so all
 * queries executed by `fn` are tenant-scoped.
 */
export async function withTenant<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const { rows } = await client.query('SELECT app_workspace_ids_for_user($1) AS ids', [userId]);
    const ids: string[] = rows[0]?.ids ?? [];
    await client.query("SELECT set_config('app.workspace_ids', $1, true)", [
      `{${ids.join(',')}}`,
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
