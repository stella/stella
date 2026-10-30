// Passive regression fixture for
// `no-raw-text-truncation/no-raw-text-truncation`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

declare const cn: (...classes: unknown[]) => string;
declare const isCompact: boolean;

// --- Flagged: a raw truncation utility on a text element ---
export const _a = () => (
  // oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation
  <span className="min-w-0 truncate">Smlouva o dílo</span>
);
export const _b = () => (
  // oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation
  <p className="text-muted-foreground line-clamp-2">A long description</p>
);
export const _c = () => (
  // oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation
  <span className="overflow-hidden text-ellipsis whitespace-nowrap">Name</span>
);

// --- Flagged: behind a variant prefix or an important marker ---
export const _d = () => (
  // oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation
  <span className="sm:truncate">Name</span>
);
export const _e = () => (
  // oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation
  <span className="!truncate">Name</span>
);

// --- Flagged: a `cn()` argument and a template chunk ---
export const _f = () => (
  // oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation
  <span className={cn("block", isCompact && "truncate")}>Name</span>
);
export const _g = () => (
  // oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation
  <span className={`block ${isCompact ? "" : "x"} line-clamp-3`}>Name</span>
);

// --- Flagged: a class string held in a constant ---
// oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation
const LABEL_CLASS_NAME = "min-w-0 truncate text-sm";
export const _h = () => <span className={LABEL_CLASS_NAME}>Name</span>;

// --- Accepted: clipping the box, not the text ---
// expect-clean: no-raw-text-truncation/no-raw-text-truncation
export const _ok1 = () => <div className="min-w-0 overflow-hidden" />;
// Accepted: lifting a clamp.
export const _ok2 = () => <p className="md:line-clamp-none">Text</p>;
// Accepted: a boolean prop named `truncate` is not a class.
const Pill = (_props: { truncate?: boolean; children: string }) => null;
export const _ok3 = () => <Pill truncate>Name</Pill>;
// Accepted: clipping text without an ellipsis is a box decision.
export const _ok4 = () => <div className="text-clip" />;
