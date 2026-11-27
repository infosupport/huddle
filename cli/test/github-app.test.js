// Runs against the compiled output: `npm test` builds first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { appConfigFromEnv, appJwt } = require('../dist/github-app.js');

test('appJwt is an RS256 JWT for the App, valid for less than 10 minutes', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const jwt = appJwt('Iv23liExample', pem, now);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.iss, 'Iv23liExample');
  assert.equal(payload.iat, now / 1000 - 60);
  assert.ok(payload.exp - now / 1000 < 600);
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('appConfigFromEnv needs both App settings and the repository', () => {
  assert.equal(appConfigFromEnv({}), null);
  assert.throws(() => appConfigFromEnv({ HUDDLE_GITHUB_APP_CLIENT_ID: 'x' }), /both/);
  assert.throws(() => appConfigFromEnv({ HUDDLE_GITHUB_APP_CLIENT_ID: 'x', HUDDLE_GITHUB_APP_PRIVATE_KEY: 'k' }), /GITHUB_REPOSITORY/);
  assert.throws(
    () => appConfigFromEnv({ HUDDLE_GITHUB_APP_CLIENT_ID: 'x', HUDDLE_GITHUB_APP_PRIVATE_KEY: 'k', GITHUB_REPOSITORY: 'o/r;x' }),
    /GITHUB_REPOSITORY/,
  );
  assert.deepEqual(
    appConfigFromEnv({ HUDDLE_GITHUB_APP_CLIENT_ID: ' x ', HUDDLE_GITHUB_APP_PRIVATE_KEY: 'k', GITHUB_REPOSITORY: 'infosupport/huddle' }),
    { clientId: 'x', privateKey: 'k', repo: 'infosupport/huddle' },
  );
});
