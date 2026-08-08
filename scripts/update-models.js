#!/usr/bin/env node

/**
 * Script to update Aster models from the API
 *
 * Fetches the model list from https://api.asterlab.ai/v1/models
 * and regenerates models.json and the README model table.
 *
 * API key: the stored `aster` credential in ~/.pi/agent/auth.json wins, then
 * the ASTER_API_KEY environment variable. The script refuses to run without one.
 * Usage: ASTER_API_KEY=your-key node scripts/update-models.js
 */

import https from 'https';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// pi's agent directory: PI_CODING_AGENT_DIR (with ~ expansion) or ~/.pi/agent.
function piAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith('~/') || envDir === '~'
      ? path.join(os.homedir(), envDir.slice(1))
      : envDir;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

const AUTH_JSON_PATH = path.join(piAgentDir(), 'auth.json');

/**
 * Resolve a configured value using pi's semantics (resolve-config-value.ts in
 * pi-mono): "!command" runs via the shell (10s timeout) and uses trimmed
 * stdout; "$VAR" / "${VAR}" interpolate environment variables ("$$" escapes a
 * literal "$", "$!" a literal "!"); anything else is a literal. Returns
 * undefined when a referenced env var is unset or a command fails.
 */
function resolveConfigValue(config, env) {
  if (typeof config !== 'string' || config.length === 0) return undefined;
  if (config.startsWith('!')) {
    try {
      const out = execSync(config.slice(1), {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let resolved = '';
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf('$', index);
    if (dollar < 0) {
      resolved += config.slice(index);
      break;
    }
    resolved += config.slice(index, dollar);
    const next = config[dollar + 1];
    let name;
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    } else if (next === '{') {
      const end = config.indexOf('}', dollar + 2);
      if (end < 0) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      const inner = config.slice(dollar + 2, end);
      if (!ENV_NAME_RE.test(inner)) {
        resolved += config.slice(dollar, end + 1);
        index = end + 1;
        continue;
      }
      name = inner;
      index = end + 1;
    } else {
      const match = config.slice(dollar + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      name = match[0];
      index = dollar + 1 + name.length;
    }
    const value = (env && env[name]) || process.env[name] || undefined;
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

/**
 * The API key, resolved the way pi itself resolves it for this provider: the
 * stored `aster` credential in ~/.pi/agent/auth.json wins, then
 * the ASTER_API_KEY environment variable.
 */
function resolveApiKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_JSON_PATH, 'utf8'));
    const credential = auth?.['aster'];
    if (credential && credential.type === 'api_key' && typeof credential.key === 'string') {
      const key = resolveConfigValue(credential.key, credential.env);
      if (key) return key;
    }
  } catch {
    // Missing or unparseable auth.json: fall through to the env var.
  }
  return process.env.ASTER_API_KEY || undefined;
}

const API_BASE = 'https://api.asterlab.ai/v1';
const MODELS_PATH = path.join(process.cwd(), 'models.json');
const PATCH_PATH = path.join(process.cwd(), 'patch.json');
const CUSTOM_MODELS_PATH = path.join(process.cwd(), 'custom-models.json');

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

// ─── Model transformation ──────────────────────────────────────────────────

// Aster does not report per-model output ceilings. 32K is the safe default:
// GPT-OSS strictly validates prompt + completion ≤ context (131K), so anything
// larger would start failing once a session grows past context - maxTokens.
// patch.json raises this for the long-output models (GLM/Kimi at 131072).
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

// Display name words the generic capitalizer gets wrong.
const NAME_WORD_CASES = {
  gpt: 'GPT',
  oss: 'OSS',
  glm: 'GLM',
  kimi: 'Kimi',
};

/** "zai-org/glm-5.2-batch" → "GLM 5.2 Batch"; "gpt-oss-120b" → "GPT OSS 120B". */
function prettifyName(id) {
  const slug = id.split('/').pop() || id;
  return slug
    .split('-')
    .map((token) => {
      const lower = token.toLowerCase();
      if (NAME_WORD_CASES[lower]) return NAME_WORD_CASES[lower];
      const numeric = lower.match(/^(\d+(?:\.\d+)?)([a-z]*)$/);
      if (numeric) return numeric[1] + numeric[2].toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function isChatModel(apiModel) {
  // Skip non-chat entries: search endpoints (per-search pricing) and entries
  // without a context length are not chat completions models.
  if (!apiModel || !apiModel.id) return false;
  if (typeof apiModel.context_length !== 'number' || apiModel.context_length <= 0) return false;
  const pricing = apiModel.pricing || {};
  const inputCost = pricing.input_per_million_tokens_usd ?? pricing.input ?? 0;
  const outputCost = pricing.output_per_million_tokens_usd ?? pricing.output ?? 0;
  if (inputCost <= 0 && outputCost <= 0) return false;
  return true;
}

function defaultCompat() {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_completion_tokens',
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
  };
}

function convertModel(apiModel, existingModelsMap) {
  const id = apiModel.id;
  const pricing = apiModel.pricing || {};
  const ctx = apiModel.context_length;
  const priceIn = pricing.input_per_million_tokens_usd ?? pricing.input ?? 0;
  const priceOut = pricing.output_per_million_tokens_usd ?? pricing.output ?? 0;
  const cacheRead = pricing.cached_input_per_million_tokens_usd ?? 0;

  // Preserve existing curated data (reasoning, compat, names, tuned maxTokens)
  if (existingModelsMap[id]) {
    const existing = { ...existingModelsMap[id] };
    if (ctx > 0) existing.contextWindow = ctx;
    if (priceIn > 0) existing.cost.input = priceIn;
    if (priceOut > 0) existing.cost.output = priceOut;
    if (cacheRead > 0) existing.cost.cacheRead = cacheRead;
    existing.compat = { ...(existing.compat || {}) };
    return existing;
  }

  // New model — build from API data + sensible defaults
  return {
    id,
    name: prettifyName(id),
    // All Aster chat models emit reasoning_content and accept reasoning_effort.
    reasoning: true,
    input: ['text'],
    cost: { input: priceIn, output: priceOut, cacheRead, cacheWrite: 0 },
    contextWindow: ctx,
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    thinkingLevelMap: { off: 'none' },
    compat: defaultCompat(),
  };
}

// ─── Patch & Custom Models ──────────────────────────────────────────────────

function applyPatch(model, patch) {
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

function buildModels(baseModels, customModels, patchData) {
  const modelMap = new Map();
  for (const model of baseModels) {
    modelMap.set(model.id, model);
  }
  for (const [id, patchEntry] of Object.entries(patchData)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }
  for (const model of customModels) {
    const existing = modelMap.get(model.id);
    const patchEntry = patchData[model.id];
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

// ─── README generation ──────────────────────────────────────────────────────

function formatCost(cost) {
  if (cost === 0) return 'Free';
  if (cost < 0.01) return `<$0.01`;
  return `$${cost.toFixed(2)}`;
}

function formatCtx(num) {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${Math.round(num / 1_000)}K`;
  return num.toString();
}

function generateReadme(models) {
  const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));

  const rows = sorted.map(m => {
    const vision = m.input.includes('image') ? '✅' : '❌';
    const reasoning = m.reasoning ? '✅' : '❌';
    const cache = m.cost.cacheRead > 0 ? '✅' : '❌';
    return `| ${m.name} | \`${m.id}\` | ${formatCtx(m.contextWindow)} | ${formatCtx(m.maxTokens)} | ${vision} | ${reasoning} | ${cache} | ${formatCost(m.cost.input)} | ${formatCost(m.cost.output)} |`;
  }).join('\n');

  const readme = `# pi-aster-provider

A [pi](https://github.com/badlogic/pi-mono) extension that adds [Aster](https://asterlab.ai) as a custom model provider.

## Features

- **OpenAI-compatible API** — Uses Aster's \`/v1/chat/completions\` endpoint
- **Coding-optimized models** — Kimi K3 (1M context), GLM 5.2, GPT-OSS 120B, and more
- **Reasoning models** — All chat models think by default; control depth with \`/reasoning\`
- **Tool use** — Function calling works on every chat model
- **Prompt caching** — Discounted cached input on GLM and Kimi K3
- **Batch variant** — \`zai-org/glm-5.2-batch\`, the discounted GLM 5.2 batch lane
- **Live model sync** — Models refresh from the Aster API in the background

## Available Models

| Model | ID | Context | Max Output | Vision | Reasoning | Cache | Input $/M | Output $/M |
|-------|----|---------|------------|--------|-----------|-------|-----------|------------|
${rows}

*Costs are per million tokens.*

Non-chat endpoints (e.g. \`aster/wildflower\`, per-call search pricing) are intentionally excluded.

## Installation

### Option 1: Using \`pi install\` (Recommended)

Install directly from GitHub:

\`\`\`bash
pi install git:github.com/monotykamary/pi-aster-provider
\`\`\`

Then set your API key and run pi:
\`\`\`bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export ASTER_API_KEY=your-api-key-here

pi
\`\`\`

Get your API key from [asterlab.ai](https://asterlab.ai).

### Option 2: Manual Clone

1. Clone this repository:
   \`\`\`bash
   git clone https://github.com/monotykamary/pi-aster-provider.git
   cd pi-aster-provider
   \`\`\`

2. Set your Aster API key:
   \`\`\`bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export ASTER_API_KEY=your-api-key-here
   \`\`\`

3. Run pi with the extension:
   \`\`\`bash
   pi -e /path/to/pi-aster-provider
   \`\`\`

## Authentication

The Aster API key can be configured in multiple ways (resolved in this order):

1. **\`auth.json\`** (recommended) — Add to \`~/.pi/agent/auth.json\`:
   \`\`\`json
   { "aster": { "type": "api_key", "key": "your-api-key" } }
   \`\`\`
   The \`key\` field supports literal values, env var names, and shell commands (prefix with \`!\`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the \`--api-key\` CLI flag
3. **Environment variable** — Set \`ASTER_API_KEY\`

Get your API key from [asterlab.ai](https://asterlab.ai).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`ASTER_API_KEY\` | No | Your Aster API key (fallback if not in auth.json) |

## Configuration

Add to your pi configuration for automatic loading:

\`\`\`json
{
  "extensions": [
    "/path/to/pi-aster-provider"
  ]
}
\`\`\`

## Usage

Once loaded, select a model with:

\`\`\`
/model aster kimi-k3
\`\`\`

Or use \`/models\` to browse all available Aster models.

### Reasoning Effort

All Aster chat models are reasoning models (thinking is on by default). Control thinking depth:

\`\`\`
/reasoning high
\`\`\`

Levels are model-dependent (\`off\` … \`max\`); pi clamps to the nearest level each model supports and the extension
passes the mapped value through as the \`reasoning_effort\` request field. Support matrix (probed against Aster):

- **gpt-oss-120b / -fast**: \`low\` \`medium\` \`high\` — canonically fixed at three levels; thinking cannot be disabled
  (\`none\` is accepted but the model still reasons), and \`minimal\`/\`xhigh\`/\`max\` are rejected with HTTP 400.
- **glm-5.2 / glm-5.2-batch**: \`off\` maps to \`none\` (disables thinking), \`low\`, \`medium\`, \`high\`, \`max\`.
  \`minimal\` and \`xhigh\` are rejected (Z.AI canonical semantics map \`low\`/\`medium\` onto \`high\` behavior).
- **kimi-k3**: \`low\`, \`high\`, \`max\` (Moonshot canonical — K3 defaults to max thinking and thinking stays on).

## API Compatibility Notes

- Reasoning streams as the \`reasoning_content\` field (DeepSeek-style), which pi parses natively.
- Both \`max_tokens\` and \`max_completion_tokens\` are honored; the extension sends \`max_completion_tokens\`.
- GPT-OSS models strictly validate \`prompt + max_completion_tokens ≤ context\` (131K), so their
  curated max output is held to 32K; GLM 5.2 and Kimi K3 accept up to 128K completion tokens.
- Image input is not supported by Aster's chat models (text-only).

## Updating Models

To refresh the model list from the Aster API:

\`\`\`bash
npm run update-models
\`\`\`

This fetches from \`/v1/models\`, updates \`models.json\`, and regenerates this README. Idempotent — safe to run repeatedly.

## API Documentation

- Aster: https://asterlab.ai
- OpenAI-compatible endpoint: \`https://api.asterlab.ai/v1\`
- Models endpoint: \`https://api.asterlab.ai/v1/models\`

## License

MIT
`;

  return readme;
}

// ─── Main ────────────────────────────────────────────────────────────────────

// Grace period for delisted models: update-models.js moves models the API no
// longer lists into deprecated-models.json (stamped with deprecatedAt) instead
// of dropping them; the runtime appends them back so sessions and saved model
// settings keep working, and after 14 days they are evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Reconcile deprecated-models.json against the freshly fetched model list.
 * - in old models.json but not the API: moved into the deprecated file
 *   (deprecatedAt = now; preserved on repeat runs so the grace clock is not reset)
 * - back in the API: resurrected (dropped from the deprecated file)
 * - deprecatedAt older than 14 days: evicted permanently
 * Must run BEFORE the new models.json is written; it reads the old file itself.
 */
function updateDeprecatedModels(modelsJsonPath, newModels) {
  const deprecatedPath = path.join(path.dirname(modelsJsonPath), 'deprecated-models.json');

  let oldModels = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
    if (Array.isArray(parsed)) oldModels = parsed;
  } catch { /* first run: no previous models.json */ }

  let deprecated = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(deprecatedPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) deprecated = parsed;
  } catch { /* no graveyard yet */ }

  const currentIds = new Set(newModels.map(m => m.id));
  const now = new Date().toISOString();
  const added = [];
  const resurrected = [];
  const evicted = [];

  for (const old of oldModels) {
    if (old && old.id && !currentIds.has(old.id) && !deprecated[old.id]) {
      deprecated[old.id] = { ...old, deprecatedAt: now };
      added.push(old.id);
    }
  }

  for (const [id, entry] of Object.entries(deprecated)) {
    if (currentIds.has(id)) {
      delete deprecated[id];
      resurrected.push(id);
      continue;
    }
    const removedAt = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : '');
    if (Number.isNaN(removedAt) || Date.now() - removedAt > DEPRECATED_MODEL_TTL_MS) {
      delete deprecated[id];
      evicted.push(id);
    }
  }

  if (added.length > 0 || resurrected.length > 0 || evicted.length > 0) {
    fs.writeFileSync(deprecatedPath, JSON.stringify(deprecated, null, 2) + '\n');
    console.log('Updated deprecated-models.json ' + JSON.stringify({ added, resurrected, evicted }));
  }
}

async function main() {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error('Error: No API key found: no `aster` credential resolved from ' + AUTH_JSON_PATH + ' and ASTER_API_KEY is not set');
    console.error('Usage: ASTER_API_KEY=your-key node scripts/update-models.js');
    process.exit(1);
  }

  console.log('Fetching models from Aster API...\n');

  try {
    const data = await fetchJSON(`${API_BASE}/models`, {
      Authorization: `Bearer ${apiKey}`,
    });

    const apiModels = data.data || [];
    console.log(`Total entries from API: ${apiModels.length}`);

    // Load existing models.json — source of truth for curated specs
    let existingModels = [];
    try {
      existingModels = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
    } catch (e) {
      // File might not exist or be invalid
    }
    const existingModelsMap = {};
    for (const m of existingModels) {
      existingModelsMap[m.id] = m;
    }

    const chatModels = apiModels.filter(isChatModel);
    const skipped = apiModels.filter(m => !isChatModel(m)).map(m => m.id);
    if (skipped.length > 0) console.log(`Skipped non-chat entries: ${skipped.join(', ')}`);

    const models = chatModels.map(m => convertModel(m, existingModelsMap));
    console.log(`Converted ${models.length} chat models`);

    // Save models.json (pure API output + defaults, no patch/custom baked in)
    // Move delisted models to deprecated-models.json BEFORE models.json is overwritten
    updateDeprecatedModels(MODELS_PATH, models);
    fs.writeFileSync(MODELS_PATH, JSON.stringify(models, null, 2) + '\n');
    console.log(`✓ Saved ${models.length} models to models.json`);

    // Build full model list for README: base → patch → custom
    let patchData = {};
    let customModels = [];
    try {
      patchData = JSON.parse(fs.readFileSync(PATCH_PATH, 'utf8'));
      console.log(`✓ Loaded ${Object.keys(patchData).length} patch overrides from patch.json`);
    } catch {}
    try {
      customModels = JSON.parse(fs.readFileSync(CUSTOM_MODELS_PATH, 'utf8'));
      if (!Array.isArray(customModels)) customModels = [];
    } catch {}
    const readmeModels = buildModels(models, customModels, patchData);

    // Update README
    const readme = generateReadme(readmeModels);
    fs.writeFileSync(path.join(process.cwd(), 'README.md'), readme);
    console.log(`✓ Updated README.md`);

    console.log('\nDone!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
