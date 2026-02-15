import { describe, it, expectTypeOf } from 'vitest';
import type { FromSchema } from 'json-schema-to-ts';
import type { ReefManifest } from '../../src/types/manifest.js';
import schema from '../../schema/reef.schema.json' with { type: 'json' };

// Derive the type from the JSON Schema at compile time
type SchemaManifest = FromSchema<typeof schema>;

describe('manifest type drift detection', () => {
  it('hand-written types are assignable to schema-derived types', () => {
    expectTypeOf<ReefManifest>().toMatchTypeOf<SchemaManifest>();
  });

  it('schema-derived types are assignable to hand-written types', () => {
    expectTypeOf<SchemaManifest>().toMatchTypeOf<ReefManifest>();
  });
});
