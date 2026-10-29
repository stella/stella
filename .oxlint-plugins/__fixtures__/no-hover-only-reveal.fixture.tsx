// Passive regression fixture for `no-hover-only-reveal/no-hover-only-reveal`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// --- Flagged: hidden at rest, revealed only by a hover variant ---
export const _a = () => (
  // oxlint-disable-next-line no-hover-only-reveal/no-hover-only-reveal
  <button className="opacity-0 group-hover:opacity-100" type="button" />
);
export const _b = () => (
  // oxlint-disable-next-line no-hover-only-reveal/no-hover-only-reveal
  <button className="opacity-0! group-hover/row:opacity-100!" type="button" />
);
export const _c = () => (
  // oxlint-disable-next-line no-hover-only-reveal/no-hover-only-reveal
  <button className="invisible hover:visible" type="button" />
);
// A keyboard reveal next to the hover one still leaves touch out.
export const _d = () => (
  <button
    // oxlint-disable-next-line no-hover-only-reveal/no-hover-only-reveal
    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
    type="button"
  />
);

// --- Flagged: a class string held in a constant ---
// oxlint-disable-next-line no-hover-only-reveal/no-hover-only-reveal
const ROW_ACTION_CLASS_NAME = "opacity-0 peer-hover:opacity-100";
export const _e = () => <button className={ROW_ACTION_CLASS_NAME} type="button" />;

// --- Accepted: touch screens show it at rest ---
// expect-clean: no-hover-only-reveal/no-hover-only-reveal
export const _ok1 = () => (
  <button className="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100" type="button" />
);
export const _ok2 = () => (
  <button className="opacity-0 hover:opacity-100 any-pointer-coarse:opacity-100" type="button" />
);
// --- Accepted: hidden only under a variant, visible at rest ---
export const _ok3 = () => (
  <button className="md:opacity-0 md:group-hover:opacity-100" type="button" />
);
// --- Accepted: revealed by state, not hover ---
export const _ok4 = () => <div className="opacity-0 data-[state=open]:opacity-100" />;
export const _ok5 = () => <button className="opacity-0 focus-visible:opacity-100" type="button" />;
// --- Accepted: decoration nobody needs to reach ---
export const _ok6 = () => <span aria-hidden="true" className="opacity-0 group-hover:opacity-100" />;
const ChevronIcon = ({ className }: { className: string }) => <svg className={className} />;
export const _ok7 = () => <ChevronIcon className="opacity-0 group-hover:opacity-100" />;
export const _ok8 = () => (
  <div className="pointer-events-none opacity-0 group-hover/row:opacity-100" />
);
// --- Flagged: an overlay that takes the pointer once revealed ---
export const _f = () => (
  <div
    // oxlint-disable-next-line no-hover-only-reveal/no-hover-only-reveal
    className="pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
  />
);
// --- Accepted: a tap sets a state that reveals it too ---
export const _ok9 = () => (
  <div className="opacity-0 group-hover/card:opacity-100 group-data-[active=true]/card:opacity-100" />
);
