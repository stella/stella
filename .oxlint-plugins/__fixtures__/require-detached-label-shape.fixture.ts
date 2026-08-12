// Passive regression fixture for
// `require-detached-label-shape/require-detached-label-shape`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the fixture
// too.

// The real helper requires the label; it is optional here so the
// missing-label case below is a lint failure rather than a type error.
declare const detached: (operation: unknown, context?: string) => void;
declare const save: () => Promise<void>;
declare const feature: string;
declare const forwardedLabel: string;

// MUST flag: the enclosing component name, the shape most call sites drifted
// to. It names where the code lives, not what was detached, and moves with
// every rename.
const bareComponentName = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "RouteComponent");
};

// MUST flag: the enclosing handler name.
const bareHandlerName = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "handleToggleEnabled");
};

// MUST flag: a single lowercase word is still not `feature.action`.
const singleSegment = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "prefetch");
};

// MUST flag: three segments reintroduce per-call-site nesting.
const threeSegments = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "document-processing.lease-heartbeat.renew");
};

// MUST flag: camelCase segments.
const camelCaseSegments = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "chatThread.prefetchMessages");
};

// MUST flag: `Component.method`, the dotted-but-not-kebab variant.
const dottedComponentMethod = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "ActivityPanel.fetchNextPage");
};

// MUST flag: underscores and spaces are not kebab-case segments.
const nonKebabSeparators = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "chat_thread.fetch next page");
};

// MUST flag: a forwarded label parameter cannot be checked, and a helper that
// takes one hides the real call sites from the guard.
const forwardedParameter = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), forwardedLabel);
};

// MUST flag: a template literal, even with a static head, can interpolate an
// identifier into the telemetry tag.
const interpolatedLabel = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), `${feature}.save`);
};

// MUST flag: no label at all.
const missingLabel = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save());
};

// MUST flag: a hyphen with no word on one side. `[a-z0-9-]+` per segment
// would accept these, and a label like `-.--` carries no attribution at all,
// which is the one thing the shape exists to guarantee.
const emptyKebabWords = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "-.--");
};

// MUST flag: trailing hyphens on otherwise plausible segments.
const danglingHyphens = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "chat-.save-");
};

// MUST flag: a doubled hyphen is not a word separator.
const doubledHyphen = () => {
  // oxlint-disable-next-line require-detached-label-shape/require-detached-label-shape
  detached(save(), "chat--thread.save");
};

// --- Cases the rule MUST NOT flag ---

// The documented shape: module or route slice, then the detached work.
const dottedLabel = () => {
  detached(save(), "chat-thread.prefetch");
};

// Multi-word kebab segments on both sides.
const multiWordSegments = () => {
  detached(save(), "template-list.invalidate-templates");
};

// Digits are part of a segment, not a separator.
const digitsInSegments = () => {
  detached(save(), "oauth2-callback.exchange-code");
};

// A same-named method on an object is a different call.
const unrelatedMethodCall = () => {
  const queue = {
    detached: (operation: unknown, label: string) => [operation, label],
  };
  queue.detached(save(), "RouteComponent");
};

export const __requireDetachedLabelShapeFixture = {
  bareComponentName,
  bareHandlerName,
  singleSegment,
  threeSegments,
  camelCaseSegments,
  dottedComponentMethod,
  nonKebabSeparators,
  forwardedParameter,
  interpolatedLabel,
  missingLabel,
  emptyKebabWords,
  danglingHyphens,
  doubledHyphen,
  dottedLabel,
  multiWordSegments,
  digitsInSegments,
  unrelatedMethodCall,
};
