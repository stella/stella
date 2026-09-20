import * as v from "valibot";

/**
 * Stable, serializable actions for the workspace explorer. Browser-specific
 * applicability and execution live in the Playwright driver.
 */

export const HISTORY_DIRECTION = {
  back: "back",
  forward: "forward",
} as const;

export const WORKSPACE_ACTION_TYPE = {
  selectControl: "select-control",
  openFixtureDocument: "open-fixture-document",
  setInspectorVisibility: "set-inspector-visibility",
  setDocumentDialog: "set-document-dialog",
  reload: "reload",
  navigateHistory: "navigate-history",
} as const;

export const replayControlSelectionSchema = v.strictObject({
  family: v.pipe(
    v.string(),
    v.nonEmpty(),
    v.maxLength(64),
    v.regex(/^[a-z][a-z\d-]*$/u),
  ),
  key: v.pipe(
    v.string(),
    v.nonEmpty(),
    v.maxLength(128),
    v.regex(/^[^\p{C}]+$/u),
  ),
});

export const workspaceActionSchema = v.variant("type", [
  v.strictObject({
    type: v.literal(WORKSPACE_ACTION_TYPE.selectControl),
    control: replayControlSelectionSchema,
  }),
  v.strictObject({
    type: v.literal(WORKSPACE_ACTION_TYPE.openFixtureDocument),
    documentKey: v.literal("primary"),
  }),
  v.strictObject({
    type: v.literal(WORKSPACE_ACTION_TYPE.setInspectorVisibility),
    visible: v.boolean(),
  }),
  v.strictObject({
    type: v.literal(WORKSPACE_ACTION_TYPE.setDocumentDialog),
    open: v.boolean(),
  }),
  v.strictObject({ type: v.literal(WORKSPACE_ACTION_TYPE.reload) }),
  v.strictObject({
    type: v.literal(WORKSPACE_ACTION_TYPE.navigateHistory),
    direction: v.picklist(Object.values(HISTORY_DIRECTION)),
  }),
]);

export type WorkspaceAction = v.InferOutput<typeof workspaceActionSchema>;
export type WorkspaceActionType = WorkspaceAction["type"];
export type ReplayControlSelection = v.InferOutput<
  typeof replayControlSelectionSchema
>;

export const parseReplayControlSelection = (
  value: unknown,
): ReplayControlSelection => v.parse(replayControlSelectionSchema, value);

const UINT32_RANGE = 4_294_967_296;
const RANDOM_MULTIPLIER = 1_664_525;
const RANDOM_INCREMENT = 1_013_904_223;

const assertSeed = (seed: number): void => {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError("Replay seed must be a safe integer");
  }
};

/** A deterministic PRNG whose output does not depend on the host runtime. */
export class SeededRandom {
  readonly #initialSeed: number;
  #state: number;

  public constructor(seed: number) {
    assertSeed(seed);
    this.#initialSeed = seed;
    this.#state = ((seed % UINT32_RANGE) + UINT32_RANGE) % UINT32_RANGE;
  }

  public get seed(): number {
    return this.#initialSeed;
  }

  public nextUint32(): number {
    this.#state =
      (this.#state * RANDOM_MULTIPLIER + RANDOM_INCREMENT) % UINT32_RANGE;
    return this.#state;
  }

  public nextFloat(): number {
    return (this.nextUint32() + 0.5) / UINT32_RANGE;
  }
}

export type WeightedWorkspaceAction = {
  action: WorkspaceAction;
  weight: number;
};

/** Select one applicable action without consulting ambient randomness. */
export const selectWeightedAction = (
  random: SeededRandom,
  candidates: readonly WeightedWorkspaceAction[],
): WorkspaceAction => {
  if (candidates.length === 0) {
    throw new RangeError("Cannot choose an action from an empty collection");
  }

  let totalWeight = 0;
  for (const { weight } of candidates) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError("Action weights must be finite and non-negative");
    }
    totalWeight += weight;
  }
  if (totalWeight === 0) {
    throw new RangeError("At least one action must have a positive weight");
  }

  let cursor = random.nextFloat() * totalWeight;
  for (const candidate of candidates) {
    cursor -= candidate.weight;
    if (cursor < 0) {
      return candidate.action;
    }
  }

  const finalCandidate = candidates.at(-1);
  if (finalCandidate === undefined) {
    throw new RangeError("Cannot choose an action from an empty collection");
  }
  return finalCandidate.action;
};

const workspaceActionKey = (action: WorkspaceAction): string =>
  JSON.stringify(action);

export const hasWorkspaceAction = (
  candidates: readonly WeightedWorkspaceAction[],
  action: WorkspaceAction,
): boolean => {
  const key = workspaceActionKey(action);
  return candidates.some(
    (candidate) => workspaceActionKey(candidate.action) === key,
  );
};
