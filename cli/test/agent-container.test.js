// Runs against the compiled output: `npm test` builds first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeOutput } = require('../dist/agent-container.js');

test('parseClaudeOutput reads the answer, usage and refused tool calls', () => {
  const out = parseClaudeOutput(JSON.stringify({
    result: ' done ',
    total_cost_usd: 0.18,
    num_turns: 19,
    permission_denials: [
      { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'npm pack node-forge@1.4.0\n  --ignore-scripts', description: 'pack' } },
      { tool_name: 'Write', tool_input: { file_path: '/tmp/a.json', content: '{}' } },
      { tool_name: 'WebFetch', tool_input: { url: 'https://osv.dev' } },
      'garbage',
    ],
  }));
  assert.equal(out.result, 'done');
  assert.equal(out.costUsd, 0.18);
  assert.equal(out.turns, 19);
  assert.deepEqual(out.denials, [
    { tool: 'Bash', input: 'npm pack node-forge@1.4.0 --ignore-scripts' },
    { tool: 'Write', input: '/tmp/a.json' },
    { tool: 'WebFetch', input: '{"url":"https://osv.dev"}' },
    { tool: '?', input: 'null' },
  ]);
});

test('parseClaudeOutput without denials or JSON', () => {
  assert.deepEqual(parseClaudeOutput('{"result":"ok"}').denials, []);
  assert.equal(parseClaudeOutput('Error: not logged in'), null);
});
