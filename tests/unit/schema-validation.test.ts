import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Load Ajv and the schema directly for fine-grained validation testing
async function loadValidator() {
  const ajvMod = await import('ajv/dist/2020.js');
  const formatsMod = await import('ajv-formats');

  const Ajv2020 = ajvMod.default?.default ?? ajvMod.default ?? ajvMod;
  const addFormats = formatsMod.default?.default ?? formatsMod.default ?? formatsMod;

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const require = createRequire(import.meta.url);
  const schemaPath = require.resolve('@openreef/schema/reef.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  return ajv.compile(schema);
}

const BASE_MANIFEST = {
  reef: '1.0',
  type: 'shoal',
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

describe('schema-validation: rich match objects', () => {
  let validate: Awaited<ReturnType<typeof loadValidator>>;

  // Load validator once before all tests
  it('loads validator', async () => {
    validate = await loadValidator();
    expect(validate).toBeDefined();
  });

  it('accepts a binding with channel + peer', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          match: {
            channel: 'slack',
            peer: { kind: 'channel', id: '#support' },
          },
          agent: 'worker',
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(true);
  });

  it('accepts a binding with channel only (no peer)', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          match: { channel: 'telegram' },
          agent: 'worker',
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(true);
  });

  it('accepts a binding with all optional match fields', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          match: {
            channel: 'discord',
            accountId: '*',
            peer: { kind: 'group', id: '12345' },
            guildId: '999',
            teamId: 'T001',
            roles: ['admin', 'moderator'],
          },
          agent: 'worker',
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(true);
  });

  it('requires match.channel', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          match: {
            peer: { kind: 'channel', id: '#ops' },
          },
          agent: 'worker',
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(false);
    const errors = validate.errors ?? [];
    const channelRequired = errors.some(
      (e: Record<string, unknown>) =>
        e.keyword === 'required' &&
        (e.params as Record<string, unknown>)?.missingProperty === 'channel',
    );
    expect(channelRequired).toBe(true);
  });

  it('rejects unknown match fields (additionalProperties: false)', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          match: {
            channel: 'slack',
            unknownField: 'should-fail',
          },
          agent: 'worker',
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(false);
    const errors = validate.errors ?? [];
    const additionalPropError = errors.some(
      (e: Record<string, unknown>) => e.keyword === 'additionalProperties',
    );
    expect(additionalPropError).toBe(true);
  });

  it('peer.kind accepts any string (not enum-restricted)', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          match: {
            channel: 'slack',
            peer: { kind: '{{MY_PEER_KIND}}', id: '#test' },
          },
          agent: 'worker',
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(true);
  });

  it('peer.kind accepts custom string values beyond direct/group/channel', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          match: {
            channel: 'telegram',
            peer: { kind: 'supergroup', id: '12345' },
          },
          agent: 'worker',
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(true);
  });

  it('rejects a binding without match', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          agent: 'worker',
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(false);
    const errors = validate.errors ?? [];
    const matchRequired = errors.some(
      (e: Record<string, unknown>) =>
        e.keyword === 'required' &&
        (e.params as Record<string, unknown>)?.missingProperty === 'match',
    );
    expect(matchRequired).toBe(true);
  });

  it('rejects a binding without agent', () => {
    const manifest = {
      ...BASE_MANIFEST,
      bindings: [
        {
          match: { channel: 'slack' },
        },
      ],
    };
    const valid = validate(manifest);
    expect(valid).toBe(false);
    const errors = validate.errors ?? [];
    const agentRequired = errors.some(
      (e: Record<string, unknown>) =>
        e.keyword === 'required' &&
        (e.params as Record<string, unknown>)?.missingProperty === 'agent',
    );
    expect(agentRequired).toBe(true);
  });
});
