import { Client } from 'pg';

const DEFAULT_MAX_REPORT_BYTES = 120000;
const DEFAULT_TABLE = 'model_verify_reports';
const DEFAULT_PENDING_TABLE = 'model_verify_pending_reports';
const DEFAULT_RATE_TABLE = 'model_verify_submission_limits';
const DEFAULT_SESSION_TABLE = 'model_verify_sessions';
const DEFAULT_DISCUSSION_TABLE = 'model_verify_discussions';
const DEFAULT_STATS_TABLE = 'site_visit_stats';
const DEFAULT_ONLINE_TABLE = 'site_online_visitors';
const DEFAULT_EDGE_CACHE_TTL_SECONDS = 3600;
const DEFAULT_STALE_CACHE_TTL_SECONDS = 21600;
const DEFAULT_SESSION_USER_CACHE_TTL_SECONDS = 300;
const DEFAULT_ONLINE_WINDOW_SECONDS = 1800;
const MAX_MEMORY_CACHE_ENTRIES = 120;
const MAX_SESSION_CACHE_ENTRIES = 400;
const MODEL_PROXY_PATH = '/model-verify-proxy';
const REPORTS_PATH = '/model-verify-reports';
const DISCUSSIONS_PATH = '/model-verify-discussions';
const AUTH_LOGIN_PATH = '/model-verify-auth/github/login';
const AUTH_CALLBACK_PATH = '/model-verify-auth/github/callback';
const AUTH_ME_PATH = '/model-verify-auth/me';
const AUTH_LOGOUT_PATH = '/model-verify-auth/logout';
const SITE_STATS_PATH = '/site-stats';
const PROXY_AUDIT_HEADER = 'x-cybertar-proxy-audit';
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
const siteStatsMemory = {
  totalVisits: 0,
  onlineVisitors: new Map(),
  updatedAt: 0,
  syncedAt: 0
};

export class SiteStatsCounter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        create table if not exists stats (
          stat_key text primary key,
          total_visits integer not null default 0,
          db_total integer not null default 0,
          pending_visits integer not null default 0,
          seeded_at integer not null default 0,
          updated_at integer not null default 0
        )
      `);
      this.ctx.storage.sql.exec(`
        insert or ignore into stats (stat_key, total_visits, db_total, pending_visits, seeded_at, updated_at)
        values ('global', 0, 0, 0, 0, ?)
      `, Date.now());
      this.ctx.storage.sql.exec(`
        create table if not exists online_visitors (
          visitor_id text primary key,
          page_path text not null default '/',
          last_seen_at integer not null
        )
      `);
      this.ctx.storage.sql.exec(`create index if not exists online_visitors_seen_idx on online_visitors (last_seen_at)`);
    });
  }

  pruneOnlineVisitors() {
    const cutoff = Date.now() - onlineWindowSeconds(this.env) * 1000;
    this.ctx.storage.sql.exec(`delete from online_visitors where last_seen_at < ?`, cutoff);
  }

  statsRow() {
    return this.ctx.storage.sql.exec(`
      select total_visits, db_total, pending_visits, seeded_at, updated_at
      from stats
      where stat_key = 'global'
    `).one();
  }

  snapshot(source = 'durable_object') {
    this.pruneOnlineVisitors();
    const row = this.statsRow();
    const online = this.ctx.storage.sql.exec(`select count(*) as count from online_visitors`).one();
    const totalVisits = Math.max(0, Math.round(Number(row?.total_visits || 0)));
    return {
      totalVisits,
      totalVisitCount: totalVisits,
      onlineVisitors: Math.max(0, Math.round(Number(online?.count || 0))),
      onlineWindowSeconds: onlineWindowSeconds(this.env),
      updatedAt: row?.updated_at ? new Date(Number(row.updated_at)).toISOString() : new Date().toISOString(),
      source,
      durableSeeded: Boolean(Number(row?.seeded_at || 0)),
      pendingVisits: Math.max(0, Math.round(Number(row?.pending_visits || 0)))
    };
  }

  async getStats() {
    return this.snapshot();
  }

  async touch(input = {}) {
    const now = Date.now();
    if (String(input.event || 'view') === 'view') {
      this.ctx.storage.sql.exec(`
        update stats
        set total_visits = total_visits + 1,
            pending_visits = pending_visits + 1,
            updated_at = ?
        where stat_key = 'global'
      `, now);
    } else {
      this.ctx.storage.sql.exec(`update stats set updated_at = ? where stat_key = 'global'`, now);
    }
    const visitorId = String(input.visitorId || '').slice(0, 128);
    if (visitorId) {
      const pagePath = normalizePagePath(input.pagePath || '/').slice(0, 300);
      this.ctx.storage.sql.exec(`
        insert into online_visitors (visitor_id, page_path, last_seen_at)
        values (?, ?, ?)
        on conflict(visitor_id) do update set
          page_path = excluded.page_path,
          last_seen_at = excluded.last_seen_at
      `, visitorId, pagePath, now);
    }
    return this.snapshot();
  }

  async seedDatabaseTotal(input = {}) {
    const dbTotal = Math.max(0, Math.round(Number(input.totalVisits || input.totalVisitCount || 0)));
    const now = Date.now();
    const row = this.statsRow();
    const wasSeeded = Boolean(Number(row?.seeded_at || 0));
    const pending = Math.max(0, Math.round(Number(row?.pending_visits || 0)));
    let totalVisits;
    let pendingVisits = pending;
    if (!wasSeeded) {
      totalVisits = Math.max(Math.round(Number(row?.total_visits || 0)), dbTotal + pending);
    } else if (dbTotal >= Number(row?.total_visits || 0)) {
      totalVisits = dbTotal;
      pendingVisits = 0;
    } else {
      totalVisits = Math.max(Math.round(Number(row?.total_visits || 0)), dbTotal + pending);
    }
    this.ctx.storage.sql.exec(`
      update stats
      set total_visits = ?,
          db_total = max(db_total, ?),
          pending_visits = ?,
          seeded_at = case when seeded_at = 0 then ? else seeded_at end,
          updated_at = ?
      where stat_key = 'global'
    `, totalVisits, dbTotal, pendingVisits, now, now);
    return this.snapshot('database_seeded_durable_object');
  }

  async markDatabasePersisted(input = {}) {
    const persistedTotal = Math.max(0, Math.round(Number(input.totalVisits || input.totalVisitCount || 0)));
    const row = this.statsRow();
    const currentTotal = Math.max(0, Math.round(Number(row?.total_visits || 0)));
    if (persistedTotal >= currentTotal) {
      const now = Date.now();
      this.ctx.storage.sql.exec(`
        update stats
        set total_visits = ?,
            db_total = ?,
            pending_visits = 0,
            seeded_at = case when seeded_at = 0 then ? else seeded_at end,
            updated_at = ?
        where stat_key = 'global'
      `, persistedTotal, persistedTotal, now, now);
    }
    return this.snapshot('database_persisted_durable_object');
  }
}

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
    'access-control-expose-headers': `${PROXY_AUDIT_HEADER},server-timing`,
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

function siteStatsResponseTimeoutMs(env) {
  const configured = Number(env.SITE_STATS_RESPONSE_TIMEOUT_MS || 1200);
  if (!Number.isFinite(configured)) return 1200;
  return Math.max(250, Math.min(5000, Math.round(configured)));
}

function siteStatsInitialSyncTimeoutMs(env) {
  const configured = Number(env.SITE_STATS_INITIAL_SYNC_TIMEOUT_MS || 900);
  if (!Number.isFinite(configured)) return 900;
  return Math.max(150, Math.min(3000, Math.round(configured)));
}

function sessionUserCacheTtlSeconds(env) {
  const configured = Number(env.MODEL_VERIFY_SESSION_USER_CACHE_TTL_SECONDS || DEFAULT_SESSION_USER_CACHE_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_USER_CACHE_TTL_SECONDS;
  return Math.max(0, Math.min(3600, Math.round(configured)));
}

function onlineWindowSeconds(env) {
  const configured = Number(env.SITE_ONLINE_WINDOW_SECONDS || DEFAULT_ONLINE_WINDOW_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_ONLINE_WINDOW_SECONDS;
  return Math.max(60, Math.min(86400, Math.round(configured)));
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

function cacheRefreshRequested(request) {
  const url = new URL(request.url);
  const value = url.searchParams.get('_refresh') || url.searchParams.get('refresh');
  return value !== null && value !== '0' && value !== 'false';
}

function normalizedCacheUrl(urlValue, baseUrl) {
  const url = new URL(urlValue, baseUrl);
  url.searchParams.delete('_refresh');
  url.searchParams.delete('refresh');
  return url.toString();
}

function cacheKeyForUrl(request, urlValue, tag, origin = request.headers.get('origin') || '') {
  const url = new URL(normalizedCacheUrl(urlValue, request.url));
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
  const forceRefresh = cacheRefreshRequested(request);
  if (forceRefresh) {
    return produceCachedJson(request, env, ctx, tag, memoryKey, edgeKey, producer, 'refresh', timing);
  }
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

function proxyAuditHeaderValue(audit) {
  return encodeURIComponent(JSON.stringify(audit));
}

function safeProxyResponseHeaders(upstream, request, env, audit) {
  const headers = new Headers(corsHeaders(request, env));
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-store');
  headers.set(PROXY_AUDIT_HEADER, proxyAuditHeaderValue(audit));
  return headers;
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

  const upstreamHeaders = {
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    ...apiAuthHeaders(provider, apiKey)
  };
  const body = method === 'POST' ? (payload?.body || {}) : null;
  const audit = {
    proxied: true,
    method,
    provider,
    targetHost: target.hostname,
    targetPath: target.pathname,
    upstreamHeaderNames: Object.keys(upstreamHeaders).map((item) => item.toLowerCase()).sort(),
    bodyKeyNames: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).slice(0, 30) : []
  };
  const upstream = await fetch(target.toString(), {
    method,
    headers: upstreamHeaders,
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: safeProxyResponseHeaders(upstream, request, env, audit)
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

function normalizePagePath(value) {
  const raw = String(value || '/').trim();
  try {
    const url = raw.startsWith('http') ? new URL(raw) : new URL(raw, 'https://cybertar.local');
    return `/${url.pathname.replace(/^\/+/, '')}`.replace(/\/index\.html$/i, '/') || '/';
  } catch {
    const path = raw.split(/[?#]/)[0].replace(/^https?:\/\/[^/]+/i, '');
    return `/${path.replace(/^\/+/, '')}`.replace(/\/index\.html$/i, '/') || '/';
  }
}

function visitorIdFromRequest(request, payload) {
  const provided = String(payload?.visitorId || payload?.visitor_id || '').trim();
  if (/^[a-zA-Z0-9_-]{12,80}$/.test(provided)) return provided;
  return '';
}

function pruneSiteStatsMemory(env) {
  const cutoff = Date.now() - onlineWindowSeconds(env) * 1000;
  for (const [visitorId, lastSeenAt] of siteStatsMemory.onlineVisitors) {
    if (!visitorId || Number(lastSeenAt || 0) < cutoff) siteStatsMemory.onlineVisitors.delete(visitorId);
  }
}

function siteStatsMemorySnapshot(env) {
  pruneSiteStatsMemory(env);
  const totalVisits = Math.max(0, Math.round(Number(siteStatsMemory.totalVisits || 0)));
  return {
    totalVisits,
    totalVisitCount: totalVisits,
    onlineVisitors: siteStatsMemory.onlineVisitors.size,
    onlineWindowSeconds: onlineWindowSeconds(env),
    updatedAt: siteStatsMemory.updatedAt ? new Date(siteStatsMemory.updatedAt).toISOString() : new Date().toISOString(),
    source: 'memory_fallback'
  };
}

function syncSiteStatsMemory(env, stats) {
  const totalVisits = Number(stats?.totalVisits ?? stats?.totalVisitCount);
  if (Number.isFinite(totalVisits)) {
    siteStatsMemory.totalVisits = Math.max(siteStatsMemory.totalVisits, Math.round(totalVisits));
  }
  siteStatsMemory.updatedAt = Date.now();
  siteStatsMemory.syncedAt = Date.now();
  return {
    ...siteStatsMemorySnapshot(env),
    ...stats,
    totalVisits: Math.max(siteStatsMemory.totalVisits, Math.round(Number(stats?.totalVisits || 0))),
    totalVisitCount: Math.max(siteStatsMemory.totalVisits, Math.round(Number(stats?.totalVisitCount || stats?.totalVisits || 0))),
    onlineVisitors: Math.max(siteStatsMemory.onlineVisitors.size, Math.round(Number(stats?.onlineVisitors || 0))),
    source: stats?.source || 'database'
  };
}

async function touchSiteStatsMemory(env, request, payload, options = {}) {
  const eventName = String(payload?.event || 'view');
  if (eventName === 'view' && options.incrementVisit !== false) siteStatsMemory.totalVisits += 1;
  const rawVisitorId = visitorIdFromRequest(request, payload) || `${clientIp(request)}:${request.headers.get('user-agent') || ''}`;
  const visitorId = await sha256(rawVisitorId);
  siteStatsMemory.onlineVisitors.set(visitorId, Date.now());
  siteStatsMemory.updatedAt = Date.now();
  return siteStatsMemorySnapshot(env);
}

function siteStatsCounterStub(env) {
  return env.SITE_STATS_COUNTER?.getByName?.('global');
}

async function durableSiteStatsSnapshot(env) {
  const stub = siteStatsCounterStub(env);
  if (!stub) return siteStatsMemorySnapshot(env);
  return stub.getStats();
}

async function seedDurableSiteStats(env, stats) {
  const stub = siteStatsCounterStub(env);
  if (!stub) return stats;
  const seeded = await stub.seedDatabaseTotal({
    totalVisits: stats?.totalVisits,
    totalVisitCount: stats?.totalVisitCount
  });
  syncSiteStatsMemory(env, seeded);
  return seeded;
}

async function markDurableSiteStatsPersisted(env, stats) {
  const stub = siteStatsCounterStub(env);
  if (!stub) return stats;
  const persisted = await stub.markDatabasePersisted({
    totalVisits: stats?.totalVisits,
    totalVisitCount: stats?.totalVisitCount
  });
  syncSiteStatsMemory(env, persisted);
  return persisted;
}

async function touchDurableSiteStats(env, request, payload) {
  const rawVisitorId = visitorIdFromRequest(request, payload) || `${clientIp(request)}:${request.headers.get('user-agent') || ''}`;
  const visitorId = await sha256(rawVisitorId);
  const stub = siteStatsCounterStub(env);
  if (!stub) return touchSiteStatsMemory(env, request, payload);
  const stats = await stub.touch({
    event: String(payload?.event || 'view'),
    pagePath: normalizePagePath(payload?.page || payload?.path || '/').slice(0, 300),
    visitorId
  });
  syncSiteStatsMemory(env, stats);
  return stats;
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
    evidencePenalty: Number(channel.evidencePenalty || 0),
    scoreAdjustments: asArray(channel.scoreAdjustments).map((adjustment) => ({
      penalty: Number(adjustment.penalty || 0),
      code: cleanText(adjustment.code, 80),
      severity: cleanText(adjustment.severity, 40),
      reason: cleanText(adjustment.reason, 160)
    })).slice(0, 12),
    qualityGates: asArray(channel.qualityGates).map((gate) => ({
      code: cleanText(gate.code, 80),
      passed: Boolean(gate.passed),
      reason: cleanText(gate.reason, 180)
    })).slice(0, 12),
    scoreCaps: asArray(channel.scoreCaps).map((cap) => ({
      cap: Number(cap.cap || 0),
      code: cleanText(cap.code, 80),
      severity: cleanText(cap.severity, 40),
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
        preview: cleanText(probe.result.preview || probe.result.error, 700),
        retriedWithoutReasoning: Boolean(probe.result.retriedWithoutReasoning),
        retriedWithLowerMaxTokens: Number(probe.result.retriedWithLowerMaxTokens || 0),
        criticalSafetyIssue: Boolean(probe.result.criticalSafetyIssue),
        harmfulContentEvidence: Boolean(probe.result.harmfulContentEvidence),
        criticalCredentialIssue: Boolean(probe.result.criticalCredentialIssue),
        credentialCanaryLeakEvidence: Boolean(probe.result.credentialCanaryLeakEvidence),
        promptLeakEvidence: Boolean(probe.result.promptLeakEvidence),
        promptInjectionEvidence: Boolean(probe.result.promptInjectionEvidence),
        illegalRequestHeaderEvidence: Boolean(probe.result.illegalRequestHeaderEvidence),
        encryptedContentError: Boolean(probe.result.encryptedContentError),
        parseFailure: Boolean(probe.result.parseFailure),
        modelIdentityMismatch: Boolean(probe.result.modelIdentityMismatch),
        modelListConflict: Boolean(probe.result.modelListConflict),
        safetyBoundaryUnclear: Boolean(probe.result.safetyBoundaryUnclear),
        requestChainIntegrityIssue: Boolean(probe.result.requestChainIntegrityIssue),
        adaptiveModelSwitchEvidence: Boolean(probe.result.adaptiveModelSwitchEvidence),
        adaptiveProtocolSwitchEvidence: Boolean(probe.result.adaptiveProtocolSwitchEvidence),
        safetyPolicyBlocked: Boolean(probe.result.safetyPolicyBlocked),
        requestAudit: probe.result.requestAudit ? walkAndRedact({
          channel: probe.result.requestAudit.channel,
          proxied: probe.result.requestAudit.proxied,
          proxyAuditPresent: probe.result.requestAudit.proxyAuditPresent,
          targetHost: probe.result.requestAudit.targetHost,
          targetPath: probe.result.requestAudit.targetPath,
          browserHeaderNames: asArray(probe.result.requestAudit.browserHeaderNames).slice(0, 12),
          expectedUpstreamHeaderNames: asArray(probe.result.requestAudit.expectedUpstreamHeaderNames).slice(0, 12),
          upstreamHeaderNames: asArray(probe.result.requestAudit.upstreamHeaderNames).slice(0, 12),
          disallowedUpstreamHeaderNames: asArray(probe.result.requestAudit.disallowedUpstreamHeaderNames).slice(0, 12),
          bodyKeyNames: asArray(probe.result.requestAudit.bodyKeyNames).slice(0, 20),
          bodyCredentialFieldPresent: Boolean(probe.result.requestAudit.bodyCredentialFieldPresent),
          bodyHeaderFieldPresent: Boolean(probe.result.requestAudit.bodyHeaderFieldPresent),
          auditWarnings: asArray(probe.result.requestAudit.auditWarnings).slice(0, 8)
        }) : undefined
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
    submitter: {
      githubId: row.submitter_github_id || '',
      login: row.submitter_login || '',
      name: row.submitter_name || '',
      avatarUrl: row.submitter_avatar_url || ''
    },
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

async function withStatementTimeout(client, ms, callback) {
  const timeout = Math.max(1000, Math.min(15000, Number(ms) || 5000));
  try {
    await client.query(`set statement_timeout = ${timeout}`);
    return await callback();
  } finally {
    await client.query('reset statement_timeout').catch(() => null);
  }
}

function withTimeout(promise, ms, message = 'operation timed out') {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function schemaKey(env) {
  return [
    tableName(env, 'MODEL_VERIFY_TABLE', DEFAULT_TABLE),
    tableName(env, 'MODEL_VERIFY_PENDING_TABLE', DEFAULT_PENDING_TABLE),
    tableName(env, 'MODEL_VERIFY_RATE_TABLE', DEFAULT_RATE_TABLE),
    tableName(env, 'MODEL_VERIFY_SESSION_TABLE', DEFAULT_SESSION_TABLE),
    tableName(env, 'MODEL_VERIFY_DISCUSSION_TABLE', DEFAULT_DISCUSSION_TABLE),
    tableName(env, 'SITE_STATS_TABLE', DEFAULT_STATS_TABLE),
    tableName(env, 'SITE_ONLINE_TABLE', DEFAULT_ONLINE_TABLE)
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

async function ensureSiteStatsTables(client, env) {
  const statsTableName = tableName(env, 'SITE_STATS_TABLE', DEFAULT_STATS_TABLE);
  const onlineTableName = tableName(env, 'SITE_ONLINE_TABLE', DEFAULT_ONLINE_TABLE);
  const statsTable = quoteIdent(statsTableName);
  const onlineTable = quoteIdent(onlineTableName);
  await client.query(`
    create table if not exists ${statsTable} (
      stat_key string primary key,
      total_count int8 not null default 0,
      updated_at timestamptz not null default now()
    )
  `);
  await client.query(`
    create table if not exists ${onlineTable} (
      visitor_id string primary key,
      page_path string not null default '/',
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    )
  `);
  await client.query(`create index if not exists ${quoteIdent(`${onlineTableName}_last_seen_idx`)} on ${onlineTable} (last_seen_at)`);
}

function isMissingStatsTableError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === '42P01' || /relation .* does not exist|table .* does not exist|undefined_table/.test(message);
}

async function siteStatsWithTableRepair(client, env, callback) {
  try {
    return await callback();
  } catch (error) {
    if (!isMissingStatsTableError(error)) throw error;
    await ensureSiteStatsTables(client, env);
    return callback();
  }
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
  const statsTableName = tableName(env, 'SITE_STATS_TABLE', DEFAULT_STATS_TABLE);
  const onlineTableName = tableName(env, 'SITE_ONLINE_TABLE', DEFAULT_ONLINE_TABLE);
  const table = quoteIdent(reportTableName);
  const pendingTable = quoteIdent(pendingTableName);
  const rateTable = quoteIdent(rateTableName);
  const sessionTable = quoteIdent(sessionTableName);
  const discussionTable = quoteIdent(discussionTableName);
  const statsTable = quoteIdent(statsTableName);
  const onlineTable = quoteIdent(onlineTableName);
  await client.query(`
    create table if not exists ${table} (
      domain string not null,
      target_model string not null default '',
      provider_name string not null,
      homepage string not null,
      shared_at timestamptz not null default now(),
      submitter_github_id string not null default '',
      submitter_login string not null default '',
      submitter_name string not null default '',
      submitter_avatar_url string not null default '',
      report jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (domain, target_model)
    )
  `);
  await client.query(`alter table ${table} add column if not exists target_model string not null default ''`);
  await client.query(`alter table ${table} add column if not exists submitter_github_id string not null default ''`);
  await client.query(`alter table ${table} add column if not exists submitter_login string not null default ''`);
  await client.query(`alter table ${table} add column if not exists submitter_name string not null default ''`);
  await client.query(`alter table ${table} add column if not exists submitter_avatar_url string not null default ''`);
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
      submitter_github_id string not null default '',
      submitter_login string not null default '',
      submitter_name string not null default '',
      submitter_avatar_url string not null default '',
      report jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `);
  await client.query(`alter table ${pendingTable} add column if not exists submitter_github_id string not null default ''`);
  await client.query(`alter table ${pendingTable} add column if not exists submitter_login string not null default ''`);
  await client.query(`alter table ${pendingTable} add column if not exists submitter_name string not null default ''`);
  await client.query(`alter table ${pendingTable} add column if not exists submitter_avatar_url string not null default ''`);
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
  await client.query(`
    create table if not exists ${statsTable} (
      stat_key string primary key,
      total_count int8 not null default 0,
      updated_at timestamptz not null default now()
    )
  `);
  await client.query(`
    create table if not exists ${onlineTable} (
      visitor_id string primary key,
      page_path string not null default '/',
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    )
  `);
  await client.query(`create index if not exists ${quoteIdent(`${reportTableName}_shared_at_idx`)} on ${table} (shared_at desc)`);
  await client.query(`create index if not exists ${quoteIdent(`${pendingTableName}_expires_at_idx`)} on ${pendingTable} (expires_at)`);
  await client.query(`create index if not exists ${quoteIdent(`${rateTableName}_updated_at_idx`)} on ${rateTable} (updated_at)`);
  await client.query(`create index if not exists ${quoteIdent(`${discussionTableName}_lookup_idx`)} on ${discussionTable} (domain, target_model, deleted_at, created_at)`);
  await client.query(`create index if not exists ${quoteIdent(`${onlineTableName}_last_seen_idx`)} on ${onlineTable} (last_seen_at)`);
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

async function readSiteStats(client, env) {
  const statsTable = quoteIdent(env.SITE_STATS_TABLE || DEFAULT_STATS_TABLE);
  const onlineTable = quoteIdent(env.SITE_ONLINE_TABLE || DEFAULT_ONLINE_TABLE);
  const onlineWindow = onlineWindowSeconds(env);
  const onlineCutoff = new Date(Date.now() - onlineWindow * 1000).toISOString();
  return withStatementTimeout(client, env.SITE_STATS_QUERY_TIMEOUT_MS || 5000, async () => {
    const statsResult = await client.query(`select total_count from ${statsTable} where stat_key = 'global' limit 1`);
    const onlineResult = await client.query(`select count(*)::int as online_count from ${onlineTable} where last_seen_at >= $1`, [onlineCutoff]);
    const totalVisits = Number(statsResult.rows[0]?.total_count || 0);
    return syncSiteStatsMemory(env, {
      totalVisits,
      totalVisitCount: totalVisits,
      onlineVisitors: Number(onlineResult.rows[0]?.online_count || 0),
      onlineWindowSeconds: onlineWindow,
      updatedAt: new Date().toISOString()
    });
  });
}

async function recordSiteVisit(client, env, request, payload, options = {}) {
  const statsTable = quoteIdent(env.SITE_STATS_TABLE || DEFAULT_STATS_TABLE);
  const onlineTable = quoteIdent(env.SITE_ONLINE_TABLE || DEFAULT_ONLINE_TABLE);
  const rawVisitorId = visitorIdFromRequest(request, payload) || `${clientIp(request)}:${request.headers.get('user-agent') || ''}`;
  const visitorId = await sha256(rawVisitorId);
  const pagePath = normalizePagePath(payload?.page || payload?.path || '/').slice(0, 300);
  const memoryStats = options.touchMemory === false ? siteStatsMemorySnapshot(env) : await touchSiteStatsMemory(env, request, payload);
  await withStatementTimeout(client, env.SITE_STATS_QUERY_TIMEOUT_MS || 5000, async () => {
    if (String(payload?.event || 'view') === 'view') {
      await client.query(`
        upsert into ${statsTable} as current_stats (stat_key, total_count, updated_at)
        values ('global', 1, now())
        on conflict (stat_key) do update
          set total_count = current_stats.total_count + 1,
              updated_at = now()
      `);
    }
    await client.query(`
      upsert into ${onlineTable} (visitor_id, page_path, first_seen_at, last_seen_at)
      values ($1, $2, now(), now())
      on conflict (visitor_id) do update
        set page_path = excluded.page_path,
            last_seen_at = now()
    `, [visitorId, pagePath]);
  });
  try {
    return await readSiteStats(client, env);
  } catch {
    return memoryStats;
  }
}

async function mirrorSiteStatsSnapshot(client, env, request, payload, stats) {
  const statsTable = quoteIdent(env.SITE_STATS_TABLE || DEFAULT_STATS_TABLE);
  const onlineTable = quoteIdent(env.SITE_ONLINE_TABLE || DEFAULT_ONLINE_TABLE);
  const totalVisits = Math.max(0, Math.round(Number(stats?.totalVisits || stats?.totalVisitCount || 0)));
  return withStatementTimeout(client, env.SITE_STATS_QUERY_TIMEOUT_MS || 5000, async () => {
    const result = await client.query(`
      insert into ${statsTable} as current_stats (stat_key, total_count, updated_at)
      values ('global', $1, now())
      on conflict (stat_key) do update
        set total_count = case
              when current_stats.total_count < excluded.total_count then excluded.total_count
              else current_stats.total_count
            end,
            updated_at = now()
      returning total_count
    `, [totalVisits]);
    if (request && payload) {
      const rawVisitorId = visitorIdFromRequest(request, payload) || `${clientIp(request)}:${request.headers.get('user-agent') || ''}`;
      const visitorId = await sha256(rawVisitorId);
      const pagePath = normalizePagePath(payload?.page || payload?.path || '/').slice(0, 300);
      await client.query(`
        upsert into ${onlineTable} (visitor_id, page_path, first_seen_at, last_seen_at)
        values ($1, $2, now(), now())
        on conflict (visitor_id) do update
          set page_path = excluded.page_path,
              last_seen_at = now()
      `, [visitorId, pagePath]);
    }
    const persistedTotal = Number(result.rows[0]?.total_count || totalVisits);
    return {
      ...stats,
      totalVisits: persistedTotal,
      totalVisitCount: persistedTotal,
      updatedAt: new Date().toISOString(),
      source: 'database_mirrored_durable_object'
    };
  });
}

async function bootstrapDurableSiteStatsFromDatabase(env) {
  const snapshot = await durableSiteStatsSnapshot(env);
  if (snapshot.durableSeeded && snapshot.pendingVisits <= 0) return snapshot;
  return withClient(env, async (client) => {
    const databaseStats = await siteStatsWithTableRepair(client, env, () => readSiteStats(client, env));
    return seedDurableSiteStats(env, databaseStats);
  });
}

async function mirrorDurableSiteStatsToDatabase(env, request = null, payload = null, currentStats = null) {
  let stats = currentStats || await durableSiteStatsSnapshot(env);
  if (!stats.durableSeeded || Number(stats.pendingVisits || 0) > 0) {
    try {
      stats = await bootstrapDurableSiteStatsFromDatabase(env);
    } catch {
      return stats;
    }
  }
  if (!stats.durableSeeded) return stats;
  return withClient(env, async (client) => {
    const mirrored = await siteStatsWithTableRepair(client, env, () => mirrorSiteStatsSnapshot(client, env, request, payload, stats));
    return markDurableSiteStatsPersisted(env, mirrored);
  });
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
    select domain, target_model, provider_name, homepage, shared_at::string as shared_at,
           submitter_github_id, submitter_login, submitter_name, submitter_avatar_url, report
    from ${table}
    where domain = $1 and target_model = $2
    limit 1
  `, [domain, targetModel]);
  return result.rows[0] ? normalizeSharedRow(result.rows[0]) : null;
}

async function upsertReportWithClient(client, env, item) {
  const table = quoteIdent(env.MODEL_VERIFY_TABLE);
  const submitter = item.submitter || {};
  const result = await client.query(`
    upsert into ${table} (
      domain, target_model, provider_name, homepage, shared_at,
      submitter_github_id, submitter_login, submitter_name, submitter_avatar_url,
      report, updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
    returning domain, target_model, provider_name, homepage, shared_at::string as shared_at,
              submitter_github_id, submitter_login, submitter_name, submitter_avatar_url, report
  `, [
    item.domain,
    item.targetModel || reportStats(item.report).targetModel || 'unknown',
    item.providerName,
    item.homepage,
    item.sharedAt,
    String(submitter.githubId || ''),
    String(submitter.login || ''),
    String(submitter.name || ''),
    String(submitter.avatarUrl || ''),
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
    select provider_name, homepage, report, score,
           submitter_github_id, submitter_login, submitter_name, submitter_avatar_url
    from ${pendingTable}
    where pending_key = $1
    limit 1
  `, [pendingKey]);

  if (!pending.rows.length) {
    await client.query(`
      upsert into ${pendingTable} (
        pending_key, domain, target_model, submitter_hash, provider_name, homepage, score,
        submitter_github_id, submitter_login, submitter_name, submitter_avatar_url,
        report, updated_at, expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now(), $13)
    `, [
      pendingKey,
      item.domain,
      targetModel,
      submitterHash,
      item.providerName,
      item.homepage,
      incomingStats.score,
      String(item.submitter?.githubId || ''),
      String(item.submitter?.login || ''),
      String(item.submitter?.name || ''),
      String(item.submitter?.avatarUrl || ''),
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
    submitter: {
      githubId: pending.rows[0].submitter_github_id || '',
      login: pending.rows[0].submitter_login || '',
      name: pending.rows[0].submitter_name || '',
      avatarUrl: pending.rows[0].submitter_avatar_url || ''
    },
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
      select domain, target_model, provider_name, homepage, shared_at::string as shared_at,
             submitter_github_id, submitter_login, submitter_name, submitter_avatar_url, report
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

async function deleteReportWithClient(client, env, domain, targetModels) {
  const table = quoteIdent(env.MODEL_VERIFY_TABLE);
  const candidates = [...new Set(asArray(targetModels)
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean))];
  for (const targetModel of candidates) {
    const result = await client.query(`
      delete from ${table}
      where domain = $1 and target_model = $2
      returning domain, target_model
    `, [domain, targetModel]);
    if (result.rows.length > 0) {
      return {
        domain: result.rows[0].domain || domain,
        targetModel: result.rows[0].target_model || targetModel
      };
    }
  }
  return null;
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
      AUTH_LOGOUT_PATH,
      SITE_STATS_PATH
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

      if (pathname === SITE_STATS_PATH) {
        if (request.method === 'GET') {
          const fallbackStats = await durableSiteStatsSnapshot(env).catch(() => siteStatsMemorySnapshot(env));
          const needsSync = !fallbackStats.durableSeeded || Number(fallbackStats.pendingVisits || 0) > 0;
          const syncPromise = mirrorDurableSiteStatsToDatabase(env);
          ctx?.waitUntil?.(withTimeout(syncPromise, siteStatsResponseTimeoutMs(env), 'site stats mirror timed out').catch(() => null));
          const stats = needsSync
            ? await withTimeout(syncPromise, siteStatsInitialSyncTimeoutMs(env), 'initial site stats mirror timed out').catch(() => fallbackStats)
            : fallbackStats;
          return json({ ok: true, stats }, { headers: corsHeaders(request, env) });
        }
        if (request.method === 'POST') {
          const payload = await request.json().catch(() => ({}));
          const beforeStats = await durableSiteStatsSnapshot(env).catch(() => siteStatsMemorySnapshot(env));
          if (!beforeStats.durableSeeded) {
            await withTimeout(bootstrapDurableSiteStatsFromDatabase(env), siteStatsInitialSyncTimeoutMs(env), 'initial site stats bootstrap timed out').catch(() => null);
          }
          const stats = await touchDurableSiteStats(env, request, payload).catch(() => touchSiteStatsMemory(env, request, payload));
          const syncPromise = mirrorDurableSiteStatsToDatabase(env, request, payload, stats);
          ctx?.waitUntil?.(withTimeout(syncPromise, siteStatsResponseTimeoutMs(env), 'site stats mirror timed out').catch(() => null));
          return json({ ok: true, stats }, { headers: corsHeaders(request, env) });
        }
        return errorResponse(request, env, 405, 'method not allowed');
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
          statsEndpoint: SITE_STATS_PATH,
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
        const targetModels = [...new Set([
          targetModel,
          ...asArray(payload?.targetModels || payload?.target_models)
        ].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
        if (!domain || !targetModels.length) return errorResponse(request, env, 400, 'domain and targetModel are required');
        const deleted = await withClient(env, async (client) => {
          await ensureSubmissionTablesCached(client, env);
          await requireAdmin(client, env, request, payload);
          return deleteReportWithClient(client, env, domain, targetModels);
        });
        if (!deleted) return errorResponse(request, env, 404, 'report not found');
        purgeCachedJson(request, env, ctx, new URL(REPORTS_PATH, request.url).toString(), 'reports');
        return json({ ok: true, action: 'deleted', domain: deleted.domain, targetModel: deleted.targetModel }, { headers: corsHeaders(request, env) });
      }

      if (request.method === 'POST') {
        const payload = await request.json().catch(() => null);
        const validation = validatePayload(payload, env);
        if (validation.error) return errorResponse(request, env, 400, validation.error);
        const result = await withClient(env, async (client) => {
          await ensureSubmissionTablesCached(client, env);
          const submitter = await userFromSession(client, env, request);
          if (submitter) {
            validation.item.submitter = {
              githubId: submitter.githubId || '',
              login: submitter.login || '',
              name: submitter.name || '',
              avatarUrl: submitter.avatarUrl || ''
            };
          }
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
