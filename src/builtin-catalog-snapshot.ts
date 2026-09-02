// Plan C (settings-seam): builtin catalog snapshot — single source of truth.

/**
 * Builtin catalog snapshot for base-matching classification and maxTokens
 * stripping (design doc §3.6).
 *
 * This module is the single source of truth for the hardcoded builtin catalog
 * data used by index.ts, translate.test.mjs, and serviceability.test.mjs.
 *
 * To regenerate: run `node scripts/generate-builtin-snapshot.mjs --generate`
 *
 * @module dsh-model-sync/builtin-catalog-snapshot
 */

import type { BuiltinModelData } from './translate.ts'

/** Per-route builtin catalog snapshot. */
export interface BuiltinCatalogSnapshotMap {
  [route: string]: BuiltinModelData[]
}

/** Builtin catalog data keyed by route id. */
export const BUILTIN_CATALOG_SNAPSHOT: BuiltinCatalogSnapshotMap = {
  'minimax-cn': [
    { id: 'MiniMax-M2.7', api: 'anthropic-messages', maxTokens: 131072 },
    { id: 'MiniMax-M2.7-highspeed', api: 'anthropic-messages', maxTokens: 131072 },
    { id: 'MiniMax-M3', api: 'anthropic-messages', maxTokens: 512000 }
  ],
  'opencode-go': [
    { id: 'deepseek-v4-flash', api: 'openai-completions', maxTokens: 384000 },
    { id: 'deepseek-v4-flash-vision-exp', api: 'openai-completions', maxTokens: 384000 },
    { id: 'deepseek-v4-pro', api: 'openai-completions', maxTokens: 384000 },
    { id: 'glm-5.1', api: 'openai-completions', maxTokens: 32768 },
    { id: 'glm-5.2', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5.3', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5.3-flash', api: 'openai-completions', maxTokens: 131072 },
    { id: 'gpt-5.6-luna', api: 'openai-responses', maxTokens: 128000 },
    { id: 'grok-4.6', api: 'openai-responses', maxTokens: 500000 },
    { id: 'hy3', api: 'openai-completions', maxTokens: 64000 },
    { id: 'hy4-preview', api: 'openai-completions', maxTokens: 64000 },
    { id: 'kimi-k2.6', api: 'openai-completions', maxTokens: 65536 },
    { id: 'kimi-k2.7-code', api: 'openai-completions', maxTokens: 262144 },
    { id: 'kimi-k3', api: 'openai-completions', maxTokens: 131072 },
    { id: 'longcat-2.0', api: 'openai-completions', maxTokens: 131072 },
    { id: 'mimo-v2.5', api: 'openai-completions', maxTokens: 128000 },
    { id: 'mimo-v2.5-pro', api: 'openai-completions', maxTokens: 128000 },
    { id: 'minimax-m2.7', api: 'openai-completions', maxTokens: 131072 },
    { id: 'minimax-m3', api: 'anthropic-messages', maxTokens: 131072 },
    { id: 'muse-spark-1.2-contributor', api: 'openai-responses', maxTokens: 131072 },
    { id: 'qwen3.6-plus', api: 'openai-completions', maxTokens: 65536 },
    { id: 'qwen3.7-max', api: 'openai-completions', maxTokens: 65536 },
    { id: 'qwen3.7-plus', api: 'openai-completions', maxTokens: 65536 },
    { id: 'qwen3.8-flash', api: 'anthropic-messages', maxTokens: 131072 },
    { id: 'qwen3.8-max', api: 'openai-completions', maxTokens: 131072 }
  ],
  'xiaomi-token-plan-cn': [
    { id: 'mimo-v2.5', api: 'openai-completions', maxTokens: 131072 },
    { id: 'mimo-v2.5-pro', api: 'openai-completions', maxTokens: 131072 }
  ],
  'zai-coding-cn': [
    { id: 'glm-4.6v', api: 'openai-completions', maxTokens: 32768 },
    { id: 'glm-4.7', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5-turbo', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5.1', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5.2', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5.2-highspeed', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5.3', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5.3-flash', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5.3-highspeed', api: 'openai-completions', maxTokens: 131072 },
    { id: 'glm-5v-turbo', api: 'openai-completions', maxTokens: 131072 }
  ]
}
