import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  failureReason,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { ACTIVITY_CHANGED_EVENT } from "./activity-types";
import {
  MATTER_RULE_FIELDS,
  MATTER_RULE_OPS,
  type MatterLearning,
  type MatterRule,
  TALLY_STATUSES,
} from "./matter-learning";

const ruleShape = {
  field: v.picklist(MATTER_RULE_FIELDS),
  op: v.picklist(MATTER_RULE_OPS),
  value: v.string(),
  matterId: v.string(),
};
const ruleSchema = v.strictObject({ id: v.string(), ...ruleShape });
const learningSchema = v.strictObject({
  rules: v.array(ruleSchema),
  learned: v.array(
    v.strictObject({
      token: v.string(),
      matterId: v.string(),
      weight: v.number(),
      atMs: v.number(),
    }),
  ),
  tallies: v.array(
    v.strictObject({
      ...ruleShape,
      count: v.number(),
      status: v.picklist(TALLY_STATUSES),
    }),
  ),
});
const unavailableSchema = v.strictObject({ type: v.literal("unavailable") });
const learningReadSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("stored"),
    revision: v.number(),
    learning: learningSchema,
  }),
  unavailableSchema,
]);
const rulesReadSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("stored"),
    revision: v.number(),
    rules: v.array(ruleSchema),
  }),
  unavailableSchema,
]);
const saveSchema = v.variant("type", [
  v.strictObject({ type: v.literal("saved"), revision: v.number() }),
  v.strictObject({ type: v.literal("conflict") }),
  unavailableSchema,
]);

/** What the store holds right now, as one window sees it. `unavailable`
 * when history is not kept encrypted on this computer: nothing is learned. */
type StoredState<T> =
  | { type: "loading" }
  | { type: "unavailable" }
  | { type: "failed" }
  | { type: "ready"; revision: number; value: T };

type StoreBinding<T> = {
  /** The window that reads it, for failure reports. */
  window: (typeof DESKTOP_TELEMETRY_WINDOWS)["activity" | "main"];
  read: () => Promise<StoredState<T>>;
  write: (revision: number, value: T) => Promise<unknown>;
};

const report = (
  window: StoreBinding<unknown>["window"],
  operation: (typeof DESKTOP_TELEMETRY_OPERATIONS)[
    "activityRead" | "activitySubscribe" | "activityUpdate"],
  rejection?: unknown,
) => {
  // Fixed codes only: nothing learned leaves the window.
  reportDesktopError({
    code:
      operation === "activitySubscribe"
        ? DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed
        : DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation,
    ...(rejection === undefined ? {} : { reason: failureReason(rejection) }),
    window,
  });
};

const LEARNING_BINDING: StoreBinding<MatterLearning> = {
  window: DESKTOP_TELEMETRY_WINDOWS.activity,
  read: async () => {
    const read = v.parse(
      learningReadSchema,
      await invoke("activity_get_matter_learning"),
    );
    return read.type === "stored"
      ? { type: "ready", revision: read.revision, value: read.learning }
      : { type: "unavailable" };
  },
  write: async (revision, learning) =>
    await invoke("activity_save_matter_learning", { revision, learning }),
};

const RULES_BINDING: StoreBinding<MatterRule[]> = {
  window: DESKTOP_TELEMETRY_WINDOWS.main,
  read: async () => {
    const read = v.parse(
      rulesReadSchema,
      await invoke("activity_get_matter_rules"),
    );
    return read.type === "stored"
      ? { type: "ready", revision: read.revision, value: read.rules }
      : { type: "unavailable" };
  },
  write: async (revision, rules) =>
    await invoke("activity_save_matter_rules", { revision, rules }),
};

const SAVE_OUTCOMES = {
  saved: "saved",
  conflict: "conflict",
  failed: "failed",
  notLoaded: "notLoaded",
} as const;

/** One store section, kept current with every window's saves. */
function useStoredSection<T>(binding: StoreBinding<T>) {
  const [state, setState] = useState<StoredState<T>>({ type: "loading" });
  const [saveFailed, setSaveFailed] = useState(false);
  // What `update` changes: the last read, which a render may not have shown
  // yet.
  const latest = useRef<StoredState<T>>({ type: "loading" });
  const reads = useRef(0);
  const reload = useCallback(async () => {
    const request = ++reads.current;
    const next = await binding
      .read()
      .catch((error: unknown): StoredState<T> => {
        report(
          binding.window,
          DESKTOP_TELEMETRY_OPERATIONS.activityRead,
          error,
        );
        return { type: "failed" };
      });
    if (request === reads.current) {
      latest.current = next;
      setState(next);
    }
    return next;
  }, [binding]);
  const reloadReported = useCallback(() => {
    reload().catch((error: unknown) => {
      report(binding.window, DESKTOP_TELEMETRY_OPERATIONS.activityRead, error);
    });
  }, [binding.window, reload]);
  useEffect(() => {
    reloadReported();
    return subscribeDesktopEvent({
      event: ACTIVITY_CHANGED_EVENT,
      handler: reloadReported,
      onError: () =>
        report(binding.window, DESKTOP_TELEMETRY_OPERATIONS.activitySubscribe),
    });
  }, [binding.window, reloadReported]);
  const save = useCallback(
    async (current: StoredState<T>, change: (value: T) => T) => {
      if (current.type !== "ready") {
        return SAVE_OUTCOMES.notLoaded;
      }
      const saved = await binding
        .write(current.revision, change(current.value))
        .then((outcome) => v.parse(saveSchema, outcome))
        .catch((error: unknown) => {
          report(
            binding.window,
            DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
            error,
          );
          return null;
        });
      if (saved === null) {
        return SAVE_OUTCOMES.failed;
      }
      if (saved.type === "conflict") {
        return SAVE_OUTCOMES.conflict;
      }
      await reload();
      return SAVE_OUTCOMES.saved;
    },
    [binding, reload],
  );
  // This window's changes apply one at a time, each to the read the one
  // before it left, so they never conflict with each other.
  const pending = useRef<Promise<void>>(Promise.resolve());
  /** Applies `change` to the latest value. When another window saved first
   * it reads again and applies the same change once more; a second conflict
   * drops the change and says so. */
  const update = useCallback(
    (change: (value: T) => T) => {
      pending.current = pending.current
        .then(async () => {
          const first = await save(latest.current, change);
          const outcome =
            first === SAVE_OUTCOMES.conflict
              ? await save(await reload(), change)
              : first;
          if (outcome === SAVE_OUTCOMES.conflict) {
            report(binding.window, DESKTOP_TELEMETRY_OPERATIONS.activityUpdate);
          }
          setSaveFailed(
            outcome === SAVE_OUTCOMES.conflict ||
              outcome === SAVE_OUTCOMES.failed,
          );
          return undefined;
        })
        .catch((error: unknown) => {
          report(
            binding.window,
            DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
            error,
          );
          setSaveFailed(true);
        });
    },
    [binding.window, reload, save],
  );
  return { state, saveFailed, update, retry: reloadReported };
}

export const useMatterLearning = () => useStoredSection(LEARNING_BINDING);
export const useMatterRules = () => useStoredSection(RULES_BINDING);
