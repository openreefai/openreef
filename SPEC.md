# OpenReef Formation Format Specification

**Version:** 1.0
**Status:** Draft

## Overview

OpenReef is a format and toolchain for packaging multi-agent team configurations ("formations") for [OpenClaw](https://github.com/openclaw/openclaw), the open-source AI agent platform. A formation is a self-contained, deployable package that defines a team of AI agents, their personalities, communication topology, dependencies, and runtime configuration.

**Terminology:**

- **OpenReef** - The project: format specification, JSON schema, CLI toolchain
- **Formation** - An individual deployable agent team package (e.g., "Install the Founder Ops Formation")

---

## Formation Directory Structure

A formation is a directory containing the following files:

```
my-formation/
├── reef.json                  # Manifest: metadata, agents, wiring, dependencies
├── reef.lock.json             # Lockfile: pinned skill versions + digests (optional)
├── .env.example               # Variable template for quick setup
├── README.md                  # Human-readable overview
├── agents/
│   ├── agent-slug/
│   │   ├── SOUL.md            # Personality and behavior (REQUIRED)
│   │   ├── HEARTBEAT.md       # Periodic wakeup checklist
│   │   ├── IDENTITY.md        # Identity metadata
│   │   ├── TOOLS.md           # Tool usage guidance
│   │   └── knowledge/
│   │       ├── static/        # Reef-controlled, overwritten on update
│   │       └── dynamic/       # Agent/user writable, preserved during updates
│   └── another-agent/
│       └── ...
```

### File Descriptions

| File | Required | Description |
|------|----------|-------------|
| `reef.json` | Yes | Formation manifest: all metadata, agent definitions, wiring, and dependencies |
| `reef.lock.json` | No | Lockfile pinning exact skill versions with SHA-256 digests |
| `.env.example` | No | Template showing required environment variables with example values |
| `README.md` | No | Human-readable formation overview and setup guide |

### Agent Directory

Each `agents/<slug>/` maps directly to an OpenClaw workspace directory on deployment.

| File | Required | Description |
|------|----------|-------------|
| `SOUL.md` | Yes | Agent personality, behavior instructions, and goals |
| `HEARTBEAT.md` | No | Periodic wakeup checklist for cron-driven agents |
| `IDENTITY.md` | No | Agent identity metadata (name, role, affiliation) |
| `TOOLS.md` | No | Guidance for how the agent should use its available tools |

**Note:** `AGENTS.md` is NOT authored in the formation. It is generated at install time from the manifest topology and injected into each agent's workspace.

### Knowledge Directories

Each agent has two knowledge subdirectories with different lifecycle semantics:

- **`knowledge/static/`** - Formation-authored reference material. This directory is fully controlled by the formation and is **overwritten on `reef update`**. Use it for SOPs, reference docs, and curated data the agent should have access to.

- **`knowledge/dynamic/`** - Runtime-writable storage. Agents store learned data, notes, and accumulated knowledge here. This directory is **preserved during updates**. `SOUL.md` should instruct agents to write here when they need to persist information across sessions.

---

## Manifest (`reef.json`)

The manifest is the single source of truth for a formation's configuration. It is a JSON file with the following top-level sections:

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reef` | `string` | Yes | Spec version. Must be `"1.0"` for this version. |
| `type` | `string` | Yes | Formation category: `"solo"`, `"shoal"`, or `"school"` |
| `name` | `string` | Yes | Formation name (lowercase, hyphens allowed) |
| `version` | `string` | Yes | Semantic version (e.g., `"1.0.0"`) |
| `description` | `string` | Yes | Brief description of what the formation does |
| `author` | `string` | No | Formation author or organization |
| `license` | `string` | No | SPDX license identifier |
| `repository` | `string` | No | URL of the formation's source repository (URI format) |
| `compatibility` | `object` | No | Platform compatibility constraints |
| `namespace` | `string` | Yes | Prefix for all agent IDs in this formation |
| `variables` | `object` | No | User-supplied configuration values |
| `agents` | `object` | Yes | Agent definitions keyed by slug |
| `agentToAgent` | `object` | No | Communication topology as adjacency list |
| `bindings` | `array` | No | Channel routing rules |
| `cron` | `array` | No | Scheduled jobs with agent assignment |
| `dependencies` | `object` | No | Required skills and services |
| `validation` | `object` | No | Post-deploy health check configuration |

### Formation Types

| Type | Description |
|------|-------------|
| `solo` | Single agent with curated SOUL.md, tools, and cron |
| `shoal` | 2–5 agents with defined roles and communication topology |
| `school` | 6+ agents or dynamically-spawning agent patterns |

In v1.0, the `type` field is **metadata only** - used for marketplace filtering and cataloging. The installer logic is identical for all types. Future versions may introduce specific orchestration logic for `school` types.

### Compatibility

```json
{
  "compatibility": {
    "openclaw": ">=0.2.0"
  }
}
```

The `openclaw` field specifies a semver range for the required OpenClaw version. This constraint is **enforced at install time** — the installer checks the running OpenClaw version (via Gateway status RPC or local `openclaw --version` CLI) and aborts if the version does not satisfy the range. Use the `--skip-compat` flag to override this check.

### Namespace

The `namespace` field is a string prefix applied to all agent IDs in the formation. For example, with `"namespace": "support-team"`, an agent with slug `triage` gets the full ID `support-team.triage`.

Namespaces:
- Must be lowercase alphanumeric with hyphens
- Provide isolation between formations
- Are used in all inter-agent references and bindings

### Variables

Variables allow formations to be customized at install time. Each variable is declared with a name (key) and configuration:

```json
{
  "variables": {
    "OPENAI_API_KEY": {
      "type": "string",
      "description": "OpenAI API key for LLM calls",
      "required": true,
      "sensitive": true
    },
    "MISSION_GOAL": {
      "type": "string",
      "description": "Primary mission for the agent team",
      "default": "Research",
      "required": false,
      "sensitive": false
    }
  }
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `type` | `string` | Yes | Value type: `"string"`, `"number"`, `"boolean"` |
| `description` | `string` | No | Human-readable description |
| `default` | `any` | No | Default value if not provided |
| `required` | `boolean` | No | Whether a value must be supplied (default: `false`) |
| `sensitive` | `boolean` | No | If `true`, value is never stored in plaintext (default: `false`) |

### Agents

Each agent is defined as a key-value pair in the `agents` object, where the key is the agent slug:

```json
{
  "agents": {
    "manager": {
      "source": "agents/manager",
      "description": "Coordinates the team and delegates tasks",
      "role": "coordinator",
      "model": "anthropic/claude-opus-4-6",
      "tools": {
        "allow": ["web_search", "read"]
      },
      "sandbox": {
        "network": true,
        "filesystem": "restricted"
      }
    }
  }
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `source` | `string` | Yes | Relative path to the agent's directory |
| `description` | `string` | Yes | What this agent does |
| `role` | `string` | No | Agent's role label (for documentation/filtering) |
| `model` | `string` | No | LLM model identifier |
| `tools` | `object` | No | Tool configuration |
| `tools.allow` | `array` | No | List of allowed tool/skill names |
| `sandbox` | `object` | No | OpenClaw sandbox configuration |

### Inter-Agent Communication (`agentToAgent`)

The `agentToAgent` field defines the communication topology as a directed adjacency list. Each key is a source agent slug and the value is an array of target agent slugs:

```json
{
  "agentToAgent": {
    "manager": ["researcher", "writer"],
    "researcher": ["manager"]
  }
}
```

This means:
- `manager` can send messages to `researcher` and `writer`
- `researcher` can send messages to `manager`
- `writer` cannot initiate messages to anyone (but can receive from `manager`)

All agent slugs referenced in `agentToAgent` must exist in the `agents` section.

#### Binding Mechanism

Reef utilizes OpenClaw's native `sessions` capability via Gateway RPC. For every directed edge `A → B` in the `agentToAgent` topology, the installer issues a session binding to Agent B's workspace:

```json
{
  "agentId": "{{namespace}}.B",
  "match": {
    "type": "session",
    "peer": { "kind": "agent", "id": "{{namespace}}.A" }
  },
  "action": "allow"
}
```

**Lifecycle:**
- Bindings are created **idempotently** during the Deploy phase (only if missing)
- Bindings are explicitly removed on uninstall to prevent orphaned routes

**Initialization:**
- If the target agent has no active session, Reef first issues a lightweight `sessions_send` ping via the Gateway to initialize routing tables

**Agent Behavior:**
- Agents are instructed via `TOOLS.md` to use the standard `sessions_send` tool
- The Gateway enforces the allow-list defined by the bindings (default deny)

### Bindings

Channel routing rules for connecting agents to external channels (e.g., Slack, Telegram, Discord):

```json
{
  "bindings": [
    {
      "match": {
        "channel": "slack",
        "peer": { "kind": "channel", "id": "#support" }
      },
      "agent": "triage"
    }
  ]
}
```

Each binding is a `{ match, agent }` object. The `match` object specifies which incoming messages to route to the named agent.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `match` | `object` | Yes | Rich match object for OpenClaw routing |
| `match.channel` | `string` | Yes | Channel token (`slack`, `telegram`, `discord`, `teams`) |
| `match.accountId` | `string` | No | Specific account, or `*` for any |
| `match.peer` | `object` | No | Peer targeting — requires both `kind` and `id` |
| `match.peer.kind` | `string` | No | Peer kind (e.g., `direct`, `group`, `channel`). Accepts any string including `{{VARIABLE}}` tokens |
| `match.peer.id` | `string` | No | Peer identifier (e.g., `#ops`, `12345`) |
| `match.guildId` | `string` | No | Discord guild ID |
| `match.teamId` | `string` | No | Slack team ID |
| `match.roles` | `string[]` | No | Discord roles — ANY matching role satisfies (overlap semantics) |
| `agent` | `string` | Yes | Agent slug to bind |

#### Channel Tokens

The `match.channel` field is a **channel token** — a simple platform identifier, not a `<type>:<scope>` compound string. Supported tokens:

| Token | Platform |
|-------|----------|
| `slack` | Slack |
| `telegram` | Telegram |
| `discord` | Discord |
| `teams` | Microsoft Teams |

Peer targeting (which specific channel, group, or DM to route) is expressed via the optional `match.peer` field, not embedded in the channel string.

Bindings without a `peer` field shadow the main agent and receive ALL messages on that channel. The installer unchecks bare bindings by default in the binding selection checkbox and logs a skip warning.

#### Functional vs. Interaction Channels

Bindings fall into two categories:

- **Functional channels** are intrinsic to the formation's design — part of what the formation *does*. Example: a monitor agent that polls a specific channel. Hardcode these.

- **Interaction channels** are how the *user* communicates with the formation's coordinator. These are user preferences, not formation decisions. Use `{{VARIABLE}}` references in individual match fields for these.

#### Convention

Declare variables for interaction channel match fields. The user sets values at install time:

```json
{
  "variables": {
    "INTERACTION_CHANNEL": {
      "type": "string",
      "required": true,
      "description": "Channel token (e.g., slack, telegram, teams)"
    },
    "INTERACTION_PEER_KIND": {
      "type": "string",
      "required": true,
      "description": "Peer kind (e.g., channel, group, direct)"
    },
    "INTERACTION_PEER_ID": {
      "type": "string",
      "required": true,
      "description": "Peer identifier (e.g., #ops, 12345)"
    }
  },
  "bindings": [
    {
      "match": {
        "channel": "{{INTERACTION_CHANNEL}}",
        "peer": {
          "kind": "{{INTERACTION_PEER_KIND}}",
          "id": "{{INTERACTION_PEER_ID}}"
        }
      },
      "agent": "coordinator"
    }
  ]
}
```

For additional channels beyond what the manifest declares, handle them in a bootstrap or reconfigure flow inside the coordinator agent (stored in `knowledge/dynamic`), not as hardcoded manifest bindings.

### Cron

Scheduled jobs that trigger agent actions on a schedule:

```json
{
  "cron": [
    {
      "schedule": "0 9 * * 1-5",
      "agent": "manager",
      "prompt": "Review open tasks and send a morning summary to the team.",
      "timezone": "America/New_York"
    }
  ]
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `schedule` | `string` | Yes | Cron expression |
| `agent` | `string` | Yes | Agent slug to trigger |
| `prompt` | `string` | Yes | Message sent to the agent |
| `timezone` | `string` | No | IANA timezone (default: `"UTC"`) |

### Dependencies

#### Skills

Skills are ClawHub packages that provide tools/capabilities to agents:

```json
{
  "dependencies": {
    "skills": {
      "web_search": "^1.2.0",
      "read": "^2.0.0"
    },
    "services": [
      {
        "name": "OpenAI API",
        "url": "https://platform.openai.com",
        "required": true,
        "description": "LLM provider for all agents"
      }
    ]
  }
}
```

- Skills are specified with semver version ranges
- Skills are installed per-agent workspace and sandboxed by OpenClaw's `agents[].sandbox` configuration
- `reef.lock.json` can pin exact versions (see Lockfile section)

#### Services

Services are external dependencies listed for informational purposes. They are not installed by Reef but are documented so users know what accounts/credentials are needed.

### Validation

Post-deploy health checks:

```json
{
  "validation": {
    "agent_exists": true,
    "file_exists": true,
    "binding_active": true,
    "cron_exists": true,
    "agent_responds": {
      "enabled": false,
      "timeout": 30
    }
  }
}
```

| Check | Type | Default | Description |
|-------|------|---------|-------------|
| `agent_exists` | `boolean` | `true` | Verify all agents were created |
| `file_exists` | `boolean` | `true` | Verify workspace files were written |
| `binding_active` | `boolean` | `true` | Verify all bindings are active |
| `cron_exists` | `boolean` | `true` | Verify cron jobs were created |
| `agent_responds` | `object` | `{ enabled: false }` | Functional connectivity check (opt-in) |

The `agent_responds` check is **opt-in only**. It sends a test message to each agent and verifies a response, which consumes tokens. It requires the `--verify-connectivity` CLI flag to run.

---

## Lockfile (`reef.lock.json`)

The lockfile pins exact versions of skill dependencies for reproducible, supply-chain-safe deployments:

```json
{
  "skills": {
    "web-search": {
      "version": "1.2.3",
      "resolved": "https://clawhub.example.com/skills/web-search/1.2.3",
      "integrity": "sha256-abc123def456..."
    }
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `version` | `string` | Exact pinned version |
| `resolved` | `string` | URL or commit reference the version was resolved from |
| `integrity` | `string` | SHA-256 digest of the skill tarball/commit for integrity verification |

**Behavior:**
- Generated by `reef lock` (scans resolved dependencies)
- Can also be manually committed
- If present, the installer uses pinned versions instead of resolving semver ranges
- If absent, semver ranges from `reef.json` are used directly

---

## Variable Interpolation

All text files in a formation (`*.md`, `.env.example`, etc.) and binding match fields in `reef.json` support `{{VARIABLE_NAME}}` substitution.

### Rules

1. Variables must be declared in the `variables` section of `reef.json`
2. `sensitive: true` variables are never stored in plaintext; the state file uses environment variable references instead
3. Undeclared `{{tokens}}` are left as-is during interpolation (agents may use mustache-style syntax in their own content)
4. Interpolation happens during the Deploy phase

### Built-in Variables

The following variables are always available and auto-computed by the installer:

| Variable | Description |
|----------|-------------|
| `{{namespace}}` | Active namespace for this deployment |
| `{{tools}}` | Auto-generated markdown list of the agent's enabled tools/skills with descriptions. Computed from `agent.tools.allow` + `dependencies.skills` during the deploy phase. |

### Example

In `SOUL.md`:
```markdown
You are the manager of the {{namespace}} team.

Your mission: {{MISSION_GOAL}}

## Available Tools

You have access to the following tools:

{{tools}}
```

After interpolation with `namespace: "support-team"`, `MISSION_GOAL: "Resolve customer issues"`, and the computed tools list:

```markdown
You are the manager of the support-team team.

Your mission: Resolve customer issues

## Available Tools

You have access to the following tools:

- **web-search** (v1.2.3) - Search the web for information
- **file-read** (v2.0.0) - Read files from the workspace
```

---

## Install Flow

The `reef install` command executes 8 phases:

### Phase 1: Parse

- Read `reef.json` from the formation directory
- Validate against the reef JSON Schema
- Abort with descriptive errors on schema violations

### Phase 2: Variables

Resolve all declared variables using the following precedence (highest to lowest):

1. CLI flags (`--set KEY=VALUE`)
2. `.env` file (loaded automatically from formation root or cwd; override with `--no-env`)
3. Environment variables
4. Default values from `reef.json`
5. Interactive prompt (for required variables with no value)

If a required variable has no value after resolution, abort with an error.

### Phase 3: Conflicts

Check for existing agents, bindings, and cron jobs that would conflict with the deployment:

- **Default:** Abort if any conflicts are found
- **`--force`:** Remove existing resources and recreate
- **`--merge`:** Update workspace files only, preserve existing agent configuration

### Phase 4: Dependencies

- Install required ClawHub skills using version ranges from `reef.json`
- If `reef.lock.json` is present, use pinned versions and verify integrity digests
- Skills are installed per-agent workspace
- Warn about unconfigured services listed in `dependencies.services`

### Phase 5: Confirm

- Print a deployment plan showing:
  - Agents to create
  - Bindings to wire
  - Cron jobs to schedule
  - Variables resolved (sensitive values masked)
- Await user confirmation (skip with `--yes`)

### Phase 6: Deploy

- Create agents via Gateway RPC
- Interpolate all template variables and write workspace files
- Compute `{{tools}}` for each agent from `agent.tools.allow` + `dependencies.skills`
- Generate `AGENTS.md` from the manifest topology and inject into each workspace
- Wire `agentToAgent` bindings idempotently (only create if missing)
- Resolve `{{VARIABLE}}` tokens in binding channel values using resolved variables
- Present binding checkbox (existing UX): bare bindings unchecked by default, unconfigured bindings unchecked
- Create channel bindings (skip bindings whose resolved channel is empty or deselected)
- Log skip warnings for bare bindings unless `--allow-channel-shadow`
- Create cron jobs

### Phase 7: Validate

Run post-deploy health checks as configured in `reef.json`:

| Check | Behavior |
|-------|----------|
| `agent_exists` | Verify each agent is accessible via Gateway |
| `file_exists` | Verify workspace files were written |
| `binding_active` | Verify all session bindings are active |
| `cron_exists` | Verify cron jobs were registered |
| `agent_responds` | **Opt-in only.** Requires `--verify-connectivity` flag. Sends a test message to each agent and verifies a response within the configured timeout. |

### Phase 8: State

Write `.reef/<formation>.state.json` containing:
- Formation name and version
- Deployed agent IDs
- Resolved variable values (sensitive values stored as env var references)
- SHA-256 hashes of all deployed files (for update diffing)
- Timestamp

---

## CLI Commands

### `reef init`

Scaffold a new formation directory with starter files.

- Creates `reef.json`, `README.md`, `.env.example`, and agent directories
- Auto-generates `.env.example` from the `variables` section in `reef.json`

### `reef install <path>`

Deploy a formation from a local directory.

- Executes the full 8-phase install flow
- Loads `.env` automatically if present (override with `--no-env`)
- Flags: `--set`, `--force`, `--merge`, `--yes`, `--no-env`, `--verify-connectivity`

### `reef validate <path>`

Run health checks against an installed formation without reinstalling.

- Executes structural checks: `agent_exists`, `file_exists`, `binding_active`, `cron_exists`
- `agent_responds` requires `--verify-connectivity`

### `reef export <namespace>`

Snapshot a running agent group into a formation package.

- Auto-detects and replaces sensitive values with `{{VARIABLE}}` placeholders
- Uses heuristics and interactive prompts to exclude noisy workspace artifacts (logs, temp files)
- Generates `reef.json`, agent directories, and `.env.example`

### `reef lock`

Generate or update `reef.lock.json` from resolved dependencies.

- Resolves semver ranges to exact versions
- Computes SHA-256 integrity digests
- Writes `reef.lock.json`

### `reef update <path>`

Update an installed formation to a new version.

- Preserves `knowledge/dynamic/` directories
- Overwrites `knowledge/static/` directories
- For other workspace files: updates if untouched by user, skips with warning if user-modified
- Uses SHA-256 hashes from the state file to detect user modifications

### `reef uninstall <name>`

Remove all resources created by a formation.

- Deletes agents via Gateway RPC
- Removes session bindings
- Removes cron jobs
- Cleans up state file

### `reef inspect <path>`

Show what a formation contains without installing.

- Displays agents, variables, dependencies, bindings, and cron jobs
- Allows users to audit a formation before deployment

### `reef list`

List all installed formations with their status.

### `reef status <name>`

Show detailed status of an installed formation including agent health, binding status, and last activity.

### `reef pack <path>`

Package a formation into a distributable `.tar.gz` archive. Validates the formation first, then creates `<name>-<version>.reef.tar.gz`.

- Runs `reef validate` before packing
- Excludes `.env`, `.reef/`, `node_modules/`, and other non-distributable files
- Output filename follows the pattern `<name>-<version>.reef.tar.gz`

### `reef diff <source>`

Compare a local formation against its deployed state. Shows file changes, variable differences, and topology changes. Useful before running `reef update`.

- Compares manifest fields (agents, bindings, cron, variables)
- Shows file-level diffs using stored SHA-256 hashes from the state file
- Highlights added, removed, and modified resources

### `reef repair <identifier>`

Detect and fix discrepancies between a deployed formation's expected state and actual state.

- Rewrites missing workspace files
- Recreates missing session bindings
- Re-registers missing cron jobs
- Reports what was repaired and what was already correct

### `reef logs <identifier>`

View session logs for a formation's agents.

- Optionally filter by agent slug with `--agent <slug>`
- Displays recent session activity and messages

### `reef publish [path]`

Publish a formation to the Tide registry.

- Requires authentication via `reef login` or `REEF_TOKEN` environment variable
- Validates the formation before publishing
- Packs the formation into a tarball
- Uploads the tarball and registers the version with the registry
- Flags: `--token`, `--yes`

### `reef search <query>`

Search the Tide registry for formations.

- Supports text and semantic search
- Filter by formation type with `--type solo|shoal|school`
- Displays name, description, version, and author for each result

### `reef login` / `reef logout` / `reef whoami`

Manage Tide registry credentials.

- `reef login` - Opens the Tide dashboard in a browser to create an API token, then prompts for input. Tokens are stored in `~/.openreef/credentials.json`.
- `reef logout` - Removes stored credentials from `~/.openreef/credentials.json`.
- `reef whoami` - Displays the currently authenticated user and token status.

---

## Registry

### Tide

[Tide](https://tide.openreef.ai) is the default formation registry for OpenReef. It provides hosting, discovery, and distribution of formation packages.

### Authentication Flow

1. Run `reef login`
2. The CLI opens the Tide dashboard (`https://tide.openreef.ai/tokens`) in the default browser
3. The user creates or copies an API token from the dashboard
4. The CLI prompts for the token and stores it in `~/.openreef/credentials.json`
5. Subsequent commands (`reef publish`, `reef search`) use the stored token automatically

Alternatively, set the `REEF_TOKEN` environment variable to authenticate without `reef login`.

### Publish Workflow

1. `reef validate` - Validates the formation
2. `reef pack` - Packages the formation into a `.tar.gz` archive
3. Upload - Sends the tarball to the Tide registry API
4. Register - Creates a version entry with metadata from `reef.json`

The publish flow is atomic: if any step fails, the version is not registered.

### Version Resolution

When installing by name (e.g., `reef install daily-ops@^1.0.0`), the registry resolves semver ranges to the latest matching version. The resolution order is:

1. Exact version match
2. Latest version satisfying the semver range
3. Latest stable version (if no range specified)

### Integrity Verification

Published formations include a SHA-256 digest of the tarball. During `reef install`, the downloaded tarball's digest is verified against the registry-provided value. A mismatch aborts the install.

### Registry URL Configuration

The default registry URL is `https://tide.openreef.ai`. Override with:

```bash
reef install daily-ops --registry https://registry.example.com
# or set the environment variable:
export REEF_REGISTRY_URL=https://registry.example.com
```

---

## Security Model

1. **No code execution.** Formations contain only data files (JSON + Markdown). No scripts, hooks, or executable code runs during install.

2. **ClawHub-only skills.** Skill dependencies must come from ClawHub. No arbitrary package sources.

3. **Per-agent sandboxing.** Skills are sandboxed per-agent via OpenClaw's agent sandbox configuration. Each agent's `sandbox` field controls network access, filesystem access, and other constraints.

4. **Supply-chain integrity.** `reef.lock.json` pins exact skill versions with SHA-256 digests. The installer verifies digests when a lockfile is present.

5. **Sensitive variable handling.** Variables marked `sensitive: true` are never stored in plaintext. The state file stores environment variable references (e.g., `$OPENAI_API_KEY`) instead of actual values.

6. **Pre-install audit.** `reef inspect <path>` lets users review everything a formation will deploy before installing.

---

## Update and Uninstall

### State Tracking

The state file (`.reef/<formation>.state.json`) records:
- SHA-256 hashes of all deployed files
- Formation version at time of deploy
- Resolved variable values (sensitive values as env var references)

### Update Behavior (`reef update`)

When updating a formation, `reef update` diffs old vs new content using stored hashes:

| Directory/File | Behavior |
|----------------|----------|
| `knowledge/static/` | **Overwritten.** New formation content replaces old. |
| `knowledge/dynamic/` | **Preserved.** Never touched during updates. |
| Other workspace files | **Updated if untouched.** If the deployed file's hash matches the state file (user hasn't modified it), it is updated. If the user has modified it, the update is skipped with a warning. |

### Uninstall Behavior (`reef uninstall`)

Removes all resources created by the formation:
- Agents (deleted via Gateway RPC)
- Session bindings (explicitly removed to prevent orphaned routes)
- Cron jobs
- State file

---

## Complete Example

A full `reef.json` for a customer support team formation:

```json
{
  "reef": "1.0",
  "type": "shoal",
  "name": "customer-support",
  "version": "1.0.0",
  "description": "A customer support team with triage, knowledge base, and escalation agents",
  "author": "Example Corp",
  "license": "MIT",
  "compatibility": {
    "openclaw": ">=0.2.0"
  },
  "namespace": "cs-team",
  "variables": {
    "OPENAI_API_KEY": {
      "type": "string",
      "description": "OpenAI API key for LLM calls",
      "required": true,
      "sensitive": true
    },
    "COMPANY_NAME": {
      "type": "string",
      "description": "Company name for agent responses",
      "default": "Acme Inc",
      "required": false,
      "sensitive": false
    },
    "ESCALATION_EMAIL": {
      "type": "string",
      "description": "Email for human escalation",
      "required": true,
      "sensitive": false
    }
  },
  "agents": {
    "triage": {
      "source": "agents/triage",
      "description": "Classifies incoming requests and routes to the right agent",
      "role": "router",
      "model": "anthropic/claude-sonnet-4-5",
      "tools": {
        "allow": ["web_search"]
      },
      "sandbox": {
        "network": true,
        "filesystem": "restricted"
      }
    },
    "knowledge": {
      "source": "agents/knowledge",
      "description": "Answers questions using the knowledge base",
      "role": "responder",
      "model": "anthropic/claude-sonnet-4-5",
      "tools": {
        "allow": ["read", "web_search"]
      },
      "sandbox": {
        "network": true,
        "filesystem": "restricted"
      }
    },
    "escalation": {
      "source": "agents/escalation",
      "description": "Handles complex issues and escalates to humans when needed",
      "role": "escalation",
      "model": "anthropic/claude-sonnet-4-5",
      "tools": {
        "allow": ["email_send"]
      },
      "sandbox": {
        "network": true,
        "filesystem": "restricted"
      }
    }
  },
  "agentToAgent": {
    "triage": ["knowledge", "escalation"],
    "knowledge": ["triage", "escalation"],
    "escalation": ["triage"]
  },
  "bindings": [
    {
      "match": {
        "channel": "slack",
        "peer": { "kind": "channel", "id": "#support" }
      },
      "agent": "triage"
    }
  ],
  "cron": [
    {
      "schedule": "0 9 * * 1-5",
      "agent": "triage",
      "prompt": "Review unresolved tickets from the past 24 hours and summarize status.",
      "timezone": "America/New_York"
    }
  ],
  "dependencies": {
    "skills": {
      "web_search": "^1.2.0",
      "read": "^2.0.0",
      "email_send": "^1.0.0"
    },
    "services": [
      {
        "name": "OpenAI API",
        "url": "https://platform.openai.com",
        "required": true,
        "description": "LLM provider for all agents"
      },
      {
        "name": "Slack",
        "url": "https://slack.com",
        "required": true,
        "description": "Customer support channel"
      }
    ]
  },
  "validation": {
    "agent_exists": true,
    "file_exists": true,
    "binding_active": true,
    "cron_exists": true,
    "agent_responds": {
      "enabled": false,
      "timeout": 30
    }
  }
}
```
