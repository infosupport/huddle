import { describe, it, expect } from 'vitest';
import { normalizeHostPath, hostPathError, hostPathLeaf } from '../src/host-path';

// Host paths komen als tekst binnen: getypt in de modal, getypt in Settings, of
// aangeklikt in de picker. Op Windows spelt elk van die drie dezelfde map
// anders. normalizeHostPath is het enige punt waar dat wordt gladgestreken;
// deze test pint die vorm vast, want docker.ts (toLinuxPath) rekent erop.
describe('normalizeHostPath', () => {
  it('zet backslashes om en maakt de driveletter hoofdletter', () => {
    expect(normalizeHostPath('t:\\projects\\huddle')).toBe('T:/projects/huddle');
    expect(normalizeHostPath('T:/projects/huddle')).toBe('T:/projects/huddle');
  });

  it('is idempotent — de gateway normaliseert ook wat de CLI al normaliseerde', () => {
    const once = normalizeHostPath('t:\\projects\\huddle\\');
    expect(normalizeHostPath(once)).toBe(once);
    expect(once).toBe('T:/projects/huddle');
  });

  it('haalt trailing slashes en dubbele slashes weg', () => {
    expect(normalizeHostPath('T:\\projects\\\\huddle\\')).toBe('T:/projects/huddle');
    expect(normalizeHostPath('/home/me/app/')).toBe('/home/me/app');
  });

  it('laat een driveroot en de filesystem-root heel', () => {
    expect(normalizeHostPath('c:\\')).toBe('C:/');
    expect(normalizeHostPath('/')).toBe('/');
  });

  it('behoudt de dubbele slash van een UNC-pad', () => {
    expect(normalizeHostPath('\\\\fileserver\\team\\repo')).toBe('//fileserver/team/repo');
  });

  it('geeft leeg terug voor leeg of witruimte', () => {
    expect(normalizeHostPath('  ')).toBe('');
    expect(normalizeHostPath(undefined as unknown as string)).toBe('');
  });
});

describe('hostPathError', () => {
  it('laat Windows-, UNC- en Linux-paden door', () => {
    expect(hostPathError('T:/projects/huddle')).toBeNull();
    expect(hostPathError('//fileserver/team/repo')).toBeNull();
    expect(hostPathError('/home/me/app')).toBeNull();
    expect(hostPathError('C:/')).toBeNull();
  });

  it('weigert relatieve paden en ~ (niets breidt dat uit)', () => {
    // De Docker-engine is geen shell: '~/.mytool' wordt nooit een home-dir.
    expect(hostPathError('~/.mytool')).toMatch(/absolute/);
    expect(hostPathError('projects/huddle')).toMatch(/absolute/);
  });

  it('weigert traversal, controltekens en shell-metatekens', () => {
    expect(hostPathError('T:/projects/../../Windows')).toMatch(/\.\./);
    expect(hostPathError('T:/pro\u0000jects')).toMatch(/control/);
    expect(hostPathError('T:/$(whoami)')).toMatch(/quotes/);
    expect(hostPathError("T:/pro'jects")).toMatch(/quotes/);
  });

  it('weigert leeg en absurd lang', () => {
    expect(hostPathError('')).toMatch(/empty/);
    expect(hostPathError(`T:/${'a'.repeat(600)}`)).toMatch(/512/);
  });
});

describe('hostPathLeaf', () => {
  it('geeft de laatste map als label', () => {
    expect(hostPathLeaf('T:/projects/huddle')).toBe('huddle');
    expect(hostPathLeaf('/home/me/app')).toBe('app');
    expect(hostPathLeaf('C:/')).toBe('C:');
  });
});
