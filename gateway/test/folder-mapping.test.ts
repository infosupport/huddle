import { describe, it, expect } from 'vitest';
import { validateFolderMappingKeys, fromWirePatch } from '../src/host-config';

// Fail-closed veldvalidatie voor folder-mappings (finding #9). De mappings staan
// sinds #98 in ~/.huddle/config.json i.p.v. SQLite, dus de sleutels belanden niet
// meer in een UPDATE-statement — maar de allowlist blijft: een config-bestand is
// geen dumpplek voor willekeurige client-sleutels, en de portal leunt nog op de
// 400 bij een typefout. host-config.ts heeft geen native binding nodig, dus deze
// test draait ook in een verse DMZ-devcontainer (voorheen: sqlite-probe + skip).
describe('validateFolderMappingKeys (#9 fail-closed)', () => {
  it('staat bekende wire-velden toe', () => {
    expect(validateFolderMappingKeys({ name: 'x', read_only: 1 }).sort()).toEqual(['name', 'read_only']);
  });

  it('weigert een geprepareerde injectie-sleutel', () => {
    // De klassieke payload uit de review: een balans-sluitende sleutel die een
    // subquery injecteert. Moet fail-closed gooien i.p.v. te worden doorgelaten.
    expect(() =>
      validateFolderMappingKeys({
        'container_path = (SELECT password FROM container_credentials LIMIT 1), name': 'x',
      }),
    ).toThrow(/unknown folder-mapping field/i);
  });

  it('weigert elke onbekende sleutel', () => {
    expect(() => validateFolderMappingKeys({ id: 5 })).toThrow(/unknown/i);
    expect(() => validateFolderMappingKeys({ evil: 1 })).toThrow(/unknown/i);
  });
});

describe('fromWirePatch', () => {
  it('zet de wire-vorm om naar de config-vorm', () => {
    expect(fromWirePatch({
      name: 'tool', host_path: '~/.tool', volume_name: '', container_path: '/home/vscode/.tool',
      read_only: 1, enabled: 0, sort_order: 3,
    })).toEqual({
      name: 'tool', hostPath: '~/.tool', volumeName: '', containerPath: '/home/vscode/.tool',
      readOnly: true, enabled: false, sortOrder: 3,
    });
  });

  it('laat een partiële patch partieel', () => {
    expect(fromWirePatch({ enabled: 1 })).toEqual({ enabled: true });
  });

  it('gooit op een onbekende sleutel i.p.v. die stil te negeren', () => {
    expect(() => fromWirePatch({ enabled: 1, evil: 'x' })).toThrow(/unknown/i);
  });
});
