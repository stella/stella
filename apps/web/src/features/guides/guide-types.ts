import type {
  GuideProgressStatus,
  GuideProgressTourId,
} from "@stll/api-contract";

import type { GuideAnchorId } from "@/features/guides/guide-anchors";
import type { TranslationKey } from "@/i18n/types";
import type { FileRouteTypes } from "@/routeTree.gen";

// Static guide destinations stay bound to the generated route tree. Matter
// tours use a semantic view target instead of storing workspace/view ids in
// the registry; the runner resolves those ids from the user's authorized
// workspace data when the guide starts.
type GuideStaticRoute = Exclude<FileRouteTypes["to"], `${string}$${string}`>;

export type GuideRoute =
  | { type: "static"; to: GuideStaticRoute }
  | { type: "workspace-unfiltered-table" };

export type GuidePlacement = "top" | "right" | "bottom" | "left";

// Guide copy lives under `guides.tours.*` and takes no ICU arguments, so these
// keys are safe to pass to `t(key)` with a single argument. Narrowing to the
// no-argument subset (rather than the full `TranslationKey` union, which
// includes keys that require interpolation values) is what makes that typecheck.
export type GuideMessageKey = Extract<TranslationKey, `guides.tours.${string}`>;

// A step may seed a harmless demo value. The runner applies it only when the
// seed target resolves to a real text input; otherwise it is skipped.
export type GuideSeed =
  | { kind: "fill-input"; anchor: GuideAnchorId; valueKey: GuideMessageKey }
  | { kind: "none" };

// A step may reveal UI before explaining what is inside it. `open` is for a
// transient disclosure surface; `transition` enters a reversible local editor
// state without creating or changing persisted data.
//
// SAFETY: the runner clicks interaction anchors on the user's behalf. Never
// put either kind on a control that mutates data, sends, deletes, uploads, or
// leaves the current route. `open` must only disclose a menu, popover, or
// dialog. `transition` must only swap local view state and must name the real
// control that reverses it so Back can restore the previous step.
export type GuideInteraction =
  | { kind: "open" }
  | { kind: "transition"; reverseAnchor: GuideAnchorId }
  | { kind: "none" };

export type GuideStep = {
  anchor: GuideAnchorId;
  route?: GuideRoute;
  titleKey: GuideMessageKey;
  bodyKey: GuideMessageKey;
  // The decision line: not what the control is, but when you would reach for
  // it over its neighbours. Rendered under the body as a muted, labelled
  // secondary line. Omit it on steps where there is no real choice to make.
  whenKey?: GuideMessageKey;
  placement: GuidePlacement;
  seed?: GuideSeed;
  interaction?: GuideInteraction;
};

// `kebab-case` wire id to the camelCase registry key, so the mapped checks
// below name every contract member and nothing else.
type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

// Both maps satisfy a type mapped over the contract union: a tour id the API
// does not accept, or a contract id with no registry entry, fails typecheck
// here instead of at the first progress write.
export const GUIDE_TOUR_IDS = {
  chat: "chat",
  chatPower: "chat-power",
  documents: "documents",
  playbooks: "playbooks",
  workflows: "workflows",
  tabularReview: "tabular-review",
} as const satisfies { [K in GuideProgressTourId as CamelCase<K>]: K };

export type GuideTourId = (typeof GUIDE_TOUR_IDS)[keyof typeof GUIDE_TOUR_IDS];

export type GuideTour = {
  id: GuideTourId;
  titleKey: GuideMessageKey;
  descriptionKey: GuideMessageKey;
  estMinutes: number;
  steps: readonly GuideStep[];
};

export const GUIDE_TOUR_STATUSES = {
  notStarted: "not-started",
  completed: "completed",
  skipped: "skipped",
} as const satisfies { [K in GuideProgressStatus as CamelCase<K>]: K };

export type GuideTourStatus =
  (typeof GUIDE_TOUR_STATUSES)[keyof typeof GUIDE_TOUR_STATUSES];
