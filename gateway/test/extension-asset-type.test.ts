import { describe, it, expect } from 'vitest';
import { extensionAssetType } from '../src/extensions/loader';

describe('extensionAssetType', () => {
  it.each([
    ['frontend/app.js', 'text/javascript; charset=utf-8'],
    ['frontend/lib.mjs', 'text/javascript; charset=utf-8'],
    ['frontend/style.css', 'text/css; charset=utf-8'],
    ['frontend/index.html', 'text/html; charset=utf-8'],
    ['frontend/data.json', 'application/json; charset=utf-8'],
    ['frontend/icon.svg', 'image/svg+xml'],
    ['frontend/logo.PNG', 'image/png'],
    ['frontend/unknown.bin', 'application/octet-stream'],
  ])('%s is served as %s', (file, expected) => {
    // Act
    const type = extensionAssetType(file);

    // Assert
    expect(type).toBe(expected);
  });
});
