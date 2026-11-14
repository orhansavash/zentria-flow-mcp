// node --test
//
// No network: fetch is a stand-in that answers from test/fixtures/engine-samples.json,
// which holds real answers of the Zentria Flow engine (generated 14 Nov 2026 from
// backend/rate_timeline.py and forced_labor_check.search).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { errorSentence, resolveBaseUrl, USER_AGENT } from '../src/api.js';
import { createServer, PROTOCOL_VERSIONS, SERVER_INFO } from '../src/server.js';
import { COMPARE_GAP_MS, DISCLAIMER, listTools, MAX_ORIGINS, tariffLayers } from '../src/tools.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const SAMPLES = JSON.parse(readFileSync(here('./fixtures/engine-samples.json'), 'utf8'));
const PKG = JSON.parse(readFileSync(here('../package.json'), 'utf8'));
const SERVER_JSON = JSON.parse(readFileSync(here('../server.json'), 'utf8'));
const KEY = 'zf_live_test_key_that_must_never_be_printed';
const NOW = () => new Date('2026-11-14T09:30:00Z');

function reply(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** A server whose fetch is `route(url, init)`; records calls and sleeps. */
function harness(route, { apiKey = '' } = {}) {
  const calls = [];
  const sleeps = [];
  const server = createServer({
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return route(new URL(url), init);
    },
    baseUrl: 'https://zentriaflow.com',
    apiKey,
    now: NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  let id = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: (id += 1), method, params });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { server, calls, sleeps, rpc, call };
}

const byOrigin = { CN: 'tshirt_cn', VN: 'tshirt_vn', MX: 'tshirt_mx' };
const tshirts = (url) => {
  const origin = url.searchParams.get('origin');
  return byOrigin[origin] ? reply(200, SAMPLES[byOrigin[origin]]) : reply(200, SAMPLES.bad_origin);
};

// ── protocol ─────────────────────────────────────────────────────────────────

test('initialize negotiates the protocol version and names the server', async () => {
  const { rpc } = harness(tshirts);
  for (const version of PROTOCOL_VERSIONS) {
    const res = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(res.result.protocolVersion, version);
    assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
    assert.equal(res.result.serverInfo.name, 'zentria-flow-mcp');
    assert.match(res.result.instructions, /not customs rulings/);
  }
  const unknown = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknown.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('notifications get no answer; ping, unknown methods and bad messages get the right one', async () => {
  const { server, rpc } = harness(tshirts);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  assert.deepEqual((await rpc('ping')).result, {});
  assert.equal((await rpc('resources/list')).error.code, -32601);
  assert.equal((await server.handle({ id: 1, method: 'ping' })).error.code, -32600);
  assert.equal((await server.handle('hello')).error.code, -32600);
  assert.equal((await server.handle([])).error.code, -32600);
  assert.equal(JSON.parse(await server.handleLine('{not json')).error.code, -32700);
  assert.equal(await server.handleLine('   '), null);
  assert.equal(await server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null);
  // a batch: one answer per request, none for the notification
  const batch = await server.handle([
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ]);
  assert.deepEqual(batch.map((r) => r.id), ['a', 'b']);
  const line = JSON.parse(await server.handleLine('{"jsonrpc":"2.0","id":7,"method":"ping"}'));
  assert.deepEqual(line, { jsonrpc: '2.0', id: 7, result: {} });
});

// ── tool schemas ─────────────────────────────────────────────────────────────

test('tools/list: four tools with valid input schemas and no handler leaked', async () => {
  const { rpc } = harness(tshirts);
  const { tools } = (await rpc('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name), ['us_tariff_check', 'compare_origins', 'hts_search', 'landed_cost']);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z_]{3,40}$/);
    assert.ok(tool.description.length > 60 && tool.description.length < 700, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const required of tool.inputSchema.required) assert.ok(tool.inputSchema.properties[required], `${tool.name}.${required}`);
    for (const [name, prop] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(prop.type && prop.description, `${tool.name}.${name} needs a type and a description`);
    }
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal('run' in tool, false);
    assert.equal(JSON.stringify(tool).includes('function'), false);
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(byName.us_tariff_check.inputSchema.required, ['hts', 'origin']);
  assert.equal(byName.compare_origins.inputSchema.properties.origins.maxItems, MAX_ORIGINS);
  assert.equal(MAX_ORIGINS, 6);
  assert.deepEqual(byName.hts_search.inputSchema.required, ['query']);
  assert.match(byName.landed_cost.description, /ZENTRIA_API_KEY/);
  // every tool says what its numbers are
  for (const tool of tools) assert.match(tool.description, /not a (customs|classification) ruling/, tool.name);
  assert.deepEqual(listTools(), tools);
});

test('descriptions make no claim beyond the company context', async () => {
  const text = JSON.stringify(listTools()) + readFileSync(here('../README.md'), 'utf8') + JSON.stringify(SERVER_JSON) + JSON.stringify(PKG);
  for (const banned of [/trusted by/i, /\b\d[\d,]*\+? (customers|importers|users)\b/i, /real[- ]time/i, /\buptime\b/i,
    /guarantee/i, /\b(1\d\d|2\d\d)\+? countries/i, /api\.zentriaflow\.com/i, /official (data|source) of/i, /\baccura(te|cy) to\b/i]) {
    assert.equal(banned.test(text), false, String(banned));
  }
});

// ── us_tariff_check ──────────────────────────────────────────────────────────

test('us_tariff_check calls the public endpoint and returns the layers, the date and the disclaimer', async () => {
  const { call, calls } = harness(tshirts);
  const res = await call('us_tariff_check', { hts: '6109.10.00', origin: 'CN' });
  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://zentriaflow.com/api/public-tools/tariff-check');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { hts: '6109.10.00', origin: 'CN' });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.equal('X-API-Key' in calls[0].init.headers, false);

  const text = res.content[0].text;
  const sample = SAMPLES.tshirt_cn;
  assert.match(text, /Total duty rate: 36\.5% of the customs value/);
  assert.match(text, /MFN duty: 16\.5%/);
  assert.match(text, /Section 301: 7\.5% \(List 4A, 9903\.88\.15\)/);
  assert.match(text, /Forced-labor Section 301 tariff: 12\.5%/);
  assert.match(text, /Checked on 2026-11-14 \(UTC\)/);
  assert.ok(text.includes(DISCLAIMER));
  assert.ok(text.includes(sample.source));
  assert.match(text, /Planning estimate, not a customs ruling/);

  const s = res.structuredContent;
  assert.equal(s.checked_on, '2026-11-14');
  assert.equal(s.total_rate_pct, sample.total_rate);
  assert.deepEqual(s.layers.map((l) => [l.key, l.rate_pct]), [
    ['mfn', sample.mfn.rate], ['section_301', sample.section_301.rate], ['forced_labor', sample.forced_labor.rate],
    ['section_232', sample.section_232.rate], ['section_338', sample.section_338.rate]]);
  assert.equal(s.disclaimer, DISCLAIMER);
});

test('us_tariff_check passes as_of, quantity and value through, and shows scheduled changes and bans', async () => {
  const route = (url) => {
    if (url.searchParams.get('origin') === 'DE') return reply(200, SAMPLES.solar_de);
    if (url.searchParams.get('origin') === 'CA') return reply(200, SAMPLES.wine_ca);
    return reply(200, SAMPLES.wine_fr_qty);
  };
  const { call, calls } = harness(route);
  const wine = await call('us_tariff_check', { hts: '2204.21.50', origin: 'FR', quantity: 750, value: 9000, as_of: '2026-12-10' });
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams),
    { hts: '2204.21.50', origin: 'FR', as_of: '2026-12-10', quantity: '750', value: '9000' });
  assert.ok(wine.content[0].text.includes(SAMPLES.wine_fr_qty.us_mfn.summary));

  const solar = await call('us_tariff_check', { hts: '8541.43.00', origin: 'DE' });
  const change = SAMPLES.solar_de.scheduled_changes[0];
  assert.ok(solar.content[0].text.includes(`- ${change.effective_date}: total ${change.total_rate_before}% -> ${change.total_rate_after}%`));
  assert.match(solar.content[0].text, /can be extended, changed or withdrawn/);
  assert.equal(solar.structuredContent.scheduled_changes[0].total_rate_after_pct, change.total_rate_after);

  const banned = await call('us_tariff_check', { hts: '2204.21.50', origin: 'CA' });
  assert.match(banned.content[0].text, /IMPORT BAN: Import ban: this product can no longer be imported from Canada/);
  assert.match(banned.content[0].text, /call again with quantity \(number of liters\) and value/);
});

test('a number the API did not send is never invented', async () => {
  const partial = { ok: true, hts: '6109.10.00', origin: 'CN', mfn: { text: '16.5%' }, section_301: { rate: '7.5' }, notes: [] };
  const { call } = harness(() => reply(200, partial));
  const res = await call('us_tariff_check', { hts: '6109.10.00', origin: 'CN' });
  const text = res.content[0].text;
  assert.match(text, /Total duty rate: not returned/);
  assert.match(text, /MFN duty: not returned \(16\.5%\)/);
  assert.match(text, /Section 301: not returned/);       // a string is not a rate
  assert.match(text, /Section 232: not returned/);
  assert.equal(res.structuredContent.total_rate_pct, null);
  assert.deepEqual(res.structuredContent.layers.map((l) => l.rate_pct), [null, null, null, null, null]);
  // every percentage printed is one the API sent
  const printed = [...res.content[0].text.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(printed)], ['16.5']);
  assert.deepEqual(tariffLayers({}).map((l) => l.rate_pct), [null, null, null, null, null]);
});

test('every percentage in a real answer comes from the engine sample', async () => {
  for (const name of ['tshirt_cn', 'tshirt_mx', 'solar_de', 'wine_ca', 'wine_fr_qty']) {
    const { call } = harness(() => reply(200, SAMPLES[name]));
    const text = (await call('us_tariff_check', { hts: SAMPLES[name].hts, origin: SAMPLES[name].origin })).content[0].text;
    const source = JSON.stringify(SAMPLES[name]);
    for (const [, number] of text.matchAll(/(\d+(?:\.\d+)?)%/g)) {
      assert.ok(source.includes(number), `${name}: ${number}% is not in the engine answer`);
    }
  }
});

test('argument validation: nothing is sent when the input is wrong', async () => {
  const { call, calls } = harness(tshirts);
  const bad = [
    ['us_tariff_check', {}, /hts must be a string/],
    ['us_tariff_check', { hts: 'shirt', origin: 'CN' }, /only digits and dots/],
    ['us_tariff_check', { hts: '61', origin: 'CN' }, /4 to 10 digits/],
    ['us_tariff_check', { hts: '6109.10.00.00.00', origin: 'CN' }, /4 to 10 digits/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'C' }, /country name or 2-letter ISO code/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'CN&x=1' }, /country name or 2-letter ISO code/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'x'.repeat(61) }, /country name/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'CN', as_of: 'tomorrow' }, /YYYY-MM-DD/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'CN', as_of: '2026-02-31' }, /not a real calendar date/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'CN', quantity: 5 }, /both quantity and value/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'CN', quantity: -1, value: 5 }, /greater than 0/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'CN', quantity: '5', value: 5 }, /must be a number/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'CN', quantity_unit: 'kg' }, /needs quantity and value/],
    ['us_tariff_check', { hts: '6109.10.00', origin: 'CN', destination: 'DE' }, /Unknown argument: destination/],
    ['compare_origins', { hts: '6109.10.00', origins: ['CN'] }, /2 to 6 countries/],
    ['compare_origins', { hts: '6109.10.00', origins: ['CN', 'VN', 'MX', 'IN', 'BD', 'TR', 'TH'] }, /2 to 6 countries/],
    ['compare_origins', { hts: '6109.10.00', origins: ['CN', 'cn'] }, /same country twice/],
    ['compare_origins', { hts: '6109.10.00', origins: 'CN,VN' }, /must be a list/],
    ['compare_origins', { hts: '6109.10.00', origins: ['CN', 5] }, /origins\[1\]/],
    ['hts_search', { query: 'x' }, /2 to 80 characters/],
    ['hts_search', { query: 'x'.repeat(81) }, /2 to 80 characters/],
    ['hts_search', { query: 7 }, /must be a string/],
    ['landed_cost', { hs_code: '6109.10.00', origin_country: 'China', unit_value_usd: 10 }, /2-letter ISO country code/],
    ['landed_cost', { hs_code: '6109.10.00', origin_country: 'CN', unit_value_usd: 0 }, /greater than 0/],
    ['landed_cost', { hs_code: '6109.10.00', origin_country: 'CN', unit_value_usd: 10, quantity: 1.5 }, /whole number/],
    ['landed_cost', { hs_code: '6109.10.00', origin_country: 'CN', unit_value_usd: 10, transport_mode: 'teleport' }, /transport_mode must be one of/],
    ['landed_cost', { hs_code: '6109.10.00', origin_country: 'CN', unit_value_usd: 10, currency: 'EURO' }, /3-letter ISO 4217/],
  ];
  for (const [name, args, expected] of bad) {
    const res = await call(name, args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.content[0].text, /^Invalid input: /);
    assert.match(res.content[0].text, expected);
  }
  assert.equal(calls.length, 0);
});

test('unknown tool and malformed tools/call are JSON-RPC errors', async () => {
  const { rpc } = harness(tshirts);
  assert.equal((await rpc('tools/call', { name: 'delete_everything', arguments: {} })).error.code, -32602);
  assert.equal((await rpc('tools/call', { arguments: {} })).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'hts_search', arguments: ['shirt'] })).error.code, -32602);
});

// ── errors from the API ──────────────────────────────────────────────────────

test('an origin or code the engine does not know is an error with the engine\'s own sentence', async () => {
  const { call } = harness(() => reply(200, SAMPLES.bad_origin));
  const res = await call('us_tariff_check', { hts: '6109.10.00', origin: 'Atlantis' });
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes(SAMPLES.bad_origin.error));
  assert.match(res.content[0].text, /No rate is shown because none was returned/);
  assert.equal(/\d%/.test(res.content[0].text), false);
});

test('429: the tool says so, gives Retry-After, and shows no rate', async () => {
  const { call, calls } = harness(() => reply(429, { detail: 'Too many lookups. Try again in a few minutes.' }, { 'retry-after': '120' }));
  const res = await call('us_tariff_check', { hts: '6109.10.00', origin: 'CN' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /rate limit reached \(HTTP 429\): Too many lookups\. Try again in a few minutes\. Retry after 120 seconds\./);
  assert.match(res.content[0].text, /No rate is shown/);
  assert.equal(calls.length, 1);                          // no automatic retry
  const search = await call('hts_search', { query: 'shirt' });
  assert.equal(search.isError, true);
  assert.match(search.content[0].text, /HTTP 429/);
});

test('422, 5xx, non-JSON, timeouts and network failures are plain errors', async () => {
  const cases = [
    [() => reply(422, { detail: 'as_of must be a date from today to 12 months ahead.' }), /as_of must be a date from today/],
    [() => reply(422, { detail: [{ loc: ['query', 'q'], msg: 'Field required', type: 'missing' }] }), /q: Field required/],
    [() => reply(503, '<html>Service Unavailable</html>'), /HTTP 503/],
    [() => reply(200, '<html>challenge</html>'), /not JSON/],
    [() => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }, /did not answer in time/],
    [() => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); }, /Could not reach Zentria Flow/],
  ];
  for (const [route, expected] of cases) {
    const { call } = harness(route);
    const res = await call('us_tariff_check', { hts: '6109.10.00', origin: 'CN' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, expected);
    assert.equal(res.content[0].text.includes('ENOTFOUND'), false);
    assert.equal(res.content[0].text.includes('<html>'), false);
  }
  assert.equal(errorSentence({ detail: 'x'.repeat(900) }).length, 300);
  assert.equal(errorSentence(null), '');
});

// ── compare_origins ──────────────────────────────────────────────────────────

test('compare_origins: sequential calls 2 seconds apart, lowest total first', async () => {
  const { call, calls, sleeps } = harness(tshirts);
  const res = await call('compare_origins', { hts: '6109.10.00', origins: ['CN', 'VN', 'MX'] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('origin')), ['CN', 'VN', 'MX']);
  assert.deepEqual(sleeps, [COMPARE_GAP_MS, COMPARE_GAP_MS]);
  assert.equal(COMPARE_GAP_MS, 2000);
  const totals = res.structuredContent.results.map((r) => [r.origin, r.total_rate_pct]);
  assert.deepEqual(totals, [['MX', SAMPLES.tshirt_mx.total_rate], ['VN', SAMPLES.tshirt_vn.total_rate], ['CN', SAMPLES.tshirt_cn.total_rate]]);
  const text = res.content[0].text;
  assert.ok(text.indexOf('- MX: 26.5%') < text.indexOf('- VN: 29%') && text.indexOf('- VN: 29%') < text.indexOf('- CN: 36.5%'));
  assert.match(text, /- CN: 36\.5% = MFN duty 16\.5% \+ Section 301 7\.5% \+ Forced-labor Section 301 tariff 12\.5%/);
  assert.match(text, /USMCA: /);
  assert.match(text, /Duty only: freight, fees and supplier prices/);
  assert.match(text, /Checked on 2026-11-14/);
  assert.ok(text.includes(DISCLAIMER));
});

test('compare_origins: an unknown origin is reported, the others still answer', async () => {
  const { call } = harness(tshirts);
  const res = await call('compare_origins', { hts: '6109.10.00', origins: ['CN', 'Atlantis'] });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /- CN: 36\.5%/);
  assert.match(res.content[0].text, /- Atlantis: no rate \(/);
  const all = await harness(() => reply(200, SAMPLES.bad_origin)).call('compare_origins', { hts: '6109.10.00', origins: ['Narnia', 'Atlantis'] });
  assert.equal(all.isError, true);
});

test('compare_origins: a 429 stops the run and the rest is marked not checked', async () => {
  let n = 0;
  const { call, calls } = harness((url) => {
    n += 1;
    return n === 1 ? tshirts(url) : reply(429, { detail: 'Too many lookups. Try again in a few minutes.' });
  });
  const res = await call('compare_origins', { hts: '6109.10.00', origins: ['CN', 'VN', 'MX', 'IN'] });
  assert.equal(calls.length, 2);                          // CN answered, VN hit the limit, MX and IN were not sent
  const text = res.content[0].text;
  assert.match(text, /- CN: 36\.5%/);
  assert.match(text, /- VN: no rate \(Not checked: rate limit reached\.\)/);
  assert.match(text, /- MX: no rate \(Not checked\.\)/);
  assert.match(text, /- IN: no rate \(Not checked\.\)/);
  assert.match(text, /rate limit reached \(HTTP 429\)/);
  assert.equal(res.structuredContent.results.filter((r) => r.ok).length, 1);
});

// ── hts_search ───────────────────────────────────────────────────────────────

test('hts_search lists the lines, or says that nothing matched', async () => {
  const { call, calls } = harness((url) => reply(200, url.searchParams.get('q') === 'cotton t-shirt' ? SAMPLES.search : { results: [] }));
  const res = await call('hts_search', { query: '  cotton   t-shirt ' });
  assert.equal(calls[0].url.pathname, '/api/public-tools/hts-search');
  assert.equal(calls[0].url.searchParams.get('q'), 'cotton t-shirt');
  assert.ok(res.content[0].text.includes(`- ${SAMPLES.search.results[0].hts}: ${SAMPLES.search.results[0].description}`));
  assert.match(res.content[0].text, /not a classification/);
  assert.match(res.content[0].text, /Checked on 2026-11-14/);
  assert.deepEqual(res.structuredContent.results, SAMPLES.search.results);
  const none = await call('hts_search', { query: 'zzzzqqqq' });
  assert.equal(none.isError, undefined);
  assert.match(none.content[0].text, /No HTSUS line matched "zzzzqqqq"/);
  assert.deepEqual(none.structuredContent.results, []);
});

// ── landed_cost (keyed) ──────────────────────────────────────────────────────

const LANDED = {
  id: 'lc_0123456789abcdef', hs_code: '6109.10.00', hs_code_source: 'input', hs_description: 'T-shirts — Of cotton',
  origin_country: 'CN', destination_country: 'US', quantity: 1000, unit_value_usd: 10, currency: 'USD',
  total_landed_cost: 14111.5, total_per_unit: 14.1115, product_value: 10000, freight: 150, insurance: 50.75,
  total_duty: 3650, effective_duty_rate_pct: 36.5, total_taxes: 0, total_fees: 260.75,
  layers: {
    mfn: { label: 'MFN customs duty', rate_pct: 16.5, amount: 1650 },
    section_301: { label: 'Section 301 (China/Brazil lists)', rate_pct: 7.5, amount: 750 },
    forced_labor_301: { label: 'Forced-labor Section 301 tariff', rate_pct: 12.5, amount: 1250 },
    section_232: { label: 'Section 232', rate_pct: 0, amount: 0 },
    vat: { label: 'VAT / GST', rate_pct: 0, amount: 0 },
    other_taxes: { label: 'Other taxes and levies', rate_pct: null, amount: 0 },
  },
  fees: { merchandise_processing_fee: 35.16, harbor_maintenance_fee: 12.69, customs_broker_fee: 175 },
  warnings: ['Freight is an estimate.'],
  rate_source: { duty_rate_source: 'USITC HTS REST (live)', sources: 'HTSUS 2026 Revision 23 (USITC)' },
};

test('landed_cost without a key explains how to set one and sends nothing', async () => {
  const { call, calls } = harness(() => reply(200, LANDED));
  const res = await call('landed_cost', { hs_code: '6109.10.00', origin_country: 'CN', unit_value_usd: 10 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ZENTRIA_API_KEY/);
  assert.equal(calls.length, 0);
});

test('landed_cost posts to /api/v1 with the key in a header and never prints it', async () => {
  const { call, calls } = harness(() => reply(200, LANDED), { apiKey: KEY });
  const res = await call('landed_cost', { hs_code: '6109.10.00', origin_country: 'cn', unit_value_usd: 10, quantity: 1000, currency: 'usd' });
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].url.href, 'https://zentriaflow.com/api/v1/landed-cost/calculate');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-API-Key'], KEY);
  assert.equal(calls[0].url.href.includes(KEY), false);
  assert.deepEqual(JSON.parse(calls[0].init.body),
    { hs_code: '6109.10.00', origin_country: 'CN', destination_country: 'US', unit_value_usd: 10, quantity: 1000, currency: 'USD' });
  const text = res.content[0].text;
  assert.match(text, /Total landed cost: 14111\.5 USD \(14\.1115 USD per unit\)/);
  assert.match(text, /- MFN customs duty: 16\.5%, 1650 USD/);
  assert.match(text, /- Duty: 3650 USD \(effective rate 36\.5%\)/);
  assert.match(text, /- Freight: 150 USD \(engine estimate\)/);
  assert.equal(/Section 232/.test(text), false);          // zero layers are left out of the list
  assert.match(text, /Checked on 2026-11-14/);
  assert.ok(text.includes(DISCLAIMER));
  assert.equal(JSON.stringify(res).includes(KEY), false);
  assert.equal(res.structuredContent.total_landed_cost, 14111.5);
});

test('landed_cost: 401, 403 and the quota 429 are explained without the key', async () => {
  const cases = [
    [reply(401, { detail: 'Invalid or revoked API key.' }), /Invalid or revoked API key/],
    [reply(403, { detail: "API access requires a Developer API plan or a Professional/Enterprise SaaS plan. Your current plan: 'free'." }), /requires a Developer API plan/],
    [reply(429, { detail: 'Monthly API limit reached (100 calls/month on the Sandbox API plan).' }, { 'retry-after': '1767225600' }), /HTTP 429\): Monthly API limit reached/],
  ];
  for (const [answer, expected] of cases) {
    const { call } = harness(() => answer, { apiKey: KEY });
    const res = await call('landed_cost', { hs_code: '6109.10.00', origin_country: 'CN', unit_value_usd: 10 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, expected);
    assert.equal(JSON.stringify(res).includes(KEY), false);
    assert.equal(res.content[0].text.includes('Retry after 1767225600 seconds'), false);   // a Unix time is not a wait
  }
});

test('the key is not sent to the keyless tools', async () => {
  const { call, calls } = harness((url) => (url.pathname.endsWith('hts-search') ? reply(200, SAMPLES.search) : tshirts(url)), { apiKey: KEY });
  await call('us_tariff_check', { hts: '6109.10.00', origin: 'CN' });
  await call('hts_search', { query: 'cotton t-shirt' });
  await call('compare_origins', { hts: '6109.10.00', origins: ['CN', 'VN'] });
  assert.equal(calls.length, 4);
  for (const c of calls) assert.equal(JSON.stringify(c.init.headers).includes(KEY), false);
});

// ── configuration and package metadata ───────────────────────────────────────

test('ZENTRIA_API_BASE: https only, except a local development host', () => {
  assert.equal(resolveBaseUrl(undefined), 'https://zentriaflow.com');
  assert.equal(resolveBaseUrl('  '), 'https://zentriaflow.com');
  assert.equal(resolveBaseUrl('https://staging.example.com/api/'), 'https://staging.example.com');
  assert.equal(resolveBaseUrl('http://localhost:8001'), 'http://localhost:8001');
  assert.throws(() => resolveBaseUrl('http://zentriaflow.com'), /https/);
  assert.throws(() => resolveBaseUrl('ftp://zentriaflow.com'), /https/);
  assert.throws(() => resolveBaseUrl('https://user:pw@zentriaflow.com'), /credentials/);
  assert.throws(() => resolveBaseUrl('not a url'), /not a URL/);
});

test('package.json, server.json and the server agree', () => {
  assert.equal(PKG.name, 'zentria-flow-mcp');
  assert.equal(PKG.version, '0.2.0');
  assert.equal(PKG.private, false);
  assert.equal(PKG.license, 'MIT');
  assert.equal(PKG.type, 'module');
  assert.deepEqual(PKG.bin, { 'zentria-flow-mcp': 'src/index.js' });
  assert.equal(PKG.dependencies, undefined);              // no runtime dependencies
  assert.equal(PKG.devDependencies, undefined);
  assert.equal(SERVER_INFO.name, PKG.name);
  assert.equal(SERVER_INFO.version, PKG.version);
  assert.ok(USER_AGENT.endsWith(`/${PKG.version}`));
  assert.ok(readFileSync(here('../src/index.js'), 'utf8').startsWith('#!/usr/bin/env node'));
  assert.match(readFileSync(here('../LICENSE'), 'utf8'), /^MIT License/);

  assert.equal(SERVER_JSON.version, PKG.version);
  assert.ok(SERVER_JSON.description.length <= 100);
  assert.equal(SERVER_JSON.name, PKG.mcpName);
  assert.equal(SERVER_JSON.packages.length, 1);
  const [oci] = SERVER_JSON.packages;
  assert.equal(oci.registryType, 'oci');
  assert.equal(oci.identifier, `ghcr.io/orhansavash/zentria-flow-mcp:${PKG.version}`);
  assert.equal(oci.version, undefined);                   // the MCP Registry rejects "version" on an oci package
  assert.deepEqual(oci.transport, { type: 'stdio' });
  // The MCP Registry proves ownership of the image by this label.
  assert.ok(readFileSync(here('../Dockerfile'), 'utf8')
    .includes(`LABEL io.modelcontextprotocol.server.name="${SERVER_JSON.name}"`));
  const key = oci.environmentVariables.find((v) => v.name === 'ZENTRIA_API_KEY');
  assert.equal(key.isSecret, true);
  assert.equal(key.isRequired, false);
});

// ── the real process over stdio (no network: only calls that fail validation) ─

test('stdio: the binary answers one JSON line per request and writes logs to stderr only', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [here('../src/index.js')], {
    env: { ...process.env, ZENTRIA_API_KEY: KEY, ZENTRIA_API_BASE: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'us_tariff_check', arguments: { hts: 'shirt', origin: 'CN' } } },
  ];
  child.stdin.end(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const answers = out.trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
  assert.deepEqual(answers.map((a) => a.id), [1, 2, 3]);
  assert.equal(answers[0].result.serverInfo.version, PKG.version);
  assert.equal(answers[1].result.tools.length, 4);
  assert.equal(answers[2].result.isError, true);
  assert.match(err, /zentria-flow-mcp 0.2.0 ready \(stdio\), API https:\/\/zentriaflow\.com/);
  assert.equal((out + err).includes(KEY), false);
});

test('stdio: --version and a bad ZENTRIA_API_BASE', async () => {
  const { spawnSync } = await import('node:child_process');
  const version = spawnSync(process.execPath, [here('../src/index.js'), '--version'], { encoding: 'utf8' });
  assert.equal(version.stdout.trim(), PKG.version);
  const bad = spawnSync(process.execPath, [here('../src/index.js')], {
    encoding: 'utf8', input: '', env: { ...process.env, ZENTRIA_API_BASE: 'http://example.com' },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be an https URL/);
  assert.equal(bad.stdout, '');
});
