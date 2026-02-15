import { describe, it, expect } from 'vitest';
import { interpolate, buildToolsList } from '../../src/core/template-interpolator.js';

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

describe('buildToolsList', () => {
  it('returns empty string when no tools', () => {
    expect(buildToolsList(undefined, undefined)).toBe('');
    expect(buildToolsList([], undefined)).toBe('');
  });

  it('formats tools with versions from skills', () => {
    const result = buildToolsList(
      ['web-search', 'file-read'],
      { 'web-search': '^1.2.0', 'file-read': '^2.0.0' },
    );
    expect(result).toBe(
      '- **web-search** (^1.2.0)\n- **file-read** (^2.0.0)',
    );
  });

  it('formats built-in tools without versions', () => {
    const result = buildToolsList(['web-search', 'calculator'], undefined);
    expect(result).toBe('- **web-search**\n- **calculator**');
  });

  it('mixes versioned skills and built-in tools', () => {
    const result = buildToolsList(
      ['web-search', 'calculator'],
      { 'web-search': '^1.0.0' },
    );
    expect(result).toBe('- **web-search** (^1.0.0)\n- **calculator**');
  });
});
