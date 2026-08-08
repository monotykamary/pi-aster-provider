/**
 * Aster Provider Extension
 *
 * Registers Aster (asterlab.ai) as a custom provider using the
 * openai-completions API. Base URL: https://api.asterlab.ai/v1
 *
 * Aster serves coding-optimized open-weight models (Kimi K3, GLM 5.2,
 * GPT-OSS) with per-token pricing.
 *
 * Key API details (probed live):
 *   - All chat models return `reasoning_content` (DeepSeek-style field),
 *     parsed by pi regardless of thinkingFormat.
 *   - Thinking is controlled via OpenAI-style `reasoning_effort`. Aster accepts
 *     none/low/medium/high/max (higher tiers model-dependent; `max` on Kimi,
 *     none disables thinking on GLM; gpt-oss is locked to low/medium/high).
 *     Per-model surfaces live in patch.json `thinkingLevelMap`.
 *   - Both `max_tokens` and `max_completion_tokens` are honored.
 *   - GPT-OSS models strictly validate prompt + max_completion_tokens
 *     against the 131K context, so their curated maxTokens is conservative.
 *   - Tool calling works on all chat models; image input does not.
 *   - `aster/wildflower` is a per-search endpoint, not a chat model — excluded.
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /models → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Option 1: Store in auth.json (recommended)
 *   # Add to ~/.pi/agent/auth.json:
 *   #   "aster": { "type": "api_key", "key": "your-api-key" }
 *
 *   # Option 2: Set as environment variable
 *   export ASTER_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-aster-provider
 *
 * @see https://asterlab.ai
 */

import { getAgentDir, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import fs from "fs";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsStore?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template" | "deepseek";
    supportsReasoningEffort?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
  };
}

interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// Entry shape returned by Aster's /v1/models.
interface AsterApiModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  pricing?: {
    input_per_million_tokens_usd?: number;
    output_per_million_tokens_usd?: number;
    cached_input_per_million_tokens_usd?: number;
    input?: number;
    output?: number;
    per_search_usd?: number;
  };
  context_length?: number;
}

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };

  if (patch.cost) {
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (!result.reasoning && result.thinkingLevelMap) {
    delete result.thinkingLevelMap;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result */
function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  // Seed with the base list plus grace-period deprecated models so patch.json
  // entries apply to deprecated models exactly as while the model was live
  // (withDeprecated keeps live data on id conflicts).
  for (const model of withDeprecated(base)) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "aster";
const BASE_URL = "https://api.asterlab.ai/v1";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

// Aster does not report per-model output ceilings. 32K is the safe default:
// GPT-OSS strictly validates prompt + completion ≤ context (131K), so anything
// larger would start failing once a session grows past context - maxTokens.
// patch.json raises this for the long-output models (GLM/Kimi at 131072).
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

// Display name words the generic capitalizer gets wrong.
const NAME_WORD_CASES: Record<string, string> = {
  gpt: "GPT",
  oss: "OSS",
  glm: "GLM",
  kimi: "Kimi",
};

/** "zai-org/glm-5.2-batch" → "GLM 5.2 Batch"; "gpt-oss-120b" → "GPT OSS 120B". */
function prettifyName(id: string): string {
  const slug = id.split("/").pop() || id;
  return slug
    .split("-")
    .map((token) => {
      const lower = token.toLowerCase();
      if (NAME_WORD_CASES[lower]) return NAME_WORD_CASES[lower];
      const numeric = lower.match(/^(\d+(?:\.\d+)?)([a-z]*)$/);
      if (numeric) return numeric[1] + numeric[2].toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** Transform a model from the Aster /v1/models API to JsonModel format. */
function transformApiModel(apiModel: AsterApiModel): JsonModel | null {
  // Skip non-chat entries: search endpoints (per-search pricing) and entries
  // without a context length are not chat completions models.
  if (!apiModel?.id) return null;
  if (typeof apiModel.context_length !== "number" || apiModel.context_length <= 0) return null;

  const pricing = apiModel.pricing || {};
  const inputCost = pricing.input_per_million_tokens_usd ?? pricing.input ?? 0;
  const outputCost = pricing.output_per_million_tokens_usd ?? pricing.output ?? 0;
  const cacheRead = pricing.cached_input_per_million_tokens_usd ?? 0;
  if (inputCost <= 0 && outputCost <= 0) return null;

  return {
    id: apiModel.id,
    name: prettifyName(apiModel.id),
    // All Aster chat models emit reasoning_content and accept reasoning_effort.
    reasoning: true,
    input: ["text"],
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead,
      cacheWrite: 0,
    },
    contextWindow: apiModel.context_length,
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    thinkingLevelMap: { off: "none" },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_completion_tokens",
      supportsReasoningEffort: true,
      // Keep thinking in history so interleaved reasoning stays coherent.
      requiresReasoningContentOnAssistantMessages: true,
    },
  };
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    const models = apiModels.map(transformApiModel).filter((m): m is JsonModel => m !== null);
    if (models.length === 0) return null;
    return models;
  } catch {
    return null;
  }
}

function loadCachedModels(): JsonModel[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map(m => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      // Self-heal: live API pricing is authoritative field-by-field. Prefer the
      // live cost when the API reports it (non-zero); fall back to embedded when
      // the API is silent (0) so curated cacheRead/cacheWrite isn't clobbered.
      // Curation (reasoning/input/compat/name) still wins via ...embedded.
      result.push({
        ...liveModel,
        ...embedded,
        cost: {
          input: liveModel.cost.input || embedded.cost.input,
          output: liveModel.cost.output || embedded.cost.output,
          cacheRead: liveModel.cost.cacheRead || embedded.cost.cacheRead,
          cacheWrite: liveModel.cost.cacheWrite || embedded.cost.cacheWrite,
        },
        contextWindow: liveModel.contextWindow || embedded.contextWindow,
      });
    } else {
      result.push(liveModel);
    }
  }
  // Append any embedded models that the live API didn't return
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working here so in-flight sessions and saved
// model settings do not break; afterwards it is evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Grace-period deprecated models with deprecation metadata stripped.
function activeDeprecatedModels(): JsonModel[] {
  const now = Date.now();
  const result: JsonModel[] = [];
  for (const entry of Object.values(deprecatedData as Record<string, JsonModel & { deprecatedAt?: string }>)) {
    if (!entry?.id) continue;
    const removedAt = Date.parse(entry.deprecatedAt ?? "");
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const model = { ...entry } as JsonModel & { deprecatedAt?: string };
    delete model.deprecatedAt;
    result.push(model);
  }
  return result;
}

// Append grace-period deprecated models the list does not already have (live data wins).
function withDeprecated(models: JsonModel[]): JsonModel[] {
  const seen = new Set(models.map((m) => m.id));
  const extras = activeDeprecatedModels().filter((m) => !seen.has(m.id));
  return extras.length > 0 ? [...models, ...extras] : models;
}

function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  // Merge embedded models that are missing from cache (newly added models)
  const cachedMap = new Map(cached.map(m => [m.id, m]));
  for (const em of embeddedModels) {
    if (!cachedMap.has(em.id)) {
      cached.push(em);
    }
  }
  return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider(PROVIDER_ID) ?? undefined;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    apiKey: "$ASTER_API_KEY",
    api: "openai-completions",
    models: staleModels,
  });

  // Wire ids of everything we serve, used to scope the orphan tool-call repair
  // hook to this provider (payload.model is the raw model id, not provider/id).
  const servedModelIds = new Set(staleModels.map((m) => m.id));

  function register(models: JsonModel[]): void {
    servedModelIds.clear();
    for (const m of models) servedModelIds.add(m.id);
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: BASE_URL,
      apiKey: "$ASTER_API_KEY",
      api: "openai-completions",
      models,
    });
  }

  // Conversation compaction can drop tool result messages while keeping the
  // assistant message that made the call; Aster's backends (vLLM-style) 400 on
  // tool_calls without matching tool messages. Insert synthetic results so
  // compacted histories stay submittable.
  pi.on("before_provider_request", async (event) => {
    const p = event.payload as Record<string, any>;
    const model: string = p.model ?? "";
    if (!servedModelIds.has(model)) return;

    const messages = p.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const toolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id);
        }
      }
    }

    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id);
      }
    }

    const orphanedIds = [...toolCallIds].filter((id) => !toolResultIds.has(id));
    if (orphanedIds.length === 0) return;

    const newMessages = [...messages];
    let insertOffset = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;

      const orphanedCalls = msg.tool_calls.filter((tc: any) =>
        orphanedIds.includes(tc.id),
      );
      if (orphanedCalls.length === 0) continue;

      const insertIdx = i + insertOffset + 1;
      const syntheticResults = orphanedCalls.map((tc: any) => ({
        role: "tool",
        tool_call_id: tc.id,
        content: "[tool result was lost during context compaction]",
      }));

      newMessages.splice(insertIdx, 0, ...syntheticResults);
      insertOffset += orphanedCalls.length;
    }

    p.messages = newMessages;
    return p;
  });

  pi.on("session_start", async (_event, ctx) => {
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    resolveApiKey(ctx.modelRegistry).then(() => {
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          register(buildModels(freshBase, customModels, patches));
        }
      });
    });
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
  });
}
