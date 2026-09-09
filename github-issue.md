# Feature: Parse `LanguageModelDataPart("usage")` into `IChatResponseModel.usage` for ChatContextUsageWidget

## Description

Third-party `LanguageModelChatProvider` extensions that report usage data via `LanguageModelDataPart` with mimeType `"usage"` are not reflected in the `ChatContextUsageWidget` (context window progress indicator). The widget always shows "0 / X tokens (0%)" even though the provider correctly streams usage data.

## Current Behavior

When a `LanguageModelChatProvider` reports usage via:

```ts
progress.report(new vscode.LanguageModelDataPart(
  new TextEncoder().encode(JSON.stringify({
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 10 }
  })),
  "usage"
));
```

The data flows through:

1. `ExtHostLanguageModels` → converts to `IChatResponseDataPart { type: 'data', mimeType: 'usage', data: ... }`
2. `MainThreadLanguageModels` → `$reportResponsePart` → emits to stream
3. Chat framework consumes stream → **does not parse `data` parts into `IChatProgress { kind: 'usage' }`**
4. `IChatResponseModel.usage` remains `undefined`
5. `ChatContextUsageWidget` shows 0%

## Expected Behavior

The Chat framework should detect `type: 'data' && mimeType === 'usage'` in the response stream from `LanguageModelChatProvider`, parse the JSON payload, and populate `IChatResponseModel.usage` with `{ promptTokens, completionTokens }` so the `ChatContextUsageWidget` displays accurate context window usage.

## Root Cause

The Copilot extension (which is also a `ChatParticipant`) can use `stream.usage({ promptTokens, completionTokens })` to directly set `IChatUsage` on the response model. However, third-party `LanguageModelChatProvider` extensions only have access to `progress.report(LanguageModelDataPart)`, and the Chat framework does not extract usage data from `LanguageModelDataPart` parts in the provider's response stream.

This is visible in the code path:
- `chatModel.ts`: `acceptResponseProgress` handles `progress.kind === 'usage'` → `setUsage(progress)`
- But the stream from `LanguageModelChatProvider` never produces a part with `kind: 'usage'`

The same `LanguageModelDataPart("usage")` pattern is used by Copilot's own BYOK providers (Anthropic, Gemini) — see `extensions/copilot/src/extension/byok/vscode-node/anthropicProvider.ts` and `geminiNativeProvider.ts`. These work because the Copilot wrapper (`CopilotLanguageModelWrapper`) is also a `ChatParticipant` that can call `stream.usage()` as a fallback. Third-party providers don't have this option.

## Proposed Fix

In the Chat framework's response stream processing (wherever `IChatResponsePart` from `LanguageModelChatProvider` is consumed and converted to `IChatProgress`), add handling for:

```ts
if (part.type === 'data' && part.mimeType === 'usage') {
  try {
    const usage = JSON.parse(new TextDecoder().decode(part.data));
    if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
      // Emit as IChatProgress { kind: 'usage', promptTokens, completionTokens }
    }
  } catch { /* ignore malformed usage data */ }
}
```

This would be a ~10 line addition and would make the `ChatContextUsageWidget` work for all third-party `LanguageModelChatProvider` extensions.

## Impact

- All third-party BYOK / national-market AI provider extensions (e.g., DeepSeek, Kimi, Qwen, Zhipu, etc.) would benefit
- No breaking changes — existing providers that don't emit usage data are unaffected
- Aligns the behavior with what Copilot's own BYOK providers already expect

## References

- `src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts` — the widget that reads `response.usage`
- `src/vs/workbench/contrib/chat/common/model/chatModel.ts` — `acceptResponseProgress` handling of `kind: 'usage'`
- `src/vs/workbench/api/common/extHostLanguageModels.ts` — where provider's `LanguageModelDataPart` is converted to `IChatResponseDataPart`
- `extensions/copilot/src/extension/byok/vscode-node/anthropicProvider.ts` — Copilot's own provider using the same `LanguageModelDataPart("usage")` pattern
