const fs = require('fs');
const path = require('path');

const outputPath = path.resolve(__dirname, '..', 'feeds', 'model-verify-reports.json');
const cockroachConfigured = Boolean(
  process.env.MODEL_VERIFY_COCKROACH_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.MODEL_VERIFY_COCKROACH_PASSWORD ||
  process.env.COCKROACHLABS_CLOUD_DB1
);
const sourceType = (process.env.MODEL_VERIFY_FEED_SOURCE || process.env.MODEL_VERIFY_SHARE_TYPE || (cockroachConfigured ? 'cockroach' : 'supabase')).toLowerCase();
const supabaseUrl = (process.env.MODEL_VERIFY_SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseKey = process.env.MODEL_VERIFY_SUPABASE_ANON_KEY || process.env.MODEL_VERIFY_SUPABASE_SERVICE_KEY || '';
const table = process.env.MODEL_VERIFY_SUPABASE_TABLE || 'model_verify_reports';
const cockroachTable = process.env.MODEL_VERIFY_COCKROACH_TABLE || table;
const cockroachDatabaseUrl = process.env.MODEL_VERIFY_COCKROACH_DATABASE_URL || process.env.DATABASE_URL || '';
const cockroachPassword = process.env.MODEL_VERIFY_COCKROACH_PASSWORD || process.env.COCKROACHLABS_CLOUD_DB1 || '';
const cockroachHost = process.env.MODEL_VERIFY_COCKROACH_HOST || '';
const cockroachUser = process.env.MODEL_VERIFY_COCKROACH_USER || '';
const cockroachDatabase = process.env.MODEL_VERIFY_COCKROACH_DATABASE || 'db1';
const cockroachPort = Number(process.env.MODEL_VERIFY_COCKROACH_PORT || 26257);
const cockroachRejectUnauthorized = process.env.MODEL_VERIFY_COCKROACH_SSL_REJECT_UNAUTHORIZED !== 'false';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLength = 700) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...[truncated]` : text;
}

function compactReport(report) {
  const channels = asArray(report && report.channels).map((channel) => ({
    channel: channel.channel || '',
    provider: channel.provider || '',
    protocol: channel.protocol || '',
    detectionMode: channel.detectionMode || '',
    executionMode: channel.executionMode || '',
    targetModel: channel.targetModel || '',
    rawScore: Number(channel.rawScore || channel.score || 0),
    score: Number(channel.score || 0),
    label: channel.label || '',
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
      id: probe.id || '',
      group: probe.group || '',
      probe: probe.probe || probe.name || '',
      score: Number(probe.score || 0),
      maxScore: Number(probe.maxScore || 0),
      notes: asArray(probe.notes).map((note) => cleanText(note, 220)).slice(0, 10),
      result: probe.result ? {
        success: Boolean(probe.result.success),
        statusCode: probe.result.statusCode || '',
        latencyMs: Number(probe.result.latencyMs || 0),
        returnedModel: probe.result.returnedModel || '',
        preview: cleanText(probe.result.preview || probe.result.error, 700)
      } : {}
    })).slice(0, 60)
  }));

  return {
    version: report && report.version ? report.version : 2,
    generatedAt: report && report.generatedAt ? report.generatedAt : '',
    source: report && report.source ? report.source : '',
    scoring: report && report.scoring ? report.scoring : {},
    channels
  };
}

function normalizeRow(row) {
  const domain = String(row.domain || '').trim().toLowerCase();
  if (!domain) return null;
  const report = compactReport(row.report || {});
  const targetModel = String(row.target_model || row.targetModel || asArray(report.channels)[0]?.targetModel || 'unknown').trim().toLowerCase();
  return {
    version: 2,
    providerName: String(row.provider_name || row.providerName || '').trim(),
    homepage: String(row.homepage || '').trim(),
    domain,
    targetModel,
    sharedAt: row.shared_at || row.sharedAt || '',
    report
  };
}

async function fetchSupabaseRows() {
  if (!supabaseUrl || !supabaseKey) {
    console.warn('MODEL_VERIFY_SUPABASE_URL / MODEL_VERIFY_SUPABASE_ANON_KEY not configured; writing empty model verify feed.');
    return [];
  }

  const endpointBase = `${supabaseUrl}/rest/v1/${encodeURIComponent(table)}`;
  const endpoint = `${endpointBase}?select=domain,target_model,provider_name,homepage,shared_at,report&order=shared_at.desc`;
  const response = await fetch(endpoint, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    }
  });
  if (!response.ok && [400, 404].includes(response.status)) {
    const fallback = await fetch(`${endpointBase}?select=domain,provider_name,homepage,shared_at,report&order=shared_at.desc`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      }
    });
    if (!fallback.ok) {
      throw new Error(`Supabase API HTTP ${fallback.status}: ${await fallback.text()}`);
    }
    return fallback.json();
  }
  if (!response.ok) {
    throw new Error(`Supabase API HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function cockroachConfigReady() {
  return Boolean(cockroachDatabaseUrl || (cockroachHost && cockroachUser && cockroachPassword));
}

async function fetchCockroachRows() {
  if (!cockroachConfigReady()) {
    console.warn('Cockroach source selected, but MODEL_VERIFY_COCKROACH_DATABASE_URL or host/user/password is missing; writing empty model verify feed.');
    return [];
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (error) {
    throw new Error('Cockroach feed source requires the pg package. Run npm install, or let GitHub Actions install package.json dependencies.');
  }

  const client = new Client(cockroachDatabaseUrl ? {
    connectionString: cockroachDatabaseUrl,
    ssl: { rejectUnauthorized: cockroachRejectUnauthorized }
  } : {
    host: cockroachHost,
    port: cockroachPort,
    user: cockroachUser,
    password: cockroachPassword,
    database: cockroachDatabase,
    ssl: { rejectUnauthorized: cockroachRejectUnauthorized }
  });

  await client.connect();
  try {
    try {
      const result = await client.query(`
        select domain, target_model, provider_name, homepage, shared_at, report
        from ${quoteIdent(cockroachTable)}
        order by shared_at desc
      `);
      return result.rows;
    } catch (error) {
      if (error.code !== '42703') throw error;
      const fallback = await client.query(`
        select domain, provider_name, homepage, shared_at, report
        from ${quoteIdent(cockroachTable)}
        order by shared_at desc
      `);
      return fallback.rows;
    }
  } finally {
    await client.end();
  }
}

function latestByDomainModel(rows) {
  const byDomainModel = new Map();
  asArray(rows).forEach((row) => {
    const item = normalizeRow(row);
    if (!item) return;
    const key = `${item.domain}::${item.targetModel || 'unknown'}`;
    const previous = byDomainModel.get(key);
    const previousTime = Date.parse(previous && previous.sharedAt || 0);
    const itemTime = Date.parse(item.sharedAt || 0);
    if (!previous || itemTime >= previousTime) byDomainModel.set(key, item);
  });
  return [...byDomainModel.values()].sort((a, b) => Date.parse(b.sharedAt || 0) - Date.parse(a.sharedAt || 0));
}

async function main() {
  const rows = sourceType === 'cockroach' ? await fetchCockroachRows() : await fetchSupabaseRows();
  const items = latestByDomainModel(rows);
  const feed = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: sourceType === 'cockroach'
      ? `cockroach://${cockroachHost || 'connection-string'}/${cockroachDatabase}/${cockroachTable}`
      : supabaseUrl ? `${supabaseUrl}/rest/v1/${table}` : 'not-configured',
    count: items.length,
    items
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`Wrote ${items.length} model verify reports to ${path.relative(path.resolve(__dirname, '..'), outputPath)}`);
}

main().catch((error) => {
  console.error(`Failed to generate model verify feed: ${error.message}`);
  process.exitCode = 1;
});
