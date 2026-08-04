import type { GuideAnchorId } from "@/features/guides/guide-anchors";
import type { TranslationKey } from "@/i18n/types";
import type { FileRouteTypes } from "@/routeTree.gen";

// Only param-less routes are navigable by a guide step: a removed route drops
// from this union and turns the referencing step into a typecheck error. Routes
// with a `$param` segment are excluded because a step cannot supply params.
export type GuideRoute = Exclude<FileRouteTypes["to"], `${string}$${string}`>;

export type GuidePlacement = "top" | "bottom" | "left" | "right";

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

// A step may reveal transient UI before explaining it, so a tour can teach a
// menu's contents instead of only pointing at the control that opens it.
//
// SAFETY: `open` may only ever target a non-destructive disclosure control —
// a menu, submenu, or popover trigger. The runner clicks that anchor on the
// user's behalf, so the click must have no effect beyond showing UI. Never put
// it on a control that mutates data, sends, deletes, uploads, or navigates
// away. Whatever a step opens is closed again when the tour ends, is
// dismissed, or moves on to a step outside the revealed surface.
export type GuideInteraction = { kind: "open" } | { kind: "none" };

export type GuideStep = {
  anchor: GuideAnchorId;
  route?: GuideRoute;
  titleKey: GuideMessageKey;
  bodyKey: GuideMessageKey;
  // The decision line: not what the control is, but when you would reach for
  // it over its neighbours. Rendered under the body as a muted, labelled
  // secondary line. Omit it on steps where there is no real choice to make.
  whenKey?: GuideMessageKey;
  placement?: GuidePlacement;
  seed?: GuideSeed;
  interaction?: GuideInteraction;
};

export const GUIDE_TOUR_IDS = {
  chat: "chat",
  documents: "documents",
  playbooks: "playbooks",
  workflows: "workflows",
  tabularReview: "tabular-review",
} as const;

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
} as const;

export type GuideTourStatus =
  (typeof GUIDE_TOUR_STATUSES)[keyof typeof GUIDE_TOUR_STATUSES];
