/**
 * The shared read-and-save loop for the member's matter learning, which the
 * activity window (`matter-learning-store.ts`) and Settings
 * (`matter-rules-store.ts`) each bind to their own commands.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import * as v from "valibot";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import type { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  failureReason,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { ACTIVITY_CHANGED_EVENT } from "./activity-types";
import { MATTER_RULE_FIELDS, MATTER_RULE_OPS } from "./matter-learning";

export const ruleShape = {
  field: v.picklist(MATTER_RULE_FIELDS),
  op: v.picklist(MATTER_RULE_OPS),
  value: v.string(),
  matterId: v.string(),
};
export const ruleSchema = v.strictObject({ id: v.string(), ...ruleShape });
export const unavailableSchema = v.strictObject({
  type: v.literal("unavailable"),
});
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

export type StoreBinding<T> = {
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

const SAVE_OUTCOMES = {
  saved: "saved",
  conflict: "conflict",
  failed: "failed",
  notLoaded: "notLoaded",
} as const;

/** One section of the member's matter learning store, kept current with
 * every window's saves. Each window binds its own section and commands. */
export function useStoredSection<T>(binding: StoreBinding<T>) {
  const [state, setState] = useState<StoredState<T>>({ type: "loading" });
  const [saveFailed, setSaveFailed] = useState(false);
  // What `update` changes: the last read, which a render may not have shown
  // yet.
  const latest = useRef<StoredState<T>>({ type: "loading" });
  const reads = useRef(0);
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
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
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
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
  const save = async (current: StoredState<T>, change: (value: T) => T) => {
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
  };
  // This window's changes apply one at a time, each to the read the one
  // before it left, so they never conflict with each other.
  const pending = useRef<Promise<void>>(Promise.resolve());
  /** Applies `change` to the latest value. When another window saved first
   * it reads again and applies the same change once more; a second conflict
   * drops the change and says so. */
  const update = (change: (value: T) => T) => {
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
  };
  return { state, saveFailed, update, retry: reloadReported };
}
