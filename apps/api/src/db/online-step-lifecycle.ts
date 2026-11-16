import { panic } from "better-result";

import { ONLINE_LIFECYCLE } from "./online-migration-entry";
import type { OnlineLifecycle } from "./online-migration-entry";
import { ONLINE_MIGRATION_ENTRIES } from "./online-migration-registry";

/** The kinds of step the online phase walks, as its reports name them. */
export type OnlineStepKind =
  "index" | "cutover" | "replacement_drop" | "repair";

/**
 * Which steps a walk builds. `migrate` builds everything by default; with
 * `finalized` it leaves pending work to be built after rollout, and the
 * pending runner builds only `pending` steps.
 */
export const ONLINE_SCOPE = {
  all: "all",
  finalized: ONLINE_LIFECYCLE.finalized,
  pending: ONLINE_LIFECYCLE.pending,
} as const;
export type OnlineScope = (typeof ONLINE_SCOPE)[keyof typeof ONLINE_SCOPE];

const stepKey = (kind: OnlineStepKind, name: string) => `${kind}:${name}`;

const STEP_LIFECYCLE: ReadonlyMap<string, OnlineLifecycle> = new Map(
  ONLINE_MIGRATION_ENTRIES.flatMap(
    (entry): (readonly [string, OnlineLifecycle])[] => {
      switch (entry.type) {
        case "indexes":
          return entry.values.map(
            ({ name }) => [stepKey("index", name), entry.lifecycle] as const,
          );
        case "cutovers":
          return entry.values.map(
            ({ final }) =>
              [stepKey("cutover", final.name), entry.lifecycle] as const,
          );
        case "replacements":
          return entry.values.map(
            ({ legacyName }) =>
              [
                stepKey("replacement_drop", legacyName),
                entry.lifecycle,
              ] as const,
          );
        case "repairs":
          return entry.values.map(
            ({ name }) => [stepKey("repair", name), entry.lifecycle] as const,
          );
        case "constraints":
          // Validated through the repairs that own them.
          return [];
        default:
          entry satisfies never;
          return panic("Online migration entry of an unknown type");
      }
    },
  ),
);

/**
 * The lifecycle of the registry entry that declares a step. A step the
 * registry does not declare (a repair a caller passes in, as tests do) is
 * treated as finalized: the run that was handed it owns it.
 */
export const onlineStepLifecycle = (
  kind: OnlineStepKind,
  name: string,
): OnlineLifecycle =>
  STEP_LIFECYCLE.get(stepKey(kind, name)) ?? ONLINE_LIFECYCLE.finalized;

export const isInOnlineScope = (
  scope: OnlineScope,
  kind: OnlineStepKind,
  name: string,
): boolean =>
  scope === ONLINE_SCOPE.all || onlineStepLifecycle(kind, name) === scope;
