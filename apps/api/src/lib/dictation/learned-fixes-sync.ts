/**
 * How the server takes a device's changes to a member's learned fixes,
 * without the database: each device numbers its changes 1, 2, 3 and so on,
 * and the server keeps the highest number it applied from each device. A
 * change at or below that number was applied already, so a retry, however
 * late and in whatever order it comes, changes nothing.
 */
import type * as v from "valibot";

import type {
  DictationLearnedFixChange,
  dictationLearnedFixSchema,
} from "@stll/api-contract/dictation-learned-fixes";
import { applyLearnedFixChanges } from "@stll/transcript/learned-fixes";

/**
 * Devices whose last change number is kept, most recently synced last. A
 * deletion starts the list again, so it holds the devices that synced in one
 * generation; past it, the device that synced longest ago is let go and its
 * next change starts its count again.
 */
export const REMEMBERED_DEVICES = 100;

type DeviceChangeNumber = { device: string; seq: number };

/** One generation's fixes and each device's highest applied change number. */
export type LearnedFixesState = {
  fixes: v.InferOutput<typeof dictationLearnedFixSchema>[];
  devices: DeviceChangeNumber[];
};

/**
 * The changes above `applied`, in number order, each number once: what a
 * device's request adds however often and in whatever order it is sent.
 */
export const unappliedChanges = (
  changes: readonly DictationLearnedFixChange[],
  applied: number,
): DictationLearnedFixChange[] => {
  const byNumber = new Map<number, DictationLearnedFixChange>();
  for (const change of changes) {
    if (change.seq > applied && !byNumber.has(change.seq)) {
      byNumber.set(change.seq, change);
    }
  }
  return [...byNumber.values()].toSorted((a, b) => a.seq - b.seq);
};

/**
 * `current` after `device`'s changes, or null when none of them is new. The
 * device moves to the end of the remembered list.
 */
export const withDeviceChanges = (
  current: LearnedFixesState,
  device: string,
  changes: readonly DictationLearnedFixChange[],
): LearnedFixesState | null => {
  const applied =
    current.devices.find((entry) => entry.device === device)?.seq ?? 0;
  const fresh = unappliedChanges(changes, applied);
  const last = fresh.at(-1);
  if (last === undefined) {
    return null;
  }
  return {
    fixes: applyLearnedFixChanges(current.fixes, fresh),
    devices: [
      ...current.devices.filter((entry) => entry.device !== device),
      { device, seq: last.seq },
    ].slice(-REMEMBERED_DEVICES),
  };
};
