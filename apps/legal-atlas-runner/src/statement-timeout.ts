/**
 * The statement timeout a bounded transaction installs: its budget, or the
 * per-statement cap when one is set and tighter. 0 installs none.
 */
export const ingestionStatementTimeoutMs = (
  budgetMs: number,
  capMs: number,
): number => {
  if (capMs === 0) {
    return budgetMs;
  }
  return budgetMs === 0 ? capMs : Math.min(budgetMs, capMs);
};
