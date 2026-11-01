// Passive regression fixture for `no-raw-reader-scroll/no-raw-reader-scroll`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

declare const scrollReaderToBlock: (
  target: Element,
  container: Element,
) => void;

// --- Flagged: a jump that computes where it lands ---
export const _flagged = (container: HTMLElement, offset: number) => {
  // oxlint-disable-next-line no-raw-reader-scroll/no-raw-reader-scroll
  container.scrollTo({ top: offset, behavior: "instant" });
};

// --- Allowed: the owner, the document's start, a held position ---
export const _owner = (target: Element, container: Element) => {
  scrollReaderToBlock(target, container);
};
export const _start = (container: HTMLElement) => {
  container.scrollTo({ top: 0, behavior: "instant" });
};
export const _held = (container: HTMLElement, drift: number) => {
  container.scrollTop += drift;
};
