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
}

export interface AgentState {
  id: string;
  slug: string;
  workspace: string;
  files: string[];
}

export interface CronJobState {
  id: string;
  name: string;
  agentSlug: string;
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
