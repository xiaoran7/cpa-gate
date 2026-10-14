import {
  stmtModelPriceAll,
  stmtModelPriceInsert,
  stmtModelPriceUpdate,
  stmtModelPriceDelete,
  quotaDb
} from '../db/sqlite.mjs';

// 价格口径：美元 / 1M Tokens (每百万 token)
// 初始默认硬编码价格矩阵，作为 DB 初始化种子数据
export const INITIAL_SEED_PRICES = [
  // Gemini 2.5 / 2.0 / 1.5 / 3 系列 (含 Keeper 对齐)
  { pattern: 'gemini-3.8-flash-high', prompt_price: 0.75, completion_price: 3.75, cache_read_price: 0.075 },
  { pattern: 'gemini-3.1-flash-lite', prompt_price: 0.25, completion_price: 1.50, cache_read_price: 0.025 },
  { pattern: 'gemini-3.1-flash-image', prompt_price: 0.50, completion_price: 60.00, cache_read_price: 0.05 },
  { pattern: 'gemini-3-flash', prompt_price: 0.50, completion_price: 3.00, cache_read_price: 0.05 },
  { pattern: 'gemini-2.5-flash', prompt_price: 0.10, completion_price: 0.40, cache_read_price: 0.025 },
  { pattern: 'gemini-2.0-flash', prompt_price: 0.10, completion_price: 0.40, cache_read_price: 0.025 },
  { pattern: 'gemini-1.5-flash', prompt_price: 0.075, completion_price: 0.30, cache_read_price: 0.01875 },
  { pattern: 'gemini-2.5-pro', prompt_price: 1.25, completion_price: 5.00, cache_read_price: 0.3125 },
  { pattern: 'gemini-2.0-pro', prompt_price: 1.25, completion_price: 5.00, cache_read_price: 0.3125 },
  { pattern: 'gemini-1.5-pro', prompt_price: 1.25, completion_price: 5.00, cache_read_price: 0.3125 },
  { pattern: 'gemini', prompt_price: 0.15, completion_price: 0.60, cache_read_price: 0.0375 },

  // Claude 3.5 / 3.7 / 4.6 系列 (含 Keeper 对齐)
  { pattern: 'claude-opus-4-6-thinking', prompt_price: 5.00, completion_price: 25.00, cache_read_price: 0.50 },
  { pattern: 'claude-sonnet-4-6', prompt_price: 3.00, completion_price: 15.00, cache_read_price: 0.30 },
  { pattern: 'claude-3-7-sonnet', prompt_price: 3.00, completion_price: 15.00, cache_read_price: 0.30 },
  { pattern: 'claude-3-5-sonnet', prompt_price: 3.00, completion_price: 15.00, cache_read_price: 0.30 },
  { pattern: 'claude-3-5-haiku', prompt_price: 0.80, completion_price: 4.00, cache_read_price: 0.08 },
  { pattern: 'claude-3-opus', prompt_price: 15.00, completion_price: 75.00, cache_read_price: 1.50 },
  { pattern: 'claude', prompt_price: 3.00, completion_price: 15.00, cache_read_price: 0.30 },

  // OpenAI GPT-4o / o1 / o3 / 5.6 / 6 系列 (含 Keeper 对齐)
  { pattern: 'gpt-5.6-sol', prompt_price: 4.00, completion_price: 20.00, cache_read_price: 0.40 },
  { pattern: 'gpt-6-astra', prompt_price: 10.00, completion_price: 50.00, cache_read_price: 1.00 },
  { pattern: 'gpt-4o-mini', prompt_price: 0.15, completion_price: 0.60, cache_read_price: 0.075 },
  { pattern: 'gpt-4o', prompt_price: 2.50, completion_price: 10.00, cache_read_price: 1.25 },
  { pattern: 'o1-mini', prompt_price: 1.10, completion_price: 4.40, cache_read_price: 0.55 },
  { pattern: 'o1', prompt_price: 15.00, completion_price: 60.00, cache_read_price: 7.50 },
  { pattern: 'o3-mini', prompt_price: 1.10, completion_price: 4.40, cache_read_price: 0.55 },
  { pattern: 'gpt-4', prompt_price: 10.00, completion_price: 30.00, cache_read_price: 5.00 },

  // DeepSeek 系列
  { pattern: 'deepseek-reasoner', prompt_price: 0.55, completion_price: 2.19, cache_read_price: 0.14 },
  { pattern: 'deepseek-r1', prompt_price: 0.55, completion_price: 2.19, cache_read_price: 0.14 },
  { pattern: 'deepseek-chat', prompt_price: 0.14, completion_price: 0.28, cache_read_price: 0.014 },
  { pattern: 'deepseek-v3', prompt_price: 0.14, completion_price: 0.28, cache_read_price: 0.014 },
  { pattern: 'deepseek', prompt_price: 0.14, completion_price: 0.28, cache_read_price: 0.014 },

  // Qwen 系列
  { pattern: 'qwen-max', prompt_price: 1.60, completion_price: 6.40, cache_read_price: 0.40 },
  { pattern: 'qwen-plus', prompt_price: 0.40, completion_price: 1.20, cache_read_price: 0.10 },
  { pattern: 'qwen-turbo', prompt_price: 0.05, completion_price: 0.20, cache_read_price: 0.01 },
  { pattern: 'qwen', prompt_price: 0.20, completion_price: 0.60, cache_read_price: 0.05 }
];

// 内存中编译后的正则与价格对象数组
let compiledPricingRules = [];
const DEFAULT_MODEL_PRICE = [0.50, 1.50, 0.10, 1.0]; // 兜底标准计费 $0.5 / 1M prompt, $1.5 / 1M completion, $0.1 / 1M cache, 1.0x

export function initModelPrices() {
  const existing = stmtModelPriceAll.all();
  if (existing.length === 0) {
    const tx = quotaDb.transaction(() => {
      for (const item of INITIAL_SEED_PRICES) {
        stmtModelPriceInsert.run(item.pattern, item.prompt_price, item.completion_price, item.cache_read_price, 1.0);
      }
    });
    tx();
  }
  reloadModelPrices();
}

export function reloadModelPrices() {
  const rows = stmtModelPriceAll.all();
  compiledPricingRules = rows.map(r => {
    let reg;
    try {
      const escaped = r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      reg = new RegExp(escaped, 'i');
    } catch (e) {
      reg = new RegExp(r.pattern, 'i');
    }
    return {
      id: r.id,
      rawPattern: r.pattern,
      regex: reg,
      price: [Number(r.prompt_price) || 0, Number(r.completion_price) || 0, Number(r.cache_read_price) || 0, Number(r.multiplier) || 1.0]
    };
  });
}

export function getAllModelPrices() {
  return stmtModelPriceAll.all();
}

export function upsertModelPrice({ id, pattern, model_pattern, prompt_price, completion_price, cache_read_price, multiplier }) {
  const pat = String(pattern || model_pattern || '').trim();
  if (!pat) throw new Error('pattern is required');
  const pPrice = Math.max(0, Number(prompt_price) || 0);
  const cPrice = Math.max(0, Number(completion_price) || 0);
  const crPrice = Math.max(0, Number(cache_read_price) || 0);
  const mult = Math.max(0.01, Math.min(100, Number(multiplier) || 1.0));

  if (id) {
    stmtModelPriceUpdate.run(pat, pPrice, cPrice, crPrice, mult, Number(id));
  } else {
    stmtModelPriceInsert.run(pat, pPrice, cPrice, crPrice, mult);
  }
  reloadModelPrices();
  return { success: true };
}

export function deleteModelPrice(id) {
  stmtModelPriceDelete.run(Number(id));
  reloadModelPrices();
  return { success: true };
}

/**
 * 根据模型与 token 构成计算花费与节省（美元）
 */
export function calculateModelCost(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0) {
  const m = String(model || '').trim();
  let pricing = DEFAULT_MODEL_PRICE;
  for (const item of compiledPricingRules) {
    if (item.regex.test(m)) {
      pricing = item.price;
      break;
    }
  }

  const [pRate, cRate, crRate, mult] = pricing;
  const normalPrompt = Math.max(0, promptTokens - cachedTokens);
  const costPrompt = (normalPrompt / 1000000) * pRate * mult;
  const costCached = (cachedTokens / 1000000) * crRate * mult;
  const costCompletion = (completionTokens / 1000000) * cRate * mult;
  const costTotal = costPrompt + costCached + costCompletion;

  const savings = cachedTokens > 0 ? (cachedTokens / 1000000) * Math.max(0, pRate - crRate) * mult : 0;

  return {
    costUsd: Math.round(costTotal * 1000000) / 1000000,
    savingsUsd: Math.round(savings * 1000000) / 1000000,
    rates: { promptPer1M: pRate, completionPer1M: cRate, cachedPer1M: crRate, multiplier: mult }
  };
}
