export interface FormationState {
  name: string;
  version: string;
  namespace: string;
  installedAt: string;
  agents: Record<string, AgentState>;
  bindings: OpenClawBinding[];
  cronJobs: CronJobState[];
  variables: Record<string, string>;
  fileHashes: Record<string, string>;
  agentToAgent?: {
    wasEnabled: boolean;
    allowAdded: boolean;
  };
  sourcePath?: string;
  updatedAt?: string;
  agentToAgentEdges?: Record<string, string[]>;
  registryRef?: { name: string; version: string };
}

export interface AgentState {
  id: string;
  slug: string;
  workspace: string;
  files: string[];
  model?: string | { primary?: string; fallbacks?: string[] };
  configTools?: Record<string, unknown>;
  configSandbox?: Record<string, unknown>;
  configIdentity?: Record<string, unknown>;
  configSkills?: string[];
}

export interface CronJobState {
  id: string;
  name: string;
  agentSlug: string;
  schedule?: string;
  timezone?: string;
  prompt?: string;
}

export interface OpenClawBinding {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: string; id: string };
    guildId?: string;
    teamId?: string;
    roles?: string[];
  };
}
