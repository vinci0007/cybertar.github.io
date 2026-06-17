const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const verifierPath = path.resolve(__dirname, '..', 'lab', 'model-verifier.js');
const current = fs.readFileSync(verifierPath, 'utf8');
const currentMatch = current.match(/const modelVerifierVersion = '([^']+)'/);

if (!currentMatch) {
  console.error('Cannot find modelVerifierVersion in lab/model-verifier.js');
  process.exit(1);
}

const currentVersion = currentMatch[1];
let baseVersion = '';
try {
  const previous = execFileSync('git', ['show', 'origin/main:lab/model-verifier.js'], { encoding: 'utf8' });
  const previousMatch = previous.match(/const modelVerifierVersion = '([^']+)'/);
  baseVersion = previousMatch ? previousMatch[1] : '';
} catch (error) {
  console.error(`Cannot read origin/main model-verifier.js: ${error.message}`);
  process.exit(1);
}

const hasVerifierDiff = /modelVerifierVersion|reportSchemaVersion|authenticityAssessment|channelIdentity|buildFingerprintStageProbes|fingerprint_raw_shape|fingerprint_native_capability|fingerprint_proxy_consistency/.test(
  execFileSync('git', ['diff', '--', 'lab/model-verifier.js'], { encoding: 'utf8' })
);

if (hasVerifierDiff && currentVersion === baseVersion) {
  console.error([
    'model-verifier.js was modified but modelVerifierVersion was not bumped.',
    `origin/main version: ${baseVersion}`,
    `working tree version: ${currentVersion}`
  ].join('\n'));
  process.exit(1);
}

console.log(`model verifier version check passed: ${currentVersion}`);
