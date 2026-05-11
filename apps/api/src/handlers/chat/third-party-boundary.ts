import type { FileUIPart, ToolSet } from "ai";
import { isFileUIPart, isToolUIPart } from "ai";
import { Result } from "better-result";

import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import { createPipelineContext, deanonymise } from "@stll/anonymize-wasm";
import type { PipelineContext } from "@stll/anonymize-wasm";

import type { ScopedDb } from "@/api/db";
import {
  CHAT_MAX_FILE_BYTES,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import {
  CHAT_TOOL_POLICY_KIND,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import type { SafeId } from "@/api/lib/branded-types";
import { parseDataUrl, toDataUrl } from "@/api/lib/data-url";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { anonymizeTextFields } from "@/api/mcp/anonymization";

export type ChatThirdPartyBoundary =
  | { type: "raw" }
  | {
      anonymizeFields?: typeof anonymizeTextFields | undefined;
      anonymizationScopeId: string;
      gazetteerEntries: ReturnType<typeof loadAnonymizationGazetteerEntries>;
      organizationId: SafeId<"organization">;
      /**
       * Shared pipeline context for every anonymization call on
       * this boundary. The wasm pipeline's placeholder counter
       * lives on the context — reusing the same instance means a
       * later batch (tool output, system prompt) keeps numbering
       * from where the previous batch (user prompt) left off, and
       * `[PERSON_1]` can never resolve to two different originals.
       */
      pipelineContext: PipelineContext;
      /**
       * Cumulative placeholder → original map across every
       * anonymization call on this boundary. Mutated as the request
       * progresses (user message, tool outputs, system text). The
       * stream-back path reads this to deanonymize assistant text /
       * tool outputs before they reach the user. Default operator
       * is "replace", which is reversible.
       */
      redactionMap: Map<string, string>;
      scopedDb: ScopedDb;
      type: "anonymized";
    };

const ANON_RESTORATIONS_DATA_PART_TYPE = "data-stella-anon-restorations";

/**
 * System-prompt note appended when anonymized mode is active.
 *
 * The model only sees placeholders (`[PERSON_1]`, `[ORGANIZATION_1]`,
 * …) in user input and tool output. Without this hint the model
 * tends to (a) refuse to act on a placeholder ("PERSON_1 doesn't
 * make sense"), or (b) strip the brackets when copying the value
 * into a JSON tool argument. The note tells the model that
 * placeholders are valid identifiers for *Stella's* internal
 * tools — Stella swaps them back to the real values before
 * executing the lookup, and re-anonymizes any output before the
 * model sees it again.
 */
export const buildAnonymizedSystemHint = (): string =>
  [
    "ANONYMIZED MODE: Names, organizations and other identifying entities the user mentions have been replaced with stable placeholders such as `[PERSON_1]`, `[ORGANIZATION_1]`, `[DATE_1]`. The same placeholder always refers to the same real entity within this conversation.",
    'When you call a Stella internal tool (run-stella-query, listContacts, listMatters, etc.), pass the placeholder verbatim — including the square brackets — as if it were the real name. Stella deanonymizes the placeholder back to the real value before the lookup runs and re-anonymizes the result before you see it. So `read.listContacts({ query: "[PERSON_1]" })` is the correct shape; the lookup will hit the real record.',
    'Do not try to invent the real value behind a placeholder, ask the user for it, or refuse to proceed because the placeholder "isn\'t a real name". External (non-Stella) tools, by contrast, only ever receive the placeholder.',
  ].join(" ");

export const createChatThirdPartyBoundary = ({
  anonymizeFields,
  anonymizationScopeId,
  organizationId,
  scopedDb,
  sendMode,
}: {
  anonymizeFields?: typeof anonymizeTextFields | undefined;
  anonymizationScopeId: string;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  sendMode: ChatSendMode;
}): ChatThirdPartyBoundary =>
  sendMode === CHAT_SEND_MODE.anonymized
    ? {
        type: "anonymized",
        anonymizeFields,
        anonymizationScopeId,
        gazetteerEntries: anonymizeFields
          ? Promise.resolve([])
          : loadAnonymizationGazetteerEntries({ organizationId, scopedDb }),
        organizationId,
        pipelineContext: createPipelineContext(),
        redactionMap: new Map<string, string>(),
        scopedDb,
      }
    : { type: "raw" };

const mergeRedactionMap = (
  target: Map<string, string>,
  source: Map<string, string> | undefined,
) => {
  if (!source) {
    return;
  }
  for (const [placeholder, original] of source) {
    // Stable mapping per request: the same placeholder must always
    // resolve to the same original. If a later call disagrees we
    // keep the first observation rather than silently rewriting it
    // — in practice the wasm pipeline gives stable numbers within a
    // single context, so collisions only arise from independent
    // anonymization batches.
    if (!target.has(placeholder)) {
      target.set(placeholder, original);
    }
  }
};

/**
 * Reverse the anonymization for outgoing assistant content. No-op
 * for raw boundaries and for placeholders not seen on the way in
 * (so hallucinated `[PERSON_99]` stays as-is rather than
 * substituting wrong text).
 */
export const deanonymizeFromBoundary = ({
  boundary,
  text,
}: {
  boundary: ChatThirdPartyBoundary;
  text: string;
}): string => {
  if (boundary.type === "raw" || boundary.redactionMap.size === 0) {
    return text;
  }
  return deanonymise(text, boundary.redactionMap);
};

const PLACEHOLDER_LIKE = /\[[A-Z][A-Z0-9_]*]/;
const PLACEHOLDER_INNER_RE = /^[A-Z][A-Z0-9_]*$/;
const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/g;
const escapeRegex = (value: string) => value.replaceAll(REGEX_SPECIALS, "\\$&");

/**
 * Recursively swap placeholders back to originals inside a value
 * tree.
 *
 * `mode` defaults to "strict" (only `[PERSON_1]` matches), used by
 * the assistant-output rehydration path so unrelated all-caps text
 * isn't accidentally swapped.
 *
 * `mode: "lenient"` *also* matches the bracketless inner form
 * (`PERSON_1`). The LLM regularly drops the brackets when copying
 * a placeholder into a JSON tool argument — without lenient
 * matching, the internal DB lookup queries the literal string
 * "PERSON_1" and finds nothing.
 */
export const deanonymizeUnknownStringsFromBoundary = (
  boundary: ChatThirdPartyBoundary,
  value: unknown,
  mode: "strict" | "lenient" = "strict",
): unknown => {
  if (boundary.type === "raw" || boundary.redactionMap.size === 0) {
    return value;
  }
  if (mode === "strict") {
    return walkStrict(value, boundary.redactionMap);
  }
  const lenient = buildLenientReplacer(boundary.redactionMap);
  if (lenient === null) {
    return value;
  }
  return walkLenient(value, lenient);
};

const walkStrict = (value: unknown, map: Map<string, string>): unknown => {
  if (typeof value === "string") {
    return PLACEHOLDER_LIKE.test(value) ? deanonymise(value, map) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walkStrict(item, map));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value).map(
    ([key, nested]) => [key, walkStrict(nested, map)] as const,
  );
  return Object.fromEntries(entries);
};

type LenientReplacer = {
  pattern: RegExp;
  lookup: Map<string, string>;
};

const buildLenientReplacer = (
  redactionMap: Map<string, string>,
): LenientReplacer | null => {
  const lookup = new Map<string, string>();
  // Bracketed placeholders (`[PERSON_1]`) and bracketless inners
  // (`PERSON_1`) live in two separate token lists. The bracketed
  // form can be `|`-joined directly — brackets are token boundaries
  // already. The bracketless form needs `\b` on both sides so a
  // larger token like `PERSON_10` (the model hallucinating a higher
  // number, or `[PERSON_1]` followed by `0`) isn't matched as
  // `PERSON_1` + dangling `0`.
  const bracketed: string[] = [];
  const bracketless: string[] = [];
  for (const [placeholder, original] of redactionMap) {
    if (!lookup.has(placeholder)) {
      lookup.set(placeholder, original);
      bracketed.push(escapeRegex(placeholder));
    }
    const inner = placeholder.slice(1, -1);
    if (PLACEHOLDER_INNER_RE.test(inner) && !lookup.has(inner)) {
      lookup.set(inner, original);
      bracketless.push(escapeRegex(inner));
    }
  }
  if (bracketed.length === 0 && bracketless.length === 0) {
    return null;
  }
  // Sort longest-first within each bucket so `[PERSON_10]` wins
  // over `[PERSON_1]` when both could match overlapping spans.
  bracketed.sort((a, b) => b.length - a.length);
  bracketless.sort((a, b) => b.length - a.length);
  const parts: string[] = [];
  if (bracketed.length > 0) {
    parts.push(bracketed.join("|"));
  }
  if (bracketless.length > 0) {
    parts.push(`\\b(?:${bracketless.join("|")})\\b`);
  }
  return { pattern: new RegExp(parts.join("|"), "g"), lookup };
};

const walkLenient = (value: unknown, replacer: LenientReplacer): unknown => {
  if (typeof value === "string") {
    return value.replaceAll(
      replacer.pattern,
      (token) => replacer.lookup.get(token) ?? token,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walkLenient(item, replacer));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value).map(
    ([key, nested]) => [key, walkLenient(nested, replacer)] as const,
  );
  return Object.fromEntries(entries);
};

type BoundaryRefusal = HandlerError<422 | 500>;

type TextReplacement = {
  text: string;
  apply: (value: string) => void;
};

export const prepareTextForThirdParty = async ({
  boundary,
  text,
}: {
  boundary: ChatThirdPartyBoundary;
  text: string;
}): Promise<Result<string, BoundaryRefusal>> => {
  if (boundary.type === "raw" || text.length === 0) {
    return Result.ok(text);
  }

  const anonymizeFields = boundary.anonymizeFields ?? anonymizeTextFields;
  const anonymized = await Result.tryPromise({
    try: async () =>
      await anonymizeFields({
        context: boundary.pipelineContext,
        fields: [text],
        gazetteerEntries: await boundary.gazetteerEntries,
        organizationId: boundary.organizationId,
        scopedDb: boundary.scopedDb,
        workspaceId: boundary.anonymizationScopeId,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to anonymize content before sending it to the AI.",
        cause,
      }),
  });

  if (Result.isError(anonymized)) {
    return Result.err(anonymized.error);
  }

  mergeRedactionMap(boundary.redactionMap, anonymized.value.redactionMap);
  return Result.ok(anonymized.value.fields.at(0) ?? "");
};

const prepareTextBatchForThirdParty = async ({
  boundary,
  replacements,
}: {
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  replacements: TextReplacement[];
}): Promise<Result<void, BoundaryRefusal>> => {
  const fields = replacements.map((replacement) => replacement.text);
  if (fields.every((field) => field.length === 0)) {
    return Result.ok(undefined);
  }

  const anonymizeFields = boundary.anonymizeFields ?? anonymizeTextFields;
  const anonymized = await Result.tryPromise({
    try: async () =>
      await anonymizeFields({
        context: boundary.pipelineContext,
        fields,
        gazetteerEntries: await boundary.gazetteerEntries,
        organizationId: boundary.organizationId,
        scopedDb: boundary.scopedDb,
        workspaceId: boundary.anonymizationScopeId,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to anonymize content before sending it to the AI.",
        cause,
      }),
  });

  if (Result.isError(anonymized)) {
    return Result.err(anonymized.error);
  }

  mergeRedactionMap(boundary.redactionMap, anonymized.value.redactionMap);

  for (let index = 0; index < replacements.length; index += 1) {
    const replacement = replacements[index];
    if (replacement === undefined) {
      continue;
    }

    replacement.apply(anonymized.value.fields.at(index) ?? "");
  }

  return Result.ok(undefined);
};

const queueTextReplacement = (
  replacements: TextReplacement[],
  text: string,
  apply: (value: string) => void,
) => {
  if (text.length === 0) {
    return;
  }

  replacements.push({ text, apply });
};

const anonymizePlainTextFile = ({
  part,
  replacements,
}: {
  part: FileUIPart;
  replacements: TextReplacement[];
}): Result<FileUIPart, BoundaryRefusal> => {
  if (part.mediaType !== TEXT_PLAIN_MIME_TYPE) {
    return Result.err(
      new HandlerError({
        code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
        status: 422,
        message:
          "Cannot send this attachment to the AI in anonymized mode because Stella cannot extract and anonymize it safely.",
      }),
    );
  }

  const parsed = parseDataUrl({
    expectedMimeType: TEXT_PLAIN_MIME_TYPE,
    maxBytes: CHAT_MAX_FILE_BYTES,
    url: part.url,
  });

  if (Result.isError(parsed)) {
    return Result.err(
      new HandlerError({
        code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
        status: 422,
        message:
          "Cannot send this attachment to the AI in anonymized mode because Stella cannot read it as text.",
        cause: parsed.error,
      }),
    );
  }

  const text = Buffer.from(parsed.value.bytes).toString("utf-8");
  let anonymizedText = text;
  let filename = part.filename;

  const prepared: FileUIPart = {
    ...part,
    ...(filename ? { filename } : {}),
    mediaType: TEXT_PLAIN_MIME_TYPE,
    url: toDataUrl(Buffer.from(anonymizedText, "utf-8"), TEXT_PLAIN_MIME_TYPE),
  };

  queueTextReplacement(replacements, text, (value) => {
    anonymizedText = value;
    prepared.url = toDataUrl(
      Buffer.from(anonymizedText, "utf-8"),
      TEXT_PLAIN_MIME_TYPE,
    );
  });

  if (filename) {
    queueTextReplacement(replacements, filename, (value) => {
      filename = value;
      prepared.filename = filename;
    });
  }

  return Result.ok(prepared);
};

const preparePartForThirdParty = ({
  boundary,
  part,
  replacements,
}: {
  boundary: ChatThirdPartyBoundary;
  part: ChatMessage["parts"][number];
  replacements: TextReplacement[];
}): Result<ChatMessage["parts"][number], BoundaryRefusal> => {
  if (boundary.type === "raw") {
    return Result.ok(part);
  }

  if (part.type === "text" || part.type === "reasoning") {
    const prepared = { ...part };
    queueTextReplacement(replacements, part.text, (value) => {
      prepared.text = value;
    });
    return Result.ok(prepared);
  }

  if (isFileUIPart(part)) {
    return anonymizePlainTextFile({ part, replacements });
  }

  if (isToolUIPart(part)) {
    return anonymizeToolPart({ part, replacements });
  }

  if (part.type === "source-document") {
    const prepared = { ...part };
    queueTextReplacement(replacements, part.title, (value) => {
      prepared.title = value;
    });
    if (part.filename) {
      queueTextReplacement(replacements, part.filename, (value) => {
        prepared.filename = value;
      });
    }
    return Result.ok(prepared);
  }

  if (part.type === "source-url" && part.title) {
    const prepared = { ...part };
    queueTextReplacement(replacements, part.title, (value) => {
      prepared.title = value;
    });
    return Result.ok(prepared);
  }

  if ("data" in part) {
    const preparedPart: Omit<typeof part, "data"> & { data: unknown } = {
      ...part,
      data: part.data,
    };
    const data = anonymizeUnknownStrings({
      apply: (value) => {
        preparedPart.data = value;
      },
      replacements,
      value: part.data,
    });

    if (Result.isError(data)) {
      return Result.err(data.error);
    }

    preparedPart.data = data.value;

    // SAFETY: data part discriminators are preserved. Nested provider-visible
    // text values are written back after the request-level batch anonymization.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Result.ok(preparedPart as ChatMessage["parts"][number]);
  }

  return Result.ok(part);
};

const isProviderInvisiblePart = (part: ChatMessage["parts"][number]): boolean =>
  part.type === ANON_RESTORATIONS_DATA_PART_TYPE;

const removeProviderInvisibleParts = (
  messages: ChatMessage[],
): ChatMessage[] => {
  const visibleMessages: ChatMessage[] = [];

  for (const message of messages) {
    const parts = message.parts.filter(
      (part) => !isProviderInvisiblePart(part),
    );

    if (parts.length === 0) {
      continue;
    }

    visibleMessages.push(
      parts.length === message.parts.length ? message : { ...message, parts },
    );
  }

  return visibleMessages;
};

export const prepareMessagesForThirdParty = async ({
  boundary,
  messages,
}: {
  boundary: ChatThirdPartyBoundary;
  messages: ChatMessage[];
}): Promise<Result<ChatMessage[], BoundaryRefusal>> => {
  const providerVisibleMessages = removeProviderInvisibleParts(messages);

  if (boundary.type === "raw") {
    return Result.ok(providerVisibleMessages);
  }

  return await Result.gen(async function* () {
    const prepared: ChatMessage[] = [];
    const replacements: TextReplacement[] = [];

    for (const message of providerVisibleMessages) {
      const parts: ChatMessage["parts"] = [];

      for (const part of message.parts) {
        parts.push(
          yield* preparePartForThirdParty({ boundary, part, replacements }),
        );
      }

      prepared.push({ ...message, parts });
    }

    yield* Result.await(
      prepareTextBatchForThirdParty({ boundary, replacements }),
    );

    return Result.ok(prepared);
  });
};

const TECHNICAL_IDENTIFIER_KEYS = new Set([
  "callId",
  "documentId",
  "entityId",
  "fileId",
  "id",
  "ids",
  "messageId",
  "organizationId",
  "threadId",
  "toolCallId",
  "userId",
  "uuid",
  "uuids",
  "workspaceId",
]);

const TECHNICAL_IDENTIFIER_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9]*_[A-Za-z0-9-]+)$/i;

const shouldPreserveStructuredString = (
  key: string,
  value: string,
): boolean => {
  if (!TECHNICAL_IDENTIFIER_PATTERN.test(value)) {
    return false;
  }

  const normalized = key.toLocaleLowerCase();

  return (
    TECHNICAL_IDENTIFIER_KEYS.has(key) ||
    TECHNICAL_IDENTIFIER_KEYS.has(normalized) ||
    normalized.endsWith("_id") ||
    normalized.endsWith("_ids") ||
    normalized.endsWith("_uuid") ||
    normalized.endsWith("_uuids") ||
    key.endsWith("Id") ||
    key.endsWith("Ids") ||
    key.endsWith("ID") ||
    key.endsWith("IDs") ||
    key.endsWith("Uuid") ||
    key.endsWith("Uuids") ||
    key.endsWith("UUID") ||
    key.endsWith("UUIDs")
  );
};

const anonymizeUnknownStrings = ({
  apply,
  key,
  replacements,
  value,
}: {
  apply?: ((value: unknown) => void) | undefined;
  key?: string | undefined;
  replacements: TextReplacement[];
  value: unknown;
}): Result<unknown, BoundaryRefusal> => {
  if (typeof value === "string") {
    if (key && shouldPreserveStructuredString(key, value)) {
      return Result.ok(value);
    }

    let prepared = value;
    queueTextReplacement(replacements, value, (next) => {
      prepared = next;
      apply?.(prepared);
    });

    return Result.ok(prepared);
  }

  if (Array.isArray(value)) {
    return Result.gen(function* () {
      const output: unknown[] = [];

      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value.at(index);
        output[index] = yield* anonymizeUnknownStrings({
          apply: (next) => {
            output[index] = next;
          },
          key,
          replacements,
          value: item,
        });
      }

      return Result.ok(output);
    });
  }

  if (typeof value !== "object" || value === null) {
    return Result.ok(value);
  }

  return Result.gen(function* () {
    const output = {};

    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      const nestedPrepared = yield* anonymizeUnknownStrings({
        apply: (next) => {
          Object.assign(output, { [nestedKey]: next });
        },
        key: nestedKey,
        replacements,
        value: nestedValue,
      });
      Object.assign(output, { [nestedKey]: nestedPrepared });
    }

    return Result.ok(output);
  });
};

type ToolLikePart = Extract<ChatMessage["parts"][number], { state: string }>;
type MutableToolLikePart = ToolLikePart & {
  approval?: unknown;
  errorText?: string | undefined;
  input?: unknown;
  output?: unknown;
  title?: string | undefined;
};

const anonymizeToolPart = ({
  part,
  replacements,
}: {
  part: ToolLikePart;
  replacements: TextReplacement[];
}): Result<ToolLikePart, BoundaryRefusal> =>
  Result.gen(function* () {
    const prepared: MutableToolLikePart = { ...part };

    if ("input" in part) {
      const input = yield* anonymizeUnknownStrings({
        apply: (value) => {
          prepared.input = value;
        },
        replacements,
        value: part.input,
      });
      prepared.input = input;
    }

    if ("output" in part) {
      const output = yield* anonymizeUnknownStrings({
        apply: (value) => {
          prepared.output = value;
        },
        replacements,
        value: part.output,
      });
      prepared.output = output;
    }

    const errorText = "errorText" in part ? part.errorText : undefined;
    if (errorText) {
      queueTextReplacement(replacements, errorText, (value) => {
        prepared.errorText = value;
      });
    }

    const title = "title" in part ? part.title : undefined;
    if (title) {
      queueTextReplacement(replacements, title, (value) => {
        prepared.title = value;
      });
    }

    const approval =
      "approval" in part &&
      part.approval !== undefined &&
      "reason" in part.approval &&
      part.approval.reason
        ? part.approval
        : undefined;
    if (approval?.reason) {
      queueTextReplacement(replacements, approval.reason, (value) => {
        prepared.approval = { ...approval, reason: value };
      });
    }

    // SAFETY: the tool UI part discriminator fields are preserved. We only
    // anonymize provider-visible text nested in input/output/error/title fields.
    return Result.ok(prepared as ToolLikePart);
  });

export const prepareToolsForThirdParty = <TTools extends ToolSet>({
  boundary,
  tools,
}: {
  boundary: ChatThirdPartyBoundary;
  tools: TTools;
}): TTools => {
  const hasExternalTool = Object.values(tools).some(
    (toolDefinition) => getChatToolPolicy(toolDefinition).requiresAnonymization,
  );
  if (boundary.type === "raw" && !hasExternalTool) {
    return tools;
  }

  const wrapped: Partial<TTools> = {};

  for (const key of Object.keys(tools) as (keyof TTools & string)[]) {
    const current = tools[key];
    if (!current?.execute) {
      wrapped[key] = current;
      continue;
    }

    const execute = current.execute;
    const policy = getChatToolPolicy(current);
    // Internal Stella tools (DB queries, mutations) operate on real
    // data, so when the model passes a placeholder it saw
    // (`[PERSON_1]`) we swap it back to the original (`Jan Novák`)
    // *before* the tool runs — otherwise the lookup misses every
    // anonymized record. External / public tools keep the
    // placeholder so real names never leave Stella.
    const deanonymizeInputBeforeExecute =
      policy.kind === CHAT_TOOL_POLICY_KIND.internal ||
      policy.kind === CHAT_TOOL_POLICY_KIND.mutation;
    wrapped[key] = {
      ...current,
      execute: async (...args: Parameters<typeof execute>) => {
        if (policy.requiresAnonymization && boundary.type === "raw") {
          throw new HandlerError({
            status: 422,
            message:
              "External chat tools require anonymized mode before Stella can call them.",
          });
        }

        if (boundary.type === "raw") {
          const rawOutput: unknown = await execute(...args);
          return rawOutput;
        }

        if (deanonymizeInputBeforeExecute && args.length > 0) {
          // SAFETY: the AI SDK types tool execute's input arg as `any`
          // because each tool defines its own input schema. We
          // recursively walk strings only and preserve every other
          // value identity, so the shape match is safe.
          // Lenient match: the LLM regularly strips the `[ ]` from
          // a placeholder when embedding it in a JSON argument, so
          // bare `PERSON_1` must also resolve here.
          (args as [unknown, ...unknown[]])[0] =
            deanonymizeUnknownStringsFromBoundary(boundary, args[0], "lenient");
        }

        const replacements: TextReplacement[] = [];
        let outputValue: unknown = await execute(...args);
        const anonymizedOutput = anonymizeUnknownStrings({
          apply: (value) => {
            outputValue = value;
          },
          replacements,
          value: outputValue,
        });

        if (Result.isError(anonymizedOutput)) {
          throw anonymizedOutput.error;
        }

        outputValue = anonymizedOutput.value;
        const anonymizedBatch = await prepareTextBatchForThirdParty({
          boundary,
          replacements,
        });
        if (Result.isError(anonymizedBatch)) {
          throw anonymizedBatch.error;
        }

        return outputValue;
      },
    };
  }

  // SAFETY: each tool is copied unchanged except for execute(), whose output
  // is recursively string-anonymized while preserving the original shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return wrapped as TTools;
};
