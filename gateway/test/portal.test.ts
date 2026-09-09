import { describe, it, expect } from 'vitest';
import { assetKeyFor, contentTypeFor } from '../src/portal';

// The portal inside the single executable is a flat key→bytes lookup, so these
// two pure functions are the whole address space of that server: what a request
// path is allowed to name, and what the browser is told it got back. Both are
// easy to get subtly wrong and neither shows up in a smoke test that only ever
// asks for `/`.

describe('assetKeyFor', () => {
  it('prefixes the build key, matching what build-sea.mjs embeds', () => {
    expect(assetKeyFor('/index.html')).toBe('ui/index.html');
    expect(assetKeyFor('/main-ABC123.js')).toBe('ui/main-ABC123.js');
    expect(assetKeyFor('/media/logo.svg')).toBe('ui/media/logo.svg');
  });

  it('drops the query and the fragment — they are not part of the key', () => {
    expect(assetKeyFor('/main.js?v=2')).toBe('ui/main.js');
    expect(assetKeyFor('/main.js#top')).toBe('ui/main.js');
  });

  it('refuses to name a key for a traversal instead of normalising it', () => {
    // Normalising would turn ../package.json into a hit on a NEIGHBOURING
    // asset. There is nothing above `ui/` in the blob, so the answer is "this
    // request names nothing", and the caller falls back to index.html.
    expect(assetKeyFor('/../package.json')).toBeNull();
    expect(assetKeyFor('/media/../../secret')).toBeNull();
    expect(assetKeyFor('/./index.html')).toBeNull();
    expect(assetKeyFor('/media//logo.svg')).toBeNull();
  });

  it('has no key for the root — that is the index.html fallback, not a file', () => {
    expect(assetKeyFor('/')).toBeNull();
    expect(assetKeyFor('')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('types what the Angular build actually emits', () => {
    expect(contentTypeFor('ui/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('ui/main-ABC.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('ui/styles-ABC.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('ui/media/logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('ui/media/font.woff2')).toBe('font/woff2');
  });

  it('is case-insensitive about the extension', () => {
    expect(contentTypeFor('ui/LOGO.PNG')).toBe('image/png');
  });

  it('gives an unknown extension a type the browser will not run or render', () => {
    // Guessing text/html for an unrecognised file is how a static server starts
    // serving something as a document that is not one.
    expect(contentTypeFor('ui/weird.xyz')).toBe('application/octet-stream');
    expect(contentTypeFor('ui/noextension')).toBe('application/octet-stream');
  });
});
