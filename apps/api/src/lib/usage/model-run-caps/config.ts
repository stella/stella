import * as v from "valibot";

/**
 * The kinds of model run an organization is capped on. Each kind keeps its
 * own counter and its own limits.
 *
 * - `list-run`: a run stella produces for a list, either a verification of a
 *   document against the list's facts or a fact extraction from documents.
 *   The two share one counter, so neither can spend the other's allowance a
 *   second time.
 * - `document-review`: a review a person starts on one document. A playbook
 *   run over a table of documents is admitted as one batch by its own gates
 *   and is not counted here.
 */
export const MODEL_RUN_KINDS = ["list-run", "document-review"] as const;
export type ModelRunKind = (typeof MODEL_RUN_KINDS)[number];

export type ModelRunCaps = {
  /** Runs of the kind that may be queued or running at once. */
  active: number;
  /** Runs of the kind that may start per Europe/Prague day. */
  startsPerDay: number;
};

/** What a counter row holds before its first start writes the configured
 *  limits; the counter table's column defaults are these values. */
export const DEFAULT_RUN_CAPS = {
  active: 2,
  startsPerDay: 20,
} as const satisfies ModelRunCaps;

/**
 * Document reviews take the list runs' limits: both start through the same
 * model admission class, and both queues work two runs at a time, so a third
 * active run of either would only wait.
 */
export const DEFAULT_MODEL_RUN_CAPS = {
  "list-run": DEFAULT_RUN_CAPS,
  "document-review": DEFAULT_RUN_CAPS,
} as const satisfies Record<ModelRunKind, ModelRunCaps>;

/** The bounds the counter table's check constraint enforces. */
export const MODEL_RUN_CAP_BOUNDS = {
  active: { min: 1, max: 100 },
  startsPerDay: { min: 1, max: 1000 },
} as const satisfies Record<keyof ModelRunCaps, { min: number; max: number }>;

const limitSchema = (bounds: { min: number; max: number }, fallback: number) =>
  v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(bounds.min),
      v.maxValue(bounds.max),
    ),
    String(fallback),
  );

/** Each kind's limits, configured per deployment. */
export const modelRunCapEnvSchema = {
  LIST_VERIFICATION_ACTIVE_RUNS_MAX: limitSchema(
    MODEL_RUN_CAP_BOUNDS.active,
    DEFAULT_MODEL_RUN_CAPS["list-run"].active,
  ),
  LIST_VERIFICATION_DAILY_STARTS_MAX: limitSchema(
    MODEL_RUN_CAP_BOUNDS.startsPerDay,
    DEFAULT_MODEL_RUN_CAPS["list-run"].startsPerDay,
  ),
  DOCUMENT_REVIEW_ACTIVE_RUNS_MAX: limitSchema(
    MODEL_RUN_CAP_BOUNDS.active,
    DEFAULT_MODEL_RUN_CAPS["document-review"].active,
  ),
  DOCUMENT_REVIEW_DAILY_STARTS_MAX: limitSchema(
    MODEL_RUN_CAP_BOUNDS.startsPerDay,
    DEFAULT_MODEL_RUN_CAPS["document-review"].startsPerDay,
  ),
};

type ModelRunCapEnvName = keyof typeof modelRunCapEnvSchema;

/** Which setting configures each kind's limits. */
export const MODEL_RUN_CAP_ENV = {
  "list-run": {
    active: "LIST_VERIFICATION_ACTIVE_RUNS_MAX",
    startsPerDay: "LIST_VERIFICATION_DAILY_STARTS_MAX",
  },
  "document-review": {
    active: "DOCUMENT_REVIEW_ACTIVE_RUNS_MAX",
    startsPerDay: "DOCUMENT_REVIEW_DAILY_STARTS_MAX",
  },
} as const satisfies Record<
  ModelRunKind,
  Record<keyof ModelRunCaps, ModelRunCapEnvName>
>;
