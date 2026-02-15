/**
 * PlatformAdapter — architectural seam for OpenClaw Gateway RPC.
 *
 * The offline commands (init, inspect, validate, pack) operate directly on
 * the filesystem via node:fs and don't need this adapter. It exists purely
 * to establish the interface for when `reef install` is built later.
 */
export interface PlatformAdapter {
  // Agent lifecycle
  createAgent(id: string, config: Record<string, unknown>): Promise<void>;
  getAgent(id: string): Promise<Record<string, unknown> | null>;
  deleteAgent(id: string): Promise<void>;
  listAgents(namespace: string): Promise<string[]>;

  // Workspace files
  writeFile(agentId: string, path: string, content: string): Promise<void>;
  readFile(agentId: string, path: string): Promise<string>;
  fileExists(agentId: string, path: string): Promise<boolean>;
  deleteFile(agentId: string, path: string): Promise<void>;

  // Bindings
  createBinding(agentId: string, binding: Record<string, unknown>): Promise<void>;
  deleteBinding(agentId: string, bindingId: string): Promise<void>;
  listBindings(agentId: string): Promise<Record<string, unknown>[]>;
  isBindingActive(agentId: string, bindingId: string): Promise<boolean>;

  // Cron
  createCron(agentId: string, cron: Record<string, unknown>): Promise<void>;
  deleteCron(agentId: string, cronId: string): Promise<void>;
  listCrons(agentId: string): Promise<Record<string, unknown>[]>;

  // Sessions
  sendPing(agentId: string): Promise<boolean>;

  // State
  readState(key: string): Promise<string | null>;
  writeState(key: string, value: string): Promise<void>;
  deleteState(key: string): Promise<void>;
}
