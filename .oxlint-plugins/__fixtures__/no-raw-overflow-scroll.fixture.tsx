// Passive regression fixture for
// `no-raw-overflow-scroll/no-raw-overflow-scroll`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// --- Flagged: a raw scrolling overflow utility on app chrome ---
export const _a = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="flex-1 overflow-y-auto" />
);
export const _b = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="overflow-x-scroll" />
);
export const _c = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="overflow-auto rounded-lg" />
);

// --- Flagged: the same utility behind a variant prefix ---
export const _d = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="md:overflow-y-auto" />
);
export const _e = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="group-data-[collapsed=true]/rail:overflow-y-auto" />
);
export const _f = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="not-data-transitioning:overflow-y-auto" />
);

// --- Flagged: the variant names exempt content without selecting it ---
export const _h = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="data-[layout=table]:overflow-auto" />
);
export const _i = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="[&:not(pre)]:overflow-auto" />
);
export const _j = () => (
  // oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
  <div className="[&_[data-slot=table]]:overflow-auto" />
);

// --- Flagged: a class string held in a constant, not written on the element ---
// oxlint-disable-next-line no-raw-overflow-scroll/no-raw-overflow-scroll
const PANE_CLASS_NAME = "min-h-0 overflow-y-scroll";
export const _g = () => <div className={PANE_CLASS_NAME} />;

// --- Accepted: the arbitrary variant targets content a renderer emits ---
export const _ok1 = () => <div className="[&_pre]:overflow-x-auto" />;
export const _ok2 = () => <div className="[&_table]:overflow-x-auto" />;
export const _ok3 = () => <div className="[&_.ProseMirror]:overflow-y-auto" />;
// Accepted: the child combinator selects it just as directly.
export const _ok3b = () => <div className="[&>table]:overflow-x-auto" />;
// Accepted: a deeper descendant chain still starts at the exempt element.
export const _ok3c = () => <div className="[&_pre_code]:overflow-x-auto" />;

// --- Accepted: clipping, not scrolling ---
// expect-clean: no-raw-overflow-scroll/no-raw-overflow-scroll
export const _ok4 = () => <div className="overflow-hidden" />;
export const _ok5 = () => <div className="overflow-clip" />;
export const _ok6 = () => <div className="overflow-visible" />;
// Accepted: an unrelated utility that merely starts with the same word.
export const _ok7 = () => <div className="overflow-x-hidden overflow-y-clip" />;
