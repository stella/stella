type FindUnusedTemplateValueKeysOptions = {
  contract: TemplateInputContract;
  values: Record<string, unknown>;
};

export type TemplateInputContract = {
  acceptedPaths: ReadonlySet<string>;
  arrayPaths: ReadonlySet<string>;
  forbiddenPaths: ReadonlySet<string>;
  primitiveArrayPaths: ReadonlySet<string>;
};

type TemplateInputKeySources =
  | {
      arrayPaths: Iterable<string>;
      type: "raw";
      primitiveArrayPaths: Iterable<string>;
      terminalPaths: Iterable<string>;
    }
  | {
      arrayPaths: Iterable<string>;
      type: "manifest";
      derivedOutputPaths: Iterable<string>;
      fillableFieldPaths: Iterable<string>;
      livePaths: Iterable<string>;
      primitiveArrayPaths: Iterable<string>;
    };

type TemplateInputField = {
  condition?: unknown;
  conditionAst?: unknown;
  formula?: unknown;
};

type RawDiscoveredField = {
  itemFields?: readonly RawDiscoveredField[];
  kind: "array" | "boolean" | "object" | "string";
  path: string;
};

type CollectRawTemplateTerminalPathsOptions = {
  fields: readonly RawDiscoveredField[];
  placeholderPaths: Iterable<string>;
};

type RawTemplateInputSources = {
  arrayPaths: string[];
  primitiveArrayPaths: string[];
  terminalPaths: string[];
};

export const collectRawTemplateInputSources = ({
  fields,
  placeholderPaths,
}: CollectRawTemplateTerminalPathsOptions): RawTemplateInputSources => {
  const arrayPaths: string[] = [];
  const primitiveArrayPaths: string[] = [];
  const terminalPaths = Array.from(placeholderPaths);

  const visit = (field: RawDiscoveredField, parentPath: string): void => {
    const path = parentPath === "" ? field.path : `${parentPath}.${field.path}`;
    const itemFields = field.itemFields;
    const hasItemFields = itemFields !== undefined && itemFields.length > 0;
    if (field.kind === "array") {
      arrayPaths.push(path);
    }
    if (
      field.kind === "array" &&
      itemFields?.some((itemField) => itemField.path === "value")
    ) {
      primitiveArrayPaths.push(path);
    }
    if (field.kind !== "object" && (field.kind !== "array" || !hasItemFields)) {
      terminalPaths.push(path);
    }
    if (itemFields !== undefined) {
      for (const itemField of itemFields) {
        visit(itemField, path);
      }
    }
  };

  for (const field of fields) {
    visit(field, "");
  }
  return { arrayPaths, primitiveArrayPaths, terminalPaths };
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
      acceptedPaths: new Set(sources.terminalPaths),
      arrayPaths: new Set(sources.arrayPaths),
      forbiddenPaths: new Set(),
      primitiveArrayPaths: new Set(sources.primitiveArrayPaths),
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
  const primitiveArrayPaths = new Set(
    Array.from(sources.primitiveArrayPaths).filter(
      (path) =>
        (acceptedPaths.has(path) ||
          hasDeclaredDescendant(path, acceptedPaths)) &&
        !isAtOrBelowAny(path, derivedOutputPaths),
    ),
  );
  const arrayPaths = new Set(
    Array.from(sources.arrayPaths).filter(
      (path) =>
        (acceptedPaths.has(path) ||
          hasDeclaredDescendant(path, acceptedPaths)) &&
        !isAtOrBelowAny(path, derivedOutputPaths),
    ),
  );
  return {
    acceptedPaths,
    arrayPaths,
    forbiddenPaths: derivedOutputPaths,
    primitiveArrayPaths,
  };
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

    if (isFlattenedArrayDescendant(path, parentPath, contract.arrayPaths)) {
      unusedPaths.push(path);
      continue;
    }

    if (contract.arrayPaths.has(path) && !Array.isArray(value)) {
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
      if (!contract.arrayPaths.has(path)) {
        unusedPaths.push(path);
        continue;
      }
      let hasInvalidItem = false;
      for (const item of value) {
        if (!isRecord(item)) {
          if (
            !contract.primitiveArrayPaths.has(path) ||
            !isTemplateLoopPrimitive(item)
          ) {
            hasInvalidItem = true;
          }
          continue;
        }
        for (const unusedPath of findUnusedPaths(item, path, contract)) {
          unusedPaths.push(unusedPath);
        }
      }
      if (hasInvalidItem) {
        unusedPaths.push(path);
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

const isFlattenedArrayDescendant = (
  path: string,
  parentPath: string,
  arrayPaths: ReadonlySet<string>,
): boolean => {
  const nestedArrayPrefix = parentPath === "" ? "" : `${parentPath}.`;
  for (const arrayPath of arrayPaths) {
    if (
      arrayPath !== parentPath &&
      arrayPath.startsWith(nestedArrayPrefix) &&
      path.startsWith(`${arrayPath}.`)
    ) {
      return true;
    }
  }
  return false;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTemplateLoopPrimitive = (
  value: unknown,
): value is boolean | number | string =>
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string";
