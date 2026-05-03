import type { FileUIPart, ToolSet } from "ai";
import { isFileUIPart, isToolUIPart } from "ai";
import { Result } from "better-result";

import type { ScopedDb } from "@/api/db";
import {
  CHAT_MAX_FILE_BYTES,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
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
      gazetteerEntries: ReturnType<typeof loadAnonymizationGazetteerEntries>;
      organizationId: SafeId<"organization">;
      scopedDb: ScopedDb;
      type: "anonymized";
    };

export const createChatThirdPartyBoundary = ({
  anonymized,
  anonymizeFields,
  organizationId,
  scopedDb,
}: {
  anonymized: boolean;
  anonymizeFields?: typeof anonymizeTextFields | undefined;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}): ChatThirdPartyBoundary =>
  anonymized
    ? {
        type: "anonymized",
        anonymizeFields,
        gazetteerEntries: anonymizeFields
          ? Promise.resolve([])
          : loadAnonymizationGazetteerEntries({ organizationId, scopedDb }),
        organizationId,
        scopedDb,
      }
    : { type: "raw" };

type BoundaryRefusal = HandlerError<422 | 500>;

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
        workspaceId: boundary.organizationId,
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

const anonymizePlainTextFile = async ({
  boundary,
  part,
}: {
  boundary: ChatThirdPartyBoundary;
  part: FileUIPart;
}): Promise<Result<FileUIPart, BoundaryRefusal>> => {
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
  const anonymizedTextResult = await prepareTextForThirdParty({
    boundary,
    text,
  });

  if (Result.isError(anonymizedTextResult)) {
    return Result.err(anonymizedTextResult.error);
  }

  const filenameResult = part.filename
    ? await prepareTextForThirdParty({ boundary, text: part.filename })
    : Result.ok<string | undefined>(undefined);

  if (Result.isError(filenameResult)) {
    return Result.err(filenameResult.error);
  }

  return Result.ok({
    ...part,
    ...(filenameResult.value ? { filename: filenameResult.value } : {}),
    mediaType: TEXT_PLAIN_MIME_TYPE,
    url: toDataUrl(
      Buffer.from(anonymizedTextResult.value, "utf-8"),
      TEXT_PLAIN_MIME_TYPE,
    ),
  });
};

const preparePartForThirdParty = async ({
  boundary,
  part,
}: {
  boundary: ChatThirdPartyBoundary;
  part: ChatMessage["parts"][number];
}): Promise<Result<ChatMessage["parts"][number], BoundaryRefusal>> => {
  if (boundary.type === "raw") {
    return Result.ok(part);
  }

  if (part.type === "text" || part.type === "reasoning") {
    const text = await prepareTextForThirdParty({ boundary, text: part.text });

    if (Result.isError(text)) {
      return Result.err(text.error);
    }

    return Result.ok({
      ...part,
      text: text.value,
    });
  }

  if (isFileUIPart(part)) {
    return await anonymizePlainTextFile({ boundary, part });
  }

  if (isToolUIPart(part)) {
    return await anonymizeToolPart({ boundary, part });
  }

  if (part.type === "source-document") {
    const title = await prepareTextForThirdParty({
      boundary,
      text: part.title,
    });

    if (Result.isError(title)) {
      return Result.err(title.error);
    }

    const filename = part.filename
      ? await prepareTextForThirdParty({
          boundary,
          text: part.filename,
        })
      : Result.ok<string | undefined>(undefined);

    if (Result.isError(filename)) {
      return Result.err(filename.error);
    }

    return Result.ok({
      ...part,
      title: title.value,
      ...(filename.value ? { filename: filename.value } : {}),
    });
  }

  if (part.type === "source-url" && part.title) {
    const title = await prepareTextForThirdParty({
      boundary,
      text: part.title,
    });

    if (Result.isError(title)) {
      return Result.err(title.error);
    }

    return Result.ok({
      ...part,
      title: title.value,
    });
  }

  if ("data" in part) {
    const data = await anonymizeUnknownStrings({
      boundary,
      value: part.data,
    });

    if (Result.isError(data)) {
      return Result.err(data.error);
    }

    const preparedPart = {
      ...part,
      data: data.value,
    };

    // SAFETY: data part discriminators and IDs are preserved. The recursive
    // anonymizer only replaces nested string values in the existing data shape.
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

    for (const message of messages) {
      const parts: ChatMessage["parts"] = [];

      for (const part of message.parts) {
        parts.push(
          yield* Result.await(preparePartForThirdParty({ boundary, part })),
        );
      }

      prepared.push({ ...message, parts });
    }

    return Result.ok(prepared);
  });
};

const shouldPreserveStructuredString = (key: string): boolean => {
  const normalized = key.toLocaleLowerCase();

  return (
    normalized === "id" ||
    normalized === "ids" ||
    normalized === "uuid" ||
    normalized === "uuids" ||
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

const anonymizeUnknownStrings = async ({
  boundary,
  key,
  value,
}: {
  boundary: ChatThirdPartyBoundary;
  key?: string | undefined;
  value: unknown;
}): Promise<Result<unknown, BoundaryRefusal>> => {
  if (boundary.type === "raw") {
    return Result.ok(value);
  }

  if (typeof value === "string") {
    if (key && shouldPreserveStructuredString(key)) {
      return Result.ok(value);
    }

    return await prepareTextForThirdParty({ boundary, text: value });
  }

  if (Array.isArray(value)) {
    return await Result.gen(async function* () {
      const output: unknown[] = [];

      for (const item of value) {
        output.push(
          yield* Result.await(
            anonymizeUnknownStrings({ boundary, key, value: item }),
          ),
        );
      }

      return Result.ok(output);
    });
  }

  if (typeof value !== "object" || value === null) {
    return Result.ok(value);
  }

  return await Result.gen(async function* () {
    const entries: [string, unknown][] = [];

    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      entries.push([
        nestedKey,
        yield* Result.await(
          anonymizeUnknownStrings({
            boundary,
            key: nestedKey,
            value: nestedValue,
          }),
        ),
      ]);
    }

    return Result.ok(Object.fromEntries(entries));
  });
};

type ToolLikePart = Extract<ChatMessage["parts"][number], { state: string }>;

const anonymizeToolPart = async ({
  boundary,
  part,
}: {
  boundary: ChatThirdPartyBoundary;
  part: ToolLikePart;
}): Promise<Result<ToolLikePart, BoundaryRefusal>> =>
  await Result.gen(async function* () {
    const input =
      "input" in part
        ? yield* Result.await(
            anonymizeUnknownStrings({ boundary, value: part.input }),
          )
        : undefined;

    const output =
      "output" in part
        ? yield* Result.await(
            anonymizeUnknownStrings({ boundary, value: part.output }),
          )
        : undefined;

    const errorText =
      "errorText" in part && part.errorText
        ? yield* Result.await(
            prepareTextForThirdParty({ boundary, text: part.errorText }),
          )
        : undefined;

    const title =
      "title" in part && part.title
        ? yield* Result.await(
            prepareTextForThirdParty({ boundary, text: part.title }),
          )
        : undefined;

    const approvalReason =
      "approval" in part &&
      part.approval !== undefined &&
      "reason" in part.approval &&
      part.approval.reason
        ? yield* Result.await(
            prepareTextForThirdParty({
              boundary,
              text: part.approval.reason,
            }),
          )
        : undefined;

    const prepared = {
      ...part,
      ...("input" in part ? { input } : {}),
      ...("output" in part ? { output } : {}),
      ...(errorText ? { errorText } : {}),
      ...(title ? { title } : {}),
      ...(approvalReason && "approval" in part
        ? { approval: { ...part.approval, reason: approvalReason } }
        : {}),
    };

    // SAFETY: the tool UI part discriminator fields are preserved. We only
    // anonymize provider-visible text nested in input/output/error/title fields.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Result.ok(prepared as ToolLikePart);
  });

export const prepareToolsForThirdParty = <TTools extends ToolSet>({
  boundary,
  tools,
}: {
  boundary: ChatThirdPartyBoundary;
  tools: TTools;
}): TTools => {
  if (boundary.type === "raw") {
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
    wrapped[key] = {
      ...current,
      execute: async (...args: Parameters<typeof execute>) => {
        const anonymizedOutput = await anonymizeUnknownStrings({
          boundary,
          value: await execute(...args),
        });

        if (Result.isError(anonymizedOutput)) {
          throw anonymizedOutput.error;
        }

        return anonymizedOutput.value;
      },
    };
  }

  // SAFETY: each tool is copied unchanged except for execute(), whose output
  // is recursively string-anonymized while preserving the original shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return wrapped as TTools;
};
