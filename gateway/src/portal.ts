// Serving the Angular portal, from a directory or from inside the binary.
//
// Huddle Node ships two ways (gateway/scripts/build-sea.mjs). From a checkout
// the portal is a directory of files and @fastify/static serves it. Downloaded,
// there is no directory at all: the 48 files are assets inside the single
// executable, and the path @fastify/static would be pointed at
// (__dirname/../dist/ui/browser) does not exist. Without this the binary starts,
// answers the API, and returns 404 for the portal — the failure looks like a
// broken install rather than a missing build step, because everything else works.
//
// The asset keys are set by the build: `ui/` + the path relative to
// dist/ui/browser, forward slashes on every platform. Keep the two in step.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import sea from 'node:sea';

/** True when this process is a single executable with the portal inside it. */
export function portalIsEmbedded(): boolean {
  // isSea() landed after the SEA API itself; a build old enough to lack it
  // cannot have been built by this repo's script, so treat absence as "no".
  return typeof sea.isSea === 'function' && sea.isSea();
}

/**
 * Only what the Angular build emits. Unknown extensions get a type the browser
 * will not execute or render — guessing on behalf of an unrecognised file is
 * how a portal starts serving something as text/html that is not.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(assetPath: string): string {
  return CONTENT_TYPES[path.extname(assetPath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The blob key for a request path, or null if the request cannot name one.
 *
 * `..` and absolute-looking keys are rejected rather than normalised. Asset
 * lookup is a flat string match, so traversal cannot escape anywhere — but a
 * request that tries is not one to answer, and normalising would silently turn
 * it into a hit on a neighbouring file.
 */
export function assetKeyFor(urlPath: string): string | null {
  const clean = urlPath.split('?')[0].split('#')[0].replace(/^\/+/, '');
  if (!clean) return null;
  if (clean.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  return `ui/${clean}`;
}

function readAsset(key: string): Buffer | null {
  try {
    const raw = sea.getRawAsset(key);
    return raw ? Buffer.from(raw as ArrayBuffer) : null;
  } catch {
    // getRawAsset throws for a key that is not in the blob.
    return null;
  }
}

/**
 * Registers the portal. Everything the API does not answer lands here: a file
 * from the blob if the path names one, and index.html otherwise, because the
 * portal uses client-side routing and the browser asks the server for
 * /firewall as if it were a page.
 */
export function registerPortal(app: FastifyInstance, uiDir: string): void {
  if (!portalIsEmbedded()) {
    app.register(fastifyStatic, { root: uiDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler(async (_req, reply) => reply.sendFile('index.html'));
    return;
  }

  app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not found' });
    }

    const key = assetKeyFor(req.url);
    const asset = key ? readAsset(key) : null;
    if (asset) {
      return reply.type(contentTypeFor(key!)).send(asset);
    }

    const index = readAsset('ui/index.html');
    if (!index) {
      // The build embeds index.html first or not at all, so this means the
      // binary was assembled without a portal — worth saying, not 404-ing.
      return reply.code(500).send({ error: 'this build has no portal embedded' });
    }
    return reply.type(CONTENT_TYPES['.html']).send(index);
  });
}
