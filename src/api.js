// HTTP client for the Zentria Flow API. No dependencies: Node's built-in fetch.
//
// The API key (ZENTRIA_API_KEY) is only ever placed in the X-API-Key header of
// a request to the configured base URL. It is never logged and never put in an
// error message.

export const DEFAULT_BASE_URL = 'https://zentriaflow.com';
export const USER_AGENT = 'zentria-flow-mcp/0.3.2';
const TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 2_000_000;

export class ApiError extends Error {
  /** @param {string} message @param {{status?: number, kind?: string, retryAfter?: string|null}} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = info.status ?? 0;
    this.kind = info.kind ?? 'error'; // "rate_limited" | "auth" | "plan" | "invalid" | "network" | "error"
    this.retryAfter = info.retryAfter ?? null;
  }
}

/** The base URL to call: https only, except a local development host. */
export function resolveBaseUrl(raw) {
  const text = (raw || '').trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('ZENTRIA_API_BASE is not a URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('ZENTRIA_API_BASE must be an https URL.');
  }
  if (url.username || url.password) throw new Error('ZENTRIA_API_BASE must not contain credentials.');
  return url.origin;
}

/** A plain sentence out of an API error body ({"detail": ...}). Never echoes more than 300 characters. */
export function errorSentence(body) {
  const detail = body && typeof body === 'object' ? body.detail ?? body.error : null;
  let text = '';
  if (typeof detail === 'string') text = detail;
  else if (Array.isArray(detail) && detail.length) {
    const first = detail[0] || {};
    const where = Array.isArray(first.loc) ? first.loc.filter((p) => p !== 'query' && p !== 'body').join('.') : '';
    text = [where, first.msg].filter(Boolean).join(': ');
  } else if (detail && typeof detail === 'object' && typeof detail.message === 'string') text = detail.message;
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * One request. Resolves with the parsed JSON body of a 2xx answer; rejects
 * with ApiError otherwise.
 *
 * @param {{fetchImpl: typeof fetch, baseUrl: string, apiKey?: string}} ctx
 * @param {{method?: string, path: string, query?: Record<string, string|undefined>, body?: unknown, keyed?: boolean}} req
 */
export async function request(ctx, req) {
  const url = new URL(req.path, ctx.baseUrl);
  for (const [name, value] of Object.entries(req.query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (req.keyed) {
    if (!ctx.apiKey) {
      throw new ApiError(
        'This tool needs a Zentria Flow API key. Create one at https://zentriaflow.com/settings/api-keys ' +
          'and set it as the ZENTRIA_API_KEY environment variable of this MCP server.',
        { kind: 'auth' },
      );
    }
    headers['X-API-Key'] = ctx.apiKey;
  }
  const init = { method: req.method || 'GET', headers, redirect: 'error' };
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(req.body);
  }
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(TIMEOUT_MS);

  let res;
  try {
    res = await ctx.fetchImpl(url.toString(), init);
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ApiError(
      timedOut ? 'Zentria Flow did not answer in time. Try again.' : 'Could not reach Zentria Flow. Check the network connection.',
      { kind: 'network' },
    );
  }

  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let body = null;
  if (text.length <= MAX_BODY_CHARS) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (res.status === 429) {
    const retryAfter = res.headers?.get?.('retry-after') ?? null;
    throw new ApiError(errorSentence(body) || 'Too many requests.', { status: 429, kind: 'rate_limited', retryAfter });
  }
  if (res.status === 401) {
    throw new ApiError(errorSentence(body) || 'The API key was not accepted.', { status: 401, kind: 'auth' });
  }
  if (res.status === 403) {
    throw new ApiError(errorSentence(body) || 'The plan of this API key does not include this endpoint.', {
      status: 403,
      kind: 'plan',
    });
  }
  if (res.status === 400 || res.status === 422) {
    throw new ApiError(errorSentence(body) || 'Zentria Flow rejected the request.', { status: res.status, kind: 'invalid' });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(`Zentria Flow answered with HTTP ${res.status}. Try again later.`, { status: res.status });
  }
  if (body === null || typeof body !== 'object') {
    throw new ApiError('Zentria Flow sent an answer that is not JSON. Try again later.', { status: res.status });
  }
  return body;
}
