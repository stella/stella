import * as v from "valibot";

import { numberFromString } from "./http-input";
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

/**
 * Each change carries its device's next number: a device numbers its changes
 * 1, 2, 3 and so on, and the server applies a change only if its number is
 * above the highest it applied from that device, so a retried change is
 * applied once however late it comes.
 */
const changeSeq = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

export const dictationLearnedFixChangeSchema = v.variant("type", [
  v.strictObject({
    seq: changeSeq,
    type: v.literal("corrected"),
    from: fixTextSchema,
    to: fixTextSchema,
  }),
  v.strictObject({
    seq: changeSeq,
    type: v.literal("kept"),
    from: fixTextSchema,
  }),
  v.strictObject({
    seq: changeSeq,
    type: v.literal("taught"),
    from: fixTextSchema,
    to: fixTextSchema,
  }),
  v.strictObject({
    seq: changeSeq,
    type: v.literal("switched"),
    from: fixTextSchema,
    status: v.picklist(DICTATION_LEARNED_FIX_SWITCHES),
  }),
]);

export type DictationLearnedFixChange = v.InferOutput<
  typeof dictationLearnedFixChangeSchema
>;

const generationSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/**
 * Changes a device made since it last synced, in the order it made them.
 * `device` is the id the device keeps with its change numbers; a device that
 * loses its numbers starts again under a new id.
 */
export const dictationLearnedFixChangesSchema = v.strictObject({
  generation: generationSchema,
  device: v.pipe(v.string(), v.uuid()),
  changes: v.pipe(
    v.array(dictationLearnedFixChangeSchema),
    v.minLength(1),
    v.maxLength(DICTATION_LEARNED_FIX_LIMITS.changesPerRequest),
  ),
});

export type DictationLearnedFixChanges = v.InferOutput<
  typeof dictationLearnedFixChangesSchema
>;

/**
 * Deleting everything learned names the generation it deletes: a repeat of a
 * deletion the server already made, or one made before another device's,
 * leaves what was learned since in place.
 */
export const dictationLearnedFixesClearQuerySchema = v.object({
  generation: numberFromString(generationSchema),
});

export type DictationLearnedFixesClearQuery = v.InferOutput<
  typeof dictationLearnedFixesClearQuerySchema
>;
