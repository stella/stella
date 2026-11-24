/**
 * What Activity records on this computer, what it never records, and what
 * leaves it. Setup, the introduction and the Activity window state these
 * facts only through `ActivityDisclosure`, which renders these lists, so no
 * surface can tell a different story. `tests/activity-disclosure.test.ts`
 * binds each fact to the native fields that make it true: a field recorded
 * or sent without a fact here fails until it is disclosed.
 */

export const ACTIVITY_RECORDED = [
  "app",
  "activeTime",
  "details",
  "browserTitles",
  "calls",
] as const;

export type ActivityRecordedFact = (typeof ACTIVITY_RECORDED)[number];

export const ACTIVITY_NEVER_RECORDED = [
  "screen",
  "keystrokes",
  "webAddresses",
  "audio",
] as const;

/** Each way recorded activity leaves the computer, always on a request. */
export const ACTIVITY_SENT = ["timeEntries", "aiDrafts"] as const;

export type ActivitySentFact = (typeof ACTIVITY_SENT)[number];

/**
 * What a stella AI draft is written from, in the order the disclosure and the
 * consent both list them: first what this computer sends with the request,
 * then what stella adds from the account. The disclosure test binds the sent
 * inputs to the request fields, so a field sent without an input here fails.
 */
export const AI_DRAFT_SENT_INPUTS = [
  "matter",
  "date",
  "duration",
  "appNames",
  "titles",
  "instructions",
] as const;

export type AiDraftSentInput = (typeof AI_DRAFT_SENT_INPUTS)[number];

export const AI_DRAFT_INPUTS = [
  ...AI_DRAFT_SENT_INPUTS,
  "earlierDescriptions",
  "billingFormat",
  "firmGuidelines",
] as const;
