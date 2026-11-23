/** Where a learned fix stands; mirrors `FixStatus` in `dictation_learned.rs`. */
const LEARNED_FIX_STATUSES = ["learning", "on", "off", "contradicted"] as const;

type LearnedFixStatus = (typeof LEARNED_FIX_STATUSES)[number];

export type LearnedFix = {
  from: string;
  seen: number;
  status: LearnedFixStatus;
  to: string;
};

/** What the learned-fixes commands answer. */
type LearnedView = { fixes: LearnedFix[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLearnedFix = (value: unknown): value is LearnedFix =>
  isRecord(value) &&
  typeof value["from"] === "string" &&
  typeof value["to"] === "string" &&
  typeof value["seen"] === "number" &&
  LEARNED_FIX_STATUSES.some((status) => status === value["status"]);

export const isLearnedView = (value: unknown): value is LearnedView =>
  isRecord(value) &&
  Array.isArray(value["fixes"]) &&
  value["fixes"].every(isLearnedFix);

/** The fixes Settings lists: those on or switched off. */
export const listedFixes = (fixes: readonly LearnedFix[]) =>
  fixes.filter(({ status }) => status === "on" || status === "off");
