import path from "node:path";

import { DERIVED_REPLAY_METADATA_KEYS } from "../apps/api/src/lib/legal-search/pipeline-metadata-policy";
import {
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";

type MetadataCensusOptions = {
  files: readonly string[];
  readSource: (file: string) => string | undefined;
  classifiedKeys: ReadonlySet<string>;
};
type ParsedMetadataSource = {
  program: ReturnType<typeof parseSource>["program"];
  ancestors: ReadonlyMap<Node, readonly Node[]>;
  bindings: readonly {
    name: string;
    init: Node | null;
    node: Node;
    scopes: readonly Node[];
  }[];
  imports: ReadonlyMap<string, { file: string; name: string }>;
};
const isScope = (node: Node) =>
  node.type === "Program" ||
  node.type === "BlockStatement" ||
  node.type === "ForOfStatement" ||
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression";
const unwrap = (node: Node): Node =>
  node.type === "TSAsExpression" ||
  node.type === "TSSatisfiesExpression" ||
  node.type === "ParenthesizedExpression"
    ? unwrap(node.expression)
    : node;
const propertyName = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  return node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
};
const memberName = (node: Node): string | undefined =>
  node.type === "MemberExpression" ? propertyName(node.property) : undefined;

const resolveImport = (file: string, specifier: string) => {
  if (specifier.startsWith("@/api/")) {
    return `apps/api/src/${specifier.slice("@/api/".length)}.ts`;
  }
  if (specifier.startsWith("@stll/")) {
    const [owner, ...parts] = specifier.slice("@stll/".length).split("/");
    return `packages/${owner}/src/${parts.join("/")}.ts`;
  }
  return specifier.startsWith(".")
    ? path.posix.normalize(
        path.posix.join(
          path.posix.dirname(file),
          `${specifier.replace(/\.ts$/u, "")}.ts`,
        ),
      )
    : undefined;
};

/** Resolves only literal pipeline keys and their local/imported constant aliases. */
class MetadataWriterCensus {
  private readonly parsed = new Map<string, ParsedMetadataSource>();
  private readonly options: Omit<MetadataCensusOptions, "files">;
  constructor(options: Omit<MetadataCensusOptions, "files">) {
    this.options = options;
  }
  private sourceOf = (file: string): ParsedMetadataSource | undefined => {
    const cached = this.parsed.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const text = this.options.readSource(file);
    if (text === undefined) {
      return undefined;
    }
    const { program } = parseSource(file, text);
    const ancestors = new Map<Node, readonly Node[]>();
    const bindings: {
      name: string;
      init: Node | null;
      node: Node;
      scopes: readonly Node[];
    }[] = [];
    const imports = new Map<string, { file: string; name: string }>();
    walk(program, (node, parents) => {
      ancestors.set(node, [...parents]);
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        const forOf = parents.at(-2);
        bindings.push({
          name: node.id.name,
          init:
            node.init ??
            (forOf?.type === "ForOfStatement" ? forOf.right : null),
          node,
          scopes: parents.filter(isScope),
        });
      }
      if (node.type !== "ImportDeclaration") {
        return;
      }
      const importedFile = resolveImport(file, node.source.value);
      if (importedFile === undefined) {
        return;
      }
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          const name = propertyName(specifier.imported);
          if (name !== undefined) {
            imports.set(specifier.local.name, { file: importedFile, name });
          }
        }
      }
    });
    const result = { program, ancestors, bindings, imports };
    this.parsed.set(file, result);
    return result;
  };
  private bindingOf = (file: string, name: string, at: Node) => {
    const source = this.sourceOf(file);
    const scopes = source?.ancestors.get(at)?.filter(isScope) ?? [];
    return source?.bindings
      .filter(
        (binding) =>
          binding.name === name &&
          binding.scopes.every((scope, index) => scopes.at(index) === scope),
      )
      .toSorted((left, right) => right.scopes.length - left.scopes.length)
      .at(0);
  };
  private resolveNode = (
    file: string,
    node: Node,
    seen = new Set<Node>(),
  ): { file: string; node: Node } | undefined => {
    const value = unwrap(node);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (value.type !== "Identifier") {
      return { file, node: value };
    }
    const binding = this.bindingOf(file, value.name, value);
    if (binding?.init) {
      return this.resolveNode(file, binding.init, seen);
    }
    const imported = this.sourceOf(file)?.imports.get(value.name);
    const importedSource =
      imported === undefined ? undefined : this.sourceOf(imported.file);
    const importedBinding = importedSource?.bindings.find(
      (candidate) => candidate.name === imported?.name,
    );
    return imported && importedBinding?.init
      ? this.resolveNode(imported.file, importedBinding.init, seen)
      : undefined;
  };
  private valuesOf = (
    file: string,
    node: Node,
    seen = new Set<Node>(),
  ): readonly string[] | undefined => {
    const resolved = this.resolveNode(file, node);
    if (resolved === undefined || seen.has(resolved.node)) {
      return undefined;
    }
    const value = resolved.node;
    seen.add(value);
    if (
      resolved.file ===
        "apps/api/src/lib/legal-search/pipeline-metadata-policy.ts" &&
      this.sourceOf(resolved.file)?.bindings.some(
        (binding) =>
          binding.name === "DERIVED_REPLAY_METADATA_KEYS" &&
          binding.init !== null &&
          unwrap(binding.init) === value,
      )
    ) {
      return DERIVED_REPLAY_METADATA_KEYS;
    }
    if (value.type === "Literal" && typeof value.value === "string") {
      return [value.value];
    }
    if (value.type === "ArrayExpression") {
      const values: string[] = [];
      for (const item of value.elements) {
        if (item === null) {
          return undefined;
        }
        const found = this.valuesOf(
          resolved.file,
          item.type === "SpreadElement" ? item.argument : item,
          new Set(seen),
        );
        if (found === undefined) {
          return undefined;
        }
        values.push(...found);
      }
      return values;
    }
    if (value.type === "MemberExpression") {
      const object = this.resolveNode(resolved.file, value.object);
      const name = memberName(value);
      if (object?.node.type !== "ObjectExpression" || name === undefined) {
        return undefined;
      }
      const property = object.node.properties.find(
        (item) => item.type === "Property" && propertyName(item.key) === name,
      );
      return property?.type === "Property"
        ? this.valuesOf(object.file, property.value, seen)
        : undefined;
    }
    if (
      value.type === "CallExpression" &&
      value.callee.type === "MemberExpression" &&
      value.callee.object.type === "Identifier" &&
      value.callee.object.name === "Object"
    ) {
      const argument = value.arguments.at(0);
      if (argument === undefined || argument.type === "SpreadElement") {
        return undefined;
      }
      if (memberName(value.callee) === "freeze") {
        return this.valuesOf(resolved.file, argument, seen);
      }
      if (memberName(value.callee) === "values") {
        return this.objectValues(resolved.file, argument, seen);
      }
    }
    return undefined;
  };
  private objectValues = (
    file: string,
    argument: Node,
    seen: Set<Node>,
  ): readonly string[] | undefined => {
    const object = this.resolveNode(file, argument);
    if (object?.node.type !== "ObjectExpression") {
      return undefined;
    }
    const values: string[] = [];
    for (const property of object.node.properties) {
      if (property.type !== "Property") {
        return undefined;
      }
      const found = this.valuesOf(object.file, property.value, new Set(seen));
      if (found === undefined) {
        return undefined;
      }
      values.push(...found);
    }
    return values;
  };
  private metadataExpression = (
    file: string,
    node: Node,
    seen = new Set<Node>(),
  ): boolean => {
    const value = unwrap(node);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (value.type === "Identifier") {
      if (/metadata/iu.test(value.name)) {
        return true;
      }
      const binding = this.bindingOf(file, value.name, value);
      return (
        binding?.init !== null &&
        binding?.init !== undefined &&
        this.metadataExpression(file, binding.init, seen)
      );
    }
    if (value.type === "MemberExpression") {
      return (
        memberName(value) === "metadata" ||
        (memberName(value) === "value" &&
          this.metadataExpression(file, value.object, seen))
      );
    }
    if (value.type === "ObjectExpression") {
      return value.properties.some(
        (property) =>
          property.type === "SpreadElement" &&
          this.metadataExpression(file, property.argument, new Set(seen)),
      );
    }
    if (value.type === "CallExpression") {
      return value.arguments.some(
        (argument) =>
          argument.type !== "SpreadElement" &&
          this.metadataExpression(file, argument, new Set(seen)),
      );
    }
    return false;
  };
  findings(file: string): string[] {
    const findings: string[] = [];
    const source = this.sourceOf(file);
    if (source === undefined) {
      return [`${file}: metadata writer source is missing`];
    }
    const charge = (node: Node, key: Node, computed: boolean) => {
      const literalName = propertyName(key);
      const literalValues =
        literalName === undefined ? undefined : [literalName];
      const values = computed ? this.valuesOf(file, key) : literalValues;
      if (values === undefined) {
        findings.push(
          `${file}:${node.start}: unresolved pipeline metadata write`,
        );
        return;
      }
      for (const value of values) {
        if (value !== undefined && !this.options.classifiedKeys.has(value)) {
          findings.push(
            `${file}:${node.start}: unclassified pipeline metadata key ${value}`,
          );
        }
      }
    };
    walk(source.program, (node, parents) => {
      if (
        node.type === "AssignmentExpression" &&
        node.left.type === "MemberExpression" &&
        this.metadataExpression(file, node.left.object)
      ) {
        charge(node, node.left.property, node.left.computed);
      }
      if (node.type !== "ObjectExpression") {
        return;
      }
      const parent = parents.at(-1);
      const metadataObject =
        this.metadataExpression(file, node) ||
        (parent?.type === "Property" &&
          propertyName(parent.key) === "metadata") ||
        (parent?.type === "VariableDeclarator" &&
          parent.id.type === "Identifier" &&
          /metadata/iu.test(parent.id.name));
      const hasKnownKey = node.properties.some(
        (property) =>
          property.type === "Property" &&
          property.computed &&
          this.valuesOf(file, property.key)?.some((key) =>
            this.options.classifiedKeys.has(key),
          ),
      );
      if (!metadataObject && !hasKnownKey) {
        return;
      }
      for (const property of node.properties) {
        if (property.type === "Property") {
          charge(property, property.key, property.computed);
        }
      }
    });
    return [...new Set(findings)];
  }
}

/** Every classified producer is read from its real source; no mirror key inventory. */
export const unclassifiedPipelineMetadataWrites = ({
  files,
  ...options
}: MetadataCensusOptions) => {
  const census = new MetadataWriterCensus(options);
  return files.flatMap((file) => census.findings(file));
};
