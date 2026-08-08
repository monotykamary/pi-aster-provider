# pi-aster-provider

A [pi](https://github.com/badlogic/pi-mono) extension that adds [Aster](https://asterlab.ai) as a custom model provider.

## Features

- **OpenAI-compatible API** — Uses Aster's `/v1/chat/completions` endpoint
- **Coding-optimized models** — Kimi K3 (1M context), GLM 5.2, GPT-OSS 120B, and more
- **Reasoning models** — All chat models think by default; control depth with `/reasoning`
- **Tool use** — Function calling works on every chat model
- **Prompt caching** — Discounted cached input on GLM and Kimi K3
- **Batch variant** — `zai-org/glm-5.2-batch`, the discounted GLM 5.2 batch lane
- **Live model sync** — Models refresh from the Aster API in the background

## Available Models

| Model | ID | Context | Max Output | Vision | Reasoning | Cache | Input $/M | Output $/M |
|-------|----|---------|------------|--------|-----------|-------|-----------|------------|
| GLM 5.2 | `glm-5.2` | 1.0M | 131K | ❌ | ✅ | ✅ | $1.00 | $4.00 |
| GLM 5.2 Batch | `zai-org/glm-5.2-batch` | 1.0M | 131K | ❌ | ✅ | ❌ | $0.75 | $2.50 |
| GPT OSS 120B | `gpt-oss-120b` | 131K | 33K | ❌ | ✅ | ❌ | $0.15 | $0.60 |
| GPT OSS 120B Fast | `gpt-oss-120b-fast` | 131K | 33K | ❌ | ✅ | ❌ | $0.15 | $0.60 |
| Kimi K3 | `kimi-k3` | 1.0M | 131K | ❌ | ✅ | ✅ | $2.50 | $12.50 |

*Costs are per million tokens.*

Non-chat endpoints (e.g. `aster/wildflower`, per-call search pricing) are intentionally excluded.

## Installation

### Option 1: Using `pi install` (Recommended)

Install directly from GitHub:

```bash
pi install git:github.com/monotykamary/pi-aster-provider
```

Then set your API key and run pi:
```bash
# Recommended: add to auth.json
# See Authentication section below

# Or set as environment variable
export ASTER_API_KEY=your-api-key-here

pi
```

Get your API key from [asterlab.ai](https://asterlab.ai).

### Option 2: Manual Clone

1. Clone this repository:
   ```bash
   git clone https://github.com/monotykamary/pi-aster-provider.git
   cd pi-aster-provider
   ```

2. Set your Aster API key:
   ```bash
   # Recommended: add to auth.json
   # See Authentication section below

   # Or set as environment variable
   export ASTER_API_KEY=your-api-key-here
   ```

3. Run pi with the extension:
   ```bash
   pi -e /path/to/pi-aster-provider
   ```

## Authentication

The Aster API key can be configured in multiple ways (resolved in this order):

1. **`auth.json`** (recommended) — Add to `~/.pi/agent/auth.json`:
   ```json
   { "aster": { "type": "api_key", "key": "your-api-key" } }
   ```
   The `key` field supports literal values, env var names, and shell commands (prefix with `!`). See [pi's auth file docs](https://github.com/badlogic/pi-mono) for details.
2. **Runtime override** — Use the `--api-key` CLI flag
3. **Environment variable** — Set `ASTER_API_KEY`

Get your API key from [asterlab.ai](https://asterlab.ai).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ASTER_API_KEY` | No | Your Aster API key (fallback if not in auth.json) |

## Configuration

Add to your pi configuration for automatic loading:

```json
{
  "extensions": [
    "/path/to/pi-aster-provider"
  ]
}
```

## Usage

Once loaded, select a model with:

```
/model aster kimi-k3
```

Or use `/models` to browse all available Aster models.

### Reasoning Effort

All Aster chat models are reasoning models (thinking is on by default). Control thinking depth:

```
/reasoning high
```

Levels: `off`, `minimal`, `low`, `medium`, `high`. `off` maps to `reasoning_effort: none`
(disables thinking); the rest pass through to the `reasoning_effort` request field.

## API Compatibility Notes

- Reasoning streams as the `reasoning_content` field (DeepSeek-style), which pi parses natively.
- Both `max_tokens` and `max_completion_tokens` are honored; the extension sends `max_completion_tokens`.
- GPT-OSS models strictly validate `prompt + max_completion_tokens ≤ context` (131K), so their
  curated max output is held to 32K; GLM 5.2 and Kimi K3 accept up to 128K completion tokens.
- Image input is not supported by Aster's chat models (text-only).

## Updating Models

To refresh the model list from the Aster API:

```bash
npm run update-models
```

This fetches from `/v1/models`, updates `models.json`, and regenerates this README. Idempotent — safe to run repeatedly.

## API Documentation

- Aster: https://asterlab.ai
- OpenAI-compatible endpoint: `https://api.asterlab.ai/v1`
- Models endpoint: `https://api.asterlab.ai/v1/models`

## License

MIT
