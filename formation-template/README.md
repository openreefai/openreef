# Formation Template - Starter kit for OpenReef formations

This is the official starter template for building OpenReef formations. It includes a working two-agent team (manager + researcher) with all required files, ready to customize for your use case.

Use `reef init` to scaffold a new formation from this template, or copy it manually and start editing.

## What's inside

```
formation-template/
  reef.json                         # Formation manifest (name, agents, topology, cron, deps)
  reef.lock.json                    # Lockfile: pins exact skill versions for supply-chain safety
  .env.example                      # Environment variable template (generated from reef.json variables)
  README.md                         # This file (Formation Author's Guide)
  agents/
    manager/
      SOUL.md                       # Agent personality, behavior, and instructions
      IDENTITY.md                   # Agent metadata (name, role, formation)
      knowledge/
        static/                     # Read-only reference material, shipped with the formation
          project-brief.md
        dynamic/                    # Runtime scratch space, written by the agent at deploy time
    researcher/
      SOUL.md
      IDENTITY.md
      knowledge/
        static/
        dynamic/
```

## Quick start

```bash
# 1. Scaffold a new formation from this template
reef init my-formation

# 2. Edit reef.json: set name, description, author, agents, topology
cd my-formation
$EDITOR reef.json

# 3. Write SOUL.md files for each agent
$EDITOR agents/manager/SOUL.md
$EDITOR agents/researcher/SOUL.md

# 4. Validate the formation
reef validate .

# 5. Deploy
reef install .
```

## Formation structure

### reef.json

The formation manifest. Every formation must have one at the root. Key fields:

| Field | Purpose |
|-------|---------|
| `reef` | Schema version (always `"1.0"`) |
| `type` | `"solo"` (single agent) or `"shoal"` (multi-agent) |
| `name` | Unique formation name (kebab-case, used in tarball filenames) |
| `version` | Semver version string |
| `description` | Human-readable summary |
| `author` | Author name or organization |
| `license` | SPDX license identifier |
| `namespace` | Runtime namespace for agent IDs (e.g., `"my-formation"`) |
| `variables` | Typed configuration variables (see Variables section) |
| `agents` | Agent definitions (source path, description, role, model, tools, sandbox) |
| `agentToAgent` | Communication topology between agents |
| `cron` | Scheduled prompts |
| `dependencies` | Skills (version-ranged) and services (informational) |
| `validation` | Post-deploy health check configuration |

### reef.lock.json

Lockfile that pins exact skill versions after running `reef lock .`. Ensures reproducible deployments and supply-chain safety. Do not edit manually.

### .env.example

Generated from the `variables` section of reef.json. Copy to `.env` and fill in sensitive values before deploying. The CLI generates this automatically during `reef init`.

### agents/

Each agent lives in its own directory under `agents/`. The directory name must match the key in `reef.json`'s `agents` object. Every agent directory must contain at least a `SOUL.md`.

### knowledge/

Each agent has `knowledge/static/` and `knowledge/dynamic/` directories:

- **static/** contains read-only reference material shipped with the formation
- **dynamic/** is empty at deploy time; agents write runtime data here

## Writing SOUL.md

SOUL.md is the core personality and instruction file for each agent. It is interpolated at deploy time with variable values and tool lists.

### Best practices

**Start with a clear role statement:**

```markdown
# Manager Agent

You are the **manager** of the {{namespace}} formation.
```

**Use `{{variable}}` interpolation** for any value that should come from reef.json variables:

```markdown
## Mission

{{MISSION_GOAL}}
```

All variables defined in reef.json's `variables` section are available, plus the built-in `{{namespace}}` variable.

**Write behavioral instructions** that are specific, actionable, and bounded:

```markdown
## Behavior

- When you receive a new mission, decompose it into specific research questions
- Delegate research tasks to the researcher agent
- Collect and synthesize findings into clear summaries
- Store important findings in your `knowledge/dynamic/` directory
```

**Include a communication section** with `{{tools}}` to inject the agent's allowed tool list:

```markdown
## Available Tools

You have access to the following tools:

{{tools}}

## Communication

You can communicate with other agents in your formation using the `sessions_send` tool.
Refer to `AGENTS.md` for the full team roster and topology.
```

The `{{tools}}` token is replaced at deploy time with the formatted list of tools from the agent's `tools.allow` array in reef.json.

**Use structured output formats** when agents need to produce consistent results:

```markdown
## Output Format

When reporting findings, use this structure:

### Finding: [Title]
- **Source:** [URL or reference]
- **Confidence:** High / Medium / Low
- **Summary:** [2-3 sentences]
- **Evidence:** [Key data points]
```

## Writing IDENTITY.md

IDENTITY.md provides brief metadata about the agent. It follows a consistent pattern:

```markdown
# Identity

- **Name:** Manager
- **Role:** Coordinator
- **Formation:** {{namespace}}
- **Description:** Coordinates the team, delegates tasks, and synthesizes results
```

The `{{namespace}}` variable is interpolated at deploy time. IDENTITY.md is optional but recommended for every agent.

## Knowledge directories

### static/

Read-only reference material that ships with the formation. Examples:

- Project briefs, runbooks, and playbooks
- API reference guides
- Style guides or tone-of-voice documents
- Channel configuration templates

Static knowledge is copied into the agent's workspace at deploy time and is never modified by the agent.

### dynamic/

Empty at deploy time. Agents write runtime data here during operation:

- Scan results, triage logs, state files
- Research notes and drafts
- Accumulated context and learned preferences

Dynamic knowledge persists across agent sessions but is destroyed on `reef uninstall`. Back up anything important before uninstalling.

## Variables

Variables are declared in the `variables` section of reef.json and interpolated into SOUL.md, IDENTITY.md, and knowledge files at deploy time.

### Types

| Type | Description | Example |
|------|-------------|---------|
| `string` | Text value | `"Research"` |
| `number` | Numeric value | `10` |
| `boolean` | True or false | `true` |

### Flags

| Flag | Description |
|------|-------------|
| `required` | Must be set before deployment (validation fails if missing) |
| `sensitive` | Value is masked in logs and inspect output (e.g., API keys) |

### Interpolation syntax

Use `{{VARIABLE_NAME}}` in any `.md` file. The CLI replaces tokens at deploy time:

```markdown
Your mission is: {{MISSION_GOAL}}
```

If a variable has a `default` value and the user does not override it, the default is used.

### .env.example generation

The CLI generates `.env.example` from the variables section of reef.json during `reef init`. Each variable becomes a line with its description as a comment.

## Communication topology

The `agentToAgent` field in reef.json defines which agents can communicate with each other via `sessions_send`.

### Hub-and-spoke

One coordinator routes all work. Specialists only talk to the hub:

```json
"agentToAgent": {
  "chief": ["monitor", "responder", "docs-agent"],
  "monitor": ["chief"],
  "responder": ["chief"],
  "docs-agent": ["chief"]
}
```

### Bidirectional

Two agents can talk to each other freely:

```json
"agentToAgent": {
  "manager": ["researcher"],
  "researcher": ["manager"]
}
```

### Unidirectional

One agent sends to another but does not receive replies:

```json
"agentToAgent": {
  "sensor": ["coordinator"],
  "coordinator": []
}
```

Agents not listed in `agentToAgent` cannot send messages to other agents. The topology is enforced at runtime.

## Channel bindings

Bindings connect agents to external communication channels so they can receive messages from humans and external systems. Each binding maps a channel to an agent.

### Channel format

Channels use the `<type>:<scope>` format:

| Example | Type | Scope |
|---------|------|-------|
| `slack:#ops` | Slack | The `#ops` channel |
| `telegram:12345` | Telegram | Chat ID `12345` |
| `teams:ops-room` | Microsoft Teams | The `ops-room` channel |

### Functional vs. interaction channels

- **Functional channels** are hard-coded in the manifest for operational purposes (e.g., a dedicated alert channel that never changes).
- **Interaction channels** are set by the operator at deploy time via variables, allowing different environments to use different channels.

The template uses the interaction pattern with `{{INTERACTION_CHANNEL}}` interpolation:

```json
"bindings": [
  { "channel": "{{INTERACTION_CHANNEL}}", "agent": "manager" }
]
```

The `{{INTERACTION_CHANNEL}}` token is resolved during `reef install` from the operator's `.env` file or CLI prompt, just like any other variable.

### Adding channels at runtime

For channels beyond what the manifest declares, use the coordinator agent's bootstrap or reconfigure flow. Dynamic channel registrations are stored in `knowledge/dynamic/` and managed by the agent itself rather than the manifest.

## Cron scheduling

The `cron` array in reef.json defines scheduled prompts that fire automatically:

```json
"cron": [
  {
    "schedule": "0 9 * * 1-5",
    "agent": "manager",
    "prompt": "Review progress on the current mission and plan today's priorities.",
    "timezone": "UTC"
  }
]
```

### Cron expressions

Standard 5-field cron syntax: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|------------|---------|
| `*/10 * * * *` | Every 10 minutes |
| `0 9 * * 1-5` | 9:00 AM UTC, weekdays |
| `5-55/10 * * * *` | Every 10 minutes, offset by 5 minutes |
| `0 7 * * *` | 7:00 AM daily |

### Timezone

All cron schedules include a `timezone` field. Use IANA timezone names (e.g., `"UTC"`, `"America/New_York"`).

### Offset patterns for coordination

When multiple agents need to run in sequence, offset their cron schedules to avoid race conditions:

```json
"cron": [
  { "schedule": "*/10 * * * *", "agent": "monitor", "prompt": "Poll channels..." },
  { "schedule": "5-55/10 * * * *", "agent": "chief", "prompt": "Process scan results..." }
]
```

The 5-minute offset gives Monitor time to finish before Chief processes the results.

### Idempotency guards

Agents with cron schedules should include idempotency guards in their SOUL.md to prevent reprocessing:

```markdown
## Wake Cycle

When you wake on cron:
1. Read `knowledge/dynamic/state.md` and check `last_processed_id`
2. If no new data since last run, skip
3. Process new data and update `last_processed_id`
```

## Dependencies

### Skills

Version-ranged tool packages that agents use:

```json
"dependencies": {
  "skills": {
    "web-search": "^1.0.0",
    "file-read": "^1.0.0"
  }
}
```

Run `reef lock .` to pin exact versions in `reef.lock.json`. Skill versions follow semver ranges (e.g., `^1.0.0`, `~2.3.0`, `>=1.0.0 <2.0.0`).

### Services

Informational declarations of external services the formation depends on:

```json
"dependencies": {
  "services": [
    {
      "name": "Anthropic API",
      "url": "https://console.anthropic.com",
      "required": true,
      "description": "LLM provider for all agents"
    }
  ]
}
```

Services are not installed or managed by the CLI. They appear in `reef inspect` output to help operators understand external requirements.

## Sandbox

Each agent can declare sandbox settings that control its runtime environment:

```json
"sandbox": {
  "network": true,
  "filesystem": "restricted"
}
```

### Network

- `true` - agent can make outbound network requests (web search, API calls)
- `false` - agent is fully sandboxed with no network access

### Filesystem

- `"restricted"` - agent can only read/write within its own workspace directory
- `"none"` - agent has no filesystem access

## Validation

The `validation` section configures post-deploy health checks:

```json
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
```

| Check | What it verifies |
|-------|------------------|
| `agent_exists` | Agent directories exist with required files |
| `file_exists` | All referenced files (SOUL.md, knowledge/) are present |
| `binding_active` | Channel bindings are registered in the runtime config |
| `cron_exists` | Cron jobs are registered for scheduled agents |
| `agent_responds` | (Optional) Sends a ping and waits for agent response within timeout |

Run validation with:

```bash
# Validate formation source
reef validate .

# Validate a deployed formation
reef validate my-namespace/my-formation --deployed
```

## Publishing

### Pack

Create a distributable tarball:

```bash
reef pack .
# Output: formation-template-0.1.0.reef.tar.gz
```

The tarball includes all formation files (reef.json, agents, knowledge/static) but excludes `.env`, `node_modules`, and other non-essential files.

### Publish

Publish to the Tide registry:

```bash
reef publish .
```

This packs the formation and uploads it to the Tide registry, making it available for others to install with `reef install <formation-name>`.

### Tide registry

The Tide registry is the central package registry for OpenReef formations. Published formations can be discovered, installed, and version-managed through the registry.

## Examples

For real-world formation examples, see:

- **[daily-ops](https://github.com/openreefai/daily-ops)** - A five-agent daily operations squad with hub-and-spoke topology, cron-driven email monitoring, research, content writing, and daily briefings
- **[launch-ops](https://github.com/openreefai/launch-ops)** - A five-agent formation for two-week product launches: channel monitoring, signal triage, response drafting, documentation fixes, and content creation
