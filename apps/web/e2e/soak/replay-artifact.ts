import * as v from "valibot";

import {
  replayControlSelectionSchema,
  workspaceActionSchema,
} from "./workspace-actions";

export const REPLAY_ARTIFACT_VERSION = 1 as const;
export const MAX_REPLAY_STEPS = 100_000;
export const MAX_EVENT_TRAIL_LENGTH = 512;
export const REPLAY_FIXTURE_NAME = "workspace-document" as const;

const routeSchema = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.maxLength(256),
  v.regex(/^\//u, "Replay route must be an application path"),
  v.transform((route) => route.split(/[?#]/u, 1)[0] ?? route),
);

const replayStateSnapshotSchema = v.pipe(
  v.strictObject({
    route: routeSchema,
    selectedControls: v.array(replayControlSelectionSchema),
    inspectorVisible: v.optional(v.boolean()),
    documentDialogOpen: v.optional(v.boolean()),
    loadedDocumentKey: v.optional(v.literal("primary")),
  }),
  v.check(
    ({ selectedControls }) =>
      new Set(selectedControls.map(({ family }) => family)).size ===
      selectedControls.length,
    "Replay state has multiple selected values in one control family",
  ),
);

const replayEventSchema = v.strictObject({
  step: v.pipe(v.number(), v.integer(), v.minValue(0)),
  action: workspaceActionSchema,
  applicableActions: v.array(workspaceActionSchema),
  before: replayStateSnapshotSchema,
  after: v.optional(replayStateSnapshotSchema),
});

const replayArtifactSchema = v.pipe(
  v.strictObject({
    version: v.literal(REPLAY_ARTIFACT_VERSION),
    seed: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(Number.MIN_SAFE_INTEGER),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
    stepLimit: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(MAX_REPLAY_STEPS),
    ),
    commit: v.union([
      v.literal("unknown"),
      v.pipe(v.string(), v.maxLength(64), v.regex(/^[\da-f]+$/iu)),
    ]),
    locale: v.literal("en-US"),
    viewport: v.strictObject({
      width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16_384)),
      height: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(16_384),
      ),
    }),
    fixture: v.strictObject({
      kind: v.literal("synthetic-workspace"),
      name: v.literal(REPLAY_FIXTURE_NAME),
    }),
    events: v.pipe(v.array(replayEventSchema), v.maxLength(MAX_REPLAY_STEPS)),
  }),
  v.check(
    ({ events, stepLimit }) => events.length <= stepLimit,
    "Replay artifact events exceed the step limit",
  ),
  v.check(
    ({ events }) => events.every(({ step }, index) => step === index),
    "Replay event steps must be contiguous and zero-based",
  ),
);

export type ReplayStateSnapshot = v.InferOutput<
  typeof replayStateSnapshotSchema
>;
export type ReplayEvent = v.InferOutput<typeof replayEventSchema>;
export type ReplayArtifact = v.InferOutput<typeof replayArtifactSchema>;

/** Validate untrusted replay JSON and discard URL query/fragment data. */
export const parseReplayArtifact = (value: unknown): ReplayArtifact =>
  v.parse(replayArtifactSchema, value);

export const serializeReplayArtifact = (artifact: ReplayArtifact): string =>
  `${JSON.stringify(parseReplayArtifact(artifact), null, 2)}\n`;

export type ReplayTrailEvent = ReplayEvent & {
  failure?: "action-failed" | "invariant-failed";
};

/** A fixed-size FIFO trail suitable for failure diagnostics. */
export class BoundedEventTrail<T> {
  readonly #limit: number;
  readonly #events: T[] = [];

  public constructor(limit = MAX_EVENT_TRAIL_LENGTH) {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > MAX_EVENT_TRAIL_LENGTH
    ) {
      throw new RangeError(
        `Event trail limit must be between 1 and ${String(MAX_EVENT_TRAIL_LENGTH)}`,
      );
    }
    this.#limit = limit;
  }

  public add(event: T): void {
    this.#events.push(event);
    if (this.#events.length > this.#limit) {
      this.#events.shift();
    }
  }

  public get size(): number {
    return this.#events.length;
  }

  public toArray(): readonly T[] {
    return this.#events.slice();
  }
}
