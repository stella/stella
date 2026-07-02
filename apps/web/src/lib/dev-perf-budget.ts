// Dev-only guard against the "live editor per cell" class of perf bug: a grid
// that renders a live editor (Base UI Select, combobox, textarea, rich-text)
// per row instead of a display-until-edit cell mass-mounts dozens of heavy
// widgets — which is what made the grouped table hang. We count live editors
// inside any grid and `console.error` past a small budget, so the regression
// surfaces immediately to any developer (on any surface, not just one table),
// and the e2e `browserErrors` fixture turns it into a CI failure. Checkboxes and
// file inputs are deliberately excluded — only heavy interactive editors count.

const GRID_EDITOR_SELECTOR = [
  '[role="grid"] [data-slot="select-trigger"]',
  '[role="grid"] [role="combobox"]',
  '[role="grid"] textarea',
  '[role="grid"] [contenteditable="true"]',
].join(", ");

// A display-until-edit grid keeps 0 live editors at rest and ~1 while a single
// cell is edited; a per-cell regression mounts one per row, well past this.
const GRID_EDITOR_BUDGET = 12;
const DEBOUNCE_MS = 1000;

/**
 * Install the dev perf budget. No-op outside dev. Returns a disposer.
 */
export const installDevPerfBudget = (): (() => void) => {
  if (!import.meta.env.DEV || typeof document === "undefined") {
    return () => undefined;
  }

  let warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = () => {
    const count = document.querySelectorAll(GRID_EDITOR_SELECTOR).length;
    if (count <= GRID_EDITOR_BUDGET) {
      warned = false;
      return;
    }
    if (warned) {
      return;
    }
    warned = true;
    // eslint-disable-next-line no-console -- dev-only perf budget; the e2e browserErrors fixture turns this into a CI failure
    console.error(
      `[perf-budget] ${count} live editors mounted inside a grid (budget ${GRID_EDITOR_BUDGET}). ` +
        "A table is rendering a live editor per cell instead of a display-until-edit cell. " +
        "Mount the heavy control only when the cell is edited (see EditableField), or virtualize the rows.",
    );
  };

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(check, DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    clearTimeout(timer);
    observer.disconnect();
  };
};
