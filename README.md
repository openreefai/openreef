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
| `shoal` | 2–5 | Defined roles with explicit communication topology |
| `school` | 6+ | Large-scale or dynamically-spawning agent patterns |

## Quick Start

### Install the CLI

```bash
npm install -g @openreef/cli
```

### Create a Formation

```bash
reef init my-formation
cd my-formation
# Edit reef.json, write your SOUL.md files
reef validate .            # Check everything is wired correctly
reef pack .                # Package for distribution
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
  "type": "shoal",
  "name": "my-formation",
  "version": "1.0.0",
  "description": "A research team with a manager and researcher",
  "namespace": "my-team",
  "variables": {
    "ANTHROPIC_API_KEY": {
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
      "model": "anthropic/claude-opus-4-6",
      "tools": { "allow": ["web-search", "file-read"] }
    },
    "researcher": {
      "source": "agents/researcher",
      "description": "Conducts deep research on assigned topics",
      "role": "researcher",
      "model": "anthropic/claude-sonnet-4-5",
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

### Offline Commands

| Command | Description |
|---------|-------------|
| `reef init [name]` | Scaffold a new formation from the bundled template |
| `reef inspect <path>` | Parse reef.json and pretty-print formation contents |
| `reef validate <path>` | Run schema and structural validation on a formation |
| `reef validate --deployed <id>` | Validate deployed formation health (workspace, config, drift) |
| `reef pack <path>` | Package a formation into a `.tar.gz` archive |

### Online Commands (requires running OpenClaw)

| Command | Description |
|---------|-------------|
| `reef install <source>` | Deploy a formation (local path, tarball, or registry name) |
| `reef uninstall <identifier>` | Remove a formation and all its resources |
| `reef update <source>` | Update a deployed formation (preserves agent-written data) |
| `reef diff <source>` | Compare local formation source against deployed state |
| `reef repair <identifier>` | Detect and fix discrepancies in a deployed formation |
| `reef export <identifier>` | Export a deployed formation's source to a local directory |
| `reef logs <identifier>` | View session logs for a formation's agents |
| `reef list` | List installed formations |
| `reef status <identifier>` | Show status of a deployed formation |
| `reef lock [path]` | Resolve and pin skill dependency versions to `reef.lock.json` |
| `reef publish [path]` | Publish a formation to the GitHub-based registry |

## Formation Registry

Install formations directly from a registry by name:

```bash
reef install daily-ops              # latest version
reef install daily-ops@1.2.0        # specific version
```

Configure the registry URL:

```bash
reef install daily-ops --registry https://registry.example.com
# or set the environment variable:
export REEF_REGISTRY_URL=https://registry.example.com
```

Use `--skip-cache` to bypass the local registry cache:

```bash
reef install daily-ops --skip-cache
```

**Resolution precedence:** local path > tarball > registry name. If `daily-ops` is a local directory or `.tar.gz` file, it will be used directly.

## Publishing

Publish formations to the GitHub-based registry:

```bash
reef publish .                         # uses REEF_GITHUB_TOKEN or GITHUB_TOKEN
reef publish . --token ghp_xxx         # explicit token
reef publish . --yes                   # skip confirmation
```

Set `REEF_GITHUB_TOKEN` (or `GITHUB_TOKEN`) for authentication. The publish flow uses an atomic draft-release workflow to prevent partial updates.

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
├── package.json               # @openreef/cli package
├── schema/
│   └── reef.schema.json       # JSON Schema for reef.json validation
├── template/                  # Starter formation template
│   ├── reef.json
│   ├── reef.lock.json
│   ├── .env.example
│   ├── README.md
│   └── agents/
│       ├── manager/
│       └── researcher/
├── src/                       # CLI source (TypeScript, ESM)
│   ├── index.ts               # Entry point — shebang + commander setup
│   ├── types/                 # ReefManifest, FormationState, ValidationResult
│   ├── core/                  # Manifest loader, validators, config patcher, registry, state manager
│   ├── commands/              # init, inspect, validate, pack, install, uninstall, update, repair, export, logs, lock, list, status
│   └── utils/                 # Path resolution, chalk helpers, fs utilities, identifiers
└── tests/                     # Vitest — unit, integration, and type drift tests
```

- **[`SPEC.md`](SPEC.md)** — The complete formation format specification: manifest schema, inter-agent communication, variable interpolation, install flow, CLI commands, security model, and update/uninstall behavior.
- **[`schema/reef.schema.json`](schema/reef.schema.json)** — JSON Schema (draft 2020-12) for validating `reef.json` manifests.
- **[`template/`](template/)** — A working starter formation you can copy and customize.

## License

[MIT](LICENSE)
