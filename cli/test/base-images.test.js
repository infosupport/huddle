// Runs against the compiled output: `npm test` builds first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const b = require('../dist/base-images.js');

const IDES = ['vscode', 'intellij'];

test('local image names live under localhost/ and carry the channel tag', () => {
  assert.equal(b.localImageName(undefined, 'latest'), 'localhost/huddle/base-devimage:latest');
  assert.equal(b.localImageName('vscode', 'experiment-137'), 'localhost/huddle/base-devimage-vscode:experiment-137');
});

test('fresh machine: base first, then every IDE on top of it', () => {
  const plan = b.buildPlan('latest', IDES, () => false, false);
  assert.deepEqual(plan.map((s) => s.name), ['base-devimage', 'base-devimage-vscode', 'base-devimage-intellij']);
  assert.deepEqual(plan[1].buildArgs, { BASE_IMAGE: 'localhost/huddle/base-devimage:latest' });
});

test('existing images are skipped', () => {
  assert.deepEqual(b.buildPlan('latest', IDES, () => true, false), []);
});

test('only the missing IDE image is built when the base exists', () => {
  const have = new Set(['localhost/huddle/base-devimage:latest', 'localhost/huddle/base-devimage-vscode:latest']);
  const plan = b.buildPlan('latest', IDES, (i) => have.has(i), false);
  assert.deepEqual(plan.map((s) => s.name), ['base-devimage-intellij']);
});

test('a rebuilt base forces its IDE images; refresh rebuilds everything', () => {
  const have = new Set(['localhost/huddle/base-devimage-vscode:latest', 'localhost/huddle/base-devimage-intellij:latest']);
  assert.equal(b.buildPlan('latest', IDES, (i) => have.has(i), false).length, 3);
  assert.equal(b.buildPlan('latest', IDES, () => true, true).length, 3);
});

test('the package ships every Dockerfile, and IDE images build on the local base', () => {
  for (const name of ['base-devimage', ...b.IDES.map((i) => `base-devimage-${i}`)]) {
    const file = path.join(__dirname, '..', 'images', name, 'Dockerfile');
    assert.ok(fs.existsSync(file), file);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/ghcr\.io\/infosupport\/base-devimage/.test(text), `${name} still refers to ghcr.io`);
    if (name !== 'base-devimage') assert.match(text, /^FROM \$\{BASE_IMAGE\}$/m);
  }
});
