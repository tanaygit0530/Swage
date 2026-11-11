import { describe, expect, it } from 'vitest';
import {
  detectEol,
  hashText,
  joinLines,
  matchTextStyle,
  splitLines,
  toCrlf,
  toLf,
} from '../../../src/changeset/text';

describe('text helpers', () => {
  it('splits and joins lines byte for byte', () => {
    for (const t of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '\n\n', 'x\r\ny\nz']) {
      expect(joinLines(splitLines(t))).toBe(t);
    }
    expect(splitLines('a\r\nb')).toEqual(['a\r\n', 'b']);
  });

  it('detects line endings', () => {
    expect(detectEol('')).toBe('none');
    expect(detectEol('one line')).toBe('none');
    expect(detectEol('a\nb\n')).toBe('lf');
    expect(detectEol('a\r\nb\r\n')).toBe('crlf');
    expect(detectEol('a\r\nb\n')).toBe('mixed');
  });

  it('converts between LF and CRLF', () => {
    expect(toCrlf('a\nb\r\n')).toBe('a\r\nb\r\n');
    expect(toLf('a\r\nb\n')).toBe('a\nb\n');
  });

  it('matches the base line endings and final newline', () => {
    expect(matchTextStyle('a\r\nb\r\n', 'x\ny')).toBe('x\r\ny\r\n');
    expect(matchTextStyle('a\nb\n', 'x\r\ny\r\n')).toBe('x\ny\n');
    expect(matchTextStyle('a\nb', 'x\ny\n')).toBe('x\ny');
    expect(matchTextStyle('a\r\nb', 'x\ny\n')).toBe('x\r\ny');
    expect(matchTextStyle('a\r\nb\n', 'x\ny')).toBe('x\ny\n');
    expect(matchTextStyle('', 'new\n')).toBe('new\n');
    expect(matchTextStyle('a\n', '')).toBe('');
  });

  it('hashes text with SHA-256', () => {
    expect(hashText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashText('a\n')).not.toBe(hashText('a\r\n'));
  });
});
