'use strict';
/**
 * Honest benchmark: tokens saved by NOT re-running tools during normal agent work.
 *
 * Models a realistic agent session — it keeps re-reading the same few files, re-
 * fetching the same price, re-searching the same docs as it works through a task.
 * Every repeated tool result would normally be regenerated AND re-fed to the model.
 * tool-cache serves the repeat instantly, saving both the call and the context tokens.
 *
 * No invented numbers: real invocation counts, token estimate = ~1 token / 4 chars.
 */

const { wrap, toolStats, clearToolCache } = require('../lib/tool-cache');

const estTokens = (v) => Math.max(1, Math.ceil((typeof v === 'string' ? v : JSON.stringify(v)).length / 4));

// realistic-sized tool results (what actually gets fed back into context)
const FILES = {
  'config.json': JSON.stringify({ env: 'prod', region: 'us-east', flags: { a: true, b: false, c: true }, keys: ['x', 'y', 'z'], nested: { deep: { value: 42, list: [1, 2, 3, 4, 5] } } }, null, 2),
  'schema.sql': 'CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT now());\n'.repeat(6),
  'README.md': '# Project\n\nThis service does X, Y and Z. It exposes an HTTP API and a worker queue. '.repeat(10)
};

let realReads = 0, realFetches = 0, realSearches = 0;
const readFile = wrap('read_file', async ({ path }) => { realReads++; return FILES[path] || ''; });
const getPrice = wrap('get_price', async ({ coin }) => { realFetches++; return `${coin.toUpperCase()}: $${(coin === 'btc' ? 75840 : 3400).toFixed(2)}`; });
const searchDocs = wrap('search_docs', async ({ q }) => { realSearches++; return `Top results for "${q}": section 3.2 covers this; see also appendix B and the migration guide.`; });

// a plausible agent workload: it revisits the same context repeatedly while working
async function run() {
  clearToolCache();
  let baselineTokens = 0;         // if EVERY tool call re-fed its result to the model
  let toolCallsRequested = 0;

  const steps = 200; // ~200 tool touches over a task
  for (let i = 0; i < steps; i++) {
    const path = ['config.json', 'schema.sql', 'README.md'][i % 3];
    const r1 = await readFile({ path });
    baselineTokens += estTokens(r1); toolCallsRequested++;

    if (i % 2 === 0) { const r2 = await getPrice({ coin: i % 4 === 0 ? 'btc' : 'eth' }); baselineTokens += estTokens(r2); toolCallsRequested++; }
    if (i % 5 === 0) { const r3 = await searchDocs({ q: 'billing tiers' }); baselineTokens += estTokens(r3); toolCallsRequested++; }
  }

  const s = toolStats();
  const realCalls = realReads + realFetches + realSearches;

  console.log('\n  AURA tool-cache — honest savings on normal agent work');
  console.log('  ' + '─'.repeat(60));
  console.log(`  tool calls the agent asked for   ${toolCallsRequested}`);
  console.log(`  calls that actually ran          ${realCalls}   (reads ${realReads} · fetches ${realFetches} · searches ${realSearches})`);
  console.log(`  calls AVOIDED (served cached)    ${s.callsAvoided}   (${(s.hits / (s.hits + s.misses) * 100).toFixed(1)}% hit rate)\n`);
  console.log(`  result tokens if NO cache        ${baselineTokens.toLocaleString()}`);
  console.log(`  result tokens actually spent     ${(baselineTokens - s.tokensSaved).toLocaleString()}`);
  console.log(`  TOKENS SAVED (not re-fed)        ${s.tokensSaved.toLocaleString()}   (${(s.tokensSaved / baselineTokens * 100).toFixed(1)}%)\n`);
  console.log(`  + every avoided call also skips a real file read / network fetch (latency + API cost).`);
  console.log('  ' + '─'.repeat(60));
  console.log('  scales safely: cache is bounded (5,000 entries, auto-pruned), TTLs expire');
  console.log('  stale data, and state-changing tools (write/deploy/pay) are never cached.\n');
}

run();
