export interface AgentTools {
  allow?: string[];
}

export interface AgentSandbox {
  network?: boolean;
  filesystem?: 'full' | 'restricted' | 'none';
}

export interface Agent {
  source: string;
  description: string;
  role?: string;
  model?: string;
  tools?: AgentTools;
  sandbox?: AgentSandbox;
}

export interface Variable {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  sensitive?: boolean;
}

export interface BindingPeer {
  kind: 'direct' | 'group' | 'channel' | (string & {});
  id: string;
}

export interface BindingMatch {
  /** Channel token: "slack", "telegram", "discord", etc. */
  channel: string;
  /** Specific account, or "*" for any. */
  accountId?: string;
  /** Peer targeting (kind + id). Both fields required if peer is present. */
  peer?: BindingPeer;
  /** Discord guild ID. */
  guildId?: string;
  /** Slack team ID. */
  teamId?: string;
  /** Discord roles — ANY matching role satisfies (overlap semantics, not "all must match"). */
  roles?: string[];
}

export interface Binding {
  /** Rich match object for OpenClaw routing. */
  match: BindingMatch;
  /** Agent slug to bind. */
  agent: string;
}

export interface CronJob {
  schedule: string;
  agent: string;
  prompt: string;
  timezone?: string;
}

export interface Service {
  name: string;
  url?: string;
  required?: boolean;
  description?: string;
}

export interface Dependencies {
  skills?: Record<string, string>;
  services?: Service[];
}

export interface ValidationConfig {
  agent_exists?: boolean;
  file_exists?: boolean;
  binding_active?: boolean;
  cron_exists?: boolean;
  agent_responds?: {
    enabled?: boolean;
    timeout?: number;
  };
}

export interface Compatibility {
  openclaw?: string;
}

export interface ReefManifest {
  reef: '1.0';
  type: 'solo' | 'shoal' | 'school';
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  repository?: string;
  compatibility?: Compatibility;
  namespace: string;
  variables?: Record<string, Variable>;
  agents: Record<string, Agent>;
  agentToAgent?: Record<string, string[]>;
  bindings?: Binding[];
  cron?: CronJob[];
  dependencies?: Dependencies;
  validation?: ValidationConfig;
}
