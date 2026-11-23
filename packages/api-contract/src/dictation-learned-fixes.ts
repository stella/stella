import * as v from "valibot";

import { STELLA_API_VERSION_PREFIX } from "./index";

// dictation-learned-fixes.json is the native client's contract; the
// desktop reads its path and limits from it, and
// dictation-learned-fixes.test.ts binds these values to it.

/** Where a signed-in member (web, phone) reads and changes their fixes. */
export const DICTATION_LEARNED_FIXES_PATH =
  `${STELLA_API_VERSION_PREFIX}/dictation/learned-fixes` as const;
/** The same for a linked desktop, with its account key and device proof. */
export const DESKTOP_DICTATION_LEARNED_FIXES_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/dictation/learned-fixes` as const;

// The statuses and the fix limit are `@stll/transcript/learned-fixes`'s,
// which applies the changes; apps/api/src/lib/dictation/learned-fixes.ts
// binds the two at compile time.
export const DICTATION_LEARNED_FIX_STATUSES = [
  "learning",
  "on",
  "off",
  "contradicted",
] as const;

/** The statuses a person sets with a fix's switch. */
export const DICTATION_LEARNED_FIX_SWITCHES = ["on", "off"] as const;

export const DICTATION_LEARNED_FIX_LIMITS = {
  fixes: 30,
  /** The longest side of a fix, in UTF-16 units. */
  textLength: 48,
  /** The most words on either side of one fix. */
  words: 3,
  /** Changes one request carries; a device with more sends them in turns. */
  changesPerRequest: 50,
} as const;

/** Whether `text` can be a side of a fix: a few words, trimmed, no line or control characters. */
const isFixText = (text: string): boolean =>
  text.length > 0 &&
  text.trim() === text &&
  !/[\p{Cc}\u2028\u2029]/u.test(text) &&
  text.split(/\s+/u).length <= DICTATION_LEARNED_FIX_LIMITS.words;

const fixTextSchema = v.pipe(
  v.string(),
  v.maxLength(DICTATION_LEARNED_FIX_LIMITS.textLength),
  v.check(
    isFixText,
    `A side of a fix is 1 to ${DICTATION_LEARNED_FIX_LIMITS.words} words on one line, trimmed.`,
  ),
);

export const dictationLearnedFixSchema = v.strictObject({
  from: fixTextSchema,
  to: fixTextSchema,
  seen: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  status: v.picklist(DICTATION_LEARNED_FIX_STATUSES),
});

/**
 * A member's learned fixes. `generation` counts how often they deleted
 * everything stella learned: a device sends the generation its changes were
 * made in, and changes made before a deletion are dropped.
 */
export const dictationLearnedFixesSchema = v.strictObject({
  generation: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  fixes: v.pipe(
    v.array(dictationLearnedFixSchema),
    v.maxLength(DICTATION_LEARNED_FIX_LIMITS.fixes),
  ),
});

export type DictationLearnedFixes = v.InferOutput<
  typeof dictationLearnedFixesSchema
>;

/** Each change names itself, the same on every attempt, so a retried one is applied once. */
const changeId = v.pipe(v.string(), v.uuid());

export const dictationLearnedFixChangeSchema = v.variant("type", [
  v.strictObject({
    id: changeId,
    type: v.literal("corrected"),
    from: fixTextSchema,
    to: fixTextSchema,
  }),
  v.strictObject({
    id: changeId,
    type: v.literal("kept"),
    from: fixTextSchema,
  }),
  v.strictObject({
    id: changeId,
    type: v.literal("taught"),
    from: fixTextSchema,
    to: fixTextSchema,
  }),
  v.strictObject({
    id: changeId,
    type: v.literal("switched"),
    from: fixTextSchema,
    status: v.picklist(DICTATION_LEARNED_FIX_SWITCHES),
  }),
]);

export type DictationLearnedFixChange = v.InferOutput<
  typeof dictationLearnedFixChangeSchema
>;

/** Changes a device made since it last synced, in the order it made them. */
export const dictationLearnedFixChangesSchema = v.strictObject({
  generation: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  changes: v.pipe(
    v.array(dictationLearnedFixChangeSchema),
    v.minLength(1),
    v.maxLength(DICTATION_LEARNED_FIX_LIMITS.changesPerRequest),
  ),
});

export type DictationLearnedFixChanges = v.InferOutput<
  typeof dictationLearnedFixChangesSchema
>;
