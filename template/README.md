# My Formation

> TODO: Describe what your formation does

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [OpenReef CLI](https://github.com/openreef/openreef) installed
- OpenAI API key

## Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `OPENAI_API_KEY` | OpenAI API key for LLM calls | Yes | — |
| `MISSION_GOAL` | Primary mission for the agent team | No | `Research` |

## Quick Start

```bash
# 1. Copy the environment template and fill in your values
cp .env.example .env

# 2. Deploy the formation
reef install .
```

## Agents

### Manager

**Role:** Coordinator

Coordinates the team, delegates tasks, and synthesizes results. Communicates with the researcher to assign topics and collect findings.

### Researcher

**Role:** Researcher

Conducts deep research on assigned topics and reports findings back to the manager.

## Communication Topology

```
manager ↔ researcher
```

The manager can send tasks to the researcher, and the researcher reports findings back to the manager.
