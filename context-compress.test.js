'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { compress, contentString } = require('./lib/context-compress');

const big = (label, n) => `${label}: ` + 'x'.repeat(n);

test('protects system, first user (task), and recent messages verbatim', () => {
  const msgs = [
    { role: 'system', content: 'you are a helpful agent' },
    { role: 'user', content: 'THE TASK: migrate the database' },
    { role: 'assistant', content: big('old tool dump', 3000) },
    { role: 'user', content: 'recent-1' },
    { role: 'assistant', content: 'recent-2' }
  ];
  const { messages } = compress(msgs, { keepRecent: 2 });
  assert.strictEqual(messages[0].content, 'you are a helpful agent', 'system untouched');
  assert.strictEqual(messages[1].content, 'THE TASK: migrate the database', 'task untouched');
  assert.strictEqual(messages[messages.length - 1].content, 'recent-2', 'recent untouched');
});

test('truncates a big OLD tool output but keeps head+tail', () => {
  const dump = 'HEAD_START' + 'y'.repeat(4000) + 'TAIL_END';
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: dump },   // old, unpinned -> truncated
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' }
  ];
  const { messages, stats } = compress(msgs, { keepRecent: 2, headChars: 20, tailChars: 10 });
  const t = messages[2].content;
  assert.ok(t.startsWith('HEAD_START'), 'kept head');
  assert.ok(t.endsWith('TAIL_END'), 'kept tail');
  assert.ok(/AURA elided \d+ chars/.test(t), 'has elision marker');
  assert.ok(stats.saved > 0);
});

test('dedups an identical large block, keeping the LATER full copy', () => {
  const shared = big('config file', 1500);
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: shared },   // earlier copy -> elided
    { role: 'user', content: 'middle' },
    { role: 'assistant', content: shared },   // later copy -> kept (but is it pinned?)
    { role: 'user', content: 'r1' },
    { role: 'assistant', content: 'r2' }
  ];
  const { messages } = compress(msgs, { keepRecent: 2, dedupOver: 200 });
  assert.ok(/identical to a later message/.test(messages[2].content), 'earlier copy elided');
  assert.strictEqual(messages[4].content, shared, 'later copy kept in full');
});

test('maxTokens drops oldest non-pinned and leaves a marker', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: big('a', 2000) },
    { role: 'user', content: big('b', 2000) },
    { role: 'assistant', content: big('c', 2000) },
    { role: 'user', content: 'recent-q' },
    { role: 'assistant', content: 'recent-a' }
  ];
  const { messages, stats } = compress(msgs, { keepRecent: 2, maxTokens: 400, truncateOver: 100000 });
  assert.ok(stats.dropped > 0, 'dropped some');
  assert.ok(messages.some((m) => /older message\(s\) elided/.test(m.content)), 'drop marker present');
  // pins survive
  assert.strictEqual(messages[0].content, 'sys');
  assert.strictEqual(messages[1].content, 'task');
  assert.strictEqual(messages[messages.length - 1].content, 'recent-a');
});

test('a small conversation under budget is returned unchanged', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' }
  ];
  const { messages, stats } = compress(msgs);
  assert.strictEqual(stats.saved, 0);
  assert.deepStrictEqual(messages.map((m) => m.content), ['sys', 'hello', 'hi there']);
});

test('token accounting is consistent (after = before - saved)', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: big('dump', 5000) },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' }
  ];
  const { stats } = compress(msgs, { keepRecent: 2 });
  assert.strictEqual(stats.tokensAfter, stats.tokensBefore - stats.saved);
});

test('handles block-array content (text + tool blocks) without throwing', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'task' }] },
    { role: 'assistant', content: [{ type: 'text', text: big('note', 3000) }, { type: 'tool_use', id: '1' }] },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' }
  ];
  assert.doesNotThrow(() => compress(msgs, { keepRecent: 2 }));
  assert.ok(contentString(msgs[2].content).length > 0);
});
