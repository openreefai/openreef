# @openreef/schema

TypeScript types, JSON Schema, and validation for OpenReef formation manifests (`reef.json`).

## Install

```bash
npm install @openreef/schema
```

## Quick Start

```typescript
import { validateManifest, type ReefManifest } from '@openreef/schema';

const manifest: ReefManifest = {
  reef: '1.0',
  type: 'solo',
  name: 'my-formation',
  version: '0.1.0',
  description: 'A single-agent formation',
  namespace: 'my-ns',
  agents: {
    assistant: {
      source: './agents/assistant',
      description: 'General-purpose assistant',
      model: 'claude-sonnet-4-20250514',
    },
  },
};

const result = await validateManifest(manifest);

if (result.valid) {
  console.log('Manifest is valid');
} else {
  console.error('Validation errors:', result.errors);
}
```

## API Reference

### `validateManifest(data: unknown): Promise<ManifestValidationResult>`

Validates an object against the `reef.json` JSON Schema using AJV (JSON Schema draft 2020-12). Returns all errors when validation fails.

```typescript
interface ManifestValidationResult {
  valid: boolean;
  errors: string[];   // human-readable error messages, empty when valid
}
```

### Manifest Types

The core types that describe a `reef.json` formation manifest.

| Type | Description |
|---|---|
| `ReefManifest` | Top-level manifest object. Required fields: `reef`, `type`, `name`, `version`, `description`, `namespace`, `agents`. |
| `Agent` | Agent definition with `source`, `description`, and optional `role`, `model`, `tools`, and `sandbox`. |
| `AgentTools` | Tool configuration. Optional `allow` list of permitted tool/skill names. |
| `AgentSandbox` | Sandbox constraints: `network` access and `filesystem` access level (`full`, `restricted`, `none`). |
| `Variable` | User-supplied configuration variable with `type`, optional `default`, `required`, and `sensitive` flags. |
| `Binding` | Routes a `channel` to an `agent` slug. |
| `CronJob` | Scheduled task: `schedule` (cron expression), `agent` slug, `prompt`, and optional `timezone`. |
| `Dependencies` | Declares required `skills` (with semver ranges) and external `services`. |
| `Service` | External service dependency with `name`, optional `url`, `required`, and `description`. |
| `ValidationConfig` | Post-deploy health check flags: `agent_exists`, `file_exists`, `binding_active`, `cron_exists`, `agent_responds`. |
| `Compatibility` | Platform version constraints (e.g., `openclaw` semver range). |

### Lockfile Types

Types for `reef-lock.json`, which pins resolved skill dependencies.

| Type | Description |
|---|---|
| `Lockfile` | Top-level lockfile containing a `skills` record. |
| `LockfileEntry` | A resolved skill: `version`, `resolved` URL, and `integrity` hash (`sha256-{hex}`). |

### Formation State Types

Types representing the runtime state of a deployed formation.

| Type | Description |
|---|---|
| `FormationState` | Full snapshot of a deployed formation: agents, bindings, cron jobs, variables, file hashes, and metadata. |
| `AgentState` | Runtime state for a single agent: `id`, `slug`, `workspace`, `files`, and optional config. |
| `CronJobState` | Runtime state for a scheduled job. |
| `OpenClawBinding` | Resolved binding with `agentId` and channel match criteria. |

### Validation Issue Types

General-purpose validation result types used across the toolchain.

| Type | Description |
|---|---|
| `ValidationResult` | Result containing `valid` boolean and an array of `issues`. |
| `ValidationIssue` | A single issue with `severity` (`error`, `warning`, `info`), `code`, `message`, and optional `path`. |
| `IssueSeverity` | `'error' | 'warning' | 'info'` |

## JSON Schema

The raw JSON Schema for `reef.json` is included in the package and can be imported directly:

```typescript
import schema from '@openreef/schema/reef.schema.json';
```

This is a JSON Schema draft 2020-12 document. You can use it with any compatible validator or for editor autocompletion by referencing it in your `reef.json`:

```json
{
  "$schema": "https://openreef.dev/schema/reef.schema.json",
  "reef": "1.0",
  "..."
}
```

## Related

- [OpenReef](https://github.com/OpenReefDev/openreef) -- CLI toolchain for packaging and deploying multi-agent AI formations
- [Tide Registry](https://tide.openreef.ai) -- Formation registry for publishing and discovering formations

## License

MIT
