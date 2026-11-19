type Direction = "input" | "output";
type Schema = Record<string, unknown>;
type SchemaBreak = { path: string; rule: string };

const isRecord = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): Schema => (isRecord(value) ? value : {});

const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const pointer = (parent: string, key: string | number): string =>
  `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

const values = (schema: Schema): readonly unknown[] | undefined => {
  if (Array.isArray(schema["enum"])) {
    return list(schema["enum"]);
  }
  return Object.hasOwn(schema, "const") ? [schema["const"]] : undefined;
};

const types = (schema: Schema): readonly unknown[] =>
  typeof schema["type"] === "string" ? [schema["type"]] : list(schema["type"]);

const allowsType = (accepted: readonly unknown[], type: unknown): boolean =>
  accepted.includes(type) ||
  (type === "integer" && accepted.includes("number"));

const MINIMUMS = ["minLength", "minItems", "minProperties"] as const;
const MAXIMUMS = ["maxLength", "maxItems", "maxProperties"] as const;

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" ? value : fallback;

type Bound = { value: number; exclusive: boolean; keyword: string };

const bound = (schema: Schema, lower: boolean): Bound => {
  const inclusiveKeyword = lower ? "minimum" : "maximum";
  const exclusiveKeyword = lower ? "exclusiveMinimum" : "exclusiveMaximum";
  const fallback = lower ? -Infinity : Infinity;
  const inclusive = number(schema[inclusiveKeyword], fallback);
  const exclusive = schema[exclusiveKeyword];
  if (
    typeof exclusive === "number" &&
    (lower ? exclusive >= inclusive : exclusive <= inclusive)
  ) {
    return { value: exclusive, exclusive: true, keyword: exclusiveKeyword };
  }
  return {
    value: inclusive,
    exclusive: exclusive === true,
    keyword: exclusive === true ? exclusiveKeyword : inclusiveKeyword,
  };
};

const tightenedBounds = (previous: Schema, current: Schema): string[] => {
  const tightened: string[] = [];
  for (const lower of [true, false]) {
    const old = bound(previous, lower);
    const next = bound(current, lower);
    if (
      (lower ? next.value > old.value : next.value < old.value) ||
      (next.value === old.value && next.exclusive && !old.exclusive)
    ) {
      tightened.push(next.keyword);
    }
  }
  return tightened;
};

const tightenedConstraints = (previous: Schema, current: Schema): string[] => {
  const tightened = tightenedBounds(previous, current);
  for (const key of MINIMUMS) {
    if (number(current[key], 0) > number(previous[key], 0)) {
      tightened.push(key);
    }
  }
  for (const key of MAXIMUMS) {
    if (number(current[key], Infinity) < number(previous[key], Infinity)) {
      tightened.push(key);
    }
  }
  // A replacement pattern or format has no general ordering.
  for (const key of ["pattern", "format"]) {
    if (current[key] !== undefined && current[key] !== previous[key]) {
      tightened.push(key);
    }
  }
  const oldDivisor = previous["multipleOf"];
  const newDivisor = current["multipleOf"];
  if (
    typeof newDivisor === "number" &&
    (typeof oldDivisor !== "number" || oldDivisor % newDivisor !== 0)
  ) {
    tightened.push("multipleOf");
  }
  if (current["uniqueItems"] === true && previous["uniqueItems"] !== true) {
    tightened.push("uniqueItems");
  }
  return tightened;
};

type Branch = {
  schema: unknown;
  path: string;
};

const alternatives = (schema: Schema, path: string): Branch[] => {
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = list(schema[keyword]);
    if (branches.length > 0) {
      return branches.map((branch, index) => ({
        schema: branch,
        path: pointer(pointer(path, keyword), index),
      }));
    }
  }
  return [];
};

const typeChoices = (schema: Schema, path: string): Branch[] => {
  const choices = types(schema);
  return choices.length > 1
    ? choices.map((type) => ({ schema: { ...schema, type }, path }))
    : [{ schema, path }];
};

const unionSiblings = (schema: Schema): Schema =>
  Object.fromEntries(
    Object.entries(schema).filter(
      ([key]) => key !== "anyOf" && key !== "oneOf",
    ),
  );

const withSiblings = (siblings: Schema, branch: Branch): unknown =>
  Object.keys(siblings).length === 0 || branch.schema === false
    ? branch.schema
    : { ...siblings, ...record(branch.schema) };

const sameValue = (left: unknown, right: unknown): boolean =>
  Bun.deepEquals(left, right);

const overlaps = (left: Schema, right: Schema): boolean => {
  const leftTypes = types(left);
  const rightTypes = types(right);
  if (
    leftTypes.length > 0 &&
    rightTypes.length > 0 &&
    leftTypes.every((type) => !allowsType(rightTypes, type)) &&
    rightTypes.every((type) => !allowsType(leftTypes, type))
  ) {
    return false;
  }
  const leftValues = values(left);
  const rightValues = values(right);
  if (
    leftValues &&
    rightValues &&
    !leftValues.some((value) =>
      rightValues.some((other) => sameValue(value, other)),
    )
  ) {
    return false;
  }
  const rightRequired = list(right["required"]);
  for (const name of list(left["required"])) {
    if (typeof name !== "string" || !rightRequired.includes(name)) {
      continue;
    }
    const leftPropertyValues = values(record(record(left["properties"])[name]));
    const rightPropertyValues = values(
      record(record(right["properties"])[name]),
    );
    if (
      leftPropertyValues &&
      rightPropertyValues &&
      !leftPropertyValues.some((value) =>
        rightPropertyValues.some((other) => sameValue(value, other)),
      )
    ) {
      return false;
    }
  }
  return true;
};

// Other keywords may alter validation in ways the structural comparison does
// not model. Annotations and reference containers do not constrain instances.
const ANNOTATION_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const HANDLED_KEYWORDS = new Set([
  ...ANNOTATION_KEYWORDS,
  "$ref",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "additionalItems",
  "anyOf",
  "oneOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  ...MINIMUMS,
  ...MAXIMUMS,
  "pattern",
  "format",
  "multipleOf",
  "uniqueItems",
]);

const resolveReference = (
  root: unknown,
  reference: unknown,
): Branch | undefined => {
  if (
    typeof reference !== "string" ||
    (reference !== "#" && !reference.startsWith("#/"))
  ) {
    return undefined;
  }
  let path: string;
  try {
    path = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  let target = root;
  for (const token of path.split("/").slice(1)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (isRecord(target) && Object.hasOwn(target, key)) {
      target = target[key];
    } else if (Array.isArray(target) && /^(0|[1-9]\d*)$/u.test(key)) {
      target = list(target).at(Number(key));
    } else {
      return undefined;
    }
  }
  return isRecord(target) || typeof target === "boolean"
    ? { schema: target, path }
    : undefined;
};

type AlternativesOptions = {
  old: Schema;
  next: Schema;
  oldBranches: Branch[];
  newBranches: Branch[];
  path: string;
};

class SchemaComparison {
  private readonly previous: unknown;
  private readonly current: unknown;
  private readonly output: boolean;
  private readonly activePairs = new Map<unknown, Set<unknown>>();
  private readonly referencePresence = new WeakMap<object, boolean>();

  constructor(direction: Direction, previous: unknown, current: unknown) {
    this.previous = previous;
    this.current = current;
    this.output = direction === "output";
  }

  private containsReference(value: unknown): boolean {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const cached = this.referencePresence.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const found =
      Object.hasOwn(value, "$ref") ||
      Object.values(value).some((entry) => this.containsReference(entry));
    this.referencePresence.set(value, found);
    return found;
  }

  private compare(
    oldValue: unknown,
    newValue: unknown,
    path: string,
  ): SchemaBreak[] {
    if (sameValue(oldValue, newValue) && !this.containsReference(oldValue)) {
      return [];
    }
    const active = this.activePairs.get(oldValue) ?? new Set();
    if (active.has(newValue)) {
      return [];
    }
    this.activePairs.set(oldValue, active);
    active.add(newValue);
    const breaks = this.compareNodes(oldValue, newValue, path);
    active.delete(newValue);
    if (active.size === 0) {
      this.activePairs.delete(oldValue);
    }
    return breaks;
  }

  private compareNodes(
    oldValue: unknown,
    newValue: unknown,
    path: string,
  ): SchemaBreak[] {
    const old = record(oldValue);
    const next = record(newValue);
    const accepted = this.output ? old : next;
    const produced = this.output ? next : old;
    const acceptedValue = this.output ? oldValue : newValue;
    const producedValue = this.output ? newValue : oldValue;
    if (producedValue === false) {
      return [];
    }
    if (acceptedValue === false) {
      return [
        {
          path,
          rule: this.output
            ? "output-type-changed"
            : "input-constraint-tightened",
        },
      ];
    }
    const breaks = [...new Set([...Object.keys(old), ...Object.keys(next)])]
      .filter(
        (key) =>
          !HANDLED_KEYWORDS.has(key) &&
          (!sameValue(old[key], next[key]) || this.containsReference(old[key])),
      )
      .map((key) => ({
        path: pointer(path, key),
        rule: "unsupported-schema-keyword-changed",
      }));
    for (const schema of [old, next]) {
      if (Array.isArray(schema["anyOf"]) && Array.isArray(schema["oneOf"])) {
        return [
          ...breaks,
          {
            path: pointer(path, "oneOf"),
            rule: "unsupported-schema-keyword-changed",
          },
        ];
      }
    }
    if (Object.hasOwn(old, "$ref") || Object.hasOwn(next, "$ref")) {
      return [...breaks, ...this.compareReferences(old, next, path)];
    }
    const oldBranches = alternatives(old, path);
    const newBranches = alternatives(next, path);
    if (oldBranches.length > 0 || newBranches.length > 0) {
      return [
        ...breaks,
        ...this.compareAlternatives({
          old,
          next,
          oldBranches,
          newBranches,
          path,
        }),
      ];
    }

    const oldTypes = types(old);
    const newTypes = types(next);
    if (
      this.output
        ? oldTypes.length !== newTypes.length ||
          oldTypes.some((type) => !newTypes.includes(type))
        : newTypes.length > 0 &&
          (oldTypes.length === 0 ||
            oldTypes.some((type) => !allowsType(newTypes, type)))
    ) {
      breaks.push({
        path: pointer(path, "type"),
        rule: this.output
          ? "output-type-changed"
          : "input-constraint-tightened",
      });
    }

    const acceptedValues = values(accepted);
    const producedValues = values(produced);
    if (
      acceptedValues &&
      (!producedValues ||
        producedValues.some(
          (value) => !acceptedValues.some((other) => sameValue(value, other)),
        ))
    ) {
      const keyword = Object.hasOwn(accepted, "enum") ? "enum" : "const";
      breaks.push({
        path: pointer(path, keyword),
        rule: this.output ? "output-enum-expanded" : "input-enum-narrowed",
      });
    }

    breaks.push(
      ...tightenedConstraints(produced, accepted).map((key) => ({
        path: pointer(path, key),
        rule: this.output
          ? "output-constraint-relaxed"
          : "input-constraint-tightened",
      })),
    );

    return [
      ...breaks,
      ...this.compareProperties(old, next, path),
      ...this.compareItems(old, next, path),
      ...this.compareAdditionalProperties(old, next, path),
    ];
  }

  private compareReferences(
    old: Schema,
    next: Schema,
    path: string,
  ): SchemaBreak[] {
    const { $ref: oldReference, ...oldSiblings } = old;
    const { $ref: newReference, ...newSiblings } = next;
    const oldTarget =
      oldReference === undefined
        ? { schema: old, path }
        : resolveReference(this.previous, oldReference);
    const newTarget =
      newReference === undefined
        ? { schema: next, path }
        : resolveReference(this.current, newReference);
    if (!oldTarget || !newTarget) {
      if (
        sameValue(old, next) &&
        typeof oldReference === "string" &&
        !oldReference.startsWith("#")
      ) {
        return [];
      }
      return [
        { path: pointer(path, "$ref"), rule: "unsupported-schema-reference" },
      ];
    }
    if (oldReference !== undefined && newReference !== undefined) {
      return [
        ...this.compare(oldSiblings, newSiblings, path),
        ...this.compare(oldTarget.schema, newTarget.schema, newTarget.path),
      ];
    }
    const siblings = oldReference === undefined ? newSiblings : oldSiblings;
    if (Object.keys(siblings).some((key) => !ANNOTATION_KEYWORDS.has(key))) {
      return [
        { path: pointer(path, "$ref"), rule: "unsupported-schema-reference" },
      ];
    }
    return this.compare(oldTarget.schema, newTarget.schema, newTarget.path);
  }

  private compareAdditionalProperties(
    old: Schema,
    next: Schema,
    path: string,
  ): SchemaBreak[] {
    const oldExtra = old["additionalProperties"];
    const newExtra = next["additionalProperties"];
    const extraPath = pointer(path, "additionalProperties");
    if (this.output && oldExtra === false && isRecord(newExtra)) {
      return [{ path: extraPath, rule: "output-constraint-relaxed" }];
    }
    if (
      this.output
        ? isRecord(oldExtra)
        : isRecord(newExtra) || newExtra === false
    ) {
      return this.compare(oldExtra, newExtra, extraPath);
    }
    return [];
  }

  private compareAlternatives({
    old,
    next,
    oldBranches,
    newBranches,
    path,
  }: AlternativesOptions): SchemaBreak[] {
    const oldChoices =
      oldBranches.length > 0 ? oldBranches : typeChoices(old, path);
    const newChoices =
      newBranches.length > 0 ? newBranches : typeChoices(next, path);
    const accepted = this.output ? oldChoices : newChoices;
    const produced = this.output ? newChoices : oldChoices;
    const acceptedSchema = this.output ? old : next;
    const producedSchema = this.output ? next : old;
    const acceptedSiblings = unionSiblings(acceptedSchema);
    const producedSiblings = unionSiblings(producedSchema);
    const sameExclusiveBranches =
      Array.isArray(acceptedSchema["oneOf"]) &&
      Array.isArray(producedSchema["oneOf"]) &&
      accepted.length === produced.length &&
      accepted.every((branch) =>
        produced.some((other) => sameValue(branch.schema, other.schema)),
      );

    return produced.flatMap((source) => {
      const sourceSchema = withSiblings(producedSiblings, source);
      const candidates = accepted.map((target) => {
        const targetSchema = withSiblings(acceptedSiblings, target);
        const useSourcePath =
          (this.output && newBranches.length > 0) || target.path === path;
        return {
          targetSchema,
          breaks: this.compare(
            this.output ? targetSchema : sourceSchema,
            this.output ? sourceSchema : targetSchema,
            useSourcePath ? source.path : target.path,
          ),
        };
      });
      const matching = candidates.find(
        (candidate) => candidate.breaks.length === 0,
      );
      if (matching) {
        // A oneOf consumer rejects values that match more than one branch.
        if (
          Array.isArray(acceptedSchema["oneOf"]) &&
          !sameExclusiveBranches &&
          candidates.some(
            (candidate) =>
              candidate !== matching &&
              overlaps(record(sourceSchema), record(candidate.targetSchema)),
          )
        ) {
          return [
            {
              path: source.path,
              rule: this.output
                ? "output-union-changed"
                : "input-constraint-tightened",
            },
          ];
        }
        return [];
      }
      const relevant = candidates.filter((candidate) =>
        overlaps(record(sourceSchema), record(candidate.targetSchema)),
      );
      const closest = (relevant.length > 0 ? relevant : candidates)
        .toSorted((left, right) => left.breaks.length - right.breaks.length)
        .at(0);
      return closest?.breaks ?? [];
    });
  }

  private compareProperties(
    old: Schema,
    next: Schema,
    path: string,
  ): SchemaBreak[] {
    const breaks: SchemaBreak[] = [];
    const oldProperties = record(old["properties"]);
    const newProperties = record(next["properties"]);
    const oldRequired = list(old["required"]);
    const newRequired = list(next["required"]);
    const propertyPath = pointer(path, "properties");
    for (const name of Object.keys(oldProperties).toSorted()) {
      const fieldPath = pointer(propertyPath, name);
      if (!Object.hasOwn(newProperties, name)) {
        breaks.push({
          path: fieldPath,
          rule: this.output
            ? "output-property-removed"
            : "input-property-removed",
        });
      } else {
        breaks.push(
          ...this.compare(oldProperties[name], newProperties[name], fieldPath),
        );
      }
    }
    for (const name of Object.keys(newProperties).toSorted()) {
      if (Object.hasOwn(oldProperties, name)) {
        continue;
      }
      const fieldPath = pointer(propertyPath, name);
      if (this.output && old["additionalProperties"] === false) {
        breaks.push({
          path: fieldPath,
          rule: "output-closed-object-property-added",
        });
      } else if (isRecord(old["additionalProperties"])) {
        breaks.push(
          ...this.compare(
            old["additionalProperties"],
            newProperties[name],
            fieldPath,
          ),
        );
      }
    }
    const required = this.output ? oldRequired : newRequired;
    const otherRequired = this.output ? newRequired : oldRequired;
    for (const name of required) {
      if (
        typeof name === "string" &&
        !otherRequired.includes(name) &&
        (!this.output || Object.hasOwn(newProperties, name))
      ) {
        breaks.push({
          path: pointer(propertyPath, name),
          rule: this.output
            ? "output-required-property-relaxed"
            : "input-required-property-added",
        });
      }
    }
    return breaks;
  }

  private compareItems(old: Schema, next: Schema, path: string): SchemaBreak[] {
    const oldTuple = list(old["prefixItems"] ?? old["items"]);
    const newTuple = list(next["prefixItems"] ?? next["items"]);
    const oldRest = Array.isArray(old["items"])
      ? old["additionalItems"]
      : old["items"];
    const newRest = Array.isArray(next["items"])
      ? next["additionalItems"]
      : next["items"];
    const breaks: SchemaBreak[] = [];
    for (
      let index = 0;
      index < Math.max(oldTuple.length, newTuple.length);
      index += 1
    ) {
      const keyword =
        next["prefixItems"] !== undefined || old["prefixItems"] !== undefined
          ? "prefixItems"
          : "items";
      breaks.push(
        ...this.compare(
          oldTuple.at(index) ?? oldRest,
          newTuple.at(index) ?? newRest,
          pointer(pointer(path, keyword), index),
        ),
      );
    }
    if (oldRest !== undefined || newRest !== undefined) {
      breaks.push(...this.compare(oldRest, newRest, pointer(path, "items")));
    }
    return breaks;
  }

  breaks(): SchemaBreak[] {
    if (sameValue(this.previous, this.current)) {
      return [];
    }
    // Several properties can reference the same changed definition.
    const reported = new Set<string>();
    return this.compare(this.previous, this.current, "").filter(
      ({ path, rule }) => {
        const key = JSON.stringify([path, rule]);
        if (reported.has(key)) {
          return false;
        }
        reported.add(key);
        return true;
      },
    );
  }
}

export const schemaBreaks = (
  direction: Direction,
  previous: unknown,
  current: unknown,
): SchemaBreak[] => new SchemaComparison(direction, previous, current).breaks();
