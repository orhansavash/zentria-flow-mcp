// The tools of the Zentria Flow MCP server.
//
// Every number a tool prints is read from the API response. Nothing is filled
// in, rounded up or estimated here: a value the API did not send is printed as
// "not returned". Every result names the day it was checked and says that it
// is a planning estimate, not a customs ruling.

import { ApiError, request } from './api.js';

export const DISCLAIMER =
  'Planning estimate, not a customs ruling. Anti-dumping and countervailing duties are company-specific and ' +
  'are not in any total. Confirm classification and rates with a licensed customs broker before entry.';
export const MAX_ORIGINS = 6;
export const COMPARE_GAP_MS = 2000;

const TRANSPORT_MODES = ['sea', 'air', 'express', 'rail', 'truck', 'road', 'multimodal'];

// ── input validation ─────────────────────────────────────────────────────────

export class InputError extends Error {}

function onlyKeys(args, allowed) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new InputError('Arguments must be an object.');
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) throw new InputError(`Unknown argument: ${extra[0]}. Allowed: ${allowed.join(', ')}.`);
}

export function cleanHts(value, name = 'hts') {
  if (typeof value !== 'string') throw new InputError(`${name} must be a string such as "6109.10.00".`);
  const text = value.trim();
  const digits = text.replace(/[.\s-]/g, '');
  if (!/^[0-9]+$/.test(digits) || text.length > 20) {
    throw new InputError(`${name} has only digits and dots, for example 6109.10.00.`);
  }
  if (digits.length < 4 || digits.length > 10) throw new InputError(`${name} needs 4 to 10 digits, for example 6109.10.00.`);
  return text;
}

export function cleanOrigin(value, name = 'origin') {
  if (typeof value !== 'string') throw new InputError(`${name} must be a country name or ISO-2 code, for example "CN".`);
  const text = value.trim();
  if (text.length < 2 || text.length > 60 || !/^[\p{L}][\p{L} .,'()-]*$/u.test(text)) {
    throw new InputError(`${name} must be a country name or 2-letter ISO code, for example CN or Vietnam.`);
  }
  return text;
}

function cleanIso2(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) {
    throw new InputError(`${name} must be a 2-letter ISO country code, for example CN.`);
  }
  return value.trim().toUpperCase();
}

export function cleanDate(value, name = 'as_of') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new InputError(`${name} must be a date as YYYY-MM-DD.`);
  }
  const text = value.trim();
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new InputError(`${name} is not a real calendar date.`);
  }
  return text;
}

function cleanNumber(value, name, { min = 0, exclusive = true, max = 1e9, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InputError(`${name} must be a number.`);
  if (integer && !Number.isInteger(value)) throw new InputError(`${name} must be a whole number.`);
  if (exclusive ? value <= min : value < min) throw new InputError(`${name} must be ${exclusive ? 'greater than' : 'at least'} ${min}.`);
  if (value > max) throw new InputError(`${name} must be at most ${max}.`);
  return value;
}

// ── formatting (values from the response only) ───────────────────────────────

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x) => (isNum(x) ? `${x}%` : 'not returned');
const str = (x) => (typeof x === 'string' ? x.trim() : '');
const today = (now) => now().toISOString().slice(0, 10);

function footer(now, source) {
  const lines = [];
  if (str(source)) lines.push(`Source: ${str(source)}`);
  lines.push(`Checked on ${today(now)} (UTC) with the Zentria Flow engine, zentriaflow.com.`);
  lines.push(DISCLAIMER);
  return lines;
}

/** The duty layers of a /public-tools/tariff-check answer, as plain rows. */
export function tariffLayers(r) {
  const s301 = r.section_301 || {};
  const fl = r.forced_labor || {};
  const s232 = r.section_232 || {};
  const s338 = r.section_338 || {};
  const mfn = r.mfn || {};
  const join = (...parts) => parts.map(str).filter(Boolean).join(', ');
  return [
    { key: 'mfn', label: 'MFN duty', rate_pct: isNum(mfn.rate) ? mfn.rate : null,
      detail: join(isNum(mfn.rate) && str(mfn.text) === `${mfn.rate}%` ? '' : mfn.text, mfn.exact === false ? 'estimate' : '') },
    { key: 'section_301', label: 'Section 301', rate_pct: isNum(s301.rate) ? s301.rate : null,
      detail: join(s301.label, s301.heading, s301.partial ? 'only some 10-digit lines' : '', s301.note) },
    { key: 'forced_labor', label: 'Forced-labor Section 301 tariff', rate_pct: isNum(fl.rate) ? fl.rate : null,
      detail: join(fl.status, fl.tier, fl.reason) },
    { key: 'section_232', label: 'Section 232', rate_pct: isNum(s232.rate) ? s232.rate : null,
      detail: join(s232.program, s232.note) },
    { key: 'section_338', label: 'Section 338 (Canada)', rate_pct: isNum(s338.rate) ? s338.rate : null,
      detail: join(s338.program, s338.heading, s338.note) },
  ];
}

function scheduled(r) {
  const list = Array.isArray(r.scheduled_changes) ? r.scheduled_changes : [];
  return list.map((c) => ({
    effective_date: str(c.effective_date),
    total_rate_before_pct: isNum(c.total_rate_before) ? c.total_rate_before : null,
    total_rate_after_pct: isNum(c.total_rate_after) ? c.total_rate_after : null,
    reason: str(c.reason),
    legal_reference: str(c.legal_reference),
  }));
}

function tariffStructured(r, now) {
  return {
    checked_on: today(now),
    disclaimer: DISCLAIMER,
    hts: str(r.hts),
    origin: str(r.origin),
    description: str(r.description),
    entry_date: str(r.as_of) || null,
    total_rate_pct: isNum(r.total_rate) ? r.total_rate : null,
    layers: tariffLayers(r),
    specific_duty: r.us_mfn && typeof r.us_mfn === 'object' ? str(r.us_mfn.summary) || str(r.us_mfn.text) : '',
    usmca: r.usmca || null,
    cafta_dr: r.cafta_dr || null,
    import_ban: r.import_ban ? str(r.import_ban.message) || 'Import ban on file.' : null,
    upcoming: r.upcoming ? str(r.upcoming.message) : null,
    scheduled_changes: scheduled(r),
    notes: Array.isArray(r.notes) ? r.notes.map(str).filter(Boolean) : [],
    source: str(r.source),
  };
}

function tariffText(r, now) {
  const s = tariffStructured(r, now);
  const out = [];
  out.push(`US tariff check: HTS ${s.hts || 'not returned'} from ${s.origin || 'not returned'}`);
  if (s.description) out.push(`Product line: ${s.description}`);
  out.push(`Entry date: ${s.entry_date || 'not returned'}`);
  out.push(`Total duty rate: ${pct(s.total_rate_pct)} of the customs value`);
  out.push('Layers:');
  for (const l of s.layers) out.push(`- ${l.label}: ${pct(l.rate_pct)}${l.detail ? ` (${l.detail})` : ''}`);
  if (s.specific_duty) out.push(`Specific or compound duty: ${s.specific_duty}`);
  const q = r.us_mfn && r.us_mfn.exact === false && r.us_mfn.quantity_field;
  if (q && str(q.many)) {
    out.push(`To price this line exactly, call again with quantity (number of ${str(q.many)}) and value (customs value in US dollars).`);
  }
  if (s.import_ban) out.push(`IMPORT BAN: ${s.import_ban}`);
  if (s.usmca) out.push(`USMCA: ${str(s.usmca.qualifying)} ${str(s.usmca.non_qualifying)}`.trim());
  if (s.cafta_dr) out.push(`CAFTA-DR: ${str(s.cafta_dr.not_claimed)} ${str(s.cafta_dr.claimed)}`.trim());
  if (s.upcoming) out.push(`Upcoming: ${s.upcoming}`);
  if (s.scheduled_changes.length) {
    out.push('Scheduled changes (can be extended, changed or withdrawn before their date):');
    for (const c of s.scheduled_changes) {
      out.push(`- ${c.effective_date}: total ${pct(c.total_rate_before_pct)} -> ${pct(c.total_rate_after_pct)}` +
        (c.legal_reference ? ` (${c.legal_reference})` : ''));
    }
  }
  if (s.notes.length) {
    out.push('Notes:');
    for (const n of s.notes) out.push(`- ${n}`);
  }
  out.push(...footer(now, s.source));
  return { text: out.join('\n'), structured: s };
}

// ── API calls ────────────────────────────────────────────────────────────────

async function tariffCheck(ctx, { hts, origin, as_of, quantity, quantity_unit, value }) {
  const body = await request(ctx, {
    path: '/api/public-tools/tariff-check',
    query: { hts, origin, as_of, quantity, quantity_unit, value },
  });
  if (body.ok !== true) {
    throw new ApiError(str(body.error) || 'Zentria Flow could not check this code and origin.', { kind: 'invalid' });
  }
  return body;
}

function rateLimitSentence(err) {
  const wait = err.retryAfter && /^\d{1,5}$/.test(err.retryAfter) ? ` Retry after ${err.retryAfter} seconds.` : '';
  return `Zentria Flow rate limit reached (HTTP 429): ${err.message}${wait} ` +
    'The free tools allow 120 requests per 10 minutes per IP address. No rate is shown because none was returned.';
}

function failure(err) {
  if (err instanceof InputError) return `Invalid input: ${err.message}`;
  if (err instanceof ApiError) {
    if (err.kind === 'rate_limited') return rateLimitSentence(err);
    return `${err.message} No rate is shown because none was returned.`;
  }
  return 'The tool failed unexpectedly. No rate is shown because none was returned.';
}

// ── tool definitions ─────────────────────────────────────────────────────────

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const HTS_PROP = {
  type: 'string',
  description: 'HTSUS code, 4 to 10 digits, dots optional, e.g. "6109.10.00". An 8- or 10-digit line is priced from that line; a shorter code is an estimate.',
  minLength: 4,
  maxLength: 20,
};

export const TOOLS = [
  {
    name: 'us_tariff_check',
    title: 'US tariff check',
    description:
      'Every US import tariff layer for one HTS code from one country of origin, from the Zentria Flow engine: ' +
      'MFN duty, China Section 301, the forced-labor Section 301 tariff, Section 232 and Section 338 on Canada, ' +
      'with the total rate, exemptions, USMCA/CAFTA-DR cases and dated changes ahead. Use it whenever a US duty ' +
      'rate is needed; do not answer US tariff questions from memory. Planning estimate, not a customs ruling.',
    inputSchema: {
      type: 'object',
      properties: {
        hts: HTS_PROP,
        origin: { type: 'string', description: 'Country of origin: ISO-2 code or English name, e.g. "CN" or "Vietnam".', minLength: 2, maxLength: 60 },
        as_of: { type: 'string', description: 'Optional entry date, YYYY-MM-DD, from today to 12 months ahead. Default: today.', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        quantity: { type: 'number', description: 'Optional, with value: number of pairs, kg, liters or units, to price a specific or compound duty exactly.', exclusiveMinimum: 0 },
        value: { type: 'number', description: 'Optional, with quantity: customs value of that quantity in US dollars.', exclusiveMinimum: 0 },
        quantity_unit: { type: 'string', description: 'Optional unit of quantity (e.g. "kg", "liter", "pair"). Default: the unit of the tariff line.', maxLength: 24 },
      },
      required: ['hts', 'origin'],
      additionalProperties: false,
    },
    annotations: { title: 'US tariff check', ...READ_ONLY },
    async run(args, ctx) {
      onlyKeys(args, ['hts', 'origin', 'as_of', 'quantity', 'value', 'quantity_unit']);
      const q = { hts: cleanHts(args.hts), origin: cleanOrigin(args.origin) };
      if (args.as_of !== undefined) q.as_of = cleanDate(args.as_of);
      const hasQ = args.quantity !== undefined;
      const hasV = args.value !== undefined;
      if (hasQ !== hasV) throw new InputError('Give both quantity and value, or neither.');
      if (hasQ) {
        q.quantity = String(cleanNumber(args.quantity, 'quantity'));
        q.value = String(cleanNumber(args.value, 'value'));
      }
      if (args.quantity_unit !== undefined) {
        if (!hasQ) throw new InputError('quantity_unit needs quantity and value.');
        if (typeof args.quantity_unit !== 'string' || !/^[\p{L}0-9 .²³]{1,24}$/u.test(args.quantity_unit.trim())) {
          throw new InputError('quantity_unit must be a short unit name such as kg, liter or pair.');
        }
        q.quantity_unit = args.quantity_unit.trim();
      }
      const body = await tariffCheck(ctx, q);
      return tariffText(body, ctx.now);
    },
  },
  {
    name: 'compare_origins',
    title: 'Compare US tariffs by origin',
    description:
      `The US tariff layers of one HTS code from 2 to ${MAX_ORIGINS} countries of origin, side by side, lowest ` +
      'total first. Calls the Zentria Flow engine once per origin, 2 seconds apart, so it takes a few seconds. ' +
      'Duty only: freight, fees and supplier price are not compared. Planning estimate, not a customs ruling.',
    inputSchema: {
      type: 'object',
      properties: {
        hts: HTS_PROP,
        origins: {
          type: 'array',
          description: `2 to ${MAX_ORIGINS} countries of origin (ISO-2 codes or English names), e.g. ["CN", "VN", "MX"].`,
          items: { type: 'string', minLength: 2, maxLength: 60 },
          minItems: 2,
          maxItems: MAX_ORIGINS,
        },
      },
      required: ['hts', 'origins'],
      additionalProperties: false,
    },
    annotations: { title: 'Compare US tariffs by origin', ...READ_ONLY },
    async run(args, ctx) {
      onlyKeys(args, ['hts', 'origins']);
      const hts = cleanHts(args.hts);
      if (!Array.isArray(args.origins)) throw new InputError('origins must be a list of countries.');
      if (args.origins.length < 2 || args.origins.length > MAX_ORIGINS) {
        throw new InputError(`origins takes 2 to ${MAX_ORIGINS} countries.`);
      }
      const origins = args.origins.map((o, i) => cleanOrigin(o, `origins[${i}]`));
      if (new Set(origins.map((o) => o.toLowerCase())).size !== origins.length) {
        throw new InputError('origins lists the same country twice.');
      }

      const rows = [];
      let stopped = '';
      for (let i = 0; i < origins.length; i += 1) {
        if (stopped) {
          rows.push({ origin_input: origins[i], ok: false, error: 'Not checked.' });
          continue;
        }
        if (i > 0) await ctx.sleep(COMPARE_GAP_MS);
        try {
          const body = await tariffCheck(ctx, { hts, origin: origins[i] });
          rows.push({ origin_input: origins[i], ok: true, ...tariffStructured(body, ctx.now) });
        } catch (err) {
          if (err instanceof ApiError && err.kind === 'rate_limited') {
            stopped = rateLimitSentence(err);
            rows.push({ origin_input: origins[i], ok: false, error: 'Not checked: rate limit reached.' });
          } else if (err instanceof ApiError) {
            rows.push({ origin_input: origins[i], ok: false, error: err.message });
          } else {
            throw err;
          }
        }
      }

      const good = rows.filter((r) => r.ok && isNum(r.total_rate_pct)).sort((a, b) => a.total_rate_pct - b.total_rate_pct);
      const rest = rows.filter((r) => !good.includes(r));
      const out = [`US tariff comparison for HTS ${good[0]?.hts || hts}`];
      if (good[0]?.description) out.push(`Product line: ${good[0].description}`);
      if (good.length) {
        out.push('Total duty rate by origin, lowest first (percent of the customs value):');
        for (const r of good) {
          const parts = r.layers.filter((l) => isNum(l.rate_pct) && l.rate_pct !== 0).map((l) => `${l.label} ${pct(l.rate_pct)}`);
          out.push(`- ${r.origin}: ${pct(r.total_rate_pct)}${parts.length ? ` = ${parts.join(' + ')}` : ''}`);
          if (r.import_ban) out.push(`  IMPORT BAN: ${r.import_ban}`);
          if (r.usmca) out.push(`  USMCA: ${str(r.usmca.qualifying)}`);
          if (r.cafta_dr) out.push(`  CAFTA-DR: ${str(r.cafta_dr.claimed)}`);
          for (const c of r.scheduled_changes) {
            out.push(`  Scheduled ${c.effective_date}: total ${pct(c.total_rate_before_pct)} -> ${pct(c.total_rate_after_pct)}`);
          }
        }
      }
      for (const r of rest) out.push(`- ${r.origin_input}: no rate (${r.error || 'the total was not returned'})`);
      if (stopped) out.push(stopped);
      out.push('Duty only: freight, fees and supplier prices differ by origin and are not compared here.');
      out.push(...footer(ctx.now, good[0]?.source));
      return {
        text: out.join('\n'),
        structured: { checked_on: today(ctx.now), disclaimer: DISCLAIMER, hts, results: [...good, ...rest] },
        isError: good.length === 0,
      };
    },
  },
  {
    name: 'hts_search',
    title: 'Search HTSUS lines',
    description:
      'Find US tariff lines (8-digit HTSUS codes) by product words or the start of a code, from the official ' +
      'HTSUS descriptions. Use it to get a code for us_tariff_check. A search hit is a candidate, not a ' +
      'classification ruling.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product words or the start of a code, e.g. "cotton t-shirt" or "6109".', minLength: 2, maxLength: 80 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Search HTSUS lines', ...READ_ONLY },
    async run(args, ctx) {
      onlyKeys(args, ['query']);
      if (typeof args.query !== 'string') throw new InputError('query must be a string.');
      const query = args.query.replace(/\s+/g, ' ').trim();
      if (query.length < 2 || query.length > 80) throw new InputError('query needs 2 to 80 characters.');
      const body = await request(ctx, { path: '/api/public-tools/hts-search', query: { q: query } });
      const results = (Array.isArray(body.results) ? body.results : [])
        .filter((r) => r && str(r.hts))
        .map((r) => ({ hts: str(r.hts), description: str(r.description) }));
      const out = [];
      if (results.length) {
        out.push(`HTSUS lines matching "${query}":`);
        for (const r of results) out.push(`- ${r.hts}: ${r.description}`);
        out.push('These are search hits on the official descriptions, not a classification. Pick the line that fits the product, then call us_tariff_check with it.');
      } else {
        out.push(`No HTSUS line matched "${query}". Try other product words (material, use) or the first 4 digits of the code.`);
      }
      out.push(...footer(ctx.now, ''));
      return { text: out.join('\n'), structured: { checked_on: today(ctx.now), disclaimer: DISCLAIMER, query, results } };
    },
  },
  {
    name: 'landed_cost',
    title: 'Landed cost of a shipment',
    description:
      'Full landed cost of one shipment from the Zentria Flow keyed API: product value, freight, insurance, every ' +
      'duty layer, VAT/GST and fees, for 70+ countries. Needs the ZENTRIA_API_KEY environment variable ' +
      '(an API plan; the Sandbox plan is free). Each call counts against the plan quota. Planning estimate, ' +
      'not a customs ruling.',
    inputSchema: {
      type: 'object',
      properties: {
        hs_code: { type: 'string', description: 'HS or HTS code, at least 4 digits, e.g. "6109.10.00".', minLength: 4, maxLength: 20 },
        origin_country: { type: 'string', description: 'ISO-2 code of the origin, e.g. "CN".', minLength: 2, maxLength: 2 },
        destination_country: { type: 'string', description: 'ISO-2 code of the destination. Default "US".', minLength: 2, maxLength: 2 },
        unit_value_usd: { type: 'number', description: 'Value of one unit in US dollars.', exclusiveMinimum: 0, maximum: 100000000 },
        quantity: { type: 'integer', description: 'Number of units. Default 1.', minimum: 1, maximum: 10000000 },
        weight_kg: { type: 'number', description: 'Optional total weight in kg. Default: 0.5 kg per unit.', exclusiveMinimum: 0, maximum: 10000000 },
        freight_cost_usd: { type: 'number', description: 'Optional freight quote in US dollars. Default: the engine\'s estimate.', minimum: 0, maximum: 100000000 },
        transport_mode: { type: 'string', enum: TRANSPORT_MODES, description: 'Default "sea".' },
        currency: { type: 'string', description: 'ISO 4217 currency of the result. Default "USD".', pattern: '^[A-Za-z]{3}$' },
      },
      required: ['hs_code', 'origin_country', 'unit_value_usd'],
      additionalProperties: false,
    },
    annotations: { title: 'Landed cost of a shipment', ...READ_ONLY, idempotentHint: false },
    async run(args, ctx) {
      onlyKeys(args, ['hs_code', 'origin_country', 'destination_country', 'unit_value_usd', 'quantity', 'weight_kg',
        'freight_cost_usd', 'transport_mode', 'currency']);
      const payload = {
        hs_code: cleanHts(args.hs_code, 'hs_code'),
        origin_country: cleanIso2(args.origin_country, 'origin_country'),
        destination_country: args.destination_country === undefined ? 'US' : cleanIso2(args.destination_country, 'destination_country'),
        unit_value_usd: cleanNumber(args.unit_value_usd, 'unit_value_usd', { max: 100_000_000 }),
        quantity: args.quantity === undefined ? 1 : cleanNumber(args.quantity, 'quantity', { min: 1, exclusive: false, max: 10_000_000, integer: true }),
      };
      if (args.weight_kg !== undefined) payload.weight_kg = cleanNumber(args.weight_kg, 'weight_kg', { max: 10_000_000 });
      if (args.freight_cost_usd !== undefined) {
        payload.freight_cost_usd = cleanNumber(args.freight_cost_usd, 'freight_cost_usd', { exclusive: false, max: 100_000_000 });
      }
      if (args.transport_mode !== undefined) {
        if (!TRANSPORT_MODES.includes(args.transport_mode)) throw new InputError(`transport_mode must be one of: ${TRANSPORT_MODES.join(', ')}.`);
        payload.transport_mode = args.transport_mode;
      }
      if (args.currency !== undefined) {
        if (typeof args.currency !== 'string' || !/^[A-Za-z]{3}$/.test(args.currency)) throw new InputError('currency must be a 3-letter ISO 4217 code, for example EUR.');
        payload.currency = args.currency.toUpperCase();
      }
      const p = await request(ctx, { method: 'POST', path: '/api/v1/landed-cost/calculate', body: payload, keyed: true });

      const cur = str(p.currency) || 'not returned';
      const money = (x) => (isNum(x) ? `${x} ${cur}` : 'not returned');
      const layers = Object.entries(p.layers && typeof p.layers === 'object' ? p.layers : {})
        .filter(([, l]) => l && typeof l === 'object')
        .map(([key, l]) => ({ key, label: str(l.label) || key, rate_pct: isNum(l.rate_pct) ? l.rate_pct : null, amount: isNum(l.amount) ? l.amount : null }));
      const fees = Object.entries(p.fees && typeof p.fees === 'object' ? p.fees : {})
        .filter(([, v]) => isNum(v))
        .map(([key, amount]) => ({ key, amount }));
      const warnings = Array.isArray(p.warnings) ? p.warnings.map(str).filter(Boolean) : [];
      const src = p.rate_source && typeof p.rate_source === 'object' ? p.rate_source : {};

      const out = [];
      out.push(`Landed cost: HS ${str(p.hs_code) || 'not returned'}, ${str(p.origin_country) || 'not returned'} -> ${str(p.destination_country) || 'not returned'}`);
      if (str(p.hs_description)) out.push(`Product line: ${str(p.hs_description)}`);
      out.push(`Quantity: ${isNum(p.quantity) ? p.quantity : 'not returned'}; unit value: ${isNum(p.unit_value_usd) ? `${p.unit_value_usd} USD` : 'not returned'}`);
      out.push(`Total landed cost: ${money(p.total_landed_cost)} (${money(p.total_per_unit)} per unit)`);
      out.push(`- Product value: ${money(p.product_value)}`);
      out.push(`- Freight: ${money(p.freight)}${args.freight_cost_usd === undefined ? ' (engine estimate)' : ''}`);
      out.push(`- Insurance: ${money(p.insurance)}`);
      out.push(`- Duty: ${money(p.total_duty)} (effective rate ${pct(p.effective_duty_rate_pct)})`);
      out.push(`- Taxes: ${money(p.total_taxes)}`);
      out.push(`- Fees: ${money(p.total_fees)}`);
      out.push('Duty and tax layers:');
      for (const l of layers) {
        if (l.amount === 0 && (l.rate_pct === 0 || l.rate_pct === null)) continue;
        out.push(`- ${l.label}: ${l.rate_pct === null ? '' : `${pct(l.rate_pct)}, `}${money(l.amount)}`);
      }
      if (fees.some((f) => f.amount !== 0)) {
        out.push('Fees:');
        for (const f of fees) if (f.amount !== 0) out.push(`- ${f.key.replace(/_/g, ' ')}: ${money(f.amount)}`);
      }
      if (str(p.import_restriction)) out.push(`IMPORT RESTRICTION: ${str(p.import_restriction)}`);
      if (str(p.upcoming_tariff)) out.push(`Upcoming: ${str(p.upcoming_tariff)}`);
      if (warnings.length) {
        out.push('Warnings:');
        for (const w of warnings) out.push(`- ${w}`);
      }
      if (str(src.duty_rate_source)) out.push(`Duty rate source: ${str(src.duty_rate_source)}`);
      out.push(...footer(ctx.now, str(src.sources)));
      return {
        text: out.join('\n'),
        structured: {
          checked_on: today(ctx.now),
          disclaimer: DISCLAIMER,
          hs_code: str(p.hs_code),
          origin_country: str(p.origin_country),
          destination_country: str(p.destination_country),
          currency: str(p.currency),
          quantity: isNum(p.quantity) ? p.quantity : null,
          total_landed_cost: isNum(p.total_landed_cost) ? p.total_landed_cost : null,
          total_per_unit: isNum(p.total_per_unit) ? p.total_per_unit : null,
          product_value: isNum(p.product_value) ? p.product_value : null,
          freight: isNum(p.freight) ? p.freight : null,
          insurance: isNum(p.insurance) ? p.insurance : null,
          total_duty: isNum(p.total_duty) ? p.total_duty : null,
          effective_duty_rate_pct: isNum(p.effective_duty_rate_pct) ? p.effective_duty_rate_pct : null,
          total_taxes: isNum(p.total_taxes) ? p.total_taxes : null,
          total_fees: isNum(p.total_fees) ? p.total_fees : null,
          layers,
          fees,
          warnings,
          source: str(src.sources),
        },
      };
    },
  },
];

/** tools/list entries: the definitions without their handlers. */
export function listTools() {
  return TOOLS.map(({ run, ...definition }) => definition);
}

/**
 * Run one tool. Always resolves with an MCP tool result; a failure is a
 * result with isError: true and a sentence the model can act on.
 * Returns null when no tool has that name.
 */
export async function callTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  try {
    const { text, structured, isError } = await tool.run(args ?? {}, ctx);
    const result = { content: [{ type: 'text', text }], structuredContent: structured };
    if (isError) result.isError = true;
    return result;
  } catch (err) {
    return { content: [{ type: 'text', text: failure(err) }], isError: true };
  }
}
