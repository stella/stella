import type { AnyServerTool, MCPToolSource } from "@tanstack/ai";
import { Result } from "better-result";

import { createPipelineContext, deanonymise } from "@stll/anonymize";
import type { PipelineContext } from "@stll/anonymize";
import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
} from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CHAT_MAX_FILE_BYTES,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import {
  createChatAttachmentPart,
  getChatAttachmentFilename,
  getChatAttachmentMimeType,
  getChatAttachmentUrl,
  isChatAttachmentPart,
  isProviderVisibleChatPart,
} from "@/api/handlers/chat/chat-message-parts";
import {
  CHAT_TOOL_POLICY_KIND,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import type {
  ChatAttachmentPart,
  ChatMessage,
} from "@/api/handlers/chat/types";
import { loadAnonymizationAllowlistCanonicals } from "@/api/lib/anonymization-allowlist";
import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { parseDataUrl, toDataUrl } from "@/api/lib/data-url";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { anonymizeTextFields } from "@/api/mcp/anonymization";

export type ChatThirdPartyBoundary =
  | { type: "raw" }
  | {
      anonymizeFields?: typeof anonymizeTextFields | undefined;
      anonymizationScopeId: string;
      gazetteerEntries: ReturnType<typeof loadAnonymizationGazetteerEntries>;
      /**
       * Canonicals the user marked as "ignore" in the inspector
       * allowlist (workspace and org scopes). Pre-loaded once on
       * boundary creation so we don't hit the DB per anonymize
       * call. Doc-scope ignores are skipped here because chat
       * threads aren't tied to a specific entity in the current
       * shape.
       */
      excludedCanonicals: Promise<string[]>;
      organizationId: SafeId<"organization">;
      /**
       * Shared pipeline context for every anonymization call on
       * this boundary. On the native pipeline (2.0+) this is only a
       * prepared-package assembly cache, not a placeholder-numbering
       * cache: reusing it across calls avoids re-assembling the same
       * config, but each `redactText` call numbers placeholders from
       * `[LABEL_1]` again. `placeholderOffsets` below rewrites each
       * batch into one continuous boundary-local numbering sequence.
       */
      pipelineContext: PipelineContext;
      /** Highest placeholder index seen per label after boundary-local rewrites. */
      placeholderOffsets: Map<string, number>;
      /** Provider-visible alias → late literal token restored at the boundary. */
      literalPlaceholderAliases: Map<string, string>;
      /** Indexed placeholder tokens present literally in provider-bound source text. */
      sourcePlaceholders: Set<string>;
      /**
       * Cumulative placeholder → original map across every
       * anonymization call on this boundary. Mutated as the request
       * progresses (user message, tool outputs, system text). The
       * stream-back path reads this to deanonymize assistant text /
       * tool outputs before they reach the user. Default operator
       * is "replace", which is reversible.
       */
      redactionMap: Map<string, string>;
      type: "anonymized";
    };

export const createChatThirdPartyBoundary = ({
  anonymizeFields,
  anonymizationScopeId,
  organizationId,
  scopedDb,
  sendMode,
  workspaceId,
}: {
  anonymizeFields?: typeof anonymizeTextFields | undefined;
  anonymizationScopeId: string;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  sendMode: ChatSendMode;
  /**
   * When the chat is workspace-scoped, the validated workspace
   * SafeId from the workspaceAccessMacro. Threads gazetteer
   * loading so workspace-specific terms join the org-wide
   * catalog. Omit for global threads.
   */
  workspaceId?: SafeId<"workspace"> | undefined;
}): ChatThirdPartyBoundary =>
  sendMode === CHAT_SEND_MODE.anonymized
    ? {
        type: "anonymized",
        anonymizeFields,
        anonymizationScopeId,
        gazetteerEntries: anonymizeFields
          ? Promise.resolve([])
          : loadAnonymizationGazetteerEntries({
              organizationId,
              // A global thread has no workspace tier to read.
              scope:
                workspaceId === undefined
                  ? { type: "organization" }
                  : { type: "workspace", workspaceId },
              scopedDb,
            }),
        excludedCanonicals: anonymizeFields
          ? Promise.resolve([])
          : loadAnonymizationAllowlistCanonicals({
              organizationId,
              scopeId: workspaceId,
              scopedDb,
            }),
        organizationId,
        pipelineContext: createPipelineContext(),
        placeholderOffsets: new Map<string, number>(),
        literalPlaceholderAliases: new Map<string, string>(),
        redactionMap: new Map<string, string>(),
        sourcePlaceholders: new Set<string>(),
      }
    : { type: "raw" };

type AnonymizedTextFieldsResult = {
  entityCount: number;
  fields: string[];
  redactionMap: Map<string, string>;
};

const INDEXED_PLACEHOLDER = /^\[(?<label>[A-Z][A-Z0-9_]*)_(?<index>\d+)\]$/u;
const INDEXED_PLACEHOLDER_OCCURRENCE =
  /\[(?<label>[A-Z][A-Z0-9_]*)_(?<index>\d+)\]/gu;

const parseIndexedPlaceholder = (
  placeholder: string,
): { label: string; index: number } | null => {
  const match = INDEXED_PLACEHOLDER.exec(placeholder);
  const label = match?.groups?.["label"];
  const indexText = match?.groups?.["index"];
  if (label === undefined || indexText === undefined) {
    return null;
  }
  const index = Number.parseInt(indexText, 10);
  return Number.isSafeInteger(index) && index > 0 ? { label, index } : null;
};

const findExistingPlaceholder = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  label: string,
  original: string,
): string | null => {
  for (const [placeholder, mappedOriginal] of boundary.redactionMap) {
    if (mappedOriginal !== original) {
      continue;
    }
    const parsed = parseIndexedPlaceholder(placeholder);
    if (parsed?.label === label) {
      return placeholder;
    }
  }

  return null;
};

const reserveSourcePlaceholders = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  fields: string[],
) => {
  for (const field of fields) {
    for (const match of field.matchAll(INDEXED_PLACEHOLDER_OCCURRENCE)) {
      boundary.sourcePlaceholders.add(match[0]);
    }
  }
};

const encodeLateLiteralPlaceholders = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  text: string,
): string => {
  const replacements = new Map<string, string>();
  const restorableTokens = [
    ...boundary.redactionMap.keys(),
    ...boundary.literalPlaceholderAliases.keys(),
  ];
  for (const token of restorableTokens) {
    if (!text.includes(token)) {
      continue;
    }

    let index = boundary.literalPlaceholderAliases.size + 1;
    let alias = `[LITERAL_PLACEHOLDER_${String(index)}]`;
    while (
      text.includes(alias) ||
      boundary.redactionMap.has(alias) ||
      boundary.literalPlaceholderAliases.has(alias) ||
      boundary.sourcePlaceholders.has(alias)
    ) {
      index += 1;
      alias = `[LITERAL_PLACEHOLDER_${String(index)}]`;
    }
    boundary.literalPlaceholderAliases.set(alias, token);
    replacements.set(token, alias);
    boundary.sourcePlaceholders.add(token);
    boundary.sourcePlaceholders.add(alias);
  }
  return rewritePlaceholders(text, replacements);
};

export const reserveThirdPartyBoundarySourcePlaceholders = ({
  boundary,
  value,
}: {
  boundary: ChatThirdPartyBoundary;
  value: unknown;
}) => {
  if (boundary.type === "raw") {
    return;
  }

  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      reserveSourcePlaceholders(boundary, [current]);
      continue;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      ArrayBuffer.isView(current) ||
      seen.has(current)
    ) {
      continue;
    }
    seen.add(current);
    for (const key of Object.keys(current)) {
      pending.push(key);
    }
    for (const nested of Object.values(current)) {
      pending.push(nested);
    }
  }
};

const boundaryForcedSensitiveValues = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
): string[] => [boundary.organizationId, boundary.anonymizationScopeId];

const boundarySensitiveSurfaces = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  text: string,
): string[] => {
  const normalizedText = text.toLowerCase();
  const surfaces = new Set<string>();
  for (const forcedValue of boundaryForcedSensitiveValues(boundary)) {
    if (forcedValue.length === 0) {
      continue;
    }
    const normalizedForcedValue = forcedValue.toLowerCase();
    let offset = normalizedText.indexOf(normalizedForcedValue);
    while (offset !== -1) {
      surfaces.add(text.slice(offset, offset + forcedValue.length));
      offset = normalizedText.indexOf(
        normalizedForcedValue,
        offset + forcedValue.length,
      );
    }
  }
  return [...surfaces];
};

const forcedSensitiveValuesForFields = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  fields: readonly string[],
): string[] => {
  const values = new Set(boundaryForcedSensitiveValues(boundary));
  for (const field of fields) {
    for (const surface of boundarySensitiveSurfaces(boundary, field)) {
      values.add(surface);
    }
  }
  return [...values];
};

const rewritePlaceholders = (
  text: string,
  replacements: Map<string, string>,
): string => {
  if (replacements.size === 0) {
    return text;
  }
  const pattern = new RegExp(
    [...replacements.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|"),
    "gu",
  );
  return text.replaceAll(pattern, (placeholder) => {
    const replacement = replacements.get(placeholder);
    return replacement ?? placeholder;
  });
};

const protectBoundaryPlaceholders = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  fields: string[],
): {
  fields: string[];
  restore: (protectedFields: string[]) => string[];
} => {
  if (boundary.redactionMap.size === 0) {
    return { fields, restore: (protectedFields) => protectedFields };
  }

  const replacements = new Map<string, string>();
  const restoreReplacements = new Map<string, string>();
  let index = 0;
  for (const placeholder of boundary.redactionMap.keys()) {
    const sentinel = `\uE000BOUNDARY_PLACEHOLDER_${index}\uE001`;
    replacements.set(placeholder, sentinel);
    restoreReplacements.set(sentinel, placeholder);
    index += 1;
  }

  return {
    fields: fields.map((field) => rewritePlaceholders(field, replacements)),
    restore: (protectedFields) =>
      protectedFields.map((field) =>
        rewritePlaceholders(field, restoreReplacements),
      ),
  };
};

const rewriteBoundaryPlaceholders = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  result: AnonymizedTextFieldsResult,
): AnonymizedTextFieldsResult => {
  const replacements = new Map<string, string>();
  const redactionMap = new Map<string, string>();
  const nextIndexByLabel = new Map<string, number>();

  for (const [placeholder, original] of result.redactionMap) {
    const parsed = parseIndexedPlaceholder(placeholder);
    if (parsed === null) {
      redactionMap.set(placeholder, original);
      continue;
    }

    const existingPlaceholder = findExistingPlaceholder(
      boundary,
      parsed.label,
      original,
    );
    if (existingPlaceholder !== null) {
      replacements.set(placeholder, existingPlaceholder);
      redactionMap.set(existingPlaceholder, original);
      continue;
    }

    let nextIndex =
      nextIndexByLabel.get(parsed.label) ??
      (boundary.placeholderOffsets.get(parsed.label) ?? 0) + 1;
    let nextPlaceholder = `[${parsed.label}_${String(nextIndex)}]`;
    while (
      boundary.sourcePlaceholders.has(nextPlaceholder) ||
      boundary.redactionMap.has(nextPlaceholder) ||
      redactionMap.has(nextPlaceholder)
    ) {
      nextIndex += 1;
      if (!Number.isSafeInteger(nextIndex)) {
        throw new TypeError("placeholder index exceeds the safe integer range");
      }
      nextPlaceholder = `[${parsed.label}_${String(nextIndex)}]`;
    }
    replacements.set(placeholder, nextPlaceholder);
    redactionMap.set(nextPlaceholder, original);
    nextIndexByLabel.set(parsed.label, nextIndex + 1);
  }

  for (const [label, nextIndex] of nextIndexByLabel) {
    boundary.placeholderOffsets.set(label, nextIndex - 1);
  }

  return {
    ...result,
    fields: result.fields.map((field) =>
      rewritePlaceholders(field, replacements),
    ),
    redactionMap,
  };
};

const mergeRedactionMap = (
  target: Map<string, string>,
  source: Map<string, string> | undefined,
) => {
  if (!source) {
    return;
  }
  for (const [placeholder, original] of source) {
    if (!target.has(placeholder)) {
      target.set(placeholder, original);
    }
  }
};

const literalPlaceholderRestoreMap = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
): Map<string, string> => new Map(boundary.literalPlaceholderAliases);

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
  if (boundary.type === "raw") {
    return text;
  }
  const deanonymized =
    boundary.redactionMap.size === 0
      ? text
      : deanonymise(text, boundary.redactionMap);
  return rewritePlaceholders(
    deanonymized,
    literalPlaceholderRestoreMap(boundary),
  );
};

const PLACEHOLDER_LIKE = /\[[A-Z][A-Z0-9_]*\]/u;
const PLACEHOLDER_INNER_RE = /^[A-Z][A-Z0-9_]*$/u;
const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/gu;
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
  if (boundary.type === "raw") {
    return value;
  }
  const literalRestorations = literalPlaceholderRestoreMap(boundary);
  if (mode === "strict") {
    const deanonymized = walkStrict(value, boundary.redactionMap);
    return walkStrict(deanonymized, literalRestorations);
  }
  const lenient = buildLenientReplacer(boundary.redactionMap);
  const deanonymized = lenient === null ? value : walkLenient(value, lenient);
  const literalLenient = buildLenientReplacer(literalRestorations);
  return literalLenient === null
    ? deanonymized
    : walkLenient(deanonymized, literalLenient);
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
    ([key, nested]) =>
      [
        PLACEHOLDER_LIKE.test(key) ? deanonymise(key, map) : key,
        walkStrict(nested, map),
      ] as const,
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
  return { pattern: new RegExp(parts.join("|"), "gu"), lookup };
};

const replaceLenient = (value: string, replacer: LenientReplacer): string =>
  value.replaceAll(
    replacer.pattern,
    (token) => replacer.lookup.get(token) ?? token,
  );

const walkLenient = (value: unknown, replacer: LenientReplacer): unknown => {
  if (typeof value === "string") {
    return replaceLenient(value, replacer);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walkLenient(item, replacer));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value).map(
    ([key, nested]) =>
      [replaceLenient(key, replacer), walkLenient(nested, replacer)] as const,
  );
  return Object.fromEntries(entries);
};

type BoundaryRefusal = HandlerError<422 | 500>;

type TextReplacement =
  | {
      type: "replace";
      text: string;
      apply: (value: string) => void;
    }
  | {
      type: "reject-if-changed";
      text: string;
      message: string;
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
  reserveSourcePlaceholders(boundary, [text]);
  const protectedInput = protectBoundaryPlaceholders(boundary, [text]);
  const anonymized = await Result.tryPromise({
    try: async () =>
      await anonymizeFields({
        context: boundary.pipelineContext,
        fields: protectedInput.fields,
        forcedSensitiveValues: forcedSensitiveValuesForFields(boundary, [text]),
        catalogs: {
          type: "preloaded",
          excludedCanonicals: await boundary.excludedCanonicals,
          gazetteerEntries: await boundary.gazetteerEntries,
        },
        organizationId: boundary.organizationId,
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

  const rewritten = rewriteBoundaryPlaceholders(boundary, anonymized.value);
  mergeRedactionMap(boundary.redactionMap, rewritten.redactionMap);
  return Result.ok(protectedInput.restore(rewritten.fields).at(0) ?? "");
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
  reserveSourcePlaceholders(boundary, fields);
  const protectedInput = protectBoundaryPlaceholders(boundary, fields);
  const anonymized = await Result.tryPromise({
    try: async () =>
      await anonymizeFields({
        context: boundary.pipelineContext,
        fields: protectedInput.fields,
        forcedSensitiveValues: forcedSensitiveValuesForFields(boundary, fields),
        catalogs: {
          type: "preloaded",
          excludedCanonicals: await boundary.excludedCanonicals,
          gazetteerEntries: await boundary.gazetteerEntries,
        },
        organizationId: boundary.organizationId,
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

  const rewritten = rewriteBoundaryPlaceholders(boundary, anonymized.value);
  const restoredFields = protectedInput.restore(rewritten.fields);

  for (let index = 0; index < replacements.length; index += 1) {
    const replacement = replacements.at(index);
    if (
      replacement?.type === "reject-if-changed" &&
      restoredFields.at(index) !== replacement.text
    ) {
      return Result.err(
        new HandlerError({
          code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
          status: 422,
          message: replacement.message,
        }),
      );
    }
  }

  mergeRedactionMap(boundary.redactionMap, rewritten.redactionMap);
  for (let index = 0; index < replacements.length; index += 1) {
    const replacement = replacements.at(index);
    if (replacement?.type !== "replace") {
      continue;
    }

    replacement.apply(restoredFields.at(index) ?? "");
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

  replacements.push({ type: "replace", text, apply });
};

const queueOpaqueTextCheck = ({
  message,
  replacements,
  text,
}: {
  message: string;
  replacements: TextReplacement[];
  text: string;
}) => {
  if (text.length === 0) {
    return;
  }

  replacements.push({ type: "reject-if-changed", text, message });
};

const validateOpaqueTextForThirdParty = async ({
  boundary,
  message,
  text,
}: {
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  message: string;
  text: string;
}): Promise<Result<void, BoundaryRefusal>> => {
  const replacements: TextReplacement[] = [];
  queueOpaqueTextCheck({ message, replacements, text });
  return await prepareTextBatchForThirdParty({ boundary, replacements });
};

const anonymizePlainTextFile = ({
  part,
  replacements,
}: {
  part: ChatAttachmentPart;
  replacements: TextReplacement[];
}): Result<ChatMessage["parts"][number], BoundaryRefusal> => {
  if (getChatAttachmentMimeType(part) !== TEXT_PLAIN_MIME_TYPE) {
    return Result.err(
      new HandlerError({
        code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
        status: 422,
        message:
          "Cannot send this attachment to the AI in anonymized mode because stella cannot extract and anonymize it safely.",
      }),
    );
  }

  const parsed = parseDataUrl({
    expectedMimeType: TEXT_PLAIN_MIME_TYPE,
    maxBytes: CHAT_MAX_FILE_BYTES,
    url: getChatAttachmentUrl(part),
  });

  if (Result.isError(parsed)) {
    return Result.err(
      new HandlerError({
        code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
        status: 422,
        message:
          "Cannot send this attachment to the AI in anonymized mode because stella cannot read it as text.",
        cause: parsed.error,
      }),
    );
  }

  const text = Buffer.from(parsed.value.bytes).toString("utf-8");
  let anonymizedText = text;
  let filename = getChatAttachmentFilename(part);

  const prepared = createChatAttachmentPart({
    filename,
    mimeType: TEXT_PLAIN_MIME_TYPE,
    url: toDataUrl(Buffer.from(anonymizedText, "utf-8"), TEXT_PLAIN_MIME_TYPE),
  });

  queueTextReplacement(replacements, text, (value) => {
    anonymizedText = value;
    prepared.source = {
      ...prepared.source,
      value: toDataUrl(
        Buffer.from(anonymizedText, "utf-8"),
        TEXT_PLAIN_MIME_TYPE,
      ),
    };
  });

  if (filename) {
    queueTextReplacement(replacements, filename, (value) => {
      filename = value;
      prepared.metadata = { ...prepared.metadata, filename };
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

  if (part.type === "text" || part.type === "thinking") {
    const prepared = { ...part };
    queueTextReplacement(replacements, part.content, (value) => {
      prepared.content = value;
    });
    return Result.ok(prepared);
  }

  if (isChatAttachmentPart(part)) {
    return anonymizePlainTextFile({ part, replacements });
  }

  if (part.type === "tool-call" || part.type === "tool-result") {
    return anonymizeToolPart({ boundary, part, replacements });
  }

  return Result.ok(part);
};

const toProviderVisibleMessage = (
  message: ChatMessage,
  parts: ChatMessage["parts"] = message.parts,
): ChatMessage => {
  const visible: ChatMessage = {
    id: message.id,
    role: message.role,
    parts,
    ...(message.createdAt === undefined
      ? {}
      : { createdAt: message.createdAt }),
  };
  return visible;
};

const removeProviderInvisibleParts = (
  messages: ChatMessage[],
): ChatMessage[] => {
  const visibleMessages: ChatMessage[] = [];

  for (const message of messages) {
    const parts: ChatMessage["parts"] = [];
    for (const part of message.parts) {
      if (isProviderVisibleChatPart(part)) {
        parts.push(part);
      }
    }
    if (parts.length === 0) {
      continue;
    }

    visibleMessages.push(toProviderVisibleMessage(message, parts));
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

  reserveThirdPartyBoundarySourcePlaceholders({
    boundary,
    value: providerVisibleMessages,
  });

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
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9]*_[A-Za-z0-9-]+)$/iu;

const containsForcedBoundaryValue = (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  value: string,
): boolean => boundarySensitiveSurfaces(boundary, value).length > 0;

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
  anonymizeStructuredKeys = false,
  apply,
  boundary,
  encodeClaimedPlaceholders = false,
  key,
  replacements,
  value,
}: {
  anonymizeStructuredKeys?: boolean | undefined;
  apply?: ((value: unknown) => void) | undefined;
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  encodeClaimedPlaceholders?: boolean | undefined;
  key?: string | undefined;
  replacements: TextReplacement[];
  value: unknown;
}): Result<unknown, BoundaryRefusal> => {
  if (typeof value === "string") {
    const sourceValue = encodeClaimedPlaceholders
      ? encodeLateLiteralPlaceholders(boundary, value)
      : value;
    if (
      key &&
      shouldPreserveStructuredString(key, value) &&
      !containsForcedBoundaryValue(boundary, value)
    ) {
      return Result.ok(sourceValue);
    }

    let prepared = sourceValue;
    queueTextReplacement(replacements, sourceValue, (next) => {
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
            apply?.(output);
          },
          anonymizeStructuredKeys,
          boundary,
          encodeClaimedPlaceholders,
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
      let preparedKey = encodeClaimedPlaceholders
        ? encodeLateLiteralPlaceholders(boundary, nestedKey)
        : nestedKey;
      let preparedValue: unknown;
      if (
        anonymizeStructuredKeys ||
        containsForcedBoundaryValue(boundary, nestedKey)
      ) {
        queueTextReplacement(replacements, preparedKey, (next) => {
          Reflect.deleteProperty(output, preparedKey);
          preparedKey = next;
          Object.assign(output, { [preparedKey]: preparedValue });
          apply?.(output);
        });
      }
      const nestedPrepared = yield* anonymizeUnknownStrings({
        anonymizeStructuredKeys,
        apply: (next) => {
          preparedValue = next;
          Object.assign(output, { [preparedKey]: next });
          apply?.(output);
        },
        boundary,
        encodeClaimedPlaceholders,
        key: nestedKey,
        replacements,
        value: nestedValue,
      });
      preparedValue = nestedPrepared;
      Object.assign(output, { [preparedKey]: nestedPrepared });
    }

    return Result.ok(output);
  });
};

/**
 * Prepare an arbitrary application value for a third-party model boundary.
 * Every user-bearing string is anonymized in one batch, while structured
 * technical identifiers retain the same preservation rules as tool payloads.
 */
export const prepareUnknownForThirdParty = async ({
  anonymizeStructuredKeys = false,
  boundary,
  encodeClaimedPlaceholders = false,
  value,
}: {
  anonymizeStructuredKeys?: boolean;
  boundary: ChatThirdPartyBoundary;
  encodeClaimedPlaceholders?: boolean;
  value: unknown;
}): Promise<Result<unknown, BoundaryRefusal>> => {
  if (boundary.type === "raw") {
    return Result.ok(value);
  }

  reserveThirdPartyBoundarySourcePlaceholders({ boundary, value });

  const replacements: TextReplacement[] = [];
  let preparedValue: unknown;
  const anonymized = anonymizeUnknownStrings({
    anonymizeStructuredKeys,
    apply: (next) => {
      preparedValue = next;
    },
    boundary,
    encodeClaimedPlaceholders,
    replacements,
    value,
  });
  if (Result.isError(anonymized)) {
    return Result.err(anonymized.error);
  }

  preparedValue = anonymized.value;
  const anonymizedBatch = await prepareTextBatchForThirdParty({
    boundary,
    replacements,
  });
  if (Result.isError(anonymizedBatch)) {
    return Result.err(anonymizedBatch.error);
  }
  return Result.ok(preparedValue);
};

type ToolLikePart = Extract<ChatMessage["parts"][number], { state: string }>;
type ToolResultPart = Extract<
  ChatMessage["parts"][number],
  { type: "tool-result" }
>;
const anonymizeToolPart = ({
  boundary,
  part,
  replacements,
}: {
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  part: ToolLikePart;
  replacements: TextReplacement[];
}): Result<ToolLikePart, BoundaryRefusal> =>
  Result.gen(function* () {
    const prepared: ToolLikePart = { ...part };

    if (part.type === "tool-call") {
      const parsedArguments = safeParseToolArguments(part.arguments);
      const argumentsResult = yield* anonymizeUnknownStrings({
        apply: (value) => {
          Reflect.set(prepared, "arguments", safeStringifyToolArguments(value));
        },
        boundary,
        replacements,
        value: parsedArguments,
      });
      Reflect.set(
        prepared,
        "arguments",
        safeStringifyToolArguments(argumentsResult),
      );
    }

    if (part.type === "tool-result") {
      const content = yield* anonymizeToolResultContent({
        apply: (value) => {
          Reflect.set(prepared, "content", value);
        },
        boundary,
        content: part.content,
        replacements,
      });
      Reflect.set(prepared, "content", content);
    }

    if ("input" in part) {
      const input = yield* anonymizeUnknownStrings({
        apply: (value) => {
          Reflect.set(prepared, "input", value);
        },
        boundary,
        replacements,
        value: part.input,
      });
      Reflect.set(prepared, "input", input);
    }

    if ("output" in part) {
      const output = yield* anonymizeUnknownStrings({
        apply: (value) => {
          Reflect.set(prepared, "output", value);
        },
        boundary,
        replacements,
        value: part.output,
      });
      Reflect.set(prepared, "output", output);
    }

    const errorText: unknown = Reflect.get(part, "errorText");
    if (typeof errorText === "string" && errorText.length > 0) {
      queueTextReplacement(replacements, errorText, (value) => {
        Reflect.set(prepared, "errorText", value);
      });
    }

    const title: unknown = Reflect.get(part, "title");
    if (typeof title === "string" && title.length > 0) {
      queueTextReplacement(replacements, title, (value) => {
        Reflect.set(prepared, "title", value);
      });
    }

    const approval: unknown = Reflect.get(part, "approval");
    if (
      typeof approval === "object" &&
      approval !== null &&
      "reason" in approval &&
      typeof approval.reason === "string" &&
      approval.reason
    ) {
      queueTextReplacement(replacements, approval.reason, (value) => {
        Reflect.set(prepared, "approval", { ...approval, reason: value });
      });
    }

    return Result.ok(prepared);
  });

const anonymizeToolResultContent = ({
  apply,
  boundary,
  content,
  replacements,
}: {
  apply: (value: ToolResultPart["content"]) => void;
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  content: ToolResultPart["content"];
  replacements: TextReplacement[];
}): Result<ToolResultPart["content"], BoundaryRefusal> => {
  if (typeof content === "string") {
    return anonymizeToolResultTextContent({
      apply,
      boundary,
      content,
      replacements,
    });
  }

  if (
    content.some((part) => part.type !== "text" && part.source.type === "data")
  ) {
    return Result.err(
      new HandlerError({
        status: 422,
        message:
          "Inline rich-media data cannot cross an anonymized third-party boundary.",
      }),
    );
  }

  const prepared = content.map((part) => {
    if (part.type === "text") {
      const preparedPart = { ...part };
      queueTextReplacement(replacements, part.content, (value) => {
        preparedPart.content = value;
        apply(prepared);
      });
      return preparedPart;
    }

    queueOpaqueTextCheck({
      message:
        "Rich-media URLs that contain sensitive data cannot cross an anonymized third-party boundary.",
      replacements,
      text: part.source.value,
    });
    return { ...part, source: { ...part.source } };
  });

  for (const preparedPart of prepared) {
    if (preparedPart.type === "text" || preparedPart.metadata === undefined) {
      continue;
    }
    const metadata = anonymizeUnknownStrings({
      apply: (value) => {
        preparedPart.metadata = value;
        apply(prepared);
      },
      boundary,
      replacements,
      value: preparedPart.metadata,
    });
    if (Result.isError(metadata)) {
      return Result.err(metadata.error);
    }
    preparedPart.metadata = metadata.value;
  }

  return Result.ok(prepared);
};

const anonymizeToolResultTextContent = ({
  apply,
  boundary,
  content,
  replacements,
}: {
  apply: (value: string) => void;
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  content: string;
  replacements: TextReplacement[];
}): Result<string, BoundaryRefusal> => {
  const parsed = parseToolResultContent(content);
  if (parsed.type === "text") {
    let prepared = content;
    queueTextReplacement(replacements, content, (value) => {
      prepared = value;
      apply(value);
    });
    return Result.ok(prepared);
  }

  let prepared = safeStringifyToolResultContent({
    fallback: content,
    value: parsed.value,
  });

  const anonymized = anonymizeUnknownStrings({
    apply: (value) => {
      prepared = safeStringifyToolResultContent({ fallback: content, value });
      apply(prepared);
    },
    boundary,
    replacements,
    value: parsed.value,
  });
  if (Result.isError(anonymized)) {
    return Result.err(anonymized.error);
  }

  prepared = safeStringifyToolResultContent({
    fallback: content,
    value: anonymized.value,
  });
  return Result.ok(prepared);
};

type ParsedToolResultContent =
  | { type: "json"; value: unknown }
  | { type: "text"; value: string };

const parseToolResultContent = (content: string): ParsedToolResultContent => {
  try {
    const value: unknown = JSON.parse(content);
    return { type: "json", value };
  } catch {
    return { type: "text", value: content };
  }
};

const safeStringifyToolResultContent = ({
  fallback,
  value,
}: {
  fallback: string;
  value: unknown;
}): string => {
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : fallback;
  } catch {
    return fallback;
  }
};

const safeParseToolArguments = (argumentsJson: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return parsed;
  } catch {
    return argumentsJson;
  }
};

const safeStringifyToolArguments = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "{}";
  } catch {
    return "{}";
  }
};

export const prepareToolsForThirdParty = ({
  boundary,
  tools,
}: {
  boundary: ChatThirdPartyBoundary;
  tools: ChatToolMap;
}): ChatToolMap => {
  reserveThirdPartyBoundarySourcePlaceholders({ boundary, value: tools });
  const hasExternalTool = Object.values(tools).some(
    (toolDefinition) =>
      toolDefinition !== undefined &&
      getChatToolPolicy(toolDefinition).requiresAnonymization,
  );
  if (boundary.type === "raw" && !hasExternalTool) {
    return tools;
  }

  const wrapped: ChatToolMap = {};

  for (const [key, current] of Object.entries(tools)) {
    if (!current) {
      continue;
    }

    if (!current.execute) {
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
      execute: async (input, context) => {
        if (policy.requiresAnonymization && boundary.type === "raw") {
          throw new HandlerError({
            status: 422,
            message:
              "External chat tools require anonymized mode before stella can call them.",
          });
        }

        if (boundary.type === "raw") {
          const outputValue: unknown = await execute(input, context);
          return outputValue;
        }

        let toolInput: unknown = input;
        if (deanonymizeInputBeforeExecute) {
          toolInput = deanonymizeUnknownStringsFromBoundary(
            boundary,
            input,
            "lenient",
          );
        }

        const outputValue: unknown = await execute(toolInput, context);
        return await anonymizeToolOutputForThirdParty({
          boundary,
          outputValue,
        });
      },
    };
  }

  return wrapped;
};

export const prepareMcpToolSourceForThirdParty = ({
  boundary,
  source,
}: {
  boundary: ChatThirdPartyBoundary;
  source: MCPToolSource;
}): MCPToolSource => {
  if (boundary.type === "raw") {
    return source;
  }

  return {
    ...source,
    tools: async (options) => {
      const tools = await source.tools(options);
      return await prepareMcpServerToolsForThirdParty({ boundary, tools });
    },
  };
};

const MCP_PROVIDER_METADATA_FIELDS = [
  "description",
  "inputSchema",
  "outputSchema",
] as const;

const unknownObjectEntries = (value: object): [string, unknown][] =>
  Object.keys(value).map((key) => [key, Reflect.get(value, key)]);

const collectMcpInputKeyRestorations = ({
  original,
  prepared,
  restorations,
}: {
  original: unknown;
  prepared: unknown;
  restorations: Map<string, string>;
}): void => {
  if (Array.isArray(original) && Array.isArray(prepared)) {
    if (original.length !== prepared.length) {
      throw new TypeError(
        "MCP input schema preparation changed its array shape",
      );
    }
    for (let index = 0; index < original.length; index += 1) {
      collectMcpInputKeyRestorations({
        original: original.at(index),
        prepared: prepared.at(index),
        restorations,
      });
    }
    return;
  }

  if (
    typeof original !== "object" ||
    original === null ||
    Array.isArray(original) ||
    typeof prepared !== "object" ||
    prepared === null ||
    Array.isArray(prepared)
  ) {
    return;
  }

  const originalEntries = unknownObjectEntries(original);
  const preparedEntries = unknownObjectEntries(prepared);
  if (originalEntries.length !== preparedEntries.length) {
    throw new TypeError(
      "MCP input schema preparation changed its object shape",
    );
  }

  for (const [
    index,
    [originalKey, originalValue],
  ] of originalEntries.entries()) {
    const preparedEntry = preparedEntries.at(index);
    if (preparedEntry === undefined) {
      throw new TypeError("MCP input schema preparation lost a property");
    }
    const [preparedKey, preparedValue] = preparedEntry;
    if (preparedKey !== originalKey) {
      restorations.set(preparedKey, originalKey);
    }
    collectMcpInputKeyRestorations({
      original: originalValue,
      prepared: preparedValue,
      restorations,
    });
  }
};

const restoreMcpInputSchemaKeys = ({
  restorations,
  value,
}: {
  restorations: ReadonlyMap<string, string>;
  value: unknown;
}): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) =>
      restoreMcpInputSchemaKeys({ restorations, value: item }),
    );
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      restorations.get(key) ?? key,
      restoreMcpInputSchemaKeys({ restorations, value: nested }),
    ]),
  );
};

const prepareMcpProviderMetadataForThirdParty = async ({
  boundary,
  index = 0,
  inputKeyRestorations,
  prepared,
}: {
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  index?: number;
  inputKeyRestorations: Map<string, string>;
  prepared: AnyServerTool;
}): Promise<void> => {
  const field = MCP_PROVIDER_METADATA_FIELDS.at(index);
  if (field === undefined) {
    return;
  }
  const providerValue: unknown = Reflect.get(prepared, field);
  if (providerValue !== undefined) {
    const preparedMetadata = await prepareUnknownForThirdParty({
      anonymizeStructuredKeys: true,
      boundary,
      encodeClaimedPlaceholders: true,
      value: providerValue,
    });
    if (Result.isError(preparedMetadata)) {
      throw preparedMetadata.error;
    }
    if (field === "inputSchema") {
      collectMcpInputKeyRestorations({
        original: providerValue,
        prepared: preparedMetadata.value,
        restorations: inputKeyRestorations,
      });
    }
    Reflect.set(prepared, field, preparedMetadata.value);
  }
  await prepareMcpProviderMetadataForThirdParty({
    boundary,
    index: index + 1,
    inputKeyRestorations,
    prepared,
  });
};

const prepareMcpServerToolsForThirdParty = async ({
  boundary,
  index = 0,
  prepared = [],
  tools,
}: {
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  index?: number;
  prepared?: AnyServerTool[];
  tools: AnyServerTool[];
}): Promise<AnyServerTool[]> => {
  const tool = tools.at(index);
  if (tool === undefined) {
    return prepared;
  }

  prepared.push(await prepareMcpServerToolForThirdParty(boundary, tool));
  return await prepareMcpServerToolsForThirdParty({
    boundary,
    index: index + 1,
    prepared,
    tools,
  });
};

const prepareMcpServerToolForThirdParty = async (
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>,
  tool: AnyServerTool,
): Promise<AnyServerTool> => {
  reserveThirdPartyBoundarySourcePlaceholders({ boundary, value: tool });
  const prepared = { ...tool };
  const providerName: unknown = Reflect.get(prepared, "name");
  if (typeof providerName === "string") {
    const nameCheck = await validateOpaqueTextForThirdParty({
      boundary,
      message:
        "MCP tool names that contain sensitive data cannot cross an anonymized third-party boundary.",
      text: providerName,
    });
    if (Result.isError(nameCheck)) {
      throw nameCheck.error;
    }
  }
  const inputKeyRestorations = new Map<string, string>();
  await prepareMcpProviderMetadataForThirdParty({
    boundary,
    inputKeyRestorations,
    prepared,
  });

  const execute = prepared.execute;
  if (!execute) {
    return prepared;
  }

  return {
    ...prepared,
    execute: async (input, context) => {
      const outputValue: unknown = await execute(
        restoreMcpInputSchemaKeys({
          restorations: inputKeyRestorations,
          value: input,
        }),
        context,
      );
      return await anonymizeToolOutputForThirdParty({
        boundary,
        outputValue,
      });
    },
  };
};

const anonymizeToolOutputForThirdParty = async ({
  boundary,
  outputValue,
}: {
  boundary: Extract<ChatThirdPartyBoundary, { type: "anonymized" }>;
  outputValue: unknown;
}): Promise<unknown> => {
  reserveThirdPartyBoundarySourcePlaceholders({
    boundary,
    value: outputValue,
  });
  const replacements: TextReplacement[] = [];
  let preparedOutput: unknown;
  const anonymizedOutput = anonymizeUnknownStrings({
    apply: (value) => {
      preparedOutput = value;
    },
    boundary,
    encodeClaimedPlaceholders: true,
    replacements,
    value: outputValue,
  });

  if (Result.isError(anonymizedOutput)) {
    throw anonymizedOutput.error;
  }

  preparedOutput = anonymizedOutput.value;
  const anonymizedBatch = await prepareTextBatchForThirdParty({
    boundary,
    replacements,
  });
  if (Result.isError(anonymizedBatch)) {
    throw anonymizedBatch.error;
  }

  return preparedOutput;
};
