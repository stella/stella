import { generateText, isFileUIPart, isTextUIPart, isToolUIPart } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { Result } from "better-result";

import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { prepareTextForThirdParty } from "@/api/handlers/chat/third-party-boundary";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 12;
const FILE_PART_ESTIMATED_TOKENS = 8000;
const DEFAULT_TRIGGER_TOKENS = 64_000;
const DEFAULT_PRESERVE_TOKENS = 38_000;
const MAX_TEXT_PART_CHARS = 8000;
const MAX_STRUCTURED_PART_CHARS = 4000;
const MAX_SUMMARY_OUTPUT_TOKENS = 1800;

const COMPACTION_SUMMARY_MESSAGE_ID = "stella-chat-compaction-summary";

const COMPACTION_SYSTEM_PROMPT = [
  "You compact chat history for stella, a legal workspace.",
  "Write a concise checkpoint that lets the next assistant continue the work without rereading the earlier messages.",
  "Preserve concrete facts, parties, dates, jurisdictions, source documents, cited law, tool findings, decisions already made, open tasks, user preferences, and unresolved questions.",
  "Do not invent facts. Keep placeholder tokens, IDs, citations, and quoted legal terms exactly as provided.",
].join("\n");

type ChatCompactionPlan =
  | {
      totalTokens: number;
      type: "none";
    }
  | {
      messagesToSummarize: ChatMessage[];
      preservedTokens: number;
      recentMessages: ChatMessage[];
      totalTokens: number;
      type: "compact";
    };

type ModelCompactionPlan =
  | {
      totalTokens: number;
      type: "none";
    }
  | {
      messagesToSummarize: ModelMessage[];
      preservedTokens: number;
      recentMessages: ModelMessage[];
      totalTokens: number;
      type: "compact";
    };

type PlanChatCompactionOptions = {
  messages: ChatMessage[];
  preserveTokens?: number | undefined;
  triggerTokens?: number | undefined;
};

export const planChatCompaction = ({
  messages,
  preserveTokens = DEFAULT_PRESERVE_TOKENS,
  triggerTokens = DEFAULT_TRIGGER_TOKENS,
}: PlanChatCompactionOptions): ChatCompactionPlan => {
  const totalTokens = estimateMessagesTokens(messages);
  if (totalTokens <= triggerTokens) {
    return { totalTokens, type: "none" };
  }

  const recentMessages: ChatMessage[] = [];
  let preservedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (!message) {
      continue;
    }

    const messageTokens = estimateMessageTokens(message);
    if (
      recentMessages.length > 0 &&
      preservedTokens + messageTokens > preserveTokens
    ) {
      break;
    }

    preservedTokens += messageTokens;
    recentMessages.unshift(message);
  }

  const messagesToSummarize = messages.slice(
    0,
    messages.length - recentMessages.length,
  );
  if (messagesToSummarize.length === 0) {
    return { totalTokens, type: "none" };
  }

  return {
    messagesToSummarize,
    preservedTokens,
    recentMessages,
    totalTokens,
    type: "compact",
  };
};

export const planModelCompaction = ({
  messages,
  preserveTokens = DEFAULT_PRESERVE_TOKENS,
  triggerTokens = DEFAULT_TRIGGER_TOKENS,
}: {
  messages: ModelMessage[];
  preserveTokens?: number | undefined;
  triggerTokens?: number | undefined;
}): ModelCompactionPlan => {
  const totalTokens = estimateModelMessagesTokens(messages);
  if (totalTokens <= triggerTokens) {
    return { totalTokens, type: "none" };
  }

  const recentMessages: ModelMessage[] = [];
  let preservedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (!message) {
      continue;
    }

    const messageTokens = estimateModelMessageTokens(message);
    if (
      recentMessages.length > 0 &&
      preservedTokens + messageTokens > preserveTokens
    ) {
      break;
    }

    preservedTokens += messageTokens;
    recentMessages.unshift(message);
  }

  const messagesToSummarize = messages.slice(
    0,
    messages.length - recentMessages.length,
  );
  if (messagesToSummarize.length === 0) {
    return { totalTokens, type: "none" };
  }

  return {
    messagesToSummarize,
    preservedTokens,
    recentMessages,
    totalTokens,
    type: "compact",
  };
};

type CompactChatMessagesOptions = PlanChatCompactionOptions & {
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
  prepareTranscript?:
    | ((transcript: string) => Promise<Result<string, HandlerError<422 | 500>>>)
    | undefined;
  summarizeTranscript: (transcript: string) => Promise<string>;
};

type CompactModelMessagesOptions = {
  messages: ModelMessage[];
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
  preserveTokens?: number | undefined;
  summarizeTranscript: (transcript: string) => Promise<string>;
  triggerTokens?: number | undefined;
};

export const compactChatMessages = async ({
  messages,
  onSummaryError,
  prepareTranscript,
  preserveTokens,
  summarizeTranscript,
  triggerTokens,
}: CompactChatMessagesOptions): Promise<
  Result<ChatMessage[], HandlerError<422 | 500>>
> => {
  const plan = planChatCompaction({ messages, preserveTokens, triggerTokens });
  if (plan.type === "none") {
    return Result.ok(messages);
  }

  const transcript = renderChatMessagesForCompaction(plan.messagesToSummarize);
  const preparedTranscript = prepareTranscript
    ? await prepareTranscript(transcript)
    : Result.ok(transcript);
  if (Result.isError(preparedTranscript)) {
    return Result.err(preparedTranscript.error);
  }

  const summaryResult = await Result.tryPromise({
    try: async () => await summarizeTranscript(preparedTranscript.value),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to compact chat history",
        cause,
      }),
  });
  if (Result.isError(summaryResult)) {
    onSummaryError?.(summaryResult.error);
    return Result.ok(plan.recentMessages);
  }

  const summary = summaryResult.value.trim();
  if (summary.length === 0) {
    return Result.ok(plan.recentMessages);
  }

  return Result.ok([
    createCompactionSummaryMessage({
      summarizedMessageCount: plan.messagesToSummarize.length,
      summary,
    }),
    ...plan.recentMessages,
  ]);
};

export const compactModelMessages = async ({
  messages,
  onSummaryError,
  preserveTokens,
  summarizeTranscript,
  triggerTokens,
}: CompactModelMessagesOptions): Promise<
  Result<ModelMessage[], HandlerError<500>>
> => {
  const plan = planModelCompaction({ messages, preserveTokens, triggerTokens });
  if (plan.type === "none") {
    return Result.ok(messages);
  }

  const transcript = renderModelMessagesForCompaction(plan.messagesToSummarize);
  const summaryResult = await Result.tryPromise({
    try: async () => await summarizeTranscript(transcript),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to compact model step history",
        cause,
      }),
  });
  if (Result.isError(summaryResult)) {
    onSummaryError?.(summaryResult.error);
    return Result.ok(plan.recentMessages);
  }

  const summary = summaryResult.value.trim();
  if (summary.length === 0) {
    return Result.ok(plan.recentMessages);
  }

  return Result.ok([
    createModelCompactionSummaryMessage({
      summarizedMessageCount: plan.messagesToSummarize.length,
      summary,
    }),
    ...plan.recentMessages,
  ]);
};

type CompactChatMessagesForModelOptions = PlanChatCompactionOptions & {
  abortSignal: AbortSignal;
  boundary: ChatThirdPartyBoundary;
  model: LanguageModel;
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
};

type CompactModelMessagesForModelOptions = {
  abortSignal: AbortSignal;
  messages: ModelMessage[];
  model: LanguageModel;
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
};

export const compactChatMessagesForModel = async ({
  abortSignal,
  boundary,
  messages,
  model,
  onSummaryError,
  preserveTokens,
  triggerTokens,
}: CompactChatMessagesForModelOptions): Promise<
  Result<ChatMessage[], HandlerError<422 | 500>>
> =>
  await compactChatMessages({
    messages,
    onSummaryError,
    preserveTokens,
    triggerTokens,
    prepareTranscript: async (transcript) =>
      await prepareTextForThirdParty({ boundary, text: transcript }),
    summarizeTranscript: async (transcript) => {
      const result = await generateText({
        abortSignal,
        maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
        model,
        prompt: [
          "Compact the earlier conversation transcript below.",
          "Return only the checkpoint summary.",
          "",
          transcript,
        ].join("\n"),
        system: COMPACTION_SYSTEM_PROMPT,
        temperature: 0,
      });

      return result.text;
    },
  });

export const compactModelMessagesForModel = async ({
  abortSignal,
  messages,
  model,
  onSummaryError,
}: CompactModelMessagesForModelOptions): Promise<
  Result<ModelMessage[], HandlerError<500>>
> =>
  await compactModelMessages({
    messages,
    onSummaryError,
    summarizeTranscript: async (transcript) => {
      const result = await generateText({
        abortSignal,
        maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
        model,
        prompt: [
          "Compact the earlier model-step transcript below.",
          "Return only the checkpoint summary.",
          "",
          transcript,
        ].join("\n"),
        system: COMPACTION_SYSTEM_PROMPT,
        temperature: 0,
      });

      return result.text;
    },
  });

export const renderChatMessagesForCompaction = (
  messages: readonly ChatMessage[],
): string =>
  messages
    .map((message, index) =>
      [
        `<message index="${index + 1}" role="${message.role}" id="${message.id}">`,
        ...message.parts.map(renderPartForCompaction),
        "</message>",
      ].join("\n"),
    )
    .join("\n\n");

export const renderModelMessagesForCompaction = (
  messages: readonly ModelMessage[],
): string =>
  messages
    .map((message, index) =>
      [
        `<message index="${index + 1}" role="${message.role}">`,
        renderTaggedValue(
          "content",
          truncateForCompaction(
            renderModelMessageContent(message),
            MAX_STRUCTURED_PART_CHARS,
          ),
        ),
        "</message>",
      ].join("\n"),
    )
    .join("\n\n");

const createCompactionSummaryMessage = ({
  summarizedMessageCount,
  summary,
}: {
  summarizedMessageCount: number;
  summary: string;
}): ChatMessage => ({
  id: COMPACTION_SUMMARY_MESSAGE_ID,
  role: "system",
  parts: [
    {
      type: "text",
      text: [
        `Earlier conversation compacted from ${summarizedMessageCount} message(s).`,
        summary,
      ].join("\n\n"),
    },
  ],
});

const createModelCompactionSummaryMessage = ({
  summarizedMessageCount,
  summary,
}: {
  summarizedMessageCount: number;
  summary: string;
}): ModelMessage => ({
  role: "system",
  content: [
    `Earlier model-step history compacted from ${summarizedMessageCount} message(s).`,
    summary,
  ].join("\n\n"),
});

const estimateMessagesTokens = (messages: readonly ChatMessage[]): number =>
  messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );

const estimateMessageTokens = (message: ChatMessage): number =>
  message.parts.reduce(
    (total, part) => total + estimatePartTokens(part),
    MESSAGE_OVERHEAD_TOKENS,
  );

const estimatePartTokens = (part: ChatMessage["parts"][number]): number => {
  if (isTextUIPart(part)) {
    return estimateTextTokens(part.text);
  }

  if (isFileUIPart(part)) {
    return FILE_PART_ESTIMATED_TOKENS;
  }

  return estimateTextTokens(safeStringify(part));
};

const estimateTextTokens = (text: string): number =>
  Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);

const estimateModelMessagesTokens = (
  messages: readonly ModelMessage[],
): number =>
  messages.reduce(
    (total, message) => total + estimateModelMessageTokens(message),
    0,
  );

const estimateModelMessageTokens = (message: ModelMessage): number =>
  MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(safeStringify(message));

const renderPartForCompaction = (
  part: ChatMessage["parts"][number],
): string => {
  if (isTextUIPart(part)) {
    return renderTaggedValue(
      "text",
      truncateForCompaction(part.text, MAX_TEXT_PART_CHARS),
    );
  }

  if (isFileUIPart(part)) {
    return renderTaggedValue(
      "file",
      [
        `name: ${part.filename ?? "unnamed"}`,
        `mediaType: ${part.mediaType}`,
        "content: omitted; old file attachments are not rehydrated during compaction",
      ].join("\n"),
    );
  }

  if (isToolUIPart(part)) {
    return renderTaggedValue(
      "tool",
      truncateForCompaction(safeStringify(part), MAX_STRUCTURED_PART_CHARS),
    );
  }

  return renderTaggedValue(
    part.type,
    truncateForCompaction(safeStringify(part), MAX_STRUCTURED_PART_CHARS),
  );
};

const renderModelMessageContent = (message: ModelMessage): string => {
  if (typeof message.content === "string") {
    return message.content;
  }

  return safeStringify(message.content);
};

const renderTaggedValue = (tag: string, value: string): string =>
  `<${tag}>\n${value}\n</${tag}>`;

const truncateForCompaction = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
};

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
};
