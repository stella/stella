import { validateAgainstSchema } from "./json-schema-validate.js";
import type { JsonSchema } from "./route-types.js";
import { compileSchemaPattern } from "./schema-pattern.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const propertiesOf = (schema: JsonSchema): Record<string, JsonSchema> => {
  const properties = schema["properties"];
  if (!isRecord(properties)) {
    return {};
  }
  const result: Record<string, JsonSchema> = {};
  for (const [name, child] of Object.entries(properties)) {
    if (isRecord(child)) {
      result[name] = child;
    }
  }
  return result;
};

const requiredOf = (schema: JsonSchema): ReadonlySet<string> => {
  const required = schema["required"];
  if (!Array.isArray(required)) {
    return new Set();
  }
  return new Set(
    required.filter((name): name is string => typeof name === "string"),
  );
};

const requiredAcrossAllOf = (schema: JsonSchema): ReadonlySet<string> => {
  const required = new Set(requiredOf(schema));
  for (const intersection of allOf(schema)) {
    for (const name of requiredAcrossAllOf(intersection)) {
      required.add(name);
    }
  }
  return required;
};

const schemaTypes = (schema: JsonSchema): readonly string[] => {
  const type = schema["type"];
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof type === "string" ? [type] : [];
};

const descriptionOf = (schema: JsonSchema): string | undefined => {
  const description = schema["description"];
  if (typeof description !== "string") {
    return undefined;
  }
  const normalized = description.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized;
};

type AlternativeGroup = {
  keyword: "anyOf" | "oneOf";
  variants: readonly JsonSchema[];
};

const MAX_COMPOSED_EXAMPLE_CANDIDATES = 64;

type ExampleSearchResult =
  | { status: "found"; example: unknown }
  | { status: "not-found" };

const exampleNotFound: ExampleSearchResult = { status: "not-found" };

const alternativeGroupsOf = (schema: JsonSchema): AlternativeGroup[] => {
  const groups: AlternativeGroup[] = [];
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const variants = schema[keyword];
    if (Array.isArray(variants)) {
      groups.push({ keyword, variants: variants.filter(isRecord) });
    }
  }
  return groups;
};

const allOf = (schema: JsonSchema): readonly JsonSchema[] => {
  const variants = schema["allOf"];
  return Array.isArray(variants) ? variants.filter(isRecord) : [];
};

const alternativeGroupsAcrossAllOf = (
  schema: JsonSchema,
): AlternativeGroup[] => [
  ...alternativeGroupsOf(schema),
  ...allOf(schema).flatMap(alternativeGroupsAcrossAllOf),
];

const describesObject = (schema: JsonSchema): boolean =>
  schemaTypes(schema).includes("object") ||
  Object.keys(propertiesOf(schema)).length > 0 ||
  allOf(schema).some(describesObject);

const hasNamedPropertiesAcrossAllOf = (schema: JsonSchema): boolean =>
  Object.keys(propertiesOf(schema)).length > 0 ||
  allOf(schema).some(hasNamedPropertiesAcrossAllOf);

const findComposedExample = (
  schema: JsonSchema,
  base: JsonSchema,
  groups: readonly AlternativeGroup[],
): ExampleSearchResult => {
  let candidatesRemaining = MAX_COMPOSED_EXAMPLE_CANDIDATES;
  const selection: JsonSchema[] = [];

  const search = (groupIndex: number): ExampleSearchResult => {
    if (candidatesRemaining === 0) {
      return exampleNotFound;
    }
    const group = groups[groupIndex];
    if (group !== undefined) {
      for (const variant of group.variants) {
        selection.push(variant);
        const result = search(groupIndex + 1);
        selection.pop();
        if (result.status === "found" || candidatesRemaining === 0) {
          return result;
        }
      }
      return exampleNotFound;
    }

    candidatesRemaining -= 1;
    const candidate = exampleFor({
      ...base,
      allOf: [...allOf(base), ...selection],
    });
    return validateAgainstSchema(schema, candidate).valid
      ? { status: "found", example: candidate }
      : exampleNotFound;
  };

  return search(0);
};

type MapEntrySchema = {
  keyPattern?: string;
  valueSchema: JsonSchema;
};

const mapEntrySchemas = (schema: JsonSchema): MapEntrySchema[] => {
  const entries: MapEntrySchema[] = [];
  const patterns = schema["patternProperties"];
  if (isRecord(patterns)) {
    for (const [keyPattern, valueSchema] of Object.entries(patterns)) {
      if (isRecord(valueSchema)) {
        entries.push({ keyPattern, valueSchema });
      }
    }
  }
  const additional = schema["additionalProperties"];
  if (additional === true) {
    entries.push({ valueSchema: {} });
  } else if (isRecord(additional)) {
    entries.push({ valueSchema: additional });
  }
  for (const intersection of allOf(schema)) {
    entries.push(...mapEntrySchemas(intersection));
  }
  return entries;
};

const scalarTypeLabel = (schema: JsonSchema): string => {
  const constant = schema["const"];
  if (
    typeof constant === "string" ||
    typeof constant === "number" ||
    typeof constant === "boolean"
  ) {
    return JSON.stringify(constant);
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (schema["type"] === "RegExp" || typeof schema["source"] === "string") {
    return "string";
  }
  const types = schemaTypes(schema);
  if (types.length > 0) {
    return types.join(" | ");
  }
  const intersectionTypes = [
    ...new Set(
      allOf(schema)
        .map(scalarTypeLabel)
        .filter((label) => label !== "any JSON value"),
    ),
  ];
  if (intersectionTypes.length > 0) {
    return intersectionTypes.join(" & ");
  }
  return "any JSON value";
};

const variantLabel = (schema: JsonSchema, index: number): string => {
  for (const [name, child] of Object.entries(propertiesOf(schema))) {
    if (child["const"] !== undefined) {
      return `variant ${index + 1}, ${name} = ${JSON.stringify(child["const"])}`;
    }
  }
  return `variant ${index + 1}`;
};

const lineFor = ({
  path,
  type,
  required,
  description,
  indent,
}: {
  path: string;
  type: string;
  required: boolean;
  description: string | undefined;
  indent: number;
}): string => {
  const suffix = description === undefined ? "" : ` — ${description}`;
  return `${"  ".repeat(indent)}${path}  ${type}  ${required ? "required" : "optional"}${suffix}`;
};

const renderMapEntries = ({
  path,
  entries,
  required,
  description,
  indent,
  lines,
}: {
  path: string;
  entries: readonly MapEntrySchema[];
  required: boolean;
  description: string | undefined;
  indent: number;
  lines: string[];
}): void => {
  for (const { keyPattern, valueSchema } of entries) {
    const valueType = scalarTypeLabel(valueSchema);
    lines.push(
      lineFor({
        path: `${path}.<key>`,
        type:
          keyPattern === undefined || keyPattern === "^(.*)$"
            ? valueType
            : `${valueType}; key matches ${keyPattern}`,
        required,
        description,
        indent,
      }),
    );
  }
};

const renderSchema = ({
  path,
  schema,
  required,
  indent,
  lines,
}: {
  path: string;
  schema: JsonSchema;
  required: boolean;
  indent: number;
  lines: string[];
}): void => {
  const alternativeGroups = alternativeGroupsAcrossAllOf(schema);
  if (alternativeGroups.length > 0) {
    for (const { keyword, variants } of alternativeGroups) {
      lines.push(
        lineFor({
          path,
          type: `${keyword}: one of ${variants.length} variants`,
          required,
          description: descriptionOf(schema),
          indent,
        }),
      );
      for (const [index, variant] of variants.entries()) {
        const label = variantLabel(variant, index);
        lines.push(`${"  ".repeat(indent + 1)}${label}:`);
        renderSchema({
          path,
          schema: variant,
          required,
          indent: indent + 2,
          lines,
        });
      }
    }
    renderObjectChildren({ path, schema, indent: indent + 1, lines });
    const mapEntries = mapEntrySchemas(schema);
    if (mapEntries.length > 0) {
      renderMapEntries({
        path,
        entries: mapEntries,
        required,
        description: descriptionOf(schema),
        indent: indent + 1,
        lines,
      });
    }
    return;
  }

  const types = schemaTypes(schema);
  if (types.includes("array")) {
    const items = schema["items"];
    const itemSchema = isRecord(items) ? items : undefined;
    lines.push(
      lineFor({
        path,
        type: `array<${itemSchema === undefined ? "any JSON value" : scalarTypeLabel(itemSchema)}>`,
        required,
        description: descriptionOf(schema),
        indent,
      }),
    );
    if (
      itemSchema !== undefined &&
      alternativeGroupsOf(itemSchema).length > 0
    ) {
      renderSchema({
        path: `${path}[]`,
        schema: itemSchema,
        required: true,
        indent: indent + 1,
        lines,
      });
    } else if (
      itemSchema !== undefined &&
      Object.keys(propertiesOf(itemSchema)).length > 0
    ) {
      renderObjectChildren({
        path: `${path}[]`,
        schema: itemSchema,
        indent: indent + 1,
        lines,
      });
    }
    return;
  }

  const properties = propertiesOf(schema);
  const intersections = allOf(schema);
  if (
    types.includes("object") ||
    Object.keys(properties).length > 0 ||
    intersections.some(describesObject)
  ) {
    const mapEntries = mapEntrySchemas(schema);
    const freeMap =
      mapEntries.length > 0 && !hasNamedPropertiesAcrossAllOf(schema);
    if (freeMap) {
      renderMapEntries({
        path,
        entries: mapEntries,
        required,
        description: descriptionOf(schema),
        indent,
        lines,
      });
      return;
    }
    lines.push(
      lineFor({
        path,
        type: "object",
        required,
        description: descriptionOf(schema),
        indent,
      }),
    );
    renderObjectChildren({ path, schema, indent: indent + 1, lines });
    if (mapEntries.length > 0) {
      renderMapEntries({
        path,
        entries: mapEntries,
        required,
        description: descriptionOf(schema),
        indent: indent + 1,
        lines,
      });
    }
    return;
  }

  lines.push(
    lineFor({
      path,
      type: scalarTypeLabel(schema),
      required,
      description: descriptionOf(schema),
      indent,
    }),
  );
};

const renderObjectChildren = ({
  path,
  schema,
  indent,
  lines,
  inheritedRequired = new Set(),
}: {
  path: string;
  schema: JsonSchema;
  indent: number;
  lines: string[];
  inheritedRequired?: ReadonlySet<string>;
}): void => {
  const required = new Set([
    ...inheritedRequired,
    ...requiredAcrossAllOf(schema),
  ]);
  for (const [name, child] of Object.entries(propertiesOf(schema))) {
    renderSchema({
      path: `${path}.${name}`,
      schema: child,
      required: required.has(name),
      indent,
      lines,
    });
  }
  for (const intersection of allOf(schema)) {
    renderObjectChildren({
      path,
      schema: intersection,
      indent,
      lines,
      inheritedRequired: required,
    });
  }
};

const schemaAtPath = (
  schema: JsonSchema,
  path: string,
): JsonSchema | undefined => {
  let current = schema;
  for (const segment of path.split(".")) {
    const child = propertiesOf(current)[segment];
    if (child === undefined) {
      return undefined;
    }
    current = child;
  }
  return current;
};

const pathRequired = (schema: JsonSchema, path: string): boolean => {
  const segments = path.split(".");
  let parent = schema;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      return requiredAcrossAllOf(parent).has(segment);
    }
    const child = propertiesOf(parent)[segment];
    if (child === undefined) {
      return false;
    }
    parent = child;
  }
  return false;
};

const characterForClass = (characterClass: string): string | undefined => {
  if (characterClass.includes("0-9")) {
    return "0";
  }
  if (characterClass.includes("A-Z")) {
    return "A";
  }
  if (characterClass.includes("a-z")) {
    return "a";
  }
  return characterClass.at(0);
};

const patternExample = (pattern: string): string | undefined => {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    return undefined;
  }

  const body = pattern.slice(1, -1);
  const tokens: string[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === undefined) {
      return undefined;
    }

    let token: string;
    if (character === "[") {
      const end = body.indexOf("]", index + 1);
      if (end === -1) {
        return undefined;
      }
      const classCharacter = characterForClass(body.slice(index + 1, end));
      if (classCharacter === undefined) {
        return undefined;
      }
      token = classCharacter;
      index = end;
    } else if (character === "\\") {
      const escaped = body[index + 1];
      if (escaped === undefined) {
        return undefined;
      }
      token = escaped === "d" ? "0" : escaped;
      index += 1;
    } else if ("().|".includes(character)) {
      return undefined;
    } else {
      token = character;
    }

    const remainder = body.slice(index + 1);
    const exact = /^\{(\d+)\}/u.exec(remainder);
    if (exact !== null) {
      tokens.push(token.repeat(Number(exact[1])));
      index += exact[0].length;
      continue;
    }
    if (remainder.startsWith("+")) {
      tokens.push(token);
      index += 1;
      continue;
    }
    if (remainder.startsWith("?")) {
      tokens.push(token);
      index += 1;
      continue;
    }
    if (remainder.startsWith("*")) {
      index += 1;
      continue;
    }
    tokens.push(token);
  }

  const example = tokens.join("");
  const compiled = compileSchemaPattern(pattern);
  if (compiled.status === "invalid") {
    return undefined;
  }
  return compiled.regex.test(example) ? example : undefined;
};

const boundedPatternExample = (
  schema: JsonSchema,
  pattern: string,
): string | undefined => {
  const example = patternExample(pattern);
  if (example === undefined) {
    return undefined;
  }
  const points = Array.from(example);
  const minLength =
    typeof schema["minLength"] === "number" ? schema["minLength"] : 0;
  const maxLength =
    typeof schema["maxLength"] === "number"
      ? schema["maxLength"]
      : Number.POSITIVE_INFINITY;
  const candidates = [example];
  const last = points.at(-1);
  if (points.length < minLength && last !== undefined) {
    candidates.push(
      [
        ...points,
        ...Array.from({ length: minLength - points.length }, () => last),
      ].join(""),
    );
    candidates.push(
      Array.from(
        { length: minLength },
        (_, index) => points[index % points.length],
      ).join(""),
    );
  }
  if (points.length > maxLength) {
    candidates.push(points.slice(0, maxLength).join(""));
  }
  const compiled = compileSchemaPattern(pattern);
  if (compiled.status === "invalid") {
    return undefined;
  }
  return candidates.find((candidate) => {
    const length = Array.from(candidate).length;
    return (
      length >= minLength &&
      length <= maxLength &&
      compiled.regex.test(candidate)
    );
  });
};

const patternsAcrossAllOf = (schema: JsonSchema): string[] => {
  const patterns: string[] = [];
  const pattern = schema["pattern"];
  if (typeof pattern === "string") {
    patterns.push(pattern);
  }
  for (const intersection of allOf(schema)) {
    patterns.push(...patternsAcrossAllOf(intersection));
  }
  return patterns;
};

const literalPatternFragment = (pattern: string): string | undefined => {
  const body = pattern.replace(/^\^/u, "").replace(/\$$/u, "");
  let fragment = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === undefined) {
      return undefined;
    }
    if (character === "\\") {
      const escaped = body[index + 1];
      if (escaped === undefined || "dDsSwWbB".includes(escaped)) {
        return undefined;
      }
      fragment += escaped;
      index += 1;
      continue;
    }
    if ("[](){}.*+?|".includes(character)) {
      return undefined;
    }
    fragment += character;
  }
  return fragment.length === 0 ? undefined : fragment;
};

const keyExampleForPattern = (pattern: string): string | undefined => {
  const compiled = compileSchemaPattern(pattern);
  if (compiled.status === "invalid") {
    return undefined;
  }
  const bounded = boundedPatternExample({}, pattern);
  const fragment = literalPatternFragment(pattern);
  const candidates = [
    bounded,
    fragment === undefined ? undefined : `${fragment}key`,
    fragment,
    "key",
    "meta-key",
    "x",
    "0",
  ];
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && compiled.regex.test(candidate),
  );
};

const numericKeywordAcrossAllOf = (
  schema: JsonSchema,
  keyword: "minLength" | "maxLength",
  select: "lower" | "upper",
): number | undefined => {
  const values: number[] = [];
  const direct = schema[keyword];
  if (typeof direct === "number") {
    values.push(direct);
  }
  for (const intersection of allOf(schema)) {
    const nested = numericKeywordAcrossAllOf(intersection, keyword, select);
    if (nested !== undefined) {
      values.push(nested);
    }
  }
  if (values.length === 0) {
    return undefined;
  }
  return select === "lower" ? Math.max(...values) : Math.min(...values);
};

const mostSpecificAnchor = (
  fragments: readonly string[],
  side: "prefix" | "suffix",
): string | undefined => {
  const longest = fragments.toSorted(
    (left, right) => right.length - left.length,
  )[0];
  if (longest === undefined) {
    return "";
  }
  const compatible = fragments.every((fragment) =>
    side === "prefix"
      ? longest.startsWith(fragment)
      : longest.endsWith(fragment),
  );
  return compatible ? longest : undefined;
};

const patternIntersectionExample = (schema: JsonSchema): string | undefined => {
  const patterns = [...new Set(patternsAcrossAllOf(schema))];
  if (patterns.length < 2) {
    return undefined;
  }
  const compiled = patterns.map((pattern) => compileSchemaPattern(pattern));
  if (compiled.some((entry) => entry.status === "invalid")) {
    return undefined;
  }
  const fragments = patterns.map(literalPatternFragment);
  if (fragments.some((fragment) => fragment === undefined)) {
    return undefined;
  }
  const prefixes: string[] = [];
  const middles: string[] = [];
  const suffixes: string[] = [];
  for (const [index, pattern] of patterns.entries()) {
    const fragment = fragments[index];
    if (fragment === undefined) {
      return undefined;
    }
    if (pattern.startsWith("^")) {
      prefixes.push(fragment);
    } else if (pattern.endsWith("$")) {
      suffixes.push(fragment);
    } else {
      middles.push(fragment);
    }
  }
  const prefix = mostSpecificAnchor(prefixes, "prefix");
  const suffix = mostSpecificAnchor(suffixes, "suffix");
  if (prefix === undefined || suffix === undefined) {
    return undefined;
  }
  let anchored = `${prefix}${suffix}`;
  if (prefix.endsWith(suffix)) {
    anchored = prefix;
  } else if (suffix.startsWith(prefix)) {
    anchored = suffix;
  }
  const candidates = [
    `${prefix}${middles.join("")}${suffix}`,
    `${anchored}${middles.join("")}`,
    fragments.join(""),
    fragments.toReversed().join(""),
  ];
  const minLength = numericKeywordAcrossAllOf(schema, "minLength", "lower");
  const maxLength = numericKeywordAcrossAllOf(schema, "maxLength", "upper");
  const baseLength = Array.from(candidates[0] ?? "").length;
  if (minLength !== undefined && baseLength < minLength) {
    const fillerSource = prefix || middles.at(-1) || suffix;
    const filler = Array.from(fillerSource).at(-1);
    if (filler !== undefined) {
      candidates.unshift(
        `${prefix}${middles.join("")}${filler.repeat(minLength - baseLength)}${suffix}`,
      );
    }
  }
  return candidates.find((candidate) => {
    const length = Array.from(candidate).length;
    return (
      (minLength === undefined || length >= minLength) &&
      (maxLength === undefined || length <= maxLength) &&
      compiled.every(
        (entry) => entry.status === "valid" && entry.regex.test(candidate),
      )
    );
  });
};

const stringExample = (schema: JsonSchema): string => {
  const format = schema["format"];
  if (format === "date") {
    return "2026-01-01";
  }
  if (format === "date-time") {
    return "2026-01-01T00:00:00.000Z";
  }
  if (format === "integer") {
    const minimum = schema["minimum"];
    return String(typeof minimum === "number" ? minimum : 0);
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string" && pattern.includes("[0-9a-fA-F]{8}")) {
    return "00000000-0000-4000-8000-000000000000";
  }
  if (typeof pattern === "string") {
    const example = boundedPatternExample(schema, pattern);
    if (example !== undefined) {
      return example;
    }
  }
  const source = schema["source"];
  if (source === "^[0-9a-f]{64}$") {
    return "0".repeat(64);
  }
  const minLength = schema["minLength"];
  const maxLength = schema["maxLength"];
  const preferredLength =
    typeof minLength === "number" ? Math.max(1, minLength) : 5;
  const length =
    typeof maxLength === "number"
      ? Math.min(preferredLength, maxLength)
      : preferredLength;
  return "x".repeat(length);
};

const stricterLowerBound = (
  left: unknown,
  right: unknown,
): number | undefined => {
  const bounds = [left, right].filter(
    (value): value is number => typeof value === "number",
  );
  return bounds.length === 0 ? undefined : Math.max(...bounds);
};

const stricterUpperBound = (
  left: unknown,
  right: unknown,
): number | undefined => {
  const bounds = [left, right].filter(
    (value): value is number => typeof value === "number",
  );
  return bounds.length === 0 ? undefined : Math.min(...bounds);
};

const combineSchemasForExample = (
  parent: JsonSchema,
  branch: JsonSchema,
): JsonSchema => {
  const combined: JsonSchema = { ...parent, ...branch };
  for (const keyword of ["minimum", "minLength", "minItems"] as const) {
    const bound = stricterLowerBound(parent[keyword], branch[keyword]);
    if (bound !== undefined) {
      combined[keyword] = bound;
    }
  }
  for (const keyword of ["maximum", "maxLength", "maxItems"] as const) {
    const bound = stricterUpperBound(parent[keyword], branch[keyword]);
    if (bound !== undefined) {
      combined[keyword] = bound;
    }
  }

  const parentProperties = propertiesOf(parent);
  const properties = { ...parentProperties };
  for (const [name, branchProperty] of Object.entries(propertiesOf(branch))) {
    const parentProperty = parentProperties[name];
    properties[name] =
      parentProperty === undefined
        ? branchProperty
        : combineSchemasForExample(parentProperty, branchProperty);
  }
  if (Object.keys(properties).length > 0) {
    combined["properties"] = properties;
  }
  const required = new Set([...requiredOf(parent), ...requiredOf(branch)]);
  if (required.size > 0) {
    combined["required"] = [...required];
  }
  const intersections = [...allOf(parent), ...allOf(branch)];
  const parentPattern = parent["pattern"];
  const branchPattern = branch["pattern"];
  if (
    typeof parentPattern === "string" &&
    typeof branchPattern === "string" &&
    parentPattern !== branchPattern
  ) {
    combined["pattern"] = undefined;
    intersections.push({ pattern: parentPattern }, { pattern: branchPattern });
  }
  if (intersections.length > 0) {
    combined["allOf"] = intersections;
  }
  return combined;
};

const collapseAllOfForExample = (schema: JsonSchema): JsonSchema => {
  let combined: JsonSchema = { ...schema, allOf: undefined };
  for (const intersection of allOf(schema)) {
    combined = combineSchemasForExample(
      combined,
      collapseAllOfForExample(intersection),
    );
  }
  return combined;
};

const exampleFor = (schema: JsonSchema): unknown => {
  const constant = schema["const"];
  if (constant !== undefined) {
    return constant;
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.at(0);
  }
  const alternativeGroups = alternativeGroupsOf(schema);
  if (alternativeGroups.length > 0) {
    const base = { ...schema, anyOf: undefined, oneOf: undefined };
    const result = findComposedExample(schema, base, alternativeGroups);
    if (result.status === "found") {
      return result.example;
    }
    return exampleFor(base);
  }
  const intersections = allOf(schema);
  if (intersections.length > 0) {
    const patternCandidate = patternIntersectionExample(schema);
    if (
      patternCandidate !== undefined &&
      validateAgainstSchema(schema, patternCandidate).valid
    ) {
      return patternCandidate;
    }
    const collapsed = collapseAllOfForExample(schema);
    if (allOf(collapsed).length === 0) {
      const composedCandidate = exampleFor(collapsed);
      if (validateAgainstSchema(schema, composedCandidate).valid) {
        return composedCandidate;
      }
    }
    const baseSchema = { ...schema, allOf: undefined };
    const result = exampleFor(baseSchema);
    for (const intersection of intersections) {
      const candidate = exampleFor(
        combineSchemasForExample(baseSchema, intersection),
      );
      if (validateAgainstSchema(schema, candidate).valid) {
        return candidate;
      }
    }
    const objectResult = isRecord(result) ? result : {};
    for (const intersection of intersections) {
      const example = exampleFor(intersection);
      if (isRecord(example)) {
        Object.assign(objectResult, example);
      }
    }
    return objectResult;
  }
  const types = schemaTypes(schema);
  const defaultValue = schema["default"];
  if (
    defaultValue !== undefined &&
    ((types.includes("string") && typeof defaultValue === "string") ||
      (types.includes("number") && typeof defaultValue === "number") ||
      (types.includes("integer") &&
        typeof defaultValue === "number" &&
        Number.isInteger(defaultValue)) ||
      (types.includes("boolean") && typeof defaultValue === "boolean"))
  ) {
    return defaultValue;
  }
  if (
    types.includes("object") ||
    Object.keys(propertiesOf(schema)).length > 0
  ) {
    const result: Record<string, unknown> = {};
    for (const name of requiredOf(schema)) {
      const child = propertiesOf(schema)[name];
      if (child !== undefined) {
        result[name] = exampleFor(child);
      }
    }
    const mapEntry = mapEntrySchemas(schema).at(0);
    if (mapEntry !== undefined) {
      const key =
        mapEntry.keyPattern === undefined
          ? "key"
          : keyExampleForPattern(mapEntry.keyPattern);
      if (key !== undefined) {
        result[key] = exampleFor(mapEntry.valueSchema);
      }
    }
    return result;
  }
  if (types.includes("array")) {
    const items = schema["items"];
    const minimum = schema["minItems"];
    const count = typeof minimum === "number" ? Math.max(1, minimum) : 1;
    const value = isRecord(items) ? exampleFor(items) : "value";
    return Array.from({ length: count }, () => value);
  }
  if (types.includes("integer") || types.includes("number")) {
    const minimum = schema["minimum"];
    return typeof minimum === "number" ? minimum : 0;
  }
  if (types.includes("boolean")) {
    return false;
  }
  if (types.includes("null")) {
    return null;
  }
  if (types.length === 0 && typeof schema["source"] !== "string") {
    return "value";
  }
  return stringExample(schema);
};

const setExamplePath = (
  schema: JsonSchema,
  target: Record<string, unknown>,
  path: string,
): void => {
  const segments = path.split(".");
  let current = target;
  let currentSchema = schema;
  for (const segment of segments) {
    const childSchema = propertiesOf(currentSchema)[segment];
    if (childSchema === undefined) {
      return;
    }
    const existing = current[segment];
    if (isRecord(existing)) {
      current = existing;
      currentSchema = childSchema;
      continue;
    }
    const example = exampleFor(childSchema);
    current[segment] = example;
    if (isRecord(example)) {
      current = example;
      currentSchema = childSchema;
    }
  }
};

type InputContractExample =
  | { status: "complete"; value: Record<string, unknown> }
  | { status: "unavailable" };

export type InputContractHelp = {
  fields: readonly string[];
  example: InputContractExample;
};

/** Quote a generated JSON example as one POSIX-shell argument. */
export const formatInputExample = (example: Record<string, unknown>): string =>
  `--input '${JSON.stringify(example).replaceAll("'", `'\\''`)}'`;

/**
 * Render the schema subtrees that cannot be expressed as scalar CLI flags and
 * produce a deterministic, schema-derived full-input example. Both artifacts
 * come from the validation schema, so help cannot drift into a hand-authored
 * second contract.
 */
export const buildInputContractHelp = ({
  schema,
  inputOnly,
  requiredPaths = [],
}: {
  schema: JsonSchema;
  inputOnly: readonly string[];
  requiredPaths?: readonly string[];
}): InputContractHelp | undefined => {
  if (inputOnly.length === 0) {
    return undefined;
  }

  const fields: string[] = [];
  for (const path of inputOnly) {
    const fieldSchema = schemaAtPath(schema, path);
    if (fieldSchema === undefined) {
      continue;
    }
    renderSchema({
      path,
      schema: fieldSchema,
      required: pathRequired(schema, path),
      indent: 0,
      lines: fields,
    });
  }

  const rootExample = exampleFor(schema);
  const example = isRecord(rootExample) ? rootExample : {};
  for (const path of [...inputOnly, ...requiredPaths]) {
    setExamplePath(schema, example, path);
  }
  return {
    fields,
    example: validateAgainstSchema(schema, example).valid
      ? { status: "complete", value: example }
      : { status: "unavailable" },
  };
};
