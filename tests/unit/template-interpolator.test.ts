import { describe, it, expect } from 'vitest';
import { interpolate } from '../../src/core/template-interpolator.js';

describe('template-interpolator', () => {
  it('replaces known variables', () => {
    const result = interpolate('Hello {{NAME}}!', { NAME: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('leaves undeclared tokens untouched', () => {
    const result = interpolate('Hello {{NAME}} and {{UNKNOWN}}', {
      NAME: 'World',
    });
    expect(result).toBe('Hello World and {{UNKNOWN}}');
  });

  it('replaces multiple occurrences of the same variable', () => {
    const result = interpolate('{{A}} and {{A}}', { A: 'x' });
    expect(result).toBe('x and x');
  });

  it('handles empty variables map', () => {
    const result = interpolate('{{A}} {{B}}', {});
    expect(result).toBe('{{A}} {{B}}');
  });

  it('handles template with no tokens', () => {
    const result = interpolate('No tokens here', { A: 'x' });
    expect(result).toBe('No tokens here');
  });

  it('handles multiple different variables', () => {
    const result = interpolate('{{namespace}} - {{MISSION_GOAL}}', {
      namespace: 'my-team',
      MISSION_GOAL: 'Research',
    });
    expect(result).toBe('my-team - Research');
  });
});
