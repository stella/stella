type FindUnusedTemplateValueKeysOptions = {
  contract: TemplateInputContract;
  values: Record<string, unknown>;
};

export type TemplateInputContract = {
  acceptedPaths: ReadonlySet<string>;
  forbiddenPaths: ReadonlySet<string>;
};

type TemplateInputKeySources =
  | {
      type: "raw";
      livePaths: Iterable<string>;
    }
  | {
      type: "manifest";
      derivedOutputPaths: Iterable<string>;
      fillableFieldPaths: Iterable<string>;
      livePaths: Iterable<string>;
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

export const collectTemplateInputKeys = (
  sources: TemplateInputKeySources,
): TemplateInputContract => {
  if (sources.type === "raw") {
    return {
      acceptedPaths: new Set(sources.livePaths),
      forbiddenPaths: new Set(),
    };
  }

  const fillableFieldPaths = new Set(sources.fillableFieldPaths);
  const derivedOutputPaths = new Set(sources.derivedOutputPaths);
  const acceptedPaths = new Set(fillableFieldPaths);
  for (const livePath of sources.livePaths) {
    if (
      isAtOrBelowAny(livePath, derivedOutputPaths) ||
      !isBelowAny(livePath, fillableFieldPaths)
    ) {
      continue;
    }
    acceptedPaths.add(livePath);
  }
  return { acceptedPaths, forbiddenPaths: derivedOutputPaths };
};

const isAtOrBelowAny = (path: string, roots: ReadonlySet<string>): boolean =>
  roots.has(path) || isBelowAny(path, roots);

const isBelowAny = (path: string, roots: ReadonlySet<string>): boolean =>
  Array.from(roots).some((root) => path.startsWith(`${root}.`));

/**
 * Compare submitted top-level or already-flattened keys with every value path
 * declared by the template. Value types are deliberately irrelevant: a typo
 * must be rejected consistently for strings, scalars, arrays, and objects.
 */
export const findUnusedTemplateValueKeys = ({
  contract,
  values,
}: FindUnusedTemplateValueKeysOptions): string[] =>
  findUnusedPaths(values, "", contract);

const findUnusedPaths = (
  values: Record<string, unknown>,
  parentPath: string,
  contract: TemplateInputContract,
): string[] => {
  const unusedPaths: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    const path = parentPath === "" ? key : `${parentPath}.${key}`;
    if (isAtOrBelowAny(path, contract.forbiddenPaths)) {
      unusedPaths.push(path);
      continue;
    }

    const pathHasContractDescendant =
      hasDeclaredDescendant(path, contract.acceptedPaths) ||
      hasDeclaredDescendant(path, contract.forbiddenPaths);
    if (pathHasContractDescendant && isRecord(value)) {
      for (const unusedPath of findUnusedPaths(value, path, contract)) {
        unusedPaths.push(unusedPath);
      }
      continue;
    }

    if (pathHasContractDescendant && Array.isArray(value)) {
      for (const item of value) {
        if (!isRecord(item)) {
          continue;
        }
        for (const unusedPath of findUnusedPaths(item, path, contract)) {
          unusedPaths.push(unusedPath);
        }
      }
      continue;
    }

    if (contract.acceptedPaths.has(path)) {
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
