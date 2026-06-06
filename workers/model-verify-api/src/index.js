import { Client } from 'pg';

const DEFAULT_MAX_REPORT_BYTES = 120000;
const DEFAULT_TABLE = 'model_verify_reports';
const DEFAULT_PENDING_TABLE = 'model_verify_pending_reports';
const DEFAULT_RATE_TABLE = 'model_verify_submission_limits';
const DEFAULT_SESSION_TABLE = 'model_verify_sessions';
const DEFAULT_DISCUSSION_TABLE = 'model_verify_discussions';
const MODEL_PROXY_PATH = '/model-verify-proxy';
const REPORTS_PATH = '/model-verify-reports';
const DISCUSSIONS_PATH = '/model-verify-discussions';
const AUTH_LOGIN_PATH = '/model-verify-auth/github/login';
const AUTH_CALLBACK_PATH = '/model-verify-auth/github/callback';
const AUTH_ME_PATH = '/model-verify-auth/me';
const AUTH_LOGOUT_PATH = '/model-verify-auth/logout';
const DEFAULT_PROXY_HOSTS = ['api.openai.com', 'api.anthropic.com'];
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_COOKIE = 'mv_oauth_state';
const OAUTH_RETURN_COOKIE = 'mv_oauth_return_to';

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

function quoteIdent(value) {
  return `"${String(value || DEFAULT_TABLE).replace(/"/g, '""')}"`;
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

function userRole(login, env) {
  return String(login || '').trim().toLowerCase() === siteOwner(env) ? 'admin' : 'user';
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
  if (!/^\/v1\/(models|responses|chat\/completions|messages)\/?$/i.test(target.pathname)) return false;
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

async function withClient(env, callback) {
  const client = new Client(connectionOptions(env));
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function primaryKeyIncludesTargetModel(client, table) {
  const result = await client.query(`show create table ${table}`);
  const statement = Object.values(result.rows[0] || {}).join('\n').toLowerCase();
  return /primary\s+key\s*\([^)]*domain[^)]*target_model/.test(statement);
}

async function ensureSubmissionTables(client, env) {
  const table = quoteIdent(env.MODEL_VERIFY_TABLE);
  const pendingTable = quoteIdent(env.MODEL_VERIFY_PENDING_TABLE || DEFAULT_PENDING_TABLE);
  const rateTable = quoteIdent(env.MODEL_VERIFY_RATE_TABLE || DEFAULT_RATE_TABLE);
  const sessionTable = quoteIdent(env.MODEL_VERIFY_SESSION_TABLE || DEFAULT_SESSION_TABLE);
  const discussionTable = quoteIdent(env.MODEL_VERIFY_DISCUSSION_TABLE || DEFAULT_DISCUSSION_TABLE);
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

function publicUser(row) {
  if (!row) return null;
  return {
    githubId: row.github_id || row.id || '',
    login: row.github_login || row.login || '',
    name: row.github_name || row.name || '',
    avatarUrl: row.avatar_url || row.avatar_url || '',
    role: row.role || 'user'
  };
}

async function userFromSession(client, env, request) {
  const token = authTokenFromRequest(request);
  if (!token) return null;
  const sessionTable = quoteIdent(env.MODEL_VERIFY_SESSION_TABLE || DEFAULT_SESSION_TABLE);
  const sessionHash = await sha256(token);
  const result = await client.query(`
    update ${sessionTable}
    set last_seen_at = now()
    where session_hash = $1 and expires_at > now()
    returning github_id, github_login, github_name, avatar_url, role
  `, [sessionHash]);
  return publicUser(result.rows[0]);
}

async function createSession(client, env, githubUser) {
  const sessionTable = quoteIdent(env.MODEL_VERIFY_SESSION_TABLE || DEFAULT_SESSION_TABLE);
  const token = randomToken(32);
  const role = userRole(githubUser.login, env);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await client.query(`
    upsert into ${sessionTable} (session_hash, github_id, github_login, github_name, avatar_url, role, last_seen_at, expires_at)
    values ($1, $2, $3, $4, $5, $6, now(), $7)
  `, [
    await sha256(token),
    String(githubUser.id || ''),
    String(githubUser.login || ''),
    String(githubUser.name || ''),
    String(githubUser.avatar_url || ''),
    role,
    expiresAt
  ]);
  return {
    token,
    user: {
      githubId: String(githubUser.id || ''),
      login: String(githubUser.login || ''),
      name: String(githubUser.name || ''),
      avatarUrl: String(githubUser.avatar_url || ''),
      role
    }
  };
}

async function logoutSession(client, env, request) {
  const token = authTokenFromRequest(request);
  if (!token) return;
  const sessionTable = quoteIdent(env.MODEL_VERIFY_SESSION_TABLE || DEFAULT_SESSION_TABLE);
  await client.query(`delete from ${sessionTable} where session_hash = $1`, [await sha256(token)]);
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
      await ensureSubmissionTables(client, env);
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

async function listReports(env) {
  const table = quoteIdent(env.MODEL_VERIFY_TABLE);
  return withClient(env, async (client) => {
    await ensureSubmissionTables(client, env);
    const result = await client.query(`
      select domain, target_model, provider_name, homepage, shared_at::string as shared_at, report
      from ${table}
      order by shared_at desc
      limit 200
    `);
    return result.rows.map(normalizeSharedRow);
  });
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

async function listDiscussions(env, domain, targetModel) {
  const discussionTable = quoteIdent(env.MODEL_VERIFY_DISCUSSION_TABLE || DEFAULT_DISCUSSION_TABLE);
  return withClient(env, async (client) => {
    await ensureSubmissionTables(client, env);
    const result = await client.query(`
      select id, domain, target_model, body, author_id, author_login, author_name, author_avatar_url,
             created_at::string as created_at, updated_at::string as updated_at
      from ${discussionTable}
      where domain = $1 and target_model = $2 and deleted_at is null
      order by created_at asc
      limit 200
    `, [domain, targetModel]);
    return result.rows.map(normalizeDiscussionRow);
  });
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

async function deleteDiscussionWithClient(client, env, request, payload) {
  const discussionTable = quoteIdent(env.MODEL_VERIFY_DISCUSSION_TABLE || DEFAULT_DISCUSSION_TABLE);
  const user = await userFromSession(client, env, request);
  if (!user) throw new HttpError(401, 'GitHub login is required');
  const id = String(payload?.id || '').trim();
  if (!id) throw new HttpError(400, 'discussion id is required');
  const existing = await client.query(`
    select author_login
    from ${discussionTable}
    where id = $1 and deleted_at is null
    limit 1
  `, [id]);
  if (!existing.rows.length) throw new HttpError(404, 'discussion not found');
  if (user.role !== 'admin' && String(existing.rows[0].author_login || '').toLowerCase() !== String(user.login || '').toLowerCase()) {
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
  async fetch(request, env) {
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
          await ensureSubmissionTables(client, env);
          return userFromSession(client, env, request);
        });
        return json({ ok: true, user, siteOwner: siteOwner(env) }, { headers: corsHeaders(request, env) });
      }

      if (pathname === AUTH_LOGOUT_PATH) {
        if (request.method !== 'POST') return errorResponse(request, env, 405, 'method not allowed');
        await withClient(env, async (client) => {
          await ensureSubmissionTables(client, env);
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
          siteOwner: siteOwner(env)
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
          const items = await listDiscussions(env, domain, targetModel);
          return json({ ok: true, items }, { headers: corsHeaders(request, env) });
        }
        if (request.method === 'POST') {
          const payload = await request.json().catch(() => null);
          const item = await withClient(env, async (client) => {
            await ensureSubmissionTables(client, env);
            return createDiscussionWithClient(client, env, request, payload);
          });
          return json({ ok: true, item }, { status: 201, headers: corsHeaders(request, env) });
        }
        if (request.method === 'DELETE') {
          const payload = await request.json().catch(() => ({}));
          await withClient(env, async (client) => {
            await ensureSubmissionTables(client, env);
            return deleteDiscussionWithClient(client, env, request, payload);
          });
          return json({ ok: true }, { headers: corsHeaders(request, env) });
        }
        return errorResponse(request, env, 405, 'method not allowed');
      }

      if (request.method === 'GET') {
        const items = await listReports(env);
        return json({ version: 2, generatedAt: new Date().toISOString(), count: items.length, items }, {
          headers: {
            ...corsHeaders(request, env),
            'cache-control': 'public, max-age=60'
          }
        });
      }

      if (request.method === 'DELETE') {
        const payload = await request.json().catch(() => ({}));
        const domain = String(payload?.domain || url.searchParams.get('domain') || '').trim().toLowerCase();
        const targetModel = String(payload?.targetModel || payload?.target_model || url.searchParams.get('targetModel') || url.searchParams.get('target_model') || '').trim().toLowerCase();
        if (!domain || !targetModel) return errorResponse(request, env, 400, 'domain and targetModel are required');
        const deleted = await withClient(env, async (client) => {
          await ensureSubmissionTables(client, env);
          await requireAdmin(client, env, request, payload);
          return deleteReportWithClient(client, env, domain, targetModel);
        });
        if (!deleted) return errorResponse(request, env, 404, 'report not found');
        return json({ ok: true, action: 'deleted', domain, targetModel }, { headers: corsHeaders(request, env) });
      }

      if (request.method === 'POST') {
        const payload = await request.json().catch(() => null);
        const validation = validatePayload(payload, env);
        if (validation.error) return errorResponse(request, env, 400, validation.error);
        const result = await withClient(env, async (client) => {
          await ensureSubmissionTables(client, env);
          const submitterHash = await enforceSubmissionRateLimit(client, env, request);
          return handleSharedReportSubmission(client, env, validation.item, submitterHash);
        });
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
