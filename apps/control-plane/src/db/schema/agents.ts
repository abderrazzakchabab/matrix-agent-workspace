/** Column names and row shape for the `specialist_agents` table. */
export const SPECIALIST_AGENTS = {
  table: 'specialist_agents',
  id: 'id',
  workspaceId: 'workspace_id',
  name: 'name',
  model: 'model',
  gatewayProvider: 'gateway_provider',
  systemPolicy: 'system_policy',
  toolsAllowlist: 'tools_allowlist',
  timeoutMs: 'timeout_ms',
  enabled: 'enabled',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export interface SpecialistAgentRow {
  id: string;
  workspaceId: string;
  name: string;
  model: string;
  gatewayProvider: string;
  systemPolicy: Record<string, unknown>;
  toolsAllowlist: string[];
  timeoutMs: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
