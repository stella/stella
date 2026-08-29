// Model calls of the bilingual pipeline. Every call takes the compact row
// manifest (never the DOCX), addresses rows by ordinal, and is validated
// against the known ordinals before anything is trusted.

import type { ModelMessage, TextPart } from "@tanstack/ai";
import type { AnthropicTextMetadata } from "@tanstack/ai-anthropic";
import { TaggedError } from "better-result";
import * as v from "valibot";

import type { ModelRole } from "@stll/ai-catalog";

import { resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import {
  BILINGUAL_GLOSSARY_ORIGINS,
  BILINGUAL_LIMITS,
  BILINGUAL_ROW_DISPOSITIONS,
} from "@/api/lib/bilingual/contract";
import type {
  BilingualGlossaryEntry,
  BilingualRowDisposition,
} from "@/api/lib/bilingual/contract";
import type {
  BilingualFormattedTranslation,
  FormattedBilingualUnit,
} from "@/api/lib/bilingual/formatting";
import { defaultDisposition, ruleDisposition } from "@/api/lib/bilingual/rows";
import type {
  BilingualUnit,
  DispositionedUnit,
} from "@/api/lib/bilingual/rows";
import type { SafeId } from "@/api/lib/branded-types";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

const DISPOSITION_ROLE = "fast" as const;
const GLOSSARY_ROLE = "chat" as const;
const TRANSLATION_ROLE = "chat" as const;
const SERVICE_TIER = "standard" as const;
const CALL_TIMEOUT_MS = 90_000;
const PREVIEW_CHARS = 240;
const GLOSSARY_SAMPLE_CHARS = 24_000;
const FORMATTED_INLINE_TOKENS_MAX = 2048;
const FORMATTED_ROWS_SERIALIZED_CHARS_MAX = 200_000;
const FORMATTED_OUTPUT_ATTEMPTS = 2;
export const SOURCE_DOCUMENT_CACHE_CHARS_MAX = 64_000;
const SOURCE_DOCUMENT_TRUNCATED = "\n[Cached input prefix truncated]";

class BilingualAIContractError extends TaggedError("BilingualAIContractError")<{
  message: string;
}> {}

export type BilingualAIContext = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  usageMetering: AIUsageMetering;
  abortSignal: AbortSignal;
  /** Stable key for prompt-cache scoping, typically the entity version id. */
  scopeKey: string;
  /** External model-dispatch boundary; supplied by focused integration tests. */
  generateObjectForRole?: typeof generateTanStackObjectForRole | undefined;
};

export type BilingualAIDocumentContext = BilingualAIContext & {
  /** Source rows from which the stable cached prefix is derived. */
  sourceDocument: readonly BilingualUnit[];
};

type Languages = { sourceLang: string; targetLang: string };

const analyticsFor = (
  context: BilingualAIContext,
  feature: string,
  modelRole: ModelRole,
) =>
  createTanStackAIAnalyticsCallbacks({
    feature,
    modelRole,
    orgAIConfig: context.orgAIConfig,
    properties: {
      organization_id: context.organizationId,
      workspace_id: context.workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering: context.usageMetering,
  });

const callSignal = (context: BilingualAIContext): AbortSignal =>
  AbortSignal.any([context.abortSignal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);

const preview = (text: string): string =>
  text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;

const serializeSourceDocument = (units: readonly BilingualUnit[]): string => {
  const lines: string[] = [];
  let chars = 0;
  for (const unit of units) {
    const place = unit.inTable ? "table" : unit.kind;
    const separator = lines.length === 0 ? "" : "\n";
    const line = `${separator}#${unit.ordinal} [${place}] ${unit.sourceText}`;
    const available =
      SOURCE_DOCUMENT_CACHE_CHARS_MAX -
      SOURCE_DOCUMENT_TRUNCATED.length -
      chars;
    if (line.length > available) {
      lines.push(line.slice(0, Math.max(0, available)));
      lines.push(SOURCE_DOCUMENT_TRUNCATED);
      return lines.join("");
    }
    lines.push(line);
    chars += line.length;
  }
  return lines.join("");
};

/**
 * Put a stable input-document region before anything that changes per request.
 * Normal documents fit in full; the prefix is bounded because provider prompt
 * caches do not remove cached tokens from the model's context-window limit.
 * The boundary is explicit for Anthropic; OpenAI uses the same prefix plus the
 * stable scope key to route repeated translation batches to one cache shard.
 */
export const buildBilingualDocumentRequest = (
  context: BilingualAIDocumentContext,
  role: ModelRole,
  request: string,
): { caching: ReturnType<typeof resolveCaching>; messages: ModelMessage[] } => {
  const caching = resolveCaching({
    promptCachingEnabled: context.promptCachingEnabled,
    role,
    scopeKey: context.scopeKey,
  });
  const source: TextPart<AnthropicTextMetadata> = {
    type: "text",
    content: `Input document:\n${serializeSourceDocument(context.sourceDocument)}`,
  };
  return {
    caching,
    messages: [
      {
        role: "user",
        content: [
          markTanStackCacheBreakpoint(source, { decision: caching }),
          { type: "text", content: request },
        ],
      },
    ],
  };
};

// ----------------------------------------------------------------------------
// Dispositions
// ----------------------------------------------------------------------------

const dispositionSchema = v.object({
  rows: v.array(
    v.object({
      n: v.pipe(v.number(), v.integer(), v.minValue(1)),
      disposition: v.picklist(BILINGUAL_ROW_DISPOSITIONS),
    }),
  ),
});

const DISPOSITION_SYSTEM = `You prepare a legal document for a two-column bilingual layout (source language left, translation right). Each row is one paragraph. Decide, for each row marked DECIDE, what should happen to it:
- translate: prose that needs a translation in the right column (clauses, recitals, headings, definitions, list items).
- keep: not prose; the row stays once, in one language, with no translation. Signature lines, names and titles under a signature, places and dates of signing, party identifiers (registration numbers, addresses, bank accounts), amounts, references like "Annex 1", dotted or blank lines.
- inline: a short label that should show in both languages on one line, such as "Podpis:" / "Signature:", "Jméno:" / "Name:", "Datum:" / "Date:", column headings of a party table.
Rows are given in document order with their position; use neighbouring rows as context (a name two rows under "Signature:" is part of the signature block). Rows inside a kept table are marked TABLE; for those choose inline for labels, keep for values, translate only for real prose. Answer for every DECIDE row by its number.`;

const formatDispositionRows = (
  units: readonly BilingualUnit[],
  decided: ReadonlyMap<number, BilingualRowDisposition>,
): string =>
  units
    .map((unit) => {
      const marker = decided.has(unit.ordinal)
        ? decided.get(unit.ordinal)
        : "DECIDE";
      const place = unit.inTable ? "TABLE" : unit.kind;
      return `#${unit.ordinal} [${place}] (${marker}) ${preview(unit.sourceText.replaceAll("\n", " "))}`;
    })
    .join("\n");

/**
 * Stamp rule-decidable rows, then ask the model about the rest in chunks that
 * overlap so every row sees its neighbours. Unknown ordinals are ignored;
 * rows the model left out fall back to the redundant default.
 */
export const decideDispositions = async (
  units: readonly BilingualUnit[],
  languages: Languages,
  context: BilingualAIDocumentContext,
): Promise<DispositionedUnit[]> => {
  const decided = new Map<number, BilingualRowDisposition>();
  for (const unit of units) {
    const rule = ruleDisposition(unit);
    if (rule !== null) {
      decided.set(unit.ordinal, rule);
    }
  }
  const modelDecided = new Map<number, BilingualRowDisposition>();

  if (decided.size < units.length) {
    const analytics = analyticsFor(
      context,
      "bilingual.dispositions",
      DISPOSITION_ROLE,
    );
    const chunk = BILINGUAL_LIMITS.dispositionChunk;
    const overlap = 10;
    const step = chunk - overlap;
    const known = new Set(units.map((unit) => unit.ordinal));
    // Chunks run one after another on purpose: the overlap carries the
    // previous chunk's neighbours, and a sequential loop keeps one model
    // request in flight per document.
    const decideFrom = async (start: number): Promise<void> => {
      if (start >= units.length) {
        return;
      }
      const slice = units.slice(start, start + chunk);
      if (!slice.every((unit) => decided.has(unit.ordinal))) {
        const request = buildBilingualDocumentRequest(
          context,
          DISPOSITION_ROLE,
          `Source language: ${languages.sourceLang}. Target language: ${languages.targetLang}.\n\n${formatDispositionRows(slice, decided)}`,
        );
        const output = await (
          context.generateObjectForRole ?? generateTanStackObjectForRole
        )({
          role: DISPOSITION_ROLE,
          orgAIConfig: context.orgAIConfig,
          organizationId: context.organizationId,
          analytics,
          caching: request.caching,
          serviceTier: SERVICE_TIER,
          tenantWorkspaceIds: [context.workspaceId],
          system: DISPOSITION_SYSTEM,
          systemPromptOrigin: "embeds-untrusted",
          messages: request.messages,
          abortSignal: callSignal(context),
          outputSchema: dispositionSchema,
        });
        for (const row of output.rows) {
          if (
            known.has(row.n) &&
            !decided.has(row.n) &&
            !modelDecided.has(row.n)
          ) {
            modelDecided.set(row.n, row.disposition);
          }
        }
      }
      if (start + chunk >= units.length) {
        return;
      }
      await decideFrom(start + step);
    };
    await decideFrom(0);
  }

  return units.map((unit) => {
    const rule = decided.get(unit.ordinal);
    if (rule !== undefined) {
      return { ...unit, disposition: rule, dispositionOrigin: "rule" as const };
    }
    const model = modelDecided.get(unit.ordinal);
    if (model !== undefined) {
      return {
        ...unit,
        disposition: model,
        dispositionOrigin: "model" as const,
      };
    }
    return {
      ...unit,
      disposition: defaultDisposition(unit),
      dispositionOrigin: "default" as const,
    };
  });
};

// ----------------------------------------------------------------------------
// Glossary
// ----------------------------------------------------------------------------

const glossarySchema = v.object({
  terms: v.array(
    v.object({
      source: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(BILINGUAL_LIMITS.termMax),
      ),
      target: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(BILINGUAL_LIMITS.termMax),
      ),
      sourceForms: v.array(
        v.pipe(v.string(), v.trim(), v.maxLength(BILINGUAL_LIMITS.termMax)),
      ),
      targetForms: v.array(
        v.pipe(v.string(), v.trim(), v.maxLength(BILINGUAL_LIMITS.termMax)),
      ),
    }),
  ),
});

const GLOSSARY_SYSTEM = `You build the glossary for translating a legal document. Given the defined terms found in the document and a sample of its text, return for each term the rendering the translation must use throughout, plus the inflected or declined forms in which the source term appears in the text (sourceForms) and the accepted forms of the target rendering (targetForms: plural, possessive, declensions). Cover every listed term. Add only terms the document clearly defines or uses as a term of art (capitalised, repeated). Keep renderings conventional for the target legal system.`;

/**
 * Propose renderings for the detected candidates (and any further terms of
 * art the model spots). Candidates the model skipped come back with an empty
 * target so the reviewer fills them in; the run refuses empty targets.
 */
export const proposeGlossary = async (
  candidates: readonly string[],
  texts: readonly string[],
  languages: Languages,
  context: BilingualAIDocumentContext,
): Promise<BilingualGlossaryEntry[]> => {
  const analytics = analyticsFor(context, "bilingual.glossary", GLOSSARY_ROLE);
  let sample = "";
  for (const text of texts) {
    if (sample.length + text.length > GLOSSARY_SAMPLE_CHARS) {
      break;
    }
    sample += `${text}\n`;
  }
  const request = buildBilingualDocumentRequest(
    context,
    GLOSSARY_ROLE,
    `Source language: ${languages.sourceLang}. Target language: ${languages.targetLang}.\n\nDefined terms found:\n${candidates.map((term) => `- ${term}`).join("\n") || "(none)"}\n\nDocument sample:\n${sample}`,
  );
  const output = await (
    context.generateObjectForRole ?? generateTanStackObjectForRole
  )({
    role: GLOSSARY_ROLE,
    orgAIConfig: context.orgAIConfig,
    organizationId: context.organizationId,
    analytics,
    caching: request.caching,
    serviceTier: SERVICE_TIER,
    tenantWorkspaceIds: [context.workspaceId],
    system: GLOSSARY_SYSTEM,
    systemPromptOrigin: "embeds-untrusted",
    messages: request.messages,
    abortSignal: callSignal(context),
    outputSchema: glossarySchema,
  });

  const byKey = new Map<string, BilingualGlossaryEntry>();
  for (const term of output.terms) {
    const key = term.source.toLowerCase();
    if (byKey.has(key) || byKey.size >= BILINGUAL_LIMITS.glossaryMax) {
      continue;
    }
    const origin = candidates.some(
      (candidate) => candidate.toLowerCase() === key,
    )
      ? BILINGUAL_GLOSSARY_ORIGINS[0]
      : BILINGUAL_GLOSSARY_ORIGINS[1];
    byKey.set(key, {
      source: term.source,
      target: term.target,
      sourceForms: term.sourceForms
        .filter(Boolean)
        .slice(0, BILINGUAL_LIMITS.formsMax),
      targetForms: term.targetForms
        .filter(Boolean)
        .slice(0, BILINGUAL_LIMITS.formsMax),
      origin,
    });
  }
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (!byKey.has(key) && byKey.size < BILINGUAL_LIMITS.glossaryMax) {
      byKey.set(key, {
        source: candidate,
        target: "",
        sourceForms: [],
        targetForms: [],
        origin: "detected",
      });
    }
  }
  return [...byKey.values()];
};

// ----------------------------------------------------------------------------
// Translation
// ----------------------------------------------------------------------------

const translationSchema = v.object({
  items: v.array(
    v.object({
      n: v.pipe(v.number(), v.integer(), v.minValue(1)),
      text: v.string(),
    }),
  ),
});

const TRANSLATION_SYSTEM = `You translate rows of a legal document for a two-column bilingual edition. Translate each numbered row faithfully and completely into the target language in a formal legal register, preserving meaning, sentence boundaries and paragraph structure. Rules:
- Use the glossary renderings exactly, inflected only as the target grammar requires.
- Keep numbers, dates, amounts, currency, article and section references, party names and defined-term capitalisation unchanged.
- Do not add explanations, notes or the source text. Return one item per row number.`;

const FORMATTED_TRANSLATION_SYSTEM = `${TRANSLATION_SYSTEM}
- Each formatted row is an ordered JSON array. Translate only text token values. Control tokens represent tabs, breaks, hyphens, symbols, and fields; they are immutable and remain in place.
- Return every text span exactly once, in its original order, with the same id. Keep text belonging to a styled source span in that span; an empty translated span is allowed when target-language word order requires it.`;

export type TranslationContextRow = {
  sourceText: string;
  targetText: string | null;
};

export type TranslateBatchInput = {
  batch: readonly BilingualUnit[];
  /** Rows preceding the batch, for continuity of reference. */
  preceding: readonly TranslationContextRow[];
  glossary: readonly BilingualGlossaryEntry[];
};

/** Translate one batch; returns text by ordinal for the rows the model
 *  answered. Missing rows are the caller's to mark failed. */
export const translateBatch = async (
  { batch, preceding, glossary }: TranslateBatchInput,
  languages: Languages,
  context: BilingualAIDocumentContext,
): Promise<Map<number, string>> => {
  const analytics = analyticsFor(
    context,
    "bilingual.translate",
    TRANSLATION_ROLE,
  );
  const glossaryLines = glossary
    .filter((entry) => entry.target !== "")
    .map((entry) => `- ${entry.source} -> ${entry.target}`)
    .join("\n");
  const contextLines = preceding
    .map(
      (row) =>
        `  ${row.sourceText}${row.targetText ? `\n  => ${row.targetText}` : ""}`,
    )
    .join("\n");
  const rowLines = batch
    .map((unit) => `#${unit.ordinal}: ${unit.sourceText}`)
    .join("\n");

  const request = buildBilingualDocumentRequest(
    context,
    TRANSLATION_ROLE,
    `Source language: ${languages.sourceLang}. Target language: ${languages.targetLang}.\n\nGlossary:\n${glossaryLines || "(none)"}\n\nPreceding rows (context only):\n${contextLines || "(start of document)"}\n\nRows to translate:\n${rowLines}`,
  );
  const output = await (
    context.generateObjectForRole ?? generateTanStackObjectForRole
  )({
    role: TRANSLATION_ROLE,
    orgAIConfig: context.orgAIConfig,
    organizationId: context.organizationId,
    analytics,
    caching: request.caching,
    serviceTier: SERVICE_TIER,
    tenantWorkspaceIds: [context.workspaceId],
    system: TRANSLATION_SYSTEM,
    systemPromptOrigin: "embeds-untrusted",
    messages: request.messages,
    abortSignal: callSignal(context),
    outputSchema: translationSchema,
  });

  const known = new Set(batch.map((unit) => unit.ordinal));
  const result = new Map<number, string>();
  for (const item of output.items) {
    const text = item.text.trim();
    if (known.has(item.n) && text !== "" && !result.has(item.n)) {
      result.set(item.n, text);
    }
  }
  return result;
};

const formattedTranslationSchema = v.object({
  items: v.array(
    v.object({
      n: v.pipe(v.number(), v.integer(), v.minValue(1)),
      spans: v.array(
        v.object({
          id: v.string(),
          text: v.string(),
        }),
      ),
    }),
  ),
});

export type TranslateFormattedBatchInput = {
  batch: readonly FormattedBilingualUnit[];
  preceding: readonly TranslationContextRow[];
  glossary: readonly BilingualGlossaryEntry[];
};

const hasExactSpanIds = (
  unit: FormattedBilingualUnit,
  spans: readonly { id: string }[],
): boolean =>
  spans.length === unit.spans.length &&
  spans.every((span, index) => span.id === unit.spans.at(index)?.id);

const serializeFormattedRows = (
  batch: readonly FormattedBilingualUnit[],
): string => {
  const lines: string[] = [];
  let serializedChars = 0;
  for (const unit of batch) {
    if (unit.inline.length > FORMATTED_INLINE_TOKENS_MAX) {
      throw new BilingualAIContractError({
        message: `Formatted bilingual row ${unit.rowId} exceeds the inline token limit`,
      });
    }
    const serialized = JSON.stringify(unit.inline);
    serializedChars += serialized.length;
    if (serializedChars > FORMATTED_ROWS_SERIALIZED_CHARS_MAX) {
      throw new BilingualAIContractError({
        message: "Formatted bilingual batch exceeds the prompt size limit",
      });
    }
    lines.push(`#${unit.ordinal}: ${serialized}`);
  }
  return lines.join("\n");
};

type FormattedTranslationOutput = v.InferOutput<
  typeof formattedTranslationSchema
>;

const collectFormattedTranslations = (
  batch: readonly FormattedBilingualUnit[],
  output: FormattedTranslationOutput,
  result: Map<number, BilingualFormattedTranslation>,
): FormattedBilingualUnit[] => {
  const byOrdinal = new Map(batch.map((unit) => [unit.ordinal, unit]));
  for (const item of output.items) {
    const unit = byOrdinal.get(item.n);
    if (!unit || result.has(item.n) || !hasExactSpanIds(unit, item.spans)) {
      continue;
    }
    const text = item.spans.map((span) => span.text).join("");
    if (text.trim() === "") {
      continue;
    }
    result.set(item.n, {
      text,
      spans: item.spans.map(({ id, text: spanText }) => ({
        id,
        text: spanText,
      })),
    });
  }
  return batch.filter((unit) => !result.has(unit.ordinal));
};

/** Translate a batch without flattening its styled DOCX runs to plain text. */
export const translateFormattedBatch = async (
  { batch, preceding, glossary }: TranslateFormattedBatchInput,
  languages: Languages,
  context: BilingualAIDocumentContext,
): Promise<Map<number, BilingualFormattedTranslation>> => {
  const analytics = analyticsFor(
    context,
    "bilingual.translate",
    TRANSLATION_ROLE,
  );
  const glossaryLines = glossary
    .filter((entry) => entry.target !== "")
    .map((entry) => `- ${entry.source} -> ${entry.target}`)
    .join("\n");
  const contextLines = preceding
    .map(
      (row) =>
        `  ${row.sourceText}${row.targetText ? `\n  => ${row.targetText}` : ""}`,
    )
    .join("\n");
  const result = new Map<number, BilingualFormattedTranslation>();
  const translateAttempt = async (
    remaining: readonly FormattedBilingualUnit[],
    attempt: number,
  ): Promise<void> => {
    const rowLines = serializeFormattedRows(remaining);
    const repairInstruction =
      attempt === 1
        ? ""
        : "\n\nContract repair: return every listed row with exactly the provided text span ids, once and in order.";
    const request = buildBilingualDocumentRequest(
      context,
      TRANSLATION_ROLE,
      `Source language: ${languages.sourceLang}. Target language: ${languages.targetLang}.\n\nGlossary:\n${glossaryLines || "(none)"}\n\nPreceding rows (context only):\n${contextLines || "(start of document)"}\n\nFormatted rows to translate:\n${rowLines}${repairInstruction}`,
    );
    const output = await (
      context.generateObjectForRole ?? generateTanStackObjectForRole
    )({
      role: TRANSLATION_ROLE,
      orgAIConfig: context.orgAIConfig,
      organizationId: context.organizationId,
      analytics,
      caching: request.caching,
      serviceTier: SERVICE_TIER,
      tenantWorkspaceIds: [context.workspaceId],
      system: FORMATTED_TRANSLATION_SYSTEM,
      systemPromptOrigin: "embeds-untrusted",
      messages: request.messages,
      abortSignal: callSignal(context),
      outputSchema: formattedTranslationSchema,
    });
    const rejected = collectFormattedTranslations(remaining, output, result);
    if (attempt < FORMATTED_OUTPUT_ATTEMPTS && rejected.length > 0) {
      await translateAttempt(rejected, attempt + 1);
    }
  };
  if (batch.length > 0) {
    await translateAttempt(batch, 1);
  }
  return result;
};
