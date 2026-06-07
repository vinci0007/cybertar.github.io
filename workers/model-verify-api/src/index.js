import { Client } from 'pg';

const DEFAULT_MAX_REPORT_BYTES = 120000;
const DEFAULT_TABLE = 'model_verify_reports';
const DEFAULT_PENDING_TABLE = 'model_verify_pending_reports';
const DEFAULT_RATE_TABLE = 'model_verify_submission_limits';
const DEFAULT_SESSION_TABLE = 'model_verify_sessions';
const DEFAULT_DISCUSSION_TABLE = 'model_verify_discussions';
const DEFAULT_EDGE_CACHE_TTL_SECONDS = 3600;
const DEFAULT_STALE_CACHE_TTL_SECONDS = 21600;
const DEFAULT_SESSION_USER_CACHE_TTL_SECONDS = 300;
const MAX_MEMORY_CACHE_ENTRIES = 120;
const MAX_SESSION_CACHE_ENTRIES = 400;
const MODEL_PROXY_PATH = '/model-verify-proxy';
const REPORTS_PATH = '/model-verify-reports';
const DISCUSSIONS_PATH = '/model-verify-discussions';
const AUTH_LOGIN_PATH = '/model-verify-auth/github/login';
const AUTH_CALLBACK_PATH = '/model-verify-auth/github/callback';
const AUTH_ME_PATH = '/model-verify-auth/me';
const AUTH_LOGOUT_PATH = '/model-verify-auth/logout';
const DEFAULT_PROXY_HOSTS = ['*'];
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const OAUTH_COOKIE = 'mv_oauth_state';
const OAUTH_RETURN_COOKIE = 'mv_oauth_return_to';
const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000;
let schemaReadyAt = 0;
let schemaReadyKey = '';
let schemaReadyPromise = null;
const jsonMemoryCache = new Map();
const jsonRefreshPromises = new Map();
const sessionUserCache = new Map();

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function createTiming() {
  return { startedAt: nowMs(), entries: [] };
}

function timeSpan(timing, name) {
  if (!timing) return () => {};
  const startedAt = nowMs();
  return () => {
    timing.entries.push({ name, duration: Math.max(0, nowMs() - startedAt) });
  };
}

function timingHeader(timing) {
  if (!timing) return '';
  const total = Math.max(0, nowMs() - timing.startedAt);
  const entries = [...timing.entries, { name: 'worker_total', duration: total }];
  return entries
    .map((entry) => `${entry.name};dur=${entry.duration.toFixed(1)}`)
    .join(', ');
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes('*') || allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}

function errorResponse(request, env, status, message) {
  return json({ error: message }, { status, headers: corsHeaders(request, env) });
}

function edgeCacheTtlSeconds(env) {
  const configured = Number(env.MODEL_VERIFY_EDGE_CACHE_TTL_SECONDS || DEFAULT_EDGE_CACHE_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_EDGE_CACHE_TTL_SECONDS;
  return Math.max(0, Math.min(86400, Math.round(configured)));
}

function staleCacheTtlSeconds(env) {
  const configured = Number(env.MODEL_VERIFY_STALE_CACHE_TTL_SECONDS || DEFAULT_STALE_CACHE_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_STALE_CACHE_TTL_SECONDS;
  return Math.max(0, Math.min(86400, Math.round(configured)));
}

function sessionUserCacheTtlSeconds(env) {
  const configured = Number(env.MODEL_VERIFY_SESSION_USER_CACHE_TTL_SECONDS || DEFAULT_SESSION_USER_CACHE_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_USER_CACHE_TTL_SECONDS;
  return Math.max(0, Math.min(3600, Math.round(configured)));
}

function edgeCacheEnabled(env) {
  return edgeCacheTtlSeconds(env) > 0 && env.MODEL_VERIFY_EDGE_CACHE_DISABLED !== 'true' && typeof caches !== 'undefined';
}

function skipReadSchemaEnsure(env) {
  return env.MODEL_VERIFY_SKIP_READ_SCHEMA_ENSURE !== 'false';
}

function cacheOrigins(request, env) {
  const requestOrigin = request.headers.get('origin') || '';
  const configured = String(env.CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item !== '*');
  return [...new Set([requestOrigin, ...configured, ''].filter((item) => item !== null && item !== undefined))];
}

function cacheKeyForUrl(request, urlValue, tag, origin = request.headers.get('origin') || '') {
  const url = new URL(urlValue, request.url);
  url.searchParams.set('__mv_cache', tag);
  url.searchParams.set('__mv_origin', origin || 'none');
  return new Request(url.toString(), { method: 'GET' });
}

function memoryCacheKeyForUrl(request, urlValue, tag, origin = request.headers.get('origin') || '') {
  return cacheKeyForUrl(request, urlValue, tag, origin).url;
}

function boundedSet(map, key, value, maxEntries) {
  if (map.size >= maxEntries && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, value);
}

function jsonResponseFromBody(body, request, env, cacheStatus = 'miss', timing = null) {
  const ttl = edgeCacheTtlSeconds(env);
  const serverTiming = timingHeader(timing);
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env),
      'cache-control': `public, max-age=${ttl}, stale-while-revalidate=${staleCacheTtlSeconds(env)}`,
      'x-model-verify-cache': cacheStatus,
      ...(serverTiming ? { 'server-timing': serverTiming } : {})
    }
  });
}

function rememberJsonCache(key, body, env) {
  const now = Date.now();
  const ttlMs = edgeCacheTtlSeconds(env) * 1000;
  if (!ttlMs) return;
  boundedSet(jsonMemoryCache, key, {
    body,
    expiresAt: now + ttlMs,
    staleUntil: now + Math.max(ttlMs, staleCacheTtlSeconds(env) * 1000)
  }, MAX_MEMORY_CACHE_ENTRIES);
}

async function produceCachedJson(request, env, ctx, tag, key, edgeKey, producer, cacheStatus = 'miss', timing = null) {
  if (jsonRefreshPromises.has(key)) {
    const body = await jsonRefreshPromises.get(key);
    return jsonResponseFromBody(body, request, env, 'coalesced', timing);
  }
  const refresh = (async () => {
    const endProducer = timeSpan(timing, 'producer');
    let body = '';
    try {
      body = JSON.stringify(await producer());
    } finally {
      endProducer();
    }
    rememberJsonCache(key, body, env);
    const response = jsonResponseFromBody(body, request, env, cacheStatus, timing);
    if (edgeCacheEnabled(env)) {
      ctx?.waitUntil?.(caches.default.put(edgeKey, response.clone()).catch(() => null));
    }
    return body;
  })().finally(() => {
    jsonRefreshPromises.delete(key);
  });
  jsonRefreshPromises.set(key, refresh);
  const body = await refresh;
  return jsonResponseFromBody(body, request, env, cacheStatus, timing);
}

async function cachedJson(request, env, ctx, tag, producer, timing = null) {
  const ttl = edgeCacheTtlSeconds(env);
  if (ttl <= 0) {
    return json(await producer(), { headers: corsHeaders(request, env) });
  }
  const memoryKey = memoryCacheKeyForUrl(request, request.url, tag);
  const edgeKey = cacheKeyForUrl(request, request.url, tag);
  const now = Date.now();
  const memoryEntry = jsonMemoryCache.get(memoryKey);
  if (memoryEntry && now < memoryEntry.expiresAt) {
    return jsonResponseFromBody(memoryEntry.body, request, env, 'memory', timing);
  }
  if (memoryEntry && now < memoryEntry.staleUntil) {
    ctx?.waitUntil?.(produceCachedJson(request, env, ctx, tag, memoryKey, edgeKey, producer, 'refresh', null).catch(() => null));
    return jsonResponseFromBody(memoryEntry.body, request, env, 'stale', timing);
  }
  if (edgeCacheEnabled(env)) {
    const endEdgeMatch = timeSpan(timing, 'cache_edge');
    const cached = await caches.default.match(edgeKey);
    endEdgeMatch();
    if (cached) {
      const body = await cached.clone().text();
      rememberJsonCache(memoryKey, body, env);
      return jsonResponseFromBody(body, request, env, 'edge', timing);
    }
  }
  return produceCachedJson(request, env, ctx, tag, memoryKey, edgeKey, producer, 'miss', timing);
}

function purgeCachedJson(request, env, ctx, urlValue, tag) {
  const origins = cacheOrigins(request, env);
  origins.forEach((origin) => jsonMemoryCache.delete(memoryCacheKeyForUrl(request, urlValue, tag, origin)));
  if (edgeCacheEnabled(env)) {
    const deletes = origins.map((origin) => caches.default.delete(cacheKeyForUrl(request, urlValue, tag, origin)));
    ctx?.waitUntil?.(Promise.allSettled(deletes).catch(() => null));
  }
}

function quoteIdent(value) {
  return `"${String(value || DEFAULT_TABLE).replace(/"/g, '""')}"`;
}

function tableName(env, key, fallback) {
  return String(env[key] || fallback).trim() || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function sha256(value) {
  const data = new TextEncoder().encode(String(value || ''));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes) {
  const raw = String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.get('cookie') || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf('=');
      return index === -1 ? [item, ''] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
    }));
}

function cookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || '/'}`,
    `Max-Age=${Number(options.maxAge || 0)}`,
    'Secure',
    `SameSite=${options.sameSite || 'Lax'}`
  ];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  return parts.join('; ');
}

function authTokenFromRequest(request) {
  const header = String(request.headers.get('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function siteOwner(env) {
  return String(env.GITHUB_SITE_OWNER || 'vinci0007').trim().toLowerCase();
}

function siteOwnerId(env) {
  return String(env.GITHUB_SITE_OWNER_ID || '').trim();
}

function userRoleByGithubId(githubId, env) {
  const ownerId = siteOwnerId(env);
  return ownerId && String(githubId || '').trim() === ownerId ? 'admin' : 'user';
}

function siteUrl(env, request, fallbackPath = '/lab/model-verifier/') {
  const configured = String(env.MODEL_VERIFY_SITE_URL || 'https://cybertar.youngood.tech/lab/model-verifier/').trim();
  try {
    return new URL(configured).toString();
  } catch {
    return new URL(fallbackPath, request.url).toString();
  }
}

function safeReturnTo(value, env, request) {
  if (!value) return siteUrl(env, request);
  try {
    const target = new URL(value);
    const allowed = String(env.CORS_ALLOW_ORIGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const configuredSite = new URL(siteUrl(env, request));
    if (target.origin === configuredSite.origin || allowed.includes(target.origin)) return target.toString();
  } catch {}
  return siteUrl(env, request);
}

function redirectResponse(location, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('location', location);
  asArray(init.cookies).forEach((item) => headers.append('set-cookie', item));
  return new Response(null, {
    status: init.status || 302,
    headers
  });
}

function timingSafeEqualText(left, right) {
  const leftHash = new TextEncoder().encode(String(left || ''));
  const rightHash = new TextEncoder().encode(String(right || ''));
  if (leftHash.length !== rightHash.length) return false;
  let diff = 0;
  for (let index = 0; index < leftHash.length; index += 1) diff |= leftHash[index] ^ rightHash[index];
  return diff === 0;
}

async function adminPasswordMatches(password, env) {
  const value = String(password || '');
  if (!value) return false;
  const configuredHash = String(env.ADMIN_DELETE_PASSWORD_SHA256 || '').trim().toLowerCase();
  if (configuredHash) {
    return timingSafeEqualText(await sha256(value), configuredHash);
  }
  const configured = String(env.ADMIN_DELETE_PASSWORD || '').trim();
  return Boolean(configured) && timingSafeEqualText(await sha256(value), await sha256(configured));
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') ||
    String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';
}

function minuteWindowIso(now = Date.now()) {
  return new Date(Math.floor(now / 60000) * 60000).toISOString();
}

function reportStats(report) {
  const channel = asArray(report?.channels)[0] || {};
  return {
    targetModel: String(channel.targetModel || '').trim().toLowerCase(),
    score: Number(channel.score || 0),
    scoredProbeCount: Number(channel.scoredProbeCount || 0),
    generatedAt: Date.parse(report?.generatedAt || 0) || 0
  };
}

function compareReportCredibility(a, b) {
  const left = reportStats(a.report || a);
  const right = reportStats(b.report || b);
  if (left.score !== right.score) return left.score - right.score;
  if (left.scoredProbeCount !== right.scoredProbeCount) return left.scoredProbeCount - right.scoredProbeCount;
  return left.generatedAt - right.generatedAt;
}

function bestSharedItem(items) {
  return items.filter(Boolean).sort((a, b) => compareReportCredibility(b, a))[0];
}

function lowerScoresAreConfirmed(existing, first, second, env) {
  const tolerance = Number(env.MODEL_VERIFY_SCORE_CONFIRM_TOLERANCE || 5);
  const existingStats = reportStats(existing.report || existing);
  const firstStats = reportStats(first.report || first);
  const secondStats = reportStats(second.report || second);
  const coverageFloor = Math.max(1, Math.floor(existingStats.scoredProbeCount * 0.8));
  const confirmedCoverage = Math.max(firstStats.scoredProbeCount, secondStats.scoredProbeCount);
  return firstStats.score < existingStats.score &&
    secondStats.score < existingStats.score &&
    Math.abs(firstStats.score - secondStats.score) <= tolerance &&
    confirmedCoverage >= coverageFloor;
}

function proxyAllowedHosts(env) {
  const configured = String(env.MODEL_VERIFY_PROXY_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_PROXY_HOSTS;
}

function isProxyTargetAllowed(target, env) {
  if (target.protocol !== 'https:') return false;
  if (target.username || target.password) return false;
  const path = target.pathname.replace(/\/+$/, '').toLowerCase();
  const isAllowedEndpoint = /(?:^|\/)(models|responses|messages)$/.test(path) ||
    /(?:^|\/)chat\/completions$/.test(path);
  if (!isAllowedEndpoint) return false;
  const host = target.hostname.toLowerCase();
  return proxyAllowedHosts(env).some((allowed) => {
    if (allowed === '*') return true;
    if (allowed.startsWith('*.')) return host.endsWith(allowed.slice(1));
    return host === allowed;
  });
}

function apiAuthHeaders(provider, apiKey) {
  const key = normalizeApiKey(apiKey);
  if (!key) return {};
  if (provider === 'anthropic') {
    return {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    };
  }
  return { authorization: `Bearer ${key}` };
}

function normalizeApiKey(value) {
  let key = String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  const assignment = key.match(/^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY)\s*=\s*["']?([^"'\s]+)["']?$/i);
  if (assignment) key = assignment[1];
  return key.replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

async function proxyModelRequest(request, env) {
  const payload = await request.json().catch(() => null);
  let target;
  try {
    target = new URL(String(payload?.url || ''));
  } catch {
    return errorResponse(request, env, 400, 'proxy target url is invalid');
  }
  const method = String(payload?.method || 'POST').toUpperCase();
  const provider = String(payload?.provider || 'openai');
  const apiKey = normalizeApiKey(payload?.apiKey);

  if (!['GET', 'POST'].includes(method)) return errorResponse(request, env, 405, 'proxy method is not allowed');
  if (!isProxyTargetAllowed(target, env)) return errorResponse(request, env, 400, 'proxy target is not allowed');
  if (!apiKey) return errorResponse(request, env, 400, 'apiKey is required');

  const upstream = await fetch(target.toString(), {
    method,
    headers: {
      'content-type': 'application/json',
      ...apiAuthHeaders(provider, apiKey)
    },
    body: method === 'POST' ? JSON.stringify(payload?.body || {}) : undefined
  });
  const headers = new Headers(upstream.headers);
  Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value));
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

function cleanText(value, maxLength = 700) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
}

function domainFromUrl(value) {
  try {
    return new URL(String(value).startsWith('http') ? value : `https://${value}`).hostname
      .replace(/^www\./i, '')
      .toLowerCase();
  } catch {
    return '';
  }
}

function walkAndRedact(value) {
  if (Array.isArray(value)) return value.map(walkAndRedact);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? cleanText(value, 1200) : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/api.?key|authorization|x-api-key|secret|token/i.test(key)) return [key, '[redacted]'];
    if (key === 'rawPreview') return [key, undefined];
    if (key === 'preview' || key === 'error') return [key, cleanText(item, 700)];
    if (key === 'modelIds' && Array.isArray(item)) return [key, item.slice(0, 80)];
    return [key, walkAndRedact(item)];
  }).filter(([, item]) => item !== undefined));
}

function compactReport(report) {
  const channels = asArray(report?.channels).map((channel) => ({
    channel: String(channel.channel || ''),
    provider: String(channel.provider || ''),
    protocol: String(channel.protocol || ''),
    detectionMode: String(channel.detectionMode || ''),
    executionMode: String(channel.executionMode || ''),
    targetModel: String(channel.targetModel || ''),
    rawScore: Number(channel.rawScore || channel.score || 0),
    score: Number(channel.score || 0),
    label: String(channel.label || ''),
    selectedTests: asArray(channel.selectedTests).slice(0, 24),
    plannedProbeCount: Number(channel.plannedProbeCount || 0),
    scoredProbeCount: Number(channel.scoredProbeCount || 0),
    scoreCaps: asArray(channel.scoreCaps).map((cap) => ({
      cap: Number(cap.cap || 0),
      reason: cleanText(cap.reason, 160)
    })).slice(0, 8),
    returnedModels: asArray(channel.returnedModels).slice(0, 20),
    modelList: channel.modelList ? {
      checked: Boolean(channel.modelList.checked),
      statusCode: channel.modelList.statusCode || '',
      declaredSupport: channel.modelList.declaredSupport,
      error: cleanText(channel.modelList.error, 260),
      modelIds: asArray(channel.modelList.modelIds).slice(0, 80)
    } : { checked: false, modelIds: [] },
    probes: asArray(channel.probes).map((probe) => ({
      id: String(probe.id || ''),
      group: String(probe.group || ''),
      probe: String(probe.probe || probe.name || ''),
      score: Number(probe.score || 0),
      maxScore: Number(probe.maxScore || 0),
      notes: asArray(probe.notes).map((note) => cleanText(note, 220)).slice(0, 10),
      result: probe.result ? {
        success: Boolean(probe.result.success),
        statusCode: probe.result.statusCode || '',
        latencyMs: Number(probe.result.latencyMs || 0),
        returnedModel: String(probe.result.returnedModel || ''),
        preview: cleanText(probe.result.preview || probe.result.error, 700)
      } : {}
    })).slice(0, 60)
  }));

  return walkAndRedact({
    version: report?.version || 2,
    generatedAt: report?.generatedAt || '',
    source: report?.source || '',
    scoring: report?.scoring || {},
    channels
  });
}

function normalizeSharedRow(row) {
  return {
    version: 2,
    providerName: row.provider_name || '',
    homepage: row.homepage || '',
    domain: row.domain || '',
    targetModel: row.target_model || reportStats(row.report).targetModel || '',
    sharedAt: row.shared_at || '',
    report: row.report || {}
  };
}

function validatePayload(payload, env) {
  const providerName = String(payload?.providerName || '').trim().slice(0, 120);
  const homepage = String(payload?.homepage || '').trim().slice(0, 500);
  const domain = String(payload?.domain || domainFromUrl(homepage)).trim().toLowerCase();
  const computedDomain = domainFromUrl(homepage);
  const report = payload?.report && typeof payload.report === 'object' ? compactReport(payload.report) : null;

  if (!providerName) return { error: 'providerName is required' };
  if (!homepage || !computedDomain) return { error: 'valid homepage is required' };
  if (!domain || domain !== computedDomain) return { error: 'domain must match homepage host' };
  if (!report || !asArray(report.channels).length) return { error: 'valid report is required' };

  const bytes = new TextEncoder().encode(JSON.stringify(report)).length;
  const maxBytes = Number(env.MAX_REPORT_BYTES || DEFAULT_MAX_REPORT_BYTES);
  if (bytes > maxBytes) return { error: `report is too large; max ${maxBytes} bytes` };

  const targetModel = reportStats(report).targetModel || 'unknown';

  return {
    item: {
      providerName,
      homepage,
      domain,
      targetModel,
      sharedAt: new Date().toISOString(),
      report
    }
  };
}

function connectionOptions(env) {
  if (env.HYPERDRIVE?.connectionString) {
    return { connectionString: env.HYPERDRIVE.connectionString };
  }
  if (env.DATABASE_URL) {
    return {
      connectionString: env.DATABASE_URL,
      ssl: env.DB_SSL_DISABLED === 'true' ? false : { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
    };
  }
  throw new Error('database is not configured');
}

async function withClient(env, callback, timing = null) {
  const client = new Client(connectionOptions(env));
  const endConnect = timeSpan(timing, 'db_connect');
  await client.connect();
  endConnect();
  try {
    return await callback(client);
  } finally {
    const endClose = timeSpan(timing, 'db_close');
    await client.end();
    endClose();
  }
}

function schemaKey(env) {
  return [
    tableName(env, 'MODEL_VERIFY_TABLE', DEFAULT_TABLE),
    tableName(env, 'MODEL_VERIFY_PENDING_TABLE', DEFAULT_PENDING_TABLE),
    tableName(env, 'MODEL_VERIFY_RATE_TABLE', DEFAULT_RATE_TABLE),
    tableName(env, 'MODEL_VERIFY_SESSION_TABLE', DEFAULT_SESSION_TABLE),
    tableName(env, 'MODEL_VERIFY_DISCUSSION_TABLE', DEFAULT_DISCUSSION_TABLE)
  ].join('|');
}

async function ensureSubmissionTablesCached(client, env) {
  const key = schemaKey(env);
  const now = Date.now();
  if (schemaReadyKey === key && schemaReadyAt && now - schemaReadyAt < SCHEMA_CACHE_TTL_MS) return;
  if (!schemaReadyPromise) {
    schemaReadyPromise = ensureSubmissionTables(client, env)
      .then(() => {
        schemaReadyKey = key;
        schemaReadyAt = Date.now();
      })
      .finally(() => {
        schemaReadyPromise = null;
      });
  }
  await schemaReadyPromise;
}

async function primaryKeyIncludesTargetModel(client, table) {
  const result = await client.query(`show create table ${table}`);
  const statement = Object.values(result.rows[0] || {}).join('\n').toLowerCase();
  return /primary\s+key\s*\([^)]*domain[^)]*target_model/.test(statement);
}

async function ensureSubmissionTables(client, env) {
  const reportTableName = tableName(env, 'MODEL_VERIFY_TABLE', DEFAULT_TABLE);
  const pendingTableName = tableName(env, 'MODEL_VERIFY_PENDING_TABLE', DEFAULT_PENDING_TABLE);
  const rateTableName = tableName(env, 'MODEL_VERIFY_RATE_TABLE', DEFAULT_RATE_TABLE);
  const sessionTableName = tableName(env, 'MODEL_VERIFY_SESSION_TABLE', DEFAULT_SESSION_TABLE);
  const discussionTableName = tableName(env, 'MODEL_VERIFY_DISCUSSION_TABLE', DEFAULT_DISCUSSION_TABLE);
  const table = quoteIdent(reportTableName);
  const pendingTable = quoteIdent(pendingTableName);
  const rateTable = quoteIdent(rateTableName);
  const sessionTable = quoteIdent(sessionTableName);
  const discussionTable = quoteIdent(discussionTableName);
  await client.query(`
    create table if not exists ${table} (
      domain string not null,
      target_model string not null default '',
      provider_name string not null,
      homepage string not null,
      shared_at timestamptz not null default now(),
      report jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (domain, target_model)
    )
  `);
  await client.query(`alter table ${table} add column if not exists target_model string not null default ''`);
  const rowsMissingModel = await client.query(`select domain, report from ${table} where target_model = ''`);
  for (const row of rowsMissingModel.rows) {
    const targetModel = reportStats(row.report).targetModel || 'unknown';
    await client.query(`update ${table} set target_model = $1 where domain = $2 and target_model = ''`, [targetModel, row.domain]);
  }
  if (!(await primaryKeyIncludesTargetModel(client, table))) {
    await client.query(`alter table ${table} alter primary key using columns (domain, target_model)`);
  }
  await client.query(`
    create table if not exists ${pendingTable} (
      pending_key string primary key,
      domain string not null,
      target_model string not null,
      submitter_hash string not null,
      provider_name string not null,
      homepage string not null,
      score float8 not null,
      report jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `);
  await client.query(`
    create table if not exists ${rateTable} (
      rate_key string primary key,
      window_start timestamptz not null,
      updated_at timestamptz not null default now()
    )
  `);
  await client.query(`
    create table if not exists ${sessionTable} (
      session_hash string primary key,
      github_id string not null,
      github_login string not null,
      github_name string not null default '',
      avatar_url string not null default '',
      role string not null default 'user',
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `);
  await client.query(`
    create table if not exists ${discussionTable} (
      id string primary key,
      domain string not null,
      target_model string not null,
      body string not null,
      author_id string not null,
      author_login string not null,
      author_name string not null default '',
      author_avatar_url string not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )
  `);
  await client.query(`create index if not exists ${quoteIdent(`${reportTableName}_shared_at_idx`)} on ${table} (shared_at desc)`);
  await client.query(`create index if not exists ${quoteIdent(`${pendingTableName}_expires_at_idx`)} on ${pendingTable} (expires_at)`);
  await client.query(`create index if not exists ${quoteIdent(`${rateTableName}_updated_at_idx`)} on ${rateTable} (updated_at)`);
  await client.query(`create index if not exists ${quoteIdent(`${discussionTableName}_lookup_idx`)} on ${discussionTable} (domain, target_model, deleted_at, created_at)`);
}

async function enforceSubmissionRateLimit(client, env, request) {
  const rateTable = quoteIdent(env.MODEL_VERIFY_RATE_TABLE || DEFAULT_RATE_TABLE);
  const submitterHash = await sha256(clientIp(request));
  const rateKey = `share:${submitterHash}`;
  const windowStart = minuteWindowIso();
  const result = await client.query(`
    insert into ${rateTable} as current_limit (rate_key, window_start, updated_at)
    values ($1, $2, now())
    on conflict (rate_key) do update
      set window_start = excluded.window_start,
          updated_at = now()
      where current_limit.window_start < excluded.window_start
    returning window_start::string as window_start
  `, [rateKey, windowStart]);
  if (!result.rows.length) {
    throw new HttpError(429, '提交过于频繁，同一 IP 每分钟最多只能提交 1 次，请稍后再试。');
  }
  await client.query(`delete from ${rateTable} where updated_at < now() - interval '10 minutes'`);
  return submitterHash;
}

function publicUser(row, env) {
  if (!row) return null;
  const githubId = row.github_id || row.id || '';
  return {
    githubId,
    login: row.github_login || row.login || '',
    name: row.github_name || row.name || '',
    avatarUrl: row.avatar_url || row.avatar_url || '',
    role: userRoleByGithubId(githubId, env)
  };
}

function sessionCacheKey(sessionHash, env) {
  return `${siteOwnerId(env) || 'no-owner'}:${sessionHash}`;
}

function rememberSessionUser(sessionHash, env, user) {
  const ttl = sessionUserCacheTtlSeconds(env) * 1000;
  if (!ttl) return;
  boundedSet(sessionUserCache, sessionCacheKey(sessionHash, env), {
    user,
    expiresAt: Date.now() + ttl
  }, MAX_SESSION_CACHE_ENTRIES);
}

function readSessionUser(sessionHash, env) {
  const key = sessionCacheKey(sessionHash, env);
  const cached = sessionUserCache.get(key);
  if (!cached) return undefined;
  if (Date.now() > cached.expiresAt) {
    sessionUserCache.delete(key);
    return undefined;
  }
  return cached.user;
}

function forgetSessionUser(sessionHash, env) {
  sessionUserCache.delete(sessionCacheKey(sessionHash, env));
}

async function userFromSession(client, env, request) {
  const token = authTokenFromRequest(request);
  if (!token) return null;
  const sessionTable = quoteIdent(env.MODEL_VERIFY_SESSION_TABLE || DEFAULT_SESSION_TABLE);
  const sessionHash = await sha256(token);
  const cached = readSessionUser(sessionHash, env);
  if (cached !== undefined) return cached;
  const result = await client.query(`
    select github_id, github_login, github_name, avatar_url, role
    from ${sessionTable}
    where session_hash = $1 and expires_at > now()
    limit 1
  `, [sessionHash]);
  const user = publicUser(result.rows[0], env);
  rememberSessionUser(sessionHash, env, user);
  return user;
}

async function createSession(client, env, githubUser) {
  const sessionTable = quoteIdent(env.MODEL_VERIFY_SESSION_TABLE || DEFAULT_SESSION_TABLE);
  const token = randomToken(32);
  const sessionHash = await sha256(token);
  const role = userRoleByGithubId(githubUser.id, env);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await client.query(`
    upsert into ${sessionTable} (session_hash, github_id, github_login, github_name, avatar_url, role, last_seen_at, expires_at)
    values ($1, $2, $3, $4, $5, $6, now(), $7)
  `, [
    sessionHash,
    String(githubUser.id || ''),
    String(githubUser.login || ''),
    String(githubUser.name || ''),
    String(githubUser.avatar_url || ''),
    role,
    expiresAt
  ]);
  const user = {
    githubId: String(githubUser.id || ''),
    login: String(githubUser.login || ''),
    name: String(githubUser.name || ''),
    avatarUrl: String(githubUser.avatar_url || ''),
    role
  };
  rememberSessionUser(sessionHash, env, user);
  return {
    token,
    user
  };
}

async function logoutSession(client, env, request) {
  const token = authTokenFromRequest(request);
  if (!token) return;
  const sessionTable = quoteIdent(env.MODEL_VERIFY_SESSION_TABLE || DEFAULT_SESSION_TABLE);
  const sessionHash = await sha256(token);
  forgetSessionUser(sessionHash, env);
  await client.query(`delete from ${sessionTable} where session_hash = $1`, [sessionHash]);
}

async function requireAdmin(client, env, request, payload = {}) {
  const user = await userFromSession(client, env, request);
  if (user?.role === 'admin') return user;
  if (await adminPasswordMatches(payload.adminPassword || payload.password, env)) {
    return { login: 'password-admin', role: 'admin' };
  }
  throw new HttpError(403, 'admin permission or delete password is required');
}

async function exchangeGitHubCode(code, env) {
  const clientId = String(env.GITHUB_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.GITHUB_OAUTH_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) throw new HttpError(503, 'GitHub login is not configured');

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code
    })
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    throw new HttpError(401, tokenPayload.error_description || tokenPayload.error || 'GitHub OAuth exchange failed');
  }

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'cybertar-model-verify-api'
    }
  });
  const user = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok || !user.login) throw new HttpError(401, 'GitHub user lookup failed');
  return user;
}

async function handleGitHubLogin(request, env) {
  const clientId = String(env.GITHUB_OAUTH_CLIENT_ID || '').trim();
  if (!clientId) return errorResponse(request, env, 503, 'GitHub login is not configured');
  const url = new URL(request.url);
  const state = randomToken(18);
  const returnTo = safeReturnTo(url.searchParams.get('return_to'), env, request);
  const redirectUri = String(env.GITHUB_OAUTH_REDIRECT_URI || new URL(AUTH_CALLBACK_PATH, request.url).toString());
  const target = new URL('https://github.com/login/oauth/authorize');
  target.searchParams.set('client_id', clientId);
  target.searchParams.set('redirect_uri', redirectUri);
  target.searchParams.set('scope', 'read:user');
  target.searchParams.set('state', state);
  return redirectResponse(target.toString(), {
    cookies: [
      cookie(OAUTH_COOKIE, state, { maxAge: 600 }),
      cookie(OAUTH_RETURN_COOKIE, returnTo, { maxAge: 600 })
    ]
  });
}

async function handleGitHubCallback(request, env) {
  const url = new URL(request.url);
  if (!url.searchParams.get('code') && !url.searchParams.get('state')) {
    return handleGitHubLogin(request, env);
  }
  const cookies = parseCookies(request);
  const state = url.searchParams.get('state') || '';
  if (!state || !cookies[OAUTH_COOKIE] || state !== cookies[OAUTH_COOKIE]) {
    return redirectResponse(`${siteUrl(env, request)}#mv_auth_error=oauth_state`);
  }
  const code = url.searchParams.get('code') || '';
  if (!code) return redirectResponse(`${siteUrl(env, request)}#mv_auth_error=missing_code`);
  try {
    const githubUser = await exchangeGitHubCode(code, env);
    const session = await withClient(env, async (client) => {
      await ensureSubmissionTablesCached(client, env);
      return createSession(client, env, githubUser);
    });
    const returnTo = safeReturnTo(cookies[OAUTH_RETURN_COOKIE], env, request);
    const redirect = new URL(returnTo);
    redirect.hash = `mv_auth_token=${encodeURIComponent(session.token)}`;
    return redirectResponse(redirect.toString(), {
      cookies: [
        cookie(OAUTH_COOKIE, '', { maxAge: 0 }),
        cookie(OAUTH_RETURN_COOKIE, '', { maxAge: 0 })
      ]
    });
  } catch (error) {
    return redirectResponse(`${siteUrl(env, request)}#mv_auth_error=${encodeURIComponent(error.message || 'github_login_failed')}`);
  }
}

async function findExistingReport(client, env, domain, targetModel) {
  const table = quoteIdent(env.MODEL_VERIFY_TABLE);
  const result = await client.query(`
    select domain, target_model, provider_name, homepage, shared_at::string as shared_at, report
    from ${table}
    where domain = $1 and target_model = $2
    limit 1
  `, [domain, targetModel]);
  return result.rows[0] ? normalizeSharedRow(result.rows[0]) : null;
}

async function upsertReportWithClient(client, env, item) {
  const table = quoteIdent(env.MODEL_VERIFY_TABLE);
  const result = await client.query(`
    upsert into ${table} (domain, target_model, provider_name, homepage, shared_at, report, updated_at)
    values ($1, $2, $3, $4, $5, $6::jsonb, now())
    returning domain, target_model, provider_name, homepage, shared_at::string as shared_at, report
  `, [
    item.domain,
    item.targetModel || reportStats(item.report).targetModel || 'unknown',
    item.providerName,
    item.homepage,
    item.sharedAt,
    JSON.stringify(item.report)
  ]);
  return normalizeSharedRow(result.rows[0]);
}

async function handleSharedReportSubmission(client, env, item, submitterHash) {
  const pendingTable = quoteIdent(env.MODEL_VERIFY_PENDING_TABLE || DEFAULT_PENDING_TABLE);
  const incomingStats = reportStats(item.report);
  const targetModel = incomingStats.targetModel || 'unknown';
  const pendingKey = `${item.domain}:${targetModel}:${submitterHash}`;
  item.targetModel = targetModel;
  const existing = await findExistingReport(client, env, item.domain, targetModel);
  const existingStats = existing ? reportStats(existing.report) : null;

  if (!existing) {
    const saved = await upsertReportWithClient(client, env, item);
    await client.query(`delete from ${pendingTable} where pending_key = $1`, [pendingKey]);
    return { status: 201, body: { ok: true, action: 'created', item: saved } };
  }

  if (incomingStats.score > existingStats.score) {
    const saved = await upsertReportWithClient(client, env, item);
    await client.query(`delete from ${pendingTable} where pending_key = $1`, [pendingKey]);
    return { status: 200, body: { ok: true, action: 'improved', item: saved, message: '提交成功，得分高于当前公开报告，已更新。' } };
  }

  if (incomingStats.score === existingStats.score) {
    const best = bestSharedItem([existing, item]);
    await client.query(`delete from ${pendingTable} where pending_key = $1`, [pendingKey]);
    if (best === existing) {
      return { status: 200, body: { ok: true, action: 'same_score_kept_existing', item: existing, message: '提交成功；得分与当前公开报告一致，已保留更可信版本。' } };
    }
    const saved = await upsertReportWithClient(client, env, item);
    return { status: 200, body: { ok: true, action: 'same_score_updated', item: saved, message: '提交成功；得分一致，已保存更可信版本。' } };
  }

  await client.query(`delete from ${pendingTable} where expires_at < now()`);
  const pending = await client.query(`
    select provider_name, homepage, report, score
    from ${pendingTable}
    where pending_key = $1
    limit 1
  `, [pendingKey]);

  if (!pending.rows.length) {
    await client.query(`
      upsert into ${pendingTable} (pending_key, domain, target_model, submitter_hash, provider_name, homepage, score, report, updated_at, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), $9)
    `, [
      pendingKey,
      item.domain,
      targetModel,
      submitterHash,
      item.providerName,
      item.homepage,
      incomingStats.score,
      JSON.stringify(item.report),
      new Date(Date.now() + PENDING_TTL_MS).toISOString()
    ]);
    throw new HttpError(409, '分享失败：本次分享得分低于当前公开报告，已暂存。请重新测试后再次提交，系统会对比两次提交与当前报告，保留更可信的一份。', {
      action: 'pending_review',
      currentScore: existingStats.score,
      submittedScore: incomingStats.score
    });
  }

  const pendingItem = {
    providerName: pending.rows[0].provider_name,
    homepage: pending.rows[0].homepage,
    domain: item.domain,
    targetModel,
    sharedAt: new Date().toISOString(),
    report: pending.rows[0].report
  };
  const best = bestSharedItem([existing, pendingItem, item]);
  await client.query(`delete from ${pendingTable} where pending_key = $1`, [pendingKey]);

  if (lowerScoresAreConfirmed(existing, pendingItem, item, env)) {
    const confirmed = bestSharedItem([pendingItem, item]);
    const saved = await upsertReportWithClient(client, env, confirmed);
    return { status: 200, body: { ok: true, action: 'confirmed_lower_score', item: saved, message: '二次提交已完成；两次复测结果接近，已用更可信的复测报告更新公开汇总。' } };
  }

  if (best === existing) {
    return { status: 200, body: { ok: true, action: 'kept_existing', item: existing, message: '二次提交已完成；当前公开报告仍是更可信版本，因此保持不变。' } };
  }

  const saved = await upsertReportWithClient(client, env, best);
  return { status: 200, body: { ok: true, action: best === item ? 'accepted_second' : 'accepted_pending', item: saved, message: '二次提交已完成，已保存更可信的报告。' } };
}

async function listReports(env, timing = null) {
  const table = quoteIdent(env.MODEL_VERIFY_TABLE);
  return withClient(env, async (client) => {
    if (skipReadSchemaEnsure(env)) {
      timing?.entries.push({ name: 'db_schema_skipped', duration: 0 });
    } else {
      const endSchema = timeSpan(timing, 'db_schema');
      await ensureSubmissionTablesCached(client, env);
      endSchema();
    }
    const endQuery = timeSpan(timing, 'db_query');
    const result = await client.query(`
      select domain, target_model, provider_name, homepage, shared_at::string as shared_at, report
      from ${table}
      order by shared_at desc
      limit 200
    `);
    endQuery();
    const endNormalize = timeSpan(timing, 'normalize');
    const items = result.rows.map(normalizeSharedRow);
    endNormalize();
    return items;
  }, timing);
}

async function deleteReportWithClient(client, env, domain, targetModel) {
  const table = quoteIdent(env.MODEL_VERIFY_TABLE);
  const result = await client.query(`
    delete from ${table}
    where domain = $1 and target_model = $2
    returning domain, target_model
  `, [domain, targetModel]);
  return result.rows.length > 0;
}

function normalizeDiscussionRow(row) {
  return {
    id: row.id || '',
    domain: row.domain || '',
    targetModel: row.target_model || '',
    body: row.body || '',
    author: {
      githubId: row.author_id || '',
      login: row.author_login || '',
      name: row.author_name || '',
      avatarUrl: row.author_avatar_url || ''
    },
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || ''
  };
}

async function listDiscussions(env, domain, targetModel, timing = null) {
  const discussionTable = quoteIdent(env.MODEL_VERIFY_DISCUSSION_TABLE || DEFAULT_DISCUSSION_TABLE);
  return withClient(env, async (client) => {
    if (skipReadSchemaEnsure(env)) {
      timing?.entries.push({ name: 'db_schema_skipped', duration: 0 });
    } else {
      const endSchema = timeSpan(timing, 'db_schema');
      await ensureSubmissionTablesCached(client, env);
      endSchema();
    }
    const endQuery = timeSpan(timing, 'db_query');
    const result = await client.query(`
      select id, domain, target_model, body, author_id, author_login, author_name, author_avatar_url,
             created_at::string as created_at, updated_at::string as updated_at
      from ${discussionTable}
      where domain = $1 and target_model = $2 and deleted_at is null
      order by created_at asc
      limit 200
    `, [domain, targetModel]);
    endQuery();
    const endNormalize = timeSpan(timing, 'normalize');
    const items = result.rows.map(normalizeDiscussionRow);
    endNormalize();
    return items;
  }, timing);
}

async function createDiscussionWithClient(client, env, request, payload) {
  const discussionTable = quoteIdent(env.MODEL_VERIFY_DISCUSSION_TABLE || DEFAULT_DISCUSSION_TABLE);
  const user = await userFromSession(client, env, request);
  if (!user) throw new HttpError(401, 'GitHub login is required');
  const domain = String(payload?.domain || '').trim().toLowerCase();
  const targetModel = String(payload?.targetModel || payload?.target_model || '').trim().toLowerCase();
  const body = cleanText(String(payload?.body || '').trim(), 2000);
  if (!domain || !targetModel) throw new HttpError(400, 'domain and targetModel are required');
  if (!body) throw new HttpError(400, 'discussion body is required');
  const id = crypto.randomUUID();
  const result = await client.query(`
    insert into ${discussionTable} (id, domain, target_model, body, author_id, author_login, author_name, author_avatar_url)
    values ($1, $2, $3, $4, $5, $6, $7, $8)
    returning id, domain, target_model, body, author_id, author_login, author_name, author_avatar_url,
              created_at::string as created_at, updated_at::string as updated_at
  `, [id, domain, targetModel, body, user.githubId, user.login, user.name, user.avatarUrl]);
  return normalizeDiscussionRow(result.rows[0]);
}

async function discussionTargetForCache(client, env, id) {
  const discussionTable = quoteIdent(env.MODEL_VERIFY_DISCUSSION_TABLE || DEFAULT_DISCUSSION_TABLE);
  const discussionId = String(id || '').trim();
  if (!discussionId) return null;
  const result = await client.query(`
    select domain, target_model
    from ${discussionTable}
    where id = $1
    limit 1
  `, [discussionId]);
  const row = result.rows[0];
  return row ? { domain: row.domain || '', targetModel: row.target_model || '' } : null;
}

async function deleteDiscussionWithClient(client, env, request, payload) {
  const discussionTable = quoteIdent(env.MODEL_VERIFY_DISCUSSION_TABLE || DEFAULT_DISCUSSION_TABLE);
  const user = await userFromSession(client, env, request);
  if (!user) throw new HttpError(401, 'GitHub login is required');
  const id = String(payload?.id || '').trim();
  if (!id) throw new HttpError(400, 'discussion id is required');
  const existing = await client.query(`
    select author_id
    from ${discussionTable}
    where id = $1 and deleted_at is null
    limit 1
  `, [id]);
  if (!existing.rows.length) throw new HttpError(404, 'discussion not found');
  if (user.role !== 'admin' && String(existing.rows[0].author_id || '').trim() !== String(user.githubId || '').trim()) {
    throw new HttpError(403, 'discussion can only be deleted by its author or admin');
  }
  await client.query(`update ${discussionTable} set deleted_at = now(), updated_at = now() where id = $1`, [id]);
  return true;
}

async function upsertReport(env, item) {
  return withClient(env, async (client) => {
    return upsertReportWithClient(client, env, item);
  });
}

export default {
  async fetch(request, env, ctx) {
    const timing = createTiming();
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const knownPaths = new Set([
      '/',
      REPORTS_PATH,
      MODEL_PROXY_PATH,
      DISCUSSIONS_PATH,
      AUTH_LOGIN_PATH,
      AUTH_CALLBACK_PATH,
      AUTH_ME_PATH,
      AUTH_LOGOUT_PATH
    ]);
    if (!knownPaths.has(pathname)) {
      return errorResponse(request, env, 404, 'not found');
    }

    try {
      if (pathname === AUTH_LOGIN_PATH) {
        if (request.method !== 'GET') return errorResponse(request, env, 405, 'method not allowed');
        return handleGitHubLogin(request, env);
      }

      if (pathname === AUTH_CALLBACK_PATH) {
        if (request.method !== 'GET') return errorResponse(request, env, 405, 'method not allowed');
        return handleGitHubCallback(request, env);
      }

      if (pathname === AUTH_ME_PATH) {
        if (request.method !== 'GET') return errorResponse(request, env, 405, 'method not allowed');
        const user = await withClient(env, async (client) => {
          await ensureSubmissionTablesCached(client, env);
          return userFromSession(client, env, request);
        });
        return json({ ok: true, user, siteOwner: siteOwner(env), siteOwnerId: siteOwnerId(env) }, { headers: corsHeaders(request, env) });
      }

      if (pathname === AUTH_LOGOUT_PATH) {
        if (request.method !== 'POST') return errorResponse(request, env, 405, 'method not allowed');
        await withClient(env, async (client) => {
          await ensureSubmissionTablesCached(client, env);
          return logoutSession(client, env, request);
        });
        return json({ ok: true }, { headers: corsHeaders(request, env) });
      }

      if (pathname === '/' && request.method === 'GET') {
        return json({
          ok: true,
          service: 'model-verify-api',
          version: 2,
          databaseConfigured: Boolean(env.HYPERDRIVE?.connectionString || env.DATABASE_URL),
          reportsEndpoint: REPORTS_PATH,
          proxyEndpoint: MODEL_PROXY_PATH,
          discussionsEndpoint: DISCUSSIONS_PATH,
          authEndpoint: AUTH_LOGIN_PATH,
          siteOwner: siteOwner(env),
          siteOwnerId: siteOwnerId(env)
        }, { headers: corsHeaders(request, env) });
      }

      if (pathname === MODEL_PROXY_PATH) {
        if (request.method !== 'POST') return errorResponse(request, env, 405, 'method not allowed');
        return proxyModelRequest(request, env);
      }

      if (pathname === DISCUSSIONS_PATH) {
        if (request.method === 'GET') {
          const domain = String(url.searchParams.get('domain') || '').trim().toLowerCase();
          const targetModel = String(url.searchParams.get('targetModel') || url.searchParams.get('target_model') || '').trim().toLowerCase();
          if (!domain || !targetModel) return errorResponse(request, env, 400, 'domain and targetModel are required');
          return cachedJson(request, env, ctx, 'discussions', async () => {
            const items = await listDiscussions(env, domain, targetModel, timing);
            return { ok: true, items };
          }, timing);
        }
        if (request.method === 'POST') {
          const payload = await request.json().catch(() => null);
          const item = await withClient(env, async (client) => {
            await ensureSubmissionTablesCached(client, env);
            return createDiscussionWithClient(client, env, request, payload);
          });
          const targetModel = String(payload?.targetModel || payload?.target_model || '').trim().toLowerCase();
          const cacheUrl = new URL(DISCUSSIONS_PATH, request.url);
          cacheUrl.searchParams.set('domain', String(payload?.domain || '').trim().toLowerCase());
          cacheUrl.searchParams.set('targetModel', targetModel);
          purgeCachedJson(request, env, ctx, cacheUrl.toString(), 'discussions');
          return json({ ok: true, item }, { status: 201, headers: corsHeaders(request, env) });
        }
        if (request.method === 'DELETE') {
          const payload = await request.json().catch(() => ({}));
          let cacheUrl = null;
          await withClient(env, async (client) => {
            await ensureSubmissionTablesCached(client, env);
            const existing = await discussionTargetForCache(client, env, payload?.id);
            if (existing) {
              cacheUrl = new URL(DISCUSSIONS_PATH, request.url);
              cacheUrl.searchParams.set('domain', existing.domain);
              cacheUrl.searchParams.set('targetModel', existing.targetModel);
            }
            return deleteDiscussionWithClient(client, env, request, payload);
          });
          if (cacheUrl) purgeCachedJson(request, env, ctx, cacheUrl.toString(), 'discussions');
          return json({ ok: true }, { headers: corsHeaders(request, env) });
        }
        return errorResponse(request, env, 405, 'method not allowed');
      }

      if (request.method === 'GET') {
        return cachedJson(request, env, ctx, 'reports', async () => {
          const items = await listReports(env, timing);
          return { version: 2, generatedAt: new Date().toISOString(), count: items.length, items };
        }, timing);
      }

      if (request.method === 'DELETE') {
        const payload = await request.json().catch(() => ({}));
        const domain = String(payload?.domain || url.searchParams.get('domain') || '').trim().toLowerCase();
        const targetModel = String(payload?.targetModel || payload?.target_model || url.searchParams.get('targetModel') || url.searchParams.get('target_model') || '').trim().toLowerCase();
        if (!domain || !targetModel) return errorResponse(request, env, 400, 'domain and targetModel are required');
        const deleted = await withClient(env, async (client) => {
          await ensureSubmissionTablesCached(client, env);
          await requireAdmin(client, env, request, payload);
          return deleteReportWithClient(client, env, domain, targetModel);
        });
        if (!deleted) return errorResponse(request, env, 404, 'report not found');
        purgeCachedJson(request, env, ctx, new URL(REPORTS_PATH, request.url).toString(), 'reports');
        return json({ ok: true, action: 'deleted', domain, targetModel }, { headers: corsHeaders(request, env) });
      }

      if (request.method === 'POST') {
        const payload = await request.json().catch(() => null);
        const validation = validatePayload(payload, env);
        if (validation.error) return errorResponse(request, env, 400, validation.error);
        const result = await withClient(env, async (client) => {
          await ensureSubmissionTablesCached(client, env);
          const submitterHash = await enforceSubmissionRateLimit(client, env, request);
          return handleSharedReportSubmission(client, env, validation.item, submitterHash);
        });
        purgeCachedJson(request, env, ctx, new URL(REPORTS_PATH, request.url).toString(), 'reports');
        return json(result.body, { status: result.status, headers: corsHeaders(request, env) });
      }

      return errorResponse(request, env, 405, 'method not allowed');
    } catch (error) {
      return json({
        ok: false,
        error: error.message || 'internal error',
        ...(error.extra || {})
      }, { status: error.status || 500, headers: corsHeaders(request, env) });
    }
  }
};
