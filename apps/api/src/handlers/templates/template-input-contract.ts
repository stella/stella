type FindUnusedTemplateValueKeysOptions = {
  declaredKeys: Iterable<string>;
  values: Record<string, unknown>;
};

type CollectTemplateInputKeysOptions = {
  discoveredFieldPaths: Iterable<string>;
  manifestFieldPaths: Iterable<string>;
  placeholderPaths: Iterable<string>;
};

type TemplateInputField = {
  condition?: unknown;
  conditionAst?: unknown;
  formula?: unknown;
};

export const isFillableTemplateInputField = (
  field: TemplateInputField,
): boolean =>
  field.formula === undefined &&
  field.condition === undefined &&
  field.conditionAst === undefined;

export const collectTemplateInputKeys = ({
  discoveredFieldPaths,
  manifestFieldPaths,
  placeholderPaths,
}: CollectTemplateInputKeysOptions): ReadonlySet<string> =>
  new Set([
    ...discoveredFieldPaths,
    ...manifestFieldPaths,
    ...placeholderPaths,
  ]);

/**
 * Compare submitted top-level or already-flattened keys with every value path
 * declared by the template. Value types are deliberately irrelevant: a typo
 * must be rejected consistently for strings, scalars, arrays, and objects.
 */
export const findUnusedTemplateValueKeys = ({
  declaredKeys,
  values,
}: FindUnusedTemplateValueKeysOptions): string[] => {
  const declaredKeySet = new Set(declaredKeys);
  return findUnusedPaths(values, "", declaredKeySet);
};

const findUnusedPaths = (
  values: Record<string, unknown>,
  parentPath: string,
  declaredKeys: ReadonlySet<string>,
): string[] => {
  const unusedPaths: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    const pathHasDeclaredDescendant = hasDeclaredDescendant(path, declaredKeys);
    if (pathHasDeclaredDescendant && isRecord(value)) {
      for (const unusedPath of findUnusedPaths(value, path, declaredKeys)) {
        unusedPaths.push(unusedPath);
      }
      continue;
    }

    if (pathHasDeclaredDescendant && Array.isArray(value)) {
      for (const item of value) {
        if (!isRecord(item)) {
          continue;
        }
        for (const unusedPath of findUnusedPaths(item, path, declaredKeys)) {
          unusedPaths.push(unusedPath);
        }
      }
      continue;
    }

    if (declaredKeys.has(path)) {
      continue;
    }

    unusedPaths.push(path);
  }

  return unusedPaths;
};

const hasDeclaredDescendant = (
  path: string,
  declaredKeys: ReadonlySet<string>,
): boolean => {
  const descendantPrefix = `${path}.`;
  for (const declaredKey of declaredKeys) {
    if (declaredKey.startsWith(descendantPrefix)) {
      return true;
    }
  }
  return false;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
