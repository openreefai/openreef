import { describe, it, expect } from 'vitest';
import { validateSchema } from '../../src/core/schema-validator.js';

const VALID_MANIFEST = {
  reef: '1.0',
  type: 'team',
  name: 'test-formation',
  version: '0.1.0',
  description: 'A test formation',
  namespace: 'test',
  agents: {
    worker: {
      source: 'agents/worker',
      description: 'Does work',
    },
  },
};

describe('schema-validator', () => {
  it('accepts a valid minimal manifest', async () => {
    const result = await validateSchema(VALID_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects missing required fields', async () => {
    const result = await validateSchema({ reef: '1.0' });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].code).toBe('SCHEMA_ERROR');
  });

  it('rejects invalid reef version', async () => {
    const result = await validateSchema({
      ...VALID_MANIFEST,
      reef: '2.0',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid name pattern', async () => {
    const result = await validateSchema({
      ...VALID_MANIFEST,
      name: 'Invalid Name!',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid formation type', async () => {
    const result = await validateSchema({
      ...VALID_MANIFEST,
      type: 'platoon',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a full manifest with all optional fields', async () => {
    const result = await validateSchema({
      ...VALID_MANIFEST,
      author: 'Test Author',
      license: 'MIT',
      compatibility: { openclaw: '>=0.2.0' },
      variables: {
        API_KEY: {
          type: 'string',
          required: true,
          sensitive: true,
        },
      },
      agentToAgent: { worker: [] },
      bindings: [{ channel: 'slack:#test', agent: 'worker' }],
      cron: [
        {
          schedule: '0 9 * * *',
          agent: 'worker',
          prompt: 'Do the thing',
        },
      ],
      dependencies: {
        skills: { 'web-search': '^1.0.0' },
        services: [{ name: 'OpenAI' }],
      },
      validation: {
        agent_exists: true,
        agent_responds: { enabled: false, timeout: 30 },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects additional properties', async () => {
    const result = await validateSchema({
      ...VALID_MANIFEST,
      extraField: true,
    });
    expect(result.valid).toBe(false);
  });
});
