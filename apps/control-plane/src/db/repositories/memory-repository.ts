import { withTenant } from '../client';
import { AGENT_MEMORIES, type AgentMemoryRow } from '../schema/memory';
import type { TenantContext } from './run-repository';

export interface StoreMemoryInput {
  id: string;
  sourceRunId?: string | null;
  sourceEventId?: string | null;
  textHash: string;
  content: string;
  embedding?: number[] | null;
  classification?: string | null;
}

/** Render a float vector as pgvector's `[a,b,c]` text input. */
function formatVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/** Parse pgvector's `[a,b,c]` text output back into a float array. */
function parseVector(text: string | null): number[] | null {
  if (text === null || text === '') return null;
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner === '') return [];
  return inner.split(',').map((s) => Number(s.trim()));
}

function mapMemoryRow(row: Record<string, unknown>): AgentMemoryRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    sourceRunId: (row.source_run_id as string | null) ?? null,
    sourceEventId: (row.source_event_id as string | null) ?? null,
    textHash: row.text_hash as string,
    content: row.content as string,
    embedding: parseVector((row.embedding as string | null) ?? null),
    classification: (row.classification as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/** Store a memory row (optionally embedded) in the tenant's workspace. */
export async function storeMemory(
  tenant: TenantContext,
  input: StoreMemoryInput,
): Promise<AgentMemoryRow> {
  return withTenant(tenant.userId, async (client) => {
    const vector = input.embedding ? formatVector(input.embedding) : null;
    const { rows } = await client.query(
      `INSERT INTO ${AGENT_MEMORIES.table}
         (${AGENT_MEMORIES.id}, ${AGENT_MEMORIES.workspaceId},
          ${AGENT_MEMORIES.sourceRunId}, ${AGENT_MEMORIES.sourceEventId},
          ${AGENT_MEMORIES.textHash}, ${AGENT_MEMORIES.content},
          ${AGENT_MEMORIES.embedding}, ${AGENT_MEMORIES.classification})
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
       RETURNING *`,
      [
        input.id,
        tenant.workspaceId,
        input.sourceRunId ?? null,
        input.sourceEventId ?? null,
        input.textHash,
        input.content,
        vector,
        input.classification ?? null,
      ],
    );
    return mapMemoryRow(rows[0]);
  });
}

/**
 * Cosine-similarity search over the tenant's workspace only. RLS adds a second
 * tenant filter, so a cross-workspace `workspaceId` yields no rows.
 */
export async function searchMemories(
  tenant: TenantContext,
  queryEmbedding: number[],
  limit = 10,
): Promise<AgentMemoryRow[]> {
  return withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ${AGENT_MEMORIES.table}
        WHERE ${AGENT_MEMORIES.workspaceId} = $1
          AND ${AGENT_MEMORIES.embedding} IS NOT NULL
        ORDER BY ${AGENT_MEMORIES.embedding} <=> $2::vector
        LIMIT $3`,
      [tenant.workspaceId, formatVector(queryEmbedding), limit],
    );
    return rows.map(mapMemoryRow);
  });
}
