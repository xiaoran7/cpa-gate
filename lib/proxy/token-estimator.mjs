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
