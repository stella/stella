import {
  isObjectLiteralProperty,
  type Node,
  parseSource,
  staticPropertyName,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";

export const ALLOWED_EMBEDDED_METRIC_NAMESPACES = {
  "Stella/CaseLaw": "Per-source replay lag and budget alarms.",
  "Stella/Backfill":
    "Backfill heartbeat health records and load-gate diagnostics.",
} as const;

export const EMBEDDED_METRIC_NAMESPACE_GUARD = "embedded-metric-namespaces";

const literalString = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return literalString(node.expression);
  }
  return undefined;
};

/** Unknown expressions fail closed; only unshadowed module constants resolve. */
export const inspectEmbeddedMetricNamespaces = (
  file: string,
  source: string,
) => {
  const parsed = parseSource(file, source);
  const constants = new Map<string, string>();
  const bindings = new Map<string, number>();
  const countBindings = (binding: Node) => {
    walk(binding, (node) => {
      if (node.type === "Identifier") {
        bindings.set(node.name, (bindings.get(node.name) ?? 0) + 1);
      }
    });
  };
  walk(parsed.program, (node, ancestors) => {
    if (node.type === "VariableDeclarator") {
      countBindings(node.id);
      const declaration = ancestors.at(-1);
      if (
        node.id.type === "Identifier" &&
        node.init !== null &&
        declaration?.type === "VariableDeclaration" &&
        declaration.kind === "const" &&
        ancestors.every((ancestor) =>
          ["Program", "VariableDeclaration", "ExportNamedDeclaration"].includes(
            ancestor.type,
          ),
        )
      ) {
        const value = literalString(node.init);
        if (value !== undefined) {
          constants.set(node.id.name, value);
        }
      }
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      for (const parameter of node.params) {
        countBindings(parameter);
      }
    }
    if (node.type === "CatchClause" && node.param !== null) {
      countBindings(node.param);
    }
  });
  const violations: { line: number; namespace: string }[] = [];
  const namespaces: string[] = [];
  walk(parsed.program, (node, ancestors) => {
    if (
      !isObjectLiteralProperty(node, ancestors.at(-1)) ||
      staticPropertyName(node) !== "CloudWatchMetrics"
    ) {
      return;
    }
    if (node.value.type !== "ArrayExpression") {
      violations.push({
        line: parsed.locate(node.start).line,
        namespace: "<dynamic metric directives>",
      });
      return;
    }
    for (const directive of node.value.elements) {
      const properties =
        directive?.type === "ObjectExpression"
          ? directive.properties.filter(
              (property) =>
                property.type === "Property" &&
                staticPropertyName(property) === "Namespace",
            )
          : [];
      const namespaceProperty = properties.at(0);
      const hasUnknownProperties =
        directive?.type !== "ObjectExpression" ||
        directive.properties.some(
          (property) =>
            property.type === "SpreadElement" ||
            staticPropertyName(property) === undefined,
        );
      const value =
        namespaceProperty?.type === "Property"
          ? namespaceProperty.value
          : undefined;
      let namespace: string | undefined;
      if (value?.type === "Identifier" && bindings.get(value.name) === 1) {
        namespace = constants.get(value.name);
      } else if (value !== undefined) {
        namespace = literalString(value);
      }
      if (namespace !== undefined) {
        namespaces.push(namespace);
      }
      if (
        namespace === undefined ||
        hasUnknownProperties ||
        properties.length !== 1 ||
        namespace === "Stella/Api" ||
        !Object.hasOwn(ALLOWED_EMBEDDED_METRIC_NAMESPACES, namespace)
      ) {
        violations.push({
          line: parsed.locate(namespaceProperty?.start ?? node.start).line,
          namespace: namespace ?? "<dynamic or missing namespace>",
        });
      }
    }
  });
  return { namespaces, violations };
};
