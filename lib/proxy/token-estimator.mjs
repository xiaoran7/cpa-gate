/**
 * 从多种响应 JSON 形态中提取 usage，包含 prompt caching 缓存命中的 token 提取：
 * OpenAI: usage.{prompt_tokens,completion_tokens,total_tokens,prompt_tokens_details.cached_tokens}
 * DeepSeek: usage.{prompt_cache_hit_tokens,prompt_tokens_details.cached_tokens}
 * Anthropic: usage.{input_tokens,output_tokens,cache_read_input_tokens}
 * Gemini 原生: usageMetadata.{promptTokenCount,candidatesTokenCount,totalTokenCount,cachedContentTokenCount}
 * 返回 { promptTokens, completionTokens, cachedTokens, totalTokens } 或 null
 */
export function extractUsageFromJson(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const u = obj.usage;
  if (u && typeof u === 'object') {
    let prompt = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount);
    let completion = Number(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount);
    let total = Number(u.total_tokens ?? u.totalTokenCount);
    let cached = Number(
      u.prompt_tokens_details?.cached_tokens ??
      u.prompt_tokens_details?.cache_read_tokens ??
      u.prompt_cache_hit_tokens ??
      u.cache_read_input_tokens ??
      u.cacheReadInputTokens ??
      u.cache_read_tokens ??
      u.cached_tokens ??
      u.cachedTokens ??
      0
    ) || 0;

    // Anthropic 协议特异性：当由 input_tokens 提供时，该字段表示未命中缓存的增量输入；
    // 若同时存在 cache_read_input_tokens，全量 prompt 应包含缓存读取量
    if (u.input_tokens != null && u.prompt_tokens == null && cached > 0 && prompt < cached) {
      prompt += cached;
    }

    if (Number.isFinite(prompt) || Number.isFinite(completion) || cached > 0) {
      if (!Number.isFinite(prompt)) prompt = 0;
      if (!Number.isFinite(completion)) completion = 0;
      if (cached > 0 && prompt < cached) prompt = cached;
      if (!Number.isFinite(total) || total <= 0) total = prompt + completion;
      return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, totalTokens: total };
    }
  }

  const gm = obj.usageMetadata;
  if (gm && typeof gm === 'object') {
    let prompt = Number(gm.promptTokenCount) || 0;
    const completion = Number(gm.candidatesTokenCount) || 0;
    const cached = Number(gm.cachedContentTokenCount) || 0;
    let total = Number(gm.totalTokenCount);
    if (cached > 0 && prompt < cached) prompt = cached;
    if (!Number.isFinite(total) || total <= 0) total = prompt + completion;
    if (prompt > 0 || completion > 0 || cached > 0) {
      return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, totalTokens: total };
    }
  }

  return null;
}

// 粗略 token 估算兜底（无 usage 时），CJK 密度按 ~3 字符/Token
export function estimateTokensFromChars(charCount) {
  return Math.ceil(charCount / 3);
}

export function estimateInputTokens(parsedBody) {
  if (!parsedBody || !Array.isArray(parsedBody.messages)) return 0;
  let chars = 0;
  for (const msg of parsedBody.messages) {
    if (typeof msg?.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg?.content)) {
      for (const p of msg.content) {
        if (typeof p?.text === 'string') chars += p.text.length;
      }
    }
    if (typeof msg?.content === 'object' && msg?.content !== null && !Array.isArray(msg?.content) && typeof msg.content.text === 'string') {
      chars += msg.content.text.length;
    }
  }
  return estimateTokensFromChars(chars) + 8;
}

/**
 * 从请求体中提取思考强度 (Reasoning Effort / Thinking Budget)
 * 涵盖业界四大协议：
 * 1. OpenAI / Codex / o-series 规范：reasoning_effort (low / medium / high / max) 或 reasoning.effort
 * 2. Anthropic Messages 规范：thinking.budget_tokens (如 2048) 或 thinking.type (adaptive / enabled)
 * 3. Google Gemini 规范：thinking_config.thinking_budget (如 1024) 或 thinking_config.mode
 * 4. 其它客户端驼峰或布尔兼容：reasoningEffort 等
 */
export function extractReasoningEffort(parsedBody) {
  if (!parsedBody || typeof parsedBody !== 'object') return null;

  // 1. OpenAI / Codex 规范：reasoning_effort 字符串 (low, medium, high, max 等)
  if (typeof parsedBody.reasoning_effort === 'string' && parsedBody.reasoning_effort.trim()) {
    return parsedBody.reasoning_effort.trim().toLowerCase().slice(0, 32);
  }
  // 嵌套 reasoning: { effort: '...' }
  if (parsedBody.reasoning && typeof parsedBody.reasoning === 'object') {
    if (typeof parsedBody.reasoning.effort === 'string' && parsedBody.reasoning.effort.trim()) {
      return parsedBody.reasoning.effort.trim().toLowerCase().slice(0, 32);
    }
  }
  // 驼峰命名兼容 reasoningEffort
  if (typeof parsedBody.reasoningEffort === 'string' && parsedBody.reasoningEffort.trim()) {
    return parsedBody.reasoningEffort.trim().toLowerCase().slice(0, 32);
  }

  // 2. Anthropic Messages 规范：output_config.effort (low / medium / high / xhigh / max 等)
  const outputEffort = parsedBody.output_config?.effort ?? parsedBody.outputConfig?.effort;
  if (typeof outputEffort === 'string' && outputEffort.trim()) {
    return outputEffort.trim().toLowerCase().slice(0, 32);
  }

  // 顶层 effort 规范
  if (typeof parsedBody.effort === 'string' && parsedBody.effort.trim()) {
    return parsedBody.effort.trim().toLowerCase().slice(0, 32);
  }

  // 3. Anthropic thinking 协议: { type: 'enabled', budget_tokens: 2048 } 或 { type: 'adaptive' }
  if (parsedBody.thinking && typeof parsedBody.thinking === 'object') {
    const t = parsedBody.thinking;
    if (t.type === 'disabled') return null;
    // thinking 对象内显式指定 effort: { type: 'adaptive', effort: 'max' }
    if (typeof t.effort === 'string' && t.effort.trim()) {
      return t.effort.trim().toLowerCase().slice(0, 32);
    }
    if (Number.isFinite(t.budget_tokens) && t.budget_tokens > 0) {
      return `budget:${t.budget_tokens}`;
    }
    if (typeof t.type === 'string' && t.type) {
      return t.type.toLowerCase().slice(0, 32);
    }
  }

  // 4. Google Gemini thinking_config 协议: { thinking_budget: 1024 }
  if (parsedBody.thinking_config && typeof parsedBody.thinking_config === 'object') {
    const tc = parsedBody.thinking_config;
    if (Number.isFinite(tc.thinking_budget) && tc.thinking_budget > 0) {
      return `budget:${tc.thinking_budget}`;
    }
    if (typeof tc.mode === 'string' && tc.mode) {
      return tc.mode.toLowerCase().slice(0, 32);
    }
  }

  // 5. 启发式后缀兜底：若请求体未传显式思考参数，但模型名称后缀以 -high / -medium / -low / -max 明确指定
  // （常见于 Gemini 等客户端在 OpenAI 兼容模式下因 SDK 白名单被丢弃参数，但通过模型名指定档位）
  if (typeof parsedBody.model === 'string' && parsedBody.model.trim()) {
    const m = parsedBody.model.trim().toLowerCase();
    const match = m.match(/[-_:](high|medium|low|max)$/i);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

/**
 * 计算 Token 生成速率 (Tokens Per Second, tok/s)
 * 算法逻辑：
 * - completionTokens / 耗时(秒)；
 * - 若为流式且具备可信的首字延迟 (ttftMs > 0 且 latencyMs > ttftMs 且生成窗口 >= 100ms)，
 *   优先扣除首字延迟，精确衡量模型纯输出阶段的吞吐速率；
 * - 否则以总延迟为分母计算整体平均速率；
 * - 结果四舍五入保留 1 位小数 (如 108.3)。
 */
export function calculateTokensPerSec(completionTokens, latencyMs, ttftMs = 0, isStream = false) {
  const tokens = Number(completionTokens) || 0;
  const latency = Number(latencyMs) || 0;
  const ttft = Number(ttftMs) || 0;

  if (tokens <= 0 || latency <= 0) return 0;

  let durationMs = latency;
  if (isStream && ttft > 0 && latency > ttft && (latency - ttft) >= 100) {
    durationMs = latency - ttft;
  }

  const sec = durationMs / 1000;
  if (sec <= 0) return 0;

  const tps = tokens / sec;
  if (!Number.isFinite(tps) || tps <= 0) return 0;
  return Math.round(tps * 10) / 10;
}
