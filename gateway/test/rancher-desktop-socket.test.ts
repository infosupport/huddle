import { describe, it, expect } from 'vitest';

// De pure helpers voor Rancher Desktop-detectie wonen in de CLI (cli/src/
// runtime.ts), maar de CLI heeft geen eigen test-runner. Gateway draait vitest
// (en dat is wat CI uitvoert), dus testen we het parsen hier. Alleen zuivere
// functies zonder daemon-afhankelijkheid — geen live docker nodig.
import { parseDockerContextSocket, isRancherDesktopSocket } from '../../cli/src/runtime';

describe('parseDockerContextSocket (#81)', () => {
  it('haalt het unix-socketpad uit de rancher-desktop context', () => {
    const json = JSON.stringify([
      {
        Name: 'rancher-desktop',
        Endpoints: { docker: { Host: 'unix:///home/toon/.rd/docker.sock', SkipTLSVerify: false } },
      },
    ]);
    expect(parseDockerContextSocket(json)).toBe('/home/toon/.rd/docker.sock');
  });

  it('haalt het pad ook uit de standaard docker-context', () => {
    const json = JSON.stringify([
      { Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } },
    ]);
    expect(parseDockerContextSocket(json)).toBe('/var/run/docker.sock');
  });

  it('accepteert ook een enkel object i.p.v. een array', () => {
    const json = JSON.stringify({ Endpoints: { docker: { Host: 'unix:///run/user/1000/docker.sock' } } });
    expect(parseDockerContextSocket(json)).toBe('/run/user/1000/docker.sock');
  });

  it('geeft null voor een niet-unix endpoint (Windows npipe)', () => {
    const json = JSON.stringify([
      { Endpoints: { docker: { Host: 'npipe:////./pipe/docker_engine' } } },
    ]);
    expect(parseDockerContextSocket(json)).toBeNull();
  });

  it('geeft null voor een remote tcp/ssh endpoint', () => {
    const json = JSON.stringify([{ Endpoints: { docker: { Host: 'tcp://1.2.3.4:2375' } } }]);
    expect(parseDockerContextSocket(json)).toBeNull();
  });

  it('geeft null bij onparsebare of onvolledige JSON', () => {
    expect(parseDockerContextSocket('not json')).toBeNull();
    expect(parseDockerContextSocket('[]')).toBeNull();
    expect(parseDockerContextSocket('[{}]')).toBeNull();
    expect(parseDockerContextSocket(JSON.stringify([{ Endpoints: {} }]))).toBeNull();
  });
});

describe('isRancherDesktopSocket (#81)', () => {
  it('herkent het rancher-desktop socketpad', () => {
    expect(isRancherDesktopSocket('/home/toon/.rd/docker.sock')).toBe(true);
    expect(isRancherDesktopSocket('/Users/toon/.rd/docker.sock')).toBe(true);
  });

  it('herkent gewone docker-sockets niet als Rancher Desktop', () => {
    expect(isRancherDesktopSocket('/var/run/docker.sock')).toBe(false);
    expect(isRancherDesktopSocket('/run/user/1000/docker.sock')).toBe(false);
    expect(isRancherDesktopSocket(undefined)).toBe(false);
    expect(isRancherDesktopSocket(null)).toBe(false);
  });
});
