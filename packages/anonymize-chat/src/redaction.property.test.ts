import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type {
  NativeAnonymizeBinding,
  NativePipelineEntity,
  NativeStaticRedactionResult,
  PipelineConfig,
} from "@stll/anonymize-wasm";
import { propertyConfig } from "@stll/property-testing";

import { runChatAnonPipeline } from "./index";
import type { ChatAnonRuntime } from "./index";

/**
 * Redaction is the whole point of this package: an entity the pipeline
 * reports must not survive in the outgoing text. The sibling
 * `index.test.ts` only checks config-shape equality and error-payload
 * parsing, so these property tests cover the privacy invariant directly.
 *
 * OFFSET CONTRACT. `runChatAnonPipeline` delegates detection + redaction
 * to the native binding (`pipeline.redactText`) and never consumes the
 * `start`/`end` offsets itself, but the binding contract these fakes stand
 * in for reports offsets as UTF-16 code units (plain JS string indices) -
 * NOT UTF-8 bytes and NOT Unicode code points. Verified empirically
 * against `@stll/anonymize-wasm` 2.0.1 `redactDefaultText`: an email at
 * JS index 5 (byte 7, code point 4) behind a `𝕏` surrogate pair is
 * reported at `start: 5`. The fakes below therefore slice with
 * `String.prototype.slice` (UTF-16 semantics), so multi-byte inputs
 * (Czech/Slovak diacritics, Arabic, and astral `𝕏`) exercise the real
 * unit and would catch a byte-vs-code-unit regression in the pipeline's
 * placeholder-protection or excluded-canonical post-processing.
 *
 * Inputs are generated free of literal `[LABEL_n]` placeholder tokens, so
 * `protectLiteralPlaceholders` is a no-op and the offsets the generators
 * compute over the original text stay valid inside `redactText` (the
 * protection step rewrites such tokens to a longer sentinel, which would
 * otherwise shift every later offset). Literal-placeholder handling is
 * covered by the example tests in `index.test.ts`.
 */

// Disjoint alphabets make the invariants crisp: entity characters never
// occur in surrounding "keep" text or inside a placeholder token, so
// "no entity character survives" is an exact check rather than an
// occurrence count.
const ENTITY_CODEPOINTS = [
  // Czech / Slovak diacritics (single UTF-16 unit each)
  "á",
  "é",
  "í",
  "č",
  "š",
  "ř",
  "ž",
  "ľ",
  "ô",
  // Arabic (single UTF-16 unit each)
  "ا",
  "ب",
  "ت",
  "ث",
  // Astral: 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes
  "𝕏",
] as const;
const ENTITY_CODEPOINT_SET = new Set<string>(ENTITY_CODEPOINTS);

// BMP-only subset for generators that place span offsets at arbitrary
// positions: every character is one UTF-16 code unit, so a random offset
// can never split a surrogate pair (which a real binding would never do).
const BMP_ENTITY_CODEPOINTS = ENTITY_CODEPOINTS.filter((c) => c.length === 1);

// Lowercase ASCII + space: disjoint from entity codepoints and from the
// uppercase/digit/bracket characters that make up placeholder tokens. Kept
// as a tuple (not a string) so `fc.constantFrom(...KEEP_CHARS)` spreads an
// array of pre-split single-code-unit characters instead of the string
// itself; every entry here is plain ASCII, so there is no offset/grapheme
// distinction to get wrong, but spreading a string still trips
// `no-misused-spread`.
const KEEP_CHARS = ["a", "b", "c", "d", "e", " "] as const;

const LABELS = [
  "person",
  "organization",
  "email address",
  "address",
  "iban",
] as const;

const normalizeLabelForPlaceholder = (label: string): string =>
  label.trim().toUpperCase().replaceAll(/\s+/gu, "_");

type Span = { start: number; end: number; label: string };

/**
 * A `ChatAnonRuntime` whose `redactText` faithfully models the native
 * binding: it resolves overlapping spans (deterministic, longest-first
 * greedy sweep, matching the "resolvedEntities" the real pipeline emits),
 * assigns a stable placeholder per distinct `(label, surface form)`, and
 * splices those spans out of the received text by UTF-16 offset. The spans
 * are captured over the same text `redactText` receives, so this exercises
 * the real offset contract rather than a text-search convenience.
 */
const buildOffsetRuntime = (spans: readonly Span[]): ChatAnonRuntime => ({
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- opaque test double for the wasm binding, never inspected
  getBinding: async () => ({}) as NativeAnonymizeBinding,
  createPipelineContext: () => ({
    nativePipelinePackage: null,
    nativePipelinePackageKey: "",
    nativePipelinePackagePromise: null,
  }),
  createNativePipelineFromConfig: async () => {
    const pipeline = {
      redactText: (fullText: string): NativeStaticRedactionResult => {
        const resolved = resolveSpans(spans);

        const placeholderByKey = new Map<string, string>();
        let counter = 0;
        const placeholderFor = (label: string, text: string): string => {
          const key = `${label} ${text}`;
          const existing = placeholderByKey.get(key);
          if (existing !== undefined) {
            return existing;
          }
          counter += 1;
          const placeholder = `[${normalizeLabelForPlaceholder(label)}_${counter}]`;
          placeholderByKey.set(key, placeholder);
          return placeholder;
        };

        const resolvedEntities: NativePipelineEntity[] = resolved.map(
          (span) => ({
            start: span.start,
            end: span.end,
            label: span.label,
            text: fullText.slice(span.start, span.end),
            score: 1,
            source: "regex",
          }),
        );

        const redactionMap = new Map<string, string>();
        const operatorMap = new Map<string, "replace">();
        // Splice right-to-left so earlier offsets stay valid.
        let redactedText = fullText;
        for (let i = resolved.length - 1; i >= 0; i--) {
          const span = resolved[i]!;
          const original = fullText.slice(span.start, span.end);
          const placeholder = placeholderFor(span.label, original);
          redactedText =
            redactedText.slice(0, span.start) +
            placeholder +
            redactedText.slice(span.end);
          redactionMap.set(placeholder, original);
          operatorMap.set(placeholder, "replace");
        }

        return {
          resolvedEntities,
          redaction: {
            redactedText,
            redactionMap,
            operatorMap,
            entityCount: resolved.length,
          },
        };
      },
    };
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only redactText is exercised
    return pipeline as unknown as Awaited<
      ReturnType<ChatAnonRuntime["createNativePipelineFromConfig"]>
    >;
  },
  // Mirror the real `deanonymise`: iterate placeholder -> original and
  // replace all occurrences (string form, as the wasm export does).
  deanonymise: (redactedText, redactionMap) => {
    let result = redactedText;
    for (const [placeholder, original] of redactionMap) {
      result = result.replaceAll(placeholder, () => original);
    }
    return result;
  },
});

/** Longest-first greedy non-overlap sweep; models resolved entities. */
const resolveSpans = (spans: readonly Span[]): Span[] => {
  const sorted = [...spans].toSorted(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const resolved: Span[] = [];
  let lastEnd = 0;
  for (const span of sorted) {
    if (span.end > span.start && span.start >= lastEnd) {
      resolved.push(span);
      lastEnd = span.end;
    }
  }
  return resolved;
};

const dictionaries = {} as NonNullable<PipelineConfig["dictionaries"]>;

const deanonymiseWith = (
  text: string,
  redactionMap: ReadonlyMap<string, string>,
): string => {
  let result = text;
  for (const [placeholder, original] of redactionMap) {
    result = result.replaceAll(placeholder, () => original);
  }
  return result;
};

const containsEntityCodepoint = (text: string): boolean => {
  for (const ch of text) {
    if (ENTITY_CODEPOINT_SET.has(ch)) {
      return true;
    }
  }
  return false;
};

// ── Generators ────────────────────────────────────────────

type Segment =
  | { kind: "keep"; text: string }
  | { kind: "entity"; text: string; label: string };

const keepSegmentArb: fc.Arbitrary<Segment> = fc
  .string({ minLength: 0, maxLength: 4, unit: fc.constantFrom(...KEEP_CHARS) })
  .map((text) => ({ kind: "keep", text }));

const entitySegmentArb: fc.Arbitrary<Segment> = fc
  .record({
    text: fc
      .array(fc.constantFrom(...ENTITY_CODEPOINTS), {
        minLength: 1,
        maxLength: 4,
      })
      .map((cps) => cps.join("")),
    label: fc.constantFrom(...LABELS),
  })
  .map(({ text, label }) => ({ kind: "entity", text, label }));

/**
 * Build a document from segments and record each entity's UTF-16 span.
 * Consecutive entity segments yield adjacent spans; a leading/trailing
 * entity segment yields a span at offset 0 / end-of-string; a
 * single-code-point entity (including the astral `𝕏`) yields a
 * minimal-width span.
 */
const documentFromSegments = (
  segments: readonly Segment[],
): { text: string; spans: Span[] } => {
  let text = "";
  const spans: Span[] = [];
  for (const segment of segments) {
    if (segment.kind === "entity") {
      spans.push({
        start: text.length,
        end: text.length + segment.text.length,
        label: segment.label,
      });
    }
    text += segment.text;
  }
  return { text, spans };
};

const documentArb = fc
  .array(fc.oneof(keepSegmentArb, entitySegmentArb), {
    minLength: 0,
    maxLength: 8,
  })
  .map(documentFromSegments);

// ── Properties ────────────────────────────────────────────

describe("chat redaction never leaks a reported entity", () => {
  test("no reported span survives in the redacted text", async () => {
    await fc.assert(
      fc.asyncProperty(documentArb, async ({ text, spans }) => {
        const runtime = buildOffsetRuntime(spans);
        const result = await runChatAnonPipeline({
          runtime,
          dictionaries,
          text,
          workspaceId: "ws",
        });

        // Every entity character lived only inside a reported span, and the
        // spans are non-overlapping, so a correct redaction removes all of
        // them. A surviving entity code point means an offset/protection
        // bug let real content through.
        expect(containsEntityCodepoint(result.redactedText)).toBe(false);
        // Reversible: the placeholder map restores the exact input, which
        // also proves surrounding "keep" text was not over-redacted.
        expect(deanonymiseWith(result.redactedText, result.redactionMap)).toBe(
          text,
        );
        expect(result.entityCount).toBe(spans.length);
        expect(result.pairs.length).toBe(result.redactionMap.size);
      }),
      propertyConfig({ numRuns: 400 }),
    );
  });
});

// Arbitrary offset pairs over BMP-only multi-byte text: overlapping,
// nested, adjacent, zero-width, and boundary spans, so overlap resolution
// and the offset math are stressed together.
const overlappingCaseArb = fc
  .string({
    minLength: 1,
    maxLength: 24,
    unit: fc.constantFrom(...KEEP_CHARS, ...BMP_ENTITY_CODEPOINTS),
  })
  .chain((text) => {
    const offset = fc.integer({ min: 0, max: text.length });
    const spanArb = fc.record({
      start: offset,
      end: offset,
      label: fc.constantFrom(...LABELS),
    });
    return fc.record({
      text: fc.constant(text),
      spans: fc.array(spanArb, { minLength: 0, maxLength: 6 }),
    });
  });

describe("chat redaction under adversarial overlapping spans", () => {
  test("stays reversible and structurally consistent", async () => {
    await fc.assert(
      fc.asyncProperty(overlappingCaseArb, async ({ text, spans }) => {
        const runtime = buildOffsetRuntime(spans);
        const result = await runChatAnonPipeline({
          runtime,
          dictionaries,
          text,
          workspaceId: "ws",
        });

        // Round-trip holds regardless of how spans overlapped, because the
        // binding emits a resolved, non-overlapping set. Also covers the
        // documented blank-text short circuit (no redaction attempted).
        expect(deanonymiseWith(result.redactedText, result.redactionMap)).toBe(
          text,
        );
        const expectedCount =
          text.trim().length === 0 ? 0 : resolveSpans(spans).length;
        expect(result.entityCount).toBe(expectedCount);
        expect(result.pairs.length).toBe(result.redactionMap.size);
        // Distinct placeholders (Map keys are unique by construction, but
        // assert the pairs mirror them without duplication).
        expect(new Set(result.pairs.map((p) => p.placeholder)).size).toBe(
          result.pairs.length,
        );
      }),
      propertyConfig({ numRuns: 400 }),
    );
  });
});

// A handful of distinct canonical entities, each repeated a few times and
// interleaved with keep text, to exercise placeholder stability and the
// excluded-canonical revert path.
const repeatedEntitiesArb = fc
  .uniqueArray(
    fc.record({
      value: fc
        .array(fc.constantFrom(...BMP_ENTITY_CODEPOINTS), {
          minLength: 2,
          maxLength: 4,
        })
        .map((cps) => cps.join("")),
      label: fc.constantFrom(...LABELS),
      occurrences: fc.integer({ min: 1, max: 3 }),
    }),
    { selector: (e) => `${e.label} ${e.value}`, minLength: 1, maxLength: 4 },
  )
  .map((canonicals) => {
    const segments: Segment[] = [];
    for (const canonical of canonicals) {
      for (let i = 0; i < canonical.occurrences; i++) {
        segments.push({ kind: "keep", text: " a " });
        segments.push({
          kind: "entity",
          text: canonical.value,
          label: canonical.label,
        });
      }
    }
    segments.push({ kind: "keep", text: " b" });
    const { text, spans } = documentFromSegments(segments);
    return { canonicals, text, spans };
  });

describe("chat redaction placeholder stability", () => {
  test("one placeholder per canonical, reversible, distinct across canonicals", async () => {
    await fc.assert(
      fc.asyncProperty(
        repeatedEntitiesArb,
        async ({ canonicals, text, spans }) => {
          const runtime = buildOffsetRuntime(spans);
          const result = await runChatAnonPipeline({
            runtime,
            dictionaries,
            text,
            workspaceId: "ws",
          });

          // One reversible placeholder per distinct canonical, so repeated
          // occurrences of the same value share a placeholder and distinct
          // values never collide onto one.
          expect(result.redactionMap.size).toBe(canonicals.length);
          expect(
            deanonymiseWith(result.redactedText, result.redactionMap),
          ).toBe(text);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("excluding a canonical removes only that entity and stays reversible", async () => {
    await fc.assert(
      fc.asyncProperty(
        repeatedEntitiesArb,
        fc.integer({ min: 0, max: 3 }),
        async ({ canonicals, text, spans }, pickRaw) => {
          const excluded = canonicals[pickRaw % canonicals.length]!;
          const runtime = buildOffsetRuntime(spans);
          const result = await runChatAnonPipeline({
            runtime,
            dictionaries,
            text,
            workspaceId: "ws",
            excludedCanonicals: [excluded.value],
          });

          // The excluded value is fully restored and dropped from the map;
          // its occurrences no longer count toward entityCount. Exclusion
          // matches by surface form only (the allowlist is a list of
          // strings, not label-scoped), so every entity sharing the value
          // is reverted regardless of its label.
          const excludedOccurrences = spans.filter(
            (s) => text.slice(s.start, s.end) === excluded.value,
          ).length;
          expect(
            [...result.redactionMap.values()].includes(excluded.value),
          ).toBe(false);
          expect(result.pairs.some((p) => p.original === excluded.value)).toBe(
            false,
          );
          expect(result.entityCount).toBe(spans.length - excludedOccurrences);

          // Remaining placeholders still fully reverse to the original doc.
          expect(
            deanonymiseWith(result.redactedText, result.redactionMap),
          ).toBe(text);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
