// Text that makes the mock model stream one kind of chunk as hundreds of tiny
// deltas (`mock-ai-stream-kinds.ts`), keyed by the chunk kinds the web app's
// thread page budgets its commits for
// (`apps/web/src/features/chat/stream-chunk-commit-budget.ts`). The web app
// cannot import the api, so it spells the same markers in its budget table;
// `apps/web/e2e/unit/stream-chunk-mock-markers.test.ts` holds the two maps
// equal. Kept free of imports so that test can read it.

export const MOCK_AI_STREAM_KIND_MARKERS = {
  reasoning: "Stream reasoning in tiny deltas please",
  status: "Stream status updates in tiny deltas please",
  subagent: "Stream a subagent run in tiny deltas please",
  text: "Stream the answer text in tiny deltas please",
  "tool-input": "Stream a tool input in tiny deltas please",
  "tool-output": "Stream tool outputs in tiny deltas please",
} as const;

export type MockAiStreamKind = keyof typeof MOCK_AI_STREAM_KIND_MARKERS;
