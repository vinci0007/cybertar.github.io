const fs = require('fs');
const path = require('path');

const outputPath = path.resolve(__dirname, '..', 'lab', 'model-verify-share-config.js');
const cockroachConfigured = Boolean(
  process.env.MODEL_VERIFY_COCKROACH_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.MODEL_VERIFY_COCKROACH_PASSWORD ||
  process.env.COCKROACHLABS_CLOUD_DB1
);
const config = {
  type: process.env.MODEL_VERIFY_SHARE_TYPE || process.env.MODEL_VERIFY_FEED_SOURCE || (cockroachConfigured ? 'cockroach' : 'supabase'),
  supabaseUrl: (process.env.MODEL_VERIFY_SUPABASE_URL || '').replace(/\/+$/, ''),
  supabaseAnonKey: process.env.MODEL_VERIFY_SUPABASE_ANON_KEY || '',
  table: process.env.MODEL_VERIFY_SUPABASE_TABLE || 'model_verify_reports',
  customEndpoint: process.env.MODEL_VERIFY_CUSTOM_ENDPOINT || '',
  modelProxyEndpoint: process.env.MODEL_VERIFY_PROXY_ENDPOINT || ''
};

const content = [
  'window.MODEL_VERIFY_SHARE_CONFIG = {',
  `  type: ${JSON.stringify(config.type)},`,
  `  supabaseUrl: ${JSON.stringify(config.supabaseUrl)},`,
  `  supabaseAnonKey: ${JSON.stringify(config.supabaseAnonKey)},`,
  `  table: ${JSON.stringify(config.table)},`,
  `  customEndpoint: ${JSON.stringify(config.customEndpoint)},`,
  `  modelProxyEndpoint: ${JSON.stringify(config.modelProxyEndpoint)}`,
  '};',
  ''
].join('\n');

fs.writeFileSync(outputPath, content);
console.log(`Wrote ${path.relative(path.resolve(__dirname, '..'), outputPath)}`);
