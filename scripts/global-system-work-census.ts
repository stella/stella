import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { mapWithConcurrency } from "@stll/concurrency";
import { repoRelativePath } from "@stll/portable-path";

import {
  parseSource,
  staticPropertyName,
} from "../packages/scripts/src/syntax-tree.ts";
import type {
  Node,
  ObjectExpression,
  ObjectProperty,
} from "../packages/scripts/src/syntax-tree.ts";
import { findImportedFunctionCalls } from "./root-connection-shapes.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const jobSource = "apps/api/src/lib/db/global-system-work.ts";
const API_SOURCE_ROOT = "apps/api/src";
const GLOBAL_SYSTEM_WORK_MODULE_PATH = "apps/api/src/lib/db/global-system-work";
const SUPPORTED_SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;

export type GlobalSystemWorkOwners = Readonly<
  Record<string, { readonly owner: string }>
>;

export type GlobalSystemWorkCallSite = {
  readonly file: string;
  readonly type: string;
};

export type GlobalSystemWorkInventory = {
  readonly owners: GlobalSystemWorkOwners;
  readonly importers: readonly string[];
  readonly callSites: readonly GlobalSystemWorkCallSite[];
};

const unwrap = (node: Node): Node => {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
};

const objectProperty = (
  properties: ObjectExpression["properties"],
  name: string,
): ObjectProperty | undefined =>
  (() => {
    let found: ObjectProperty | undefined;
    const names = new Set<string>();
    for (const property of properties) {
      if (
        property.type !== "Property" ||
        property.kind !== "init" ||
        property.computed ||
        (property.shorthand && staticPropertyName(property) === name) ||
        property.method
      ) {
        return panic(
          "GLOBAL_SYSTEM_JOBS values must use explicit literal properties",
        );
      }
      const propertyName = staticPropertyName(property);
      if (propertyName === undefined) {
        return panic(
          "GLOBAL_SYSTEM_JOBS values must use explicit literal properties",
        );
      }
      if (names.has(propertyName)) {
        return panic(`GLOBAL_SYSTEM_JOBS value repeats ${propertyName}`);
      }
      names.add(propertyName);
      if (propertyName !== name) {
        continue;
      }
      found = property;
    }
    return found;
  })();

export const parseGlobalSystemWorkOwners = (
  content: string,
  file: string,
): GlobalSystemWorkOwners => {
  const source = parseSource(file, content);
  const declarations = source.program.body.flatMap((statement) => {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "VariableDeclaration"
    ) {
      return [];
    }
    const kind = statement.declaration.kind;
    return statement.declaration.declarations
      .filter(
        (declaration) =>
          declaration.id.type === "Identifier" &&
          declaration.id.name === "GLOBAL_SYSTEM_JOBS",
      )
      .map((declaration) => ({
        declaration,
        kind,
      }));
  });
  const exported = declarations.at(0);
  const declaration = exported?.declaration;
  if (
    declarations.length !== 1 ||
    exported === undefined ||
    declaration === undefined ||
    exported.kind !== "const" ||
    unwrap(
      declaration.init ?? panic("GLOBAL_SYSTEM_JOBS initializer is missing"),
    ).type !== "ObjectExpression"
  ) {
    return panic("GLOBAL_SYSTEM_JOBS must remain a literal source map");
  }
  const entries = unwrap(
    declaration.init ?? panic("GLOBAL_SYSTEM_JOBS initializer is missing"),
  );
  if (entries.type !== "ObjectExpression") {
    return panic("GLOBAL_SYSTEM_JOBS must remain a literal source map");
  }
  const owners = new Map<string, { readonly owner: string }>();
  for (const entry of entries.properties) {
    if (
      entry.type !== "Property" ||
      entry.kind !== "init" ||
      entry.computed ||
      entry.shorthand ||
      entry.method
    ) {
      return panic("GLOBAL_SYSTEM_JOBS entries must be literal records");
    }
    const type = staticPropertyName(entry);
    const value = unwrap(entry.value);
    if (
      type === undefined ||
      owners.has(type) ||
      value.type !== "ObjectExpression"
    ) {
      return panic("GLOBAL_SYSTEM_JOBS entries must be literal records");
    }
    const owner = objectProperty(value.properties, "owner")?.value;
    if (owner?.type !== "Literal" || typeof owner.value !== "string") {
      return panic(
        `GLOBAL_SYSTEM_JOBS owner for ${type} must be a string literal`,
      );
    }
    owners.set(type, { owner: owner.value });
  }
  return Object.fromEntries(owners);
};

const parseOwners = (root: string): GlobalSystemWorkOwners => {
  const file = path.join(root, jobSource);
  return parseGlobalSystemWorkOwners(readFileSync(file, "utf-8"), file);
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(file);
    }
    return /\.[cm]?tsx?$/u.test(entry.name) ? [file] : [];
  });

export const isGlobalSystemWorkTestSource = (file: string): boolean =>
  /(?:\.test|\.spec)\.[cm]?tsx?$/u.test(file) ||
  file.split(path.sep).includes("tests");

const resolvesToGlobalSystemWork = (
  importer: string,
  specifier: string,
): boolean => {
  let resolved: string;
  if (specifier.startsWith("@/api/")) {
    resolved = path.posix.join(
      "apps/api/src",
      specifier.slice("@/api/".length),
    );
  } else if (specifier.startsWith(".")) {
    resolved = path.posix.join(path.posix.dirname(importer), specifier);
  } else {
    return false;
  }
  return (
    resolved.replace(SUPPORTED_SOURCE_EXTENSION, "") ===
    GLOBAL_SYSTEM_WORK_MODULE_PATH
  );
};

const callType = (args: readonly Node[]): string => {
  if (args.length !== 2) {
    return panic(
      "runGlobalSystemWork requires exactly one literal job argument",
    );
  }
  const intent = unwrap(
    args[1] ?? panic("Global system job argument is missing"),
  );
  if (intent.type !== "ObjectExpression") {
    return panic("runGlobalSystemWork job must be a literal object");
  }
  const type = objectProperty(intent.properties, "type")?.value;
  if (type?.type !== "Literal" || typeof type.value !== "string") {
    return panic("runGlobalSystemWork requires a literal job type");
  }
  return type.value;
};

export const inspectGlobalSystemWorkSource = (
  owners: GlobalSystemWorkOwners,
  file: string,
  content: string,
): {
  readonly imported: boolean;
  readonly callSites: readonly GlobalSystemWorkCallSite[];
} => {
  const scan = findImportedFunctionCalls({
    content,
    exportName: "runGlobalSystemWork",
    file,
    modulePattern: (specifier) => resolvesToGlobalSystemWork(file, specifier),
  });
  const callSites = scan.calls.map(({ arguments: args }) => {
    const type = callType(args);
    const owner = owners[type]?.owner;
    if (owner === undefined) {
      return panic(`Unlisted global system job ${type} in ${file}`);
    }
    if (!isGlobalSystemWorkTestSource(file) && owner !== file) {
      return panic(
        `Global system job ${type} is called outside its owner ${owner}`,
      );
    }
    return { file, type };
  });
  if (scan.imported && callSites.length === 0) {
    panic(`${file} imports global system work without a direct call`);
  }
  return { imported: scan.imported, callSites };
};

export const globalSystemWorkAllowedImports = (root = repoRoot) => {
  const owners = parseOwners(root);
  const paths = [...new Set(Object.values(owners).map(({ owner }) => owner))];
  const tests = [...paths, jobSource]
    .flatMap((file) =>
      [".test.ts", ".postgres.test.ts", ".integration.test.ts"].map((suffix) =>
        file.replace(/\.ts$/u, () => suffix),
      ),
    )
    .filter(
      (file) =>
        existsSync(path.join(root, file)) &&
        inspectGlobalSystemWorkSource(
          owners,
          file,
          readFileSync(path.join(root, file), "utf-8"),
        ).imported,
    );
  return [
    ...paths.map((file) => ({
      path: file,
      reason: "Owns a listed literal global cleanup job.",
    })),
    ...tests.map((file) => ({
      path: file,
      reason: "Exercises the colocated global cleanup owner.",
    })),
  ];
};

export const readGlobalSystemWorkInventory = async (
  root = repoRoot,
): Promise<GlobalSystemWorkInventory> => {
  const owners = parseOwners(root);
  const results = await mapWithConcurrency({
    items: sourceFiles(path.join(root, API_SOURCE_ROOT)),
    limit: 32,
    operation: async (file) => {
      const relativeFile = repoRelativePath(root, file);
      return {
        file: relativeFile,
        ...inspectGlobalSystemWorkSource(
          owners,
          relativeFile,
          await readFile(file, "utf-8"),
        ),
      };
    },
  });
  return {
    owners,
    importers: results
      .filter(({ imported }) => imported)
      .map(({ file }) => file)
      .toSorted(compareCodeUnit),
    callSites: results
      .flatMap(({ callSites }) => callSites)
      .toSorted(
        (left, right) =>
          compareCodeUnit(left.file, right.file) ||
          compareCodeUnit(left.type, right.type),
      ),
  };
};
