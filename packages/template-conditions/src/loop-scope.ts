/**
 * The path a marker names, once the loops around it are taken into account.
 *
 * `{% for attorney in attorneys %}{{ attorney.name }}{% endfor %}` writes one
 * field, and the manifest calls it `attorneys.name`: the loop's alias is the
 * body's name for the item, the array path is the manifest's. Discovery reads
 * that mapping, and every writer that puts a configuration back into a marker
 * has to reverse it, so the rule lives beside the grammar rather than in each
 * of them; two readings of one loop are two different documents.
 */

/** One enclosing `{% for %}`, as the body sees it and as the manifest does. */
export type RowScope = {
  /** The loop variable the body addresses items through. */
  alias: string;
  /** The array path the opener was written with, before its own enclosing
   *  loops were applied. */
  declaredPath: string;
  /** The array path the manifest speaks, enclosing loops included. */
  scopedPath: string;
};

export const rowScopePaths = (rowScopes: readonly RowScope[]): string[] =>
  rowScopes.map(({ scopedPath }) => scopedPath);

/** A path already under the innermost repeat is left alone; anything else is
 *  read as a name relative to it. */
export const qualifyRowScopedPath = (
  path: string,
  rowPaths: readonly string[] = [],
): string => {
  if (
    rowPaths.some(
      (rowPath) => path === rowPath || path.startsWith(`${rowPath}.`),
    )
  ) {
    return path;
  }
  const innermostRowPath = rowPaths.at(-1);
  return innermostRowPath === undefined ? path : `${innermostRowPath}.${path}`;
};

/** The manifest path for a marker written inside these loops. */
export const qualifyRowScopedPlaceholder = (
  path: string,
  rowScopes: readonly RowScope[],
): string => {
  if (
    rowScopes.some(
      ({ scopedPath }) =>
        path === scopedPath || path.startsWith(`${scopedPath}.`),
    )
  ) {
    return path;
  }
  for (const { alias, declaredPath, scopedPath } of rowScopes.toReversed()) {
    // The alias is the authored form; the declared path still resolves so a
    // template that reaches for the loop's own path is discovered the same way
    // it fills (`unaliased_item_path` names it as a warning).
    for (const head of [alias, declaredPath]) {
      if (path === head) {
        return scopedPath;
      }
      if (path.startsWith(`${head}.`)) {
        return `${scopedPath}.${path.slice(head.length + 1)}`;
      }
    }
  }
  return path;
};

/** The manifest path for an array a `{% for %}` opens inside these loops. */
export const qualifyLoopPath = (
  declaredPath: string,
  rowScopes: readonly RowScope[],
): string =>
  qualifyRowScopedPath(
    qualifyRowScopedPlaceholder(declaredPath, rowScopes),
    rowScopePaths(rowScopes),
  );
