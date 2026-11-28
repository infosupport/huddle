import { describe, it, expect } from 'vitest';
import { ensureBaseImage, DEFAULT_BASE_IMAGE } from '../src/base-image-build';

// Base images worden lokaal gebouwd. Start een devcontainer terwijl zijn image
// nog ontbreekt, dan wacht de gateway op een lopende CLI-build en bouwt anders
// zelf: eerst de gedeelde base, dan de IDE-image erop (via build-arg BASE_IMAGE).
function deps(opts: { present?: string[]; status?: { state: string; updatedAt: string }; files?: boolean; now?: () => number }) {
  const present = new Set(opts.present ?? []);
  const builds: { name: string; file: string; args?: Record<string, string> }[] = [];
  let t = 0;
  return {
    builds,
    present,
    d: {
      imageExists: async (n: string) => present.has(n),
      buildImage: async (name: string, file: string, args?: Record<string, string>) => { builds.push({ name, file, args }); present.add(name); },
      readStatus: () => opts.status,
      fileExists: () => opts.files ?? true,
      sleep: async (ms: number) => { t += ms; },
      now: opts.now ?? (() => Date.parse('2026-11-28T10:00:00Z') + t),
      log: () => {},
    },
  };
}

const IDE = 'localhost/huddle/base-devimage-vscode:latest';

describe('ensureBaseImage', () => {
  it('doet niets als de image er al is', async () => {
    const x = deps({ present: [IDE] });
    await ensureBaseImage('vscode', IDE, x.d);
    expect(x.builds).toEqual([]);
  });

  it('bouwt eerst de base en dan de IDE-image erop', async () => {
    const x = deps({});
    await ensureBaseImage('vscode', IDE, x.d);
    expect(x.builds.map((b) => b.name)).toEqual([DEFAULT_BASE_IMAGE, IDE]);
    expect(x.builds[1].args).toEqual({ BASE_IMAGE: DEFAULT_BASE_IMAGE });
    expect(x.builds[1].file).toMatch(/base-devimage-vscode\/Dockerfile$/);
  });

  it('hergebruikt een bestaande base', async () => {
    const x = deps({ present: [DEFAULT_BASE_IMAGE] });
    await ensureBaseImage('vscode', IDE, x.d);
    expect(x.builds.map((b) => b.name)).toEqual([IDE]);
  });

  it('wacht op een lopende CLI-build in plaats van dubbel te bouwen', async () => {
    const x = deps({ status: { state: 'building', updatedAt: '2026-11-28T09:59:00Z' } });
    let polls = 0;
    x.d.imageExists = async (n: string) => n === IDE && ++polls > 3;
    await ensureBaseImage('vscode', IDE, x.d);
    expect(x.builds).toEqual([]);
  });

  it('negeert een verlopen build-status en bouwt zelf', async () => {
    const x = deps({ status: { state: 'building', updatedAt: '2026-11-28T07:00:00Z' } });
    await ensureBaseImage('vscode', IDE, x.d);
    expect(x.builds.map((b) => b.name)).toEqual([DEFAULT_BASE_IMAGE, IDE]);
  });

  it('geeft een duidelijke fout zonder Dockerfile', async () => {
    const x = deps({ files: false });
    await expect(ensureBaseImage('vscode', IDE, x.d)).rejects.toThrow(/huddle images build/);
  });
});
