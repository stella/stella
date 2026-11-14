import { panic, Result } from "better-result";

import { envKillSwitches } from "@/api/env-kill-switches";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import {
  ACTION_KIND_KILL_SWITCH,
  KILL_SWITCH_STATE,
  KILL_SWITCHES,
} from "@/api/lib/kill-switches/registry";
import type { ActionKind } from "@/api/lib/rate-limit/action-kinds";

/**
 * Refuses an action whose kill switch is off, with the typed
 * `feature_disabled` admission refusal every admission caller already
 * answers. One map read per call, so admission checks it on every request.
 */
export const admitSwitchedAction = (
  actionKind: ActionKind,
): Result<void, ActionAdmissionError> => {
  const killSwitch = ACTION_KIND_KILL_SWITCH[actionKind];
  const state =
    envKillSwitches.KILL_SWITCHES.get(killSwitch) ??
    KILL_SWITCHES[killSwitch].default;
  switch (state) {
    case KILL_SWITCH_STATE.on:
      return Result.ok(undefined);
    case KILL_SWITCH_STATE.off:
      return Result.err(
        new ActionAdmissionError({
          reason: "feature_disabled",
          killSwitch,
          message: `The ${killSwitch} kill switch is off`,
        }),
      );
    default:
      state satisfies never;
      return panic(`Unknown kill switch state for ${killSwitch}`);
  }
};
