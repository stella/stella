import type { OwnershipEntry } from "../ownership-types.ts";
// Model requests whose content never comes from a chat thread: documents,
// matters, templates, playbooks and public corpora, requested outside chat.
const MODEL_REQUESTS_WITHOUT_CHAT_CONTENT = [
  "apps/api/src/handlers/ai-autocomplete/stream.ts",
  "apps/api/src/handlers/case-law/analysis/generate.ts",
  "apps/api/src/handlers/case-law/analysis/significance-run.ts",
  "apps/api/src/handlers/case-law/decisions/search-expand.ts",
  "apps/api/src/handlers/case-law/decisions/search-refine.ts",
  "apps/api/src/handlers/case-law/polarity/llm-classifier.ts",
  "apps/api/src/handlers/clauses/rewrite.ts",
  "apps/api/src/handlers/contacts/extract-procuracao.ts",
  "apps/api/src/handlers/document-reviews/reference-positions.ts",
  "apps/api/src/handlers/entities/placements/suggest.ts",
  "apps/api/src/handlers/playbooks/derive-ask.ts",
  "apps/api/src/handlers/search/ai.ts",
  "apps/api/src/handlers/skills/drafts/generate.ts",
  "apps/api/src/handlers/skills/proposals/from-comments/create.ts",
  "apps/api/src/handlers/skills/resources/rewrite.ts",
  "apps/api/src/handlers/templates/prefill.ts",
  "apps/api/src/handlers/time-entries/polish-narrative.ts",
  "apps/api/src/lib/ai-change-summary.ts",
  "apps/api/src/lib/bbox/ai-generate-b-boxes.ts",
  "apps/api/src/lib/bilingual/ai.ts",
  "apps/api/src/lib/case-law/research-answer-runner.ts",
  "apps/api/src/lib/document-review/parties.ts",
  "apps/api/src/lib/document-review/reference-grade.ts",
  "apps/api/src/lib/document-translation/ai.ts",
  "apps/api/src/lib/flows/flow-executor.ts",
  "apps/api/src/lib/lists/verification/model-call.ts",
  "apps/api/src/lib/properties/column-prompt-suggestion.ts",
  "apps/api/src/lib/scouts/document-deadlines.ts",
  "apps/api/src/lib/workflow/ai-generate-batch.ts",
  "apps/api/src/lib/workflow/verdict-engine.ts",
] as const;
// Recognises a model request that stayed off the table below.
const MODEL_REQUEST_NAMES = [
  "collectTanStackTextRun",
  "generateChatObject",
  "generateTanStackChatObject",
  "generateTanStackObjectForRole",
  "generateTanStackTextForRole",
  "streamChatChunks",
  "streamChatObject",
  "streamTanStackChatRun",
  "streamTanStackObjectForRole",
  "streamTanStackTextForRole",
] as const;

export default {
  id: "model-request-send-mode",
  capability: "Sending a request to an AI model",
  owner: [
    "apps/api/src/lib/tanstack-ai-generate.ts",
    "apps/api/src/lib/chat/tanstack-chat-runtime.ts",
  ],
  summary:
    "Every request to a model decides how a chat thread's send mode " +
    "applies to what it carries. The chat turn, its subagents and its " +
    "compaction prepare their payload through " +
    "`handlers/chat/third-party-boundary.ts`. A request built from a " +
    "thread's stored content outside the turn (a title, a recap, " +
    "suggestions, a background summary, memory extraction) reads " +
    "`readThreadStoredContentSendModeOnTx` after loading that content and " +
    "sends nothing for a thread that used anonymized mode. The rest carry " +
    "no chat content. A new caller joins this list with its decision.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/lib/tanstack-ai-generate",
      "@/api/lib/chat/tanstack-chat-runtime",
    ],
    names: MODEL_REQUEST_NAMES,
    allowed: [
      {
        path: "apps/api/src/handlers/chat/messages/revisions/span-edit.ts",
        reason:
          "Proposes an answer rewrite from stored content; reads the thread send mode after loading the answer and refuses anonymized threads.",
      },
      {
        path: "apps/api/src/handlers/chat/stream-chat.ts",
        reason:
          "The chat turn: messages, system text, tools and resumed payloads pass through the turn's third-party boundary right before the request.",
      },
      {
        path: "apps/api/src/handlers/chat/subagent-runner.ts",
        reason:
          "A subagent's brief, messages and tools pass through the parent turn's boundary.",
      },
      {
        path: "apps/api/src/handlers/chat/compaction.ts",
        reason:
          "In-turn compaction: the transcript passes through the turn's boundary, or is already the boundary's output inside the run.",
      },
      {
        path: "apps/api/src/handlers/chat/generate-thread-title.ts",
        reason:
          "Titles a new thread from its first raw turn; reads the thread's send mode right before sending.",
      },
      {
        path: "apps/api/src/handlers/chat/suggest-thread-title.ts",
        reason:
          "Sends the window `loadRecapMessageWindow` returns, which reads the send mode after the messages.",
      },
      {
        path: "apps/api/src/handlers/chat/get-suggested-prompts.ts",
        reason:
          "Sends the window `loadRecapMessageWindow` returns, which reads the send mode after the messages.",
      },
      {
        path: "apps/api/src/handlers/chat/thread-recap.ts",
        reason:
          "Recaps the window `loadRecapMessageWindow` returns, which reads the send mode after the messages.",
      },
      {
        path: "apps/api/src/handlers/chat/improve-prompt.ts",
        reason:
          "Sends only the composer text, and refuses a request in anonymized mode.",
      },
      {
        path: "apps/api/src/lib/chat/thread-compaction.ts",
        reason:
          "Background summary: reads the send mode after the delta and again under the checkpoint lock.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/memory-extractor.ts",
        reason:
          "Claims skip anonymized threads; reads the send mode after the transcript, right before sending.",
      },
      {
        path: "apps/api/src/lib/docx/ai-field-generator.ts",
        reason:
          "Template AI fields: chat's fill_template sends their prompts and values through the turn's boundary; the fill routes carry no chat content.",
      },
      {
        path: "apps/api/src/lib/templates/suggest-template-fields.ts",
        reason:
          "Chat's suggest_template_fields prepares the text through the turn's boundary first; the template routes carry no chat content.",
      },
      ...MODEL_REQUESTS_WITHOUT_CHAT_CONTENT.map((modulePath) => ({
        path: modulePath,
        reason: "Carries no chat content.",
      })),
      {
        path: "apps/api/evals/",
        reason: "Offline evaluations over fixture conversations.",
      },
      {
        path: "apps/api/scripts/ai-native-image-canary.ts",
        reason: "Provider canary with synthetic content.",
      },
      {
        path: "apps/api/scripts/ai-provider-canary.ts",
        reason: "Provider canary with synthetic content.",
      },
      {
        path: "apps/api/scripts/ai-provider-cassette-probe.ts",
        reason: "Records provider cassettes from synthetic prompts.",
      },
      {
        path: "apps/api/scripts/benchmark-chat-read-surface.ts",
        reason: "Benchmark with synthetic content.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
