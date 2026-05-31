import type { ModelMessage } from "ai";

const codePointOf = (value: string): number => {
  const code = value.codePointAt(0);
  if (code === undefined) {
    return 0;
  }
  return code;
};

const TOOL_CALL_LOOP_THRESHOLD = 5;
const LOOP_RECOVERY_INTERVAL = 5;
const PERSISTENT_LOOP_REPETITION_LIMIT = 15;
const CONTENT_CHUNK_SIZE = 50;
const CONTENT_LOOP_THRESHOLD = 10;
const CONTENT_HISTORY_CHARS = 5000;
const BOX_DRAWING_START_CODE_POINT = codePointOf("\u2500");
const BOX_DRAWING_END_CODE_POINT = codePointOf("\u257f");
const DIGIT_ZERO_CODE_POINT = 48;
const DIGIT_NINE_CODE_POINT = 57;

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantContentPart = Exclude<
  AssistantMessage["content"],
  string
>[number];
type ToolCallPart = Extract<AssistantContentPart, { type: "tool-call" }>;

type ToolCallLoopDetection = {
  repetitionCount: number;
  toolName: string;
  type: "tool-call-loop";
};

type ContentLoopDetection = {
  repetitionCount: number;
  type: "content-loop";
};

export type ModelLoopDetection =
  | {
      type: "none";
    }
  | ToolCallLoopDetection
  | ContentLoopDetection;

export const detectModelLoop = (
  messages: readonly ModelMessage[],
): ModelLoopDetection => {
  const currentTurnMessages = getCurrentTurnMessages(messages);
  const toolCallLoop = detectToolCallLoop(currentTurnMessages);
  if (toolCallLoop.type !== "none") {
    return toolCallLoop;
  }

  return detectContentLoop(currentTurnMessages);
};

export const shouldInjectLoopRecovery = (
  detection: ModelLoopDetection,
): detection is Exclude<ModelLoopDetection, { type: "none" }> => {
  if (detection.type === "none") {
    return false;
  }

  return detection.repetitionCount % LOOP_RECOVERY_INTERVAL === 0;
};

export const shouldStopLoopRecovery = (
  detection: ModelLoopDetection,
): detection is Exclude<ModelLoopDetection, { type: "none" }> => {
  if (detection.type === "none") {
    return false;
  }

  return detection.repetitionCount >= PERSISTENT_LOOP_REPETITION_LIMIT;
};

export const createLoopRecoveryMessage = (
  detection: Exclude<ModelLoopDetection, { type: "none" }>,
): ModelMessage => ({
  role: "system",
  content: [
    "System: Potential loop detected.",
    `Signal: ${describeLoopDetection(detection)}.`,
    "Take a step back before continuing. Confirm what has changed, choose a different approach, or ask the user a focused clarification if you are blocked. Do not repeat the same tool call or response without new information.",
  ].join("\n"),
});

const detectToolCallLoop = (
  messages: readonly ModelMessage[],
): ModelLoopDetection => {
  const signatures = collectToolCallSignatures(messages);
  const latest = signatures.at(-1);
  if (!latest) {
    return { type: "none" };
  }

  let repetitionCount = 0;
  for (const signature of signatures) {
    if (signature.key === latest.key) {
      repetitionCount += 1;
    }
  }

  if (repetitionCount < TOOL_CALL_LOOP_THRESHOLD) {
    return { type: "none" };
  }

  return {
    repetitionCount,
    toolName: latest.toolName,
    type: "tool-call-loop",
  };
};

const getCurrentTurnMessages = (
  messages: readonly ModelMessage[],
): readonly ModelMessage[] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (message?.role === "user") {
      return messages.slice(index + 1);
    }
  }

  return messages;
};

const collectToolCallSignatures = (
  messages: readonly ModelMessage[],
): { key: string; toolName: string }[] => {
  const signatures: { key: string; toolName: string }[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }

    for (const part of message.content) {
      if (!isToolCallPart(part)) {
        continue;
      }

      const serializedInput = stableStringify(part.input);
      signatures.push({
        key: hashString(`${part.toolName}:${serializedInput}`),
        toolName: part.toolName,
      });
    }
  }

  return signatures;
};

const detectContentLoop = (
  messages: readonly ModelMessage[],
): ModelLoopDetection => {
  const assistantText = collectAssistantText(messages)
    .join("\n")
    .slice(-CONTENT_HISTORY_CHARS);
  if (assistantText.length < CONTENT_CHUNK_SIZE * CONTENT_LOOP_THRESHOLD) {
    return { type: "none" };
  }

  const chunkIndices = new Map<string, number[]>();
  for (
    let index = 0;
    index + CONTENT_CHUNK_SIZE <= assistantText.length;
    index += 1
  ) {
    const chunk = assistantText.slice(index, index + CONTENT_CHUNK_SIZE);
    if (isStructuredMarkdownChunk(chunk)) {
      continue;
    }

    const indices = chunkIndices.get(chunk);
    if (!indices) {
      chunkIndices.set(chunk, [index]);
      continue;
    }

    indices.push(index);
    const recent = indices.slice(-CONTENT_LOOP_THRESHOLD);
    if (
      recent.length >= CONTENT_LOOP_THRESHOLD &&
      isClusteredContentLoop(assistantText, recent)
    ) {
      return {
        repetitionCount: indices.length,
        type: "content-loop",
      };
    }
  }

  return { type: "none" };
};

const collectAssistantText = (
  messages: readonly ModelMessage[],
): readonly string[] => {
  const texts: string[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        texts.push(part.text);
      }
    }
  }

  return texts;
};

const isClusteredContentLoop = (
  content: string,
  indices: readonly number[],
): boolean => {
  const firstIndex = indices.at(0);
  const lastIndex = indices.at(-1);
  if (firstIndex === undefined || lastIndex === undefined) {
    return false;
  }

  const averageDistance = (lastIndex - firstIndex) / (indices.length - 1);
  if (averageDistance > CONTENT_CHUNK_SIZE * 5) {
    return false;
  }

  const periods = new Set<string>();
  for (let index = 0; index < indices.length - 1; index += 1) {
    const start = indices.at(index);
    const end = indices.at(index + 1);
    if (start === undefined || end === undefined) {
      continue;
    }
    periods.add(content.slice(start, end));
  }

  return periods.size <= Math.floor(CONTENT_LOOP_THRESHOLD / 2);
};

const isStructuredMarkdownChunk = (chunk: string): boolean => {
  if (chunk.includes("```")) {
    return true;
  }

  for (const line of chunk.split("\n")) {
    const trimmedLine = line.trimStart();
    if (trimmedLine.startsWith("|")) {
      return true;
    }
    if (isMarkdownRuleLine(trimmedLine.trim())) {
      return true;
    }
    if (isMarkdownListItemLine(trimmedLine)) {
      return true;
    }
    if (isMarkdownHeadingLine(trimmedLine)) {
      return true;
    }
  }

  return false;
};

const isMarkdownRuleLine = (value: string): boolean => {
  if (value.length < 3) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const char = value.at(index);
    const code = value.codePointAt(index);
    if (
      char !== "+" &&
      char !== "-" &&
      char !== "_" &&
      char !== "=" &&
      char !== "*" &&
      (code === undefined ||
        code < BOX_DRAWING_START_CODE_POINT ||
        code > BOX_DRAWING_END_CODE_POINT)
    ) {
      return false;
    }
  }

  return true;
};

const isMarkdownListItemLine = (value: string): boolean => {
  const first = value.at(0);
  if (
    (first === "*" || first === "+" || first === "-") &&
    value.at(1) === " "
  ) {
    return true;
  }

  const dotIndex = value.indexOf(".");
  if (dotIndex <= 0 || dotIndex > 4 || value.at(dotIndex + 1) !== " ") {
    return false;
  }

  for (let index = 0; index < dotIndex; index += 1) {
    const code = value.codePointAt(index);
    if (
      code === undefined ||
      code < DIGIT_ZERO_CODE_POINT ||
      code > DIGIT_NINE_CODE_POINT
    ) {
      return false;
    }
  }

  return true;
};

const isMarkdownHeadingLine = (value: string): boolean => {
  let headingMarks = 0;
  while (value.at(headingMarks) === "#") {
    headingMarks += 1;
  }

  return (
    headingMarks >= 1 && headingMarks <= 6 && value.at(headingMarks) === " "
  );
};

const isToolCallPart = (part: AssistantContentPart): part is ToolCallPart =>
  part.type === "tool-call";

const describeLoopDetection = (
  detection: Exclude<ModelLoopDetection, { type: "none" }>,
): string => {
  if (detection.type === "tool-call-loop") {
    return `${detection.repetitionCount} identical calls to ${detection.toolName}`;
  }

  return `${detection.repetitionCount} repeated assistant text chunks`;
};

const stableStringify = (value: unknown): string => {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const serializedEntries: string[] = [];
  for (const [key, entryValue] of Object.entries(value).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    serializedEntries.push(
      `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
    );
  }

  return `{${serializedEntries.join(",")}}`;
};

const hashString = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
