export interface LockfileEntry {
  version: string;
  resolved: string;
  integrity: string; // "sha256-{hex}"
}

export interface Lockfile {
  skills: Record<string, LockfileEntry>;
}
