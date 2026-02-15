# OpenReef

**The open formation format for multi-agent teams.**

OpenReef is a packaging format and toolchain for deploying pre-configured AI agent teams ("formations") to [OpenClaw](https://github.com/openclaw/openclaw). Define your agents, wire their communication, declare dependencies, and ship the whole thing as a single portable package.

```bash
reef install ./founder-ops
# → 3 agents deployed, 4 bindings wired, 2 cron jobs scheduled ✓
```

## Why

Setting up a multi-agent team on OpenClaw today means manually creating each agent, writing personality files, wiring inter-agent communication, configuring tools, and setting up cron jobs. If you want to share that setup or reproduce it, you're copying workspace directories and hoping nothing breaks.

OpenReef gives agent teams a **package format** — like Docker Compose for AI agents. One `reef.json` manifest declares everything. Install it, configure your variables, and the whole team spins up.

## What's a Formation?

A formation is a directory containing everything needed to deploy a team of AI agents:

```
my-formation/
├── reef.json              # Manifest — agents, wiring, dependencies, variables
├── reef.lock.json         # Pinned skill versions with integrity digests
├── .env.example           # Quick setup template
├── README.md              # Human-readable overview
└── agents/
    ├── manager/
    │   ├── SOUL.md        # Personality and behavior
    │   ├── IDENTITY.md    # Identity metadata
    │   └── knowledge/
    │       ├── static/    # Reference material (overwritten on update)
    │       └── dynamic/   # Agent-written data (preserved on update)
    └── researcher/
        ├── SOUL.md
        └── knowledge/
            ├── static/
            └── dynamic/
```

## Formation Types

| Type | Agents | Use Case |
|------|--------|----------|
| `solo` | 1 | Single agent with curated personality, tools, and cron |
| `team` | 2–5 | Defined roles with explicit communication topology |
| `swarm` | 6+ | Large-scale or dynamically-spawning agent patterns |

## Quick Start

### Create a Formation

```bash
reef init my-formation
cd my-formation
# Edit reef.json, write your SOUL.md files, done
```

### Deploy a Formation

```bash
cp .env.example .env       # Fill in your variables
reef install .             # Deploy to OpenClaw
```

### Use the Starter Template

The [`template/`](template/) directory contains a ready-to-customize two-agent formation (manager + researcher) with example variables, inter-agent wiring, and knowledge directories.

## The Manifest (`reef.json`)

A single JSON file declares your entire formation:

```json
{
  "reef": "1.0",
  "type": "team",
  "name": "my-formation",
  "version": "1.0.0",
  "description": "A research team with a manager and researcher",
  "namespace": "my-team",
  "variables": {
    "OPENAI_API_KEY": {
      "type": "string",
      "required": true,
      "sensitive": true
    },
    "MISSION_GOAL": {
      "type": "string",
      "default": "Research"
    }
  },
  "agents": {
    "manager": {
      "source": "agents/manager",
      "description": "Coordinates the team and delegates tasks",
      "role": "coordinator",
      "model": "gpt-4o",
      "tools": { "allow": ["web-search", "file-read"] }
    },
    "researcher": {
      "source": "agents/researcher",
      "description": "Conducts deep research on assigned topics",
      "role": "researcher",
      "model": "gpt-4o",
      "tools": { "allow": ["web-search"] }
    }
  },
  "agentToAgent": {
    "manager": ["researcher"],
    "researcher": ["manager"]
  }
}
```

Variables support `{{VARIABLE_NAME}}` interpolation across all text files. Sensitive values are never stored in plaintext.

## CLI

| Command | Description |
|---------|-------------|
| `reef init` | Scaffold a new formation |
| `reef install <path>` | Deploy a formation to OpenClaw |
| `reef update <path>` | Update a deployed formation (preserves agent-written data) |
| `reef uninstall <name>` | Remove a formation and all its resources |
| `reef inspect <path>` | Preview what a formation will deploy |
| `reef validate <path>` | Run health checks on a deployed formation |
| `reef export <namespace>` | Snapshot running agents into a formation package |
| `reef lock` | Pin dependency versions with integrity digests |
| `reef list` | List installed formations |
| `reef status <name>` | Show status of a deployed formation |

## Security

- **No code execution.** Formations are data files only (JSON + Markdown). Nothing runs during install.
- **Pinned dependencies.** `reef.lock.json` pins exact skill versions with SHA-256 integrity digests.
- **Sensitive variable handling.** Values marked `sensitive` are never written to disk in plaintext.
- **Pre-install audit.** `reef inspect` shows exactly what will be deployed before you install.
- **Per-agent sandboxing.** Skills run within OpenClaw's agent sandbox boundaries.

## Project Structure

```
openreef/
├── SPEC.md                    # Full format specification
├── schema/
│   └── reef.schema.json       # JSON Schema for reef.json validation
└── template/                  # Starter formation template
    ├── reef.json
    ├── reef.lock.json
    ├── .env.example
    ├── README.md
    └── agents/
        ├── manager/
        └── researcher/
```

- **[`SPEC.md`](SPEC.md)** — The complete formation format specification: manifest schema, inter-agent communication, variable interpolation, install flow, CLI commands, security model, and update/uninstall behavior.
- **[`schema/reef.schema.json`](schema/reef.schema.json)** — JSON Schema (draft 2020-12) for validating `reef.json` manifests.
- **[`template/`](template/)** — A working starter formation you can copy and customize.

## License

[MIT](LICENSE)
