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

export interface Binding {
  /**
   * Channel identifier in `<type>:<scope>` form (e.g., `slack:#ops`, `telegram:12345`).
   * Functional channels (intrinsic to the formation) use literals.
   * Interaction channels (user preference) use `{{VARIABLE}}` references resolved at install time.
   */
  channel: string;
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
