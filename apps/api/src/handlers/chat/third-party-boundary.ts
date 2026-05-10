import type { FileUIPart, ToolSet } from "ai";
import { isFileUIPart, isToolUIPart } from "ai";
import { Result } from "better-result";

import type { ScopedDb } from "@/api/db";
import {
  CHAT_MAX_FILE_BYTES,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import { getChatToolPolicy } from "@/api/handlers/chat/tools/tool-policy";
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
      scopedDb: ScopedDb;
      type: "anonymized";
    };

export const createChatThirdPartyBoundary = ({
  anonymized,
  anonymizeFields,
  anonymizationScopeId,
  organizationId,
  scopedDb,
}: {
  anonymized: boolean;
  anonymizeFields?: typeof anonymizeTextFields | undefined;
  anonymizationScopeId: string;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}): ChatThirdPartyBoundary =>
  anonymized
    ? {
        type: "anonymized",
        anonymizeFields,
        anonymizationScopeId,
        gazetteerEntries: anonymizeFields
          ? Promise.resolve([])
          : loadAnonymizationGazetteerEntries({ organizationId, scopedDb }),
        organizationId,
        scopedDb,
      }
    : { type: "raw" };

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

export const prepareMessagesForThirdParty = async ({
  boundary,
  messages,
}: {
  boundary: ChatThirdPartyBoundary;
  messages: ChatMessage[];
}): Promise<Result<ChatMessage[], BoundaryRefusal>> => {
  if (boundary.type === "raw") {
    return Result.ok(messages);
  }

  return await Result.gen(async function* () {
    const prepared: ChatMessage[] = [];
    const replacements: TextReplacement[] = [];

    for (const message of messages) {
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
