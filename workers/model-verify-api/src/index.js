import { Client } from 'pg';

const DEFAULT_MAX_REPORT_BYTES = 120000;
const DEFAULT_TABLE = 'model_verify_reports';
const DEFAULT_PENDING_TABLE = 'model_verify_pending_reports';
const DEFAULT_RATE_TABLE = 'model_verify_submission_limits';
const MODEL_PROXY_PATH = '/model-verify-proxy';
const REPORTS_PATH = '/model-verify-reports';
const DEFAULT_PROXY_HOSTS = ['api.openai.com', 'api.anthropic.com'];
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

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
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
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
    if (pathname !== '/' && pathname !== REPORTS_PATH && pathname !== MODEL_PROXY_PATH) {
      return errorResponse(request, env, 404, 'not found');
    }

    try {
      if (pathname === '/' && request.method === 'GET') {
        return json({
          ok: true,
          service: 'model-verify-api',
          version: 2,
          databaseConfigured: Boolean(env.HYPERDRIVE?.connectionString || env.DATABASE_URL),
          reportsEndpoint: REPORTS_PATH,
          proxyEndpoint: MODEL_PROXY_PATH
        }, { headers: corsHeaders(request, env) });
      }

      if (pathname === MODEL_PROXY_PATH) {
        if (request.method !== 'POST') return errorResponse(request, env, 405, 'method not allowed');
        return proxyModelRequest(request, env);
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
