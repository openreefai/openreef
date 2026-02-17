import { describe, it, expect } from 'vitest';
import {
  normalizeToolName,
  isRecognizedTool,
  getAliasTarget,
} from '../../src/core/tool-names.js';

describe('tool-names', () => {
  describe('normalizeToolName', () => {
    it('normalizes "bash" to "exec"', () => {
      expect(normalizeToolName('bash')).toBe('exec');
    });

    it('normalizes "web-search" to "web_search"', () => {
      expect(normalizeToolName('web-search')).toBe('web_search');
    });

    it('returns "read" unchanged (already canonical)', () => {
      expect(normalizeToolName('read')).toBe('read');
    });

    it('normalizes "file-read" to "read"', () => {
      expect(normalizeToolName('file-read')).toBe('read');
    });

    it('normalizes "file-write" to "write"', () => {
      expect(normalizeToolName('file-write')).toBe('write');
    });

    it('normalizes "apply-patch" to "apply_patch"', () => {
      expect(normalizeToolName('apply-patch')).toBe('apply_patch');
    });

    it('handles leading/trailing whitespace', () => {
      expect(normalizeToolName('  bash  ')).toBe('exec');
    });

    it('handles uppercase input', () => {
      expect(normalizeToolName('BASH')).toBe('exec');
    });

    it('returns unknown names unchanged', () => {
      expect(normalizeToolName('nonexistent-tool')).toBe('nonexistent-tool');
    });
  });

  describe('isRecognizedTool', () => {
    it('recognizes canonical tool "exec"', () => {
      expect(isRecognizedTool('exec')).toBe(true);
    });

    it('recognizes "bash" via alias mapping', () => {
      expect(isRecognizedTool('bash')).toBe(true);
    });

    it('recognizes "read" as canonical', () => {
      expect(isRecognizedTool('read')).toBe(true);
    });

    it('recognizes "web_search" as canonical', () => {
      expect(isRecognizedTool('web_search')).toBe(true);
    });

    it('recognizes "web-search" via alias', () => {
      expect(isRecognizedTool('web-search')).toBe(true);
    });

    it('recognizes tool groups like "group:memory"', () => {
      expect(isRecognizedTool('group:memory')).toBe(true);
    });

    it('returns false for unrecognized tool names', () => {
      expect(isRecognizedTool('nonexistent-tool')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isRecognizedTool('')).toBe(false);
    });
  });

  describe('getAliasTarget', () => {
    it('returns "exec" for alias "bash"', () => {
      expect(getAliasTarget('bash')).toBe('exec');
    });

    it('returns "web_search" for alias "web-search"', () => {
      expect(getAliasTarget('web-search')).toBe('web_search');
    });

    it('returns "read" for alias "file-read"', () => {
      expect(getAliasTarget('file-read')).toBe('read');
    });

    it('returns undefined for canonical name "read" (not an alias)', () => {
      expect(getAliasTarget('read')).toBeUndefined();
    });

    it('returns undefined for canonical name "exec" (not an alias)', () => {
      expect(getAliasTarget('exec')).toBeUndefined();
    });

    it('returns undefined for unknown name', () => {
      expect(getAliasTarget('nonexistent-tool')).toBeUndefined();
    });

    it('handles whitespace and casing', () => {
      expect(getAliasTarget('  BASH  ')).toBe('exec');
    });
  });
});
