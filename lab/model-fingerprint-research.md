# Model Fingerprint Research

This note collects vendor/model-family fingerprints that can identify an upstream model provider without relying on the model ID string. The goal is to separate strong protocol evidence from weak style evidence before turning any signal into a verifier score.

## Scoring Vocabulary

| Field | Meaning |
| --- | --- |
| Evidence type | `response_shape`, `feature_acceptance`, `reasoning_trace`, `tool_protocol`, `safety_metadata`, `usage_accounting`, or `behavioral_style` |
| Uniqueness | How strongly the signal points to one provider or model family |
| Stability | How likely the signal is to remain stable across SDK/API updates |
| False positive risk | How likely compatible gateways or proxies can imitate the signal |
| Adoption | `adopt_now`, `diagnostic_first`, `manual_review`, or `avoid` |

## Candidate Fingerprints

| Vendor / family | Fingerprint | Evidence type | Uniqueness | Stability | False positive risk | Probe method | Adoption |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI Responses | Response object uses `object:"response"`, `output[]`, typed output content, `previous_response_id`, `parallel_tool_calls` | response_shape | High | High | Medium | Send a minimal Responses request and inspect raw JSON paths | adopt_now |
| OpenAI reasoning models | Request/response accepts `reasoning`; response may expose reasoning token accounting or encrypted reasoning include fields | reasoning_trace | Medium-high | Medium | Medium | Send a low-cost reasoning request and inspect accepted fields/errors | diagnostic_first |
| OpenAI tools | Built-in tool events and response items are emitted as typed response items rather than plain chat message content | tool_protocol | High | Medium | Medium | Force a simple function/tool call and inspect `output[].type` values | diagnostic_first |
| Anthropic Claude | `content[]` is a list of blocks; extended thinking can produce `type:"thinking"` with opaque `signature` and then `type:"text"` | reasoning_trace | Very high | High | Low | Enable extended thinking and inspect content block types | adopt_now |
| Anthropic Claude safety-redacted thinking | `type:"redacted_thinking"` block with encrypted `data` | reasoning_trace | Very high | Medium | Low | Trigger extended thinking on safety-sensitive reasoning; inspect block type | diagnostic_first |
| Anthropic streaming | SSE events include `content_block_start`, `content_block_delta`, `signature_delta`, `content_block_stop` for thinking | response_shape | Very high | Medium | Low | Run a streaming extended-thinking request | diagnostic_first |
| Gemini | Native response uses `candidates[]`, `content.parts[]`, `promptFeedback`, `usageMetadata`, and often `modelVersion`/`responseId` | response_shape | Very high | High | Low | Use native `generateContent` endpoint and inspect raw JSON | adopt_now |
| Gemini thinking summaries | `thinkingConfig.includeThoughts` returns parts where `part.thought` marks thought summaries | reasoning_trace | High | Medium | Medium | Request thought summaries and inspect `candidates[0].content.parts[].thought` | diagnostic_first |
| Gemini thinking budget | Gemini 2.5 uses `thinkingBudget`; Gemini 3 recommends `thinkingLevel` and treats budget as backward compatibility | feature_acceptance | High | Medium | Low | Send model-family-specific thinking config and inspect accept/reject behavior | diagnostic_first |
| Gemini usage accounting | `usageMetadata.thoughtsTokenCount` appears when thinking is enabled | usage_accounting | High | Medium | Medium | Enable thinking and inspect usage metadata | diagnostic_first |
| DeepSeek | Chat completion message can include `reasoning_content`; streaming deltas can include `reasoning_content` | reasoning_trace | High | Medium | Medium | Request a reasoning model and inspect message/delta fields | adopt_now |
| DeepSeek cache accounting | Usage includes `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` | usage_accounting | Medium-high | Medium | Medium | Send repeated prompts and inspect usage accounting | diagnostic_first |
| DeepSeek logprobs | Logprobs schema separates `content` and `reasoning_content` token arrays | reasoning_trace | High | Medium | Medium | Request logprobs on reasoning output and inspect paths | diagnostic_first |
| Mistral | Request accepts `safe_prompt` to inject a safety prompt before conversations | feature_acceptance | High | Medium | Medium | Send a minimal request with `safe_prompt:true`; compare status/error | adopt_now |
| Mistral reasoning | Request accepts `prompt_mode:"reasoning"` and `reasoning_effort` values including `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | feature_acceptance | High | Medium | Medium | Send parameter-compatibility probes, record 200/400 and error text | diagnostic_first |
| Mistral tools | `tool_choice` supports `any` and `required`; tool list can include web search, code interpreter, image generation, document library, custom connector | tool_protocol | Medium-high | Medium | Medium | Send tool-choice schema probe and inspect accept/reject behavior | diagnostic_first |
| Cohere v2 Chat | Response shape has top-level `message.content[]` and `usage.billed_units` plus `usage.tokens` | response_shape | High | High | Medium | Send `/v2/chat` request and inspect raw JSON | adopt_now |
| Cohere safety modes | `safety_mode` supports `CONTEXTUAL`, `STRICT`, and sometimes `OFF`; compatibility varies by newer Command models | safety_metadata | High | Medium | Medium | Send a minimal request with each safety mode and inspect accept/reject | diagnostic_first |
| Cohere strict tools | `strict_tools` beta flag and `tool_choice` values `REQUIRED`/`NONE` create a distinctive tool protocol | tool_protocol | Medium-high | Medium | Medium | Force a simple tool call with strict tools enabled | diagnostic_first |
| xAI Grok | OpenAI-compatible chat and Responses endpoints expose xAI-specific usage fields such as `num_sources_used`, `num_server_side_tools_used`, and `cost_in_usd_ticks` | usage_accounting | High | Medium | Medium | Send chat/responses request and inspect usage paths | adopt_now |
| xAI Grok | Response examples expose `system_fingerprint` and detailed input/output token subfields | usage_accounting | Medium | Medium | Medium | Inspect raw usage details from a minimal call | diagnostic_first |
| Alibaba DashScope / Qwen OpenAI-compatible | OpenAI-compatible surface may preserve DashScope-specific headers/errors and model capability constraints while returning chat-completion shape | feature_acceptance | Medium | Medium | High | Probe OpenAI-compatible parameters and compare accepted/unsupported fields | manual_review |
| Generic OpenAI-compatible proxy | Returns OpenAI chat-completion shape but rejects vendor-native fields for claimed provider | response_shape | Low as identity, high as proxy evidence | High | Medium | Send native-fingerprint probes for declared vendor and compare errors | adopt_now |

## Strong Signals To Adopt First

1. **Native response shape**
   Use raw JSON paths before text analysis. Strong examples: OpenAI Responses `object:"response"`, Anthropic block content, Gemini `candidates/promptFeedback/usageMetadata`, Cohere `message.content[] + usage.billed_units`.

2. **Feature acceptance / rejection**
   A provider may imitate OpenAI-compatible text output, but it is harder to imitate every native parameter. Probe low-cost flags such as Mistral `safe_prompt`, Gemini `thinkingBudget`, Cohere `safety_mode`, and DeepSeek `reasoning_content`/logprobs support.

3. **Reasoning trace containers**
   Prefer container evidence over natural-language explanations. Claude `thinking.signature`, Gemini `part.thought`, DeepSeek `message.reasoning_content`, and OpenAI reasoning-token metadata are more reliable than asking the model to describe its reasoning mode.

4. **Usage accounting**
   Usage fields are useful when they are provider-specific. Examples: Cohere `billed_units`, DeepSeek cache hit/miss tokens, xAI source/tool/cost ticks, Gemini `thoughtsTokenCount`.

## Weak Signals To Avoid Or Keep Low Weight

| Signal | Reason |
| --- | --- |
| Self-reported model name in text | Easy to hallucinate or prompt-inject |
| Writing style, tone, markdown habits | Too unstable across prompts and system instructions |
| Refusal wording | Strongly affected by safety prompt, locale, and gateway |
| Latency alone | Depends on network, routing, load, and streaming |
| Context window claim in text | Model can repeat product claims without proving capability |

## Proposed Verifier Design

### Phase 1: Raw Shape Probe

Send a tiny prompt through the selected protocol and store a redacted raw JSON sample. Score only structural paths:

- `response_shape.openai_responses`: `object === "response"` and `output` is an array.
- `response_shape.anthropic_blocks`: top-level `content` is an array of typed blocks.
- `response_shape.gemini_generate_content`: top-level `candidates` plus `usageMetadata` or `promptFeedback`.
- `response_shape.cohere_v2_chat`: top-level `message.content[]` plus `usage.billed_units`.

### Phase 2: Native Capability Probe

Only run the native probe when the user has selected or claimed a vendor family:

- OpenAI: send a Responses request with `parallel_tool_calls:false` and inspect response item shape.
- Anthropic: send extended-thinking request and inspect `thinking.signature` or compatibility error.
- Gemini: send `thinkingConfig` and inspect `usageMetadata.thoughtsTokenCount` or `part.thought`.
- DeepSeek: request reasoning/logprobs and inspect `reasoning_content`.
- Mistral: send `safe_prompt:true` and `reasoning_effort:"minimal"`.
- Cohere: send `safety_mode:"STRICT"` and inspect `message.content[]`/usage.
- xAI: inspect `num_sources_used` / `num_server_side_tools_used` in usage.

### Phase 3: Proxy Consistency Probe

When the endpoint is OpenAI-compatible but the claimed model family is not OpenAI, compare:

- OpenAI-compatible chat shape is expected and should not be considered identity proof.
- Vendor-native feature rejection should be reported as `proxy_compatibility_limit`, not as model fraud by itself.
- Vendor-native feature acceptance plus native-shaped metadata is strong evidence.

## Initial Weighting Recommendation

| Evidence | Weight | Notes |
| --- | ---: | --- |
| Native response shape match | 10 | Highest confidence, low prompt sensitivity |
| Native reasoning container | 9 | Strong but often requires special request config |
| Native feature acceptance | 8 | Use status code and structured error text |
| Provider-specific usage accounting | 7 | Good corroborating evidence |
| Tool protocol shape | 6 | Useful, but proxies may normalize it |
| Safety metadata/control compatibility | 5 | Useful but policy-sensitive |
| Capability success text | 3 | Keep low weight |
| Natural-language self-report | 1 | Diagnostic only |

## Source Index

- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses/create
- Anthropic extended thinking: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
- Gemini thinking: https://ai.google.dev/gemini-api/docs/thinking
- DeepSeek chat completion: https://api-docs.deepseek.com/api/create-chat-completion
- Mistral API: https://docs.mistral.ai/api
- Cohere v2 chat: https://docs.cohere.com/v2/reference/chat
- xAI chat/responses reference: https://docs.x.ai/developers/rest-api-reference/inference/chat
- Alibaba DashScope OpenAI compatibility: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope

