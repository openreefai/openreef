import { describe, it, expect } from 'vitest';
import { normalizeChannel } from '../../src/core/channel-prompt.js';

describe('normalizeChannel', () => {
  it('normalizes valid type:scope', () => {
    expect(normalizeChannel('slack:#ops')).toBe('slack:#ops');
  });

  it('trims whitespace', () => {
    expect(normalizeChannel('  slack : #ops  ')).toBe('slack:#ops');
  });

  it('lowercases type', () => {
    expect(normalizeChannel('Slack:#ops')).toBe('slack:#ops');
  });

  it('returns null for bare channel (no colon)', () => {
    expect(normalizeChannel('slack')).toBeNull();
  });

  it('returns null for empty type', () => {
    expect(normalizeChannel(':#ops')).toBeNull();
  });

  it('returns null for empty scope', () => {
    expect(normalizeChannel('slack:')).toBeNull();
  });

  it('returns null for whitespace-only scope', () => {
    expect(normalizeChannel('slack:   ')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeChannel('')).toBeNull();
  });

  it('preserves scope case', () => {
    expect(normalizeChannel('slack:#MyChannel')).toBe('slack:#MyChannel');
  });
});
