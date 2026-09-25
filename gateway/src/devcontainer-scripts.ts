// Loads static shell scripts that get base64-embedded into devcontainer config
// scripts (see docker.ts's buildJbConfigScript). Kept as real .sh files under
// devcontainer-scripts/ instead of inline TS template strings so they stay
// shellcheck-able and match the pocsshcontainers/ POC they were ported from.
//
// Huddle Node ships two ways (gateway/scripts/build-sea.mjs) — same split
// portal.ts handles for the Angular UI. From a checkout, gateway/package.json's
// build:ts copies src/devcontainer-scripts/ next to dist/index.js and this
// reads the file straight off disk. In the packaged SEA binary there is no
// dist/ directory at all — build-sea.mjs embeds it as a blob asset instead,
// read back the same way portal.ts reads the UI's assets.

import fs from 'fs';
import path from 'path';
import sea from 'node:sea';
import { portalIsEmbedded } from './portal';

const cache = new Map<string, string>();

export function readDevcontainerScript(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  let content: string;
  if (portalIsEmbedded()) {
    const raw = sea.getRawAsset(`devcontainer-scripts/${name}`);
    content = Buffer.from(raw as ArrayBuffer).toString('utf8');
  } else {
    content = fs.readFileSync(path.join(__dirname, 'devcontainer-scripts', name), 'utf8');
  }
  cache.set(name, content);
  return content;
}
