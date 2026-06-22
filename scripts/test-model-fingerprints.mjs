const cases = [
  {
    name: 'openai responses',
    payload: { object: 'response', output: [{ content: [{ type: 'output_text', text: 'ok' }] }], parallel_tool_calls: true },
    expectedVendor: 'OpenAI'
  },
  {
    name: 'anthropic thinking',
    payload: { content: [{ type: 'thinking', thinking: '...', signature: 'sig' }, { type: 'text', text: 'ok' }] },
    expectedVendor: 'Anthropic'
  },
  {
    name: 'gemini generate content',
    payload: { candidates: [{ content: { parts: [{ text: 'ok' }] } }], promptFeedback: {}, usageMetadata: { thoughtsTokenCount: 4 }, responseId: 'r' },
    expectedVendor: 'Gemini'
  },
  {
    name: 'deepseek reasoning',
    payload: { choices: [{ message: { reasoning_content: '...', content: 'ok' } }], usage: { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2 } },
    expectedVendor: 'DeepSeek'
  },
  {
    name: 'mistral parameter echo',
    payload: { model: 'mistral', safe_prompt: true, reasoning_effort: 'minimal' },
    expectedVendor: 'Mistral'
  },
  {
    name: 'cohere chat',
    payload: { message: { content: [{ type: 'text', text: 'ok' }] }, usage: { billed_units: { input_tokens: 1 }, tokens: { input_tokens: 1 } } },
    expectedVendor: 'Cohere'
  },
  {
    name: 'xai usage',
    payload: { usage: { num_sources_used: 1, num_server_side_tools_used: 0, cost_in_usd_ticks: 10 } },
    expectedVendor: 'xAI'
  },
  {
    name: 'dashscope qwen compatibility',
    payload: { choices: [{ message: { content: 'ok' } }] },
    requestMeta: { protocol: 'chat_completions', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', requestBody: { enable_thinking: false } },
    expectedVendor: 'DashScope/Qwen'
  },
  {
    name: 'generic fallback',
    payload: { choices: [{ message: { content: 'ok' } }] },
    expectedVendor: 'generic'
  }
];

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

function collectObjectPaths(value, path = [], results = []) {
  if (!value || typeof value !== 'object') return results;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectObjectPaths(item, [...path, String(index)], results));
    return results;
  }
  Object.entries(value).forEach(([key, item]) => {
    const nextPath = [...path, key];
    if (item && typeof item === 'object') {
      results.push(nextPath.join('.'));
      collectObjectPaths(item, nextPath, results);
    } else {
      results.push(nextPath.join('.'));
    }
  });
  return results;
}

function detectResponseFingerprint(payload, requestMeta = {}) {
  const paths = uniqueList(collectObjectPaths(payload).map((item) => String(item || '').toLowerCase()));
  const hasPath = (needle) => paths.some((item) => item === needle || item.startsWith(`${needle}.`) || item.includes(`.${needle}.`));
  const hasAny = (...needles) => needles.some((needle) => hasPath(needle));
  const fieldPresent = (needle) => paths.some((item) => item.endsWith(needle) || item.includes(`.${needle}`));
  const requestUrl = String(requestMeta?.url || '').toLowerCase();
  const requestBody = requestMeta?.requestBody && typeof requestMeta.requestBody === 'object' ? requestMeta.requestBody : {};
  const results = [];
  const push = (vendor, evidence, confidence) => results.push({ vendor, evidence, confidence });

  if (payload && typeof payload === 'object') {
    const rootObject = String(payload.object || '').toLowerCase();
    if (rootObject === 'response' || hasAny('output', 'previous_response_id', 'parallel_tool_calls')) push('OpenAI', 'response_shape', 'high');
    if (hasAny('output.output_text', 'output.content.text')) push('OpenAI', 'output_text', 'high');
    if (hasAny('content') && fieldPresent('signature')) push('Anthropic', 'thinking_signature', 'very_high');
    if (hasAny('redacted_thinking')) push('Anthropic', 'redacted_thinking', 'very_high');
    if (hasAny('candidates', 'promptfeedback', 'usagemetadata', 'responseid', 'modelversion')) push('Gemini', 'generate_content_shape', 'very_high');
    if (fieldPresent('thought') || fieldPresent('thoughtsignature') || fieldPresent('thoughtstokencount')) push('Gemini', 'thinking_metadata', 'high');
    if (fieldPresent('reasoning_content')) push('DeepSeek', 'reasoning_content', 'high');
    if (fieldPresent('prompt_cache_hit_tokens') || fieldPresent('prompt_cache_miss_tokens')) push('DeepSeek', 'cache_accounting', 'medium_high');
    if (hasAny('message.content') && hasAny('usage.billed_units', 'usage.tokens')) push('Cohere', 'chat_shape', 'high');
    if (hasAny('safe_prompt', 'prompt_mode', 'reasoning_effort')) push('Mistral', 'parameter_acceptance', 'high');
    if (fieldPresent('num_sources_used') || fieldPresent('num_server_side_tools_used') || fieldPresent('cost_in_usd_ticks')) push('xAI', 'usage_accounting', 'high');
    if (requestUrl.includes('dashscope.aliyuncs.com') || Object.prototype.hasOwnProperty.call(requestBody, 'enable_thinking')) push('DashScope/Qwen', 'compatible_endpoint_feature', 'medium');
  }

  if (!results.length && requestMeta.protocol) push('generic', 'proxy_shape_only', 'low');
  return uniqueList(results.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item));
}

let failed = 0;
for (const item of cases) {
  const fingerprints = detectResponseFingerprint(item.payload, item.requestMeta || { protocol: 'chat_completions' });
  const vendors = fingerprints.map((fingerprint) => fingerprint.vendor);
  if (!vendors.includes(item.expectedVendor)) {
    failed += 1;
    console.error(`FAIL ${item.name}: expected ${item.expectedVendor}, got ${vendors.join(', ') || 'none'}`);
  } else {
    console.log(`PASS ${item.name}: ${vendors.join(', ')}`);
  }
}

if (failed) process.exit(1);
