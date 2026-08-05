import { test } from 'node:test';
import assert from 'node:assert/strict';
import parsers from '../src/parsers/index.js';

test('every registered parser has the required shape', () => {
  assert.ok(parsers.length > 0, 'registry is empty');
  for (const p of parsers) {
    assert.equal(typeof p.id, 'string', 'parser is missing an id');
    assert.ok(p.id.length > 0, 'parser id is empty');
    assert.equal(typeof p.from, 'string', `${p.id} is missing a from address`);
    assert.equal(typeof p.parse, 'function', `${p.id} is missing parse()`);
  }
});

test('parser ids are unique — a duplicate would silently shadow a bank', () => {
  const ids = parsers.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in [${ids.join(', ')}]`);
});

// `--source` resolves against this namespace, so three words are already spoken for and a
// parser claiming one could never be selected. `all` runs every parser. `wise` is the
// hardcoded API branch in cli.js, and would run both it and the parser. `trust` is rewritten
// to `trust-sg` by the pre-1.0 alias before the loop ever sees it.
test('no parser claims a reserved --source word', () => {
  const RESERVED = ['all', 'wise', 'trust'];
  for (const p of parsers) {
    assert.ok(!RESERVED.includes(p.id),
      `parser id '${p.id}' is a reserved --source word (${RESERVED.join(', ')}) and could never be selected`);
  }
});

test('trust-sg is registered', () => {
  assert.ok(parsers.some((p) => p.id === 'trust-sg'));
});
