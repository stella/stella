import { panic } from "better-result";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import { isAstNode, isIdentifier } from "./utils.ts";

const REPLAY_ENTRYPOINTS = [
  "apps/api/src/handlers/case-law/ingestion/pipeline.ts",
  "apps/api/src/handlers/case-law/ingestion/replay.ts",
  "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts",
  "apps/api/src/handlers/case-law/ingestion/eu-completion-store.ts",
  "apps/api/src/handlers/case-law/ingestion/cz-us-judges-backfill.ts",
  "apps/api/src/handlers/case-law/ingestion/listing-census.ts",
  "apps/api/src/handlers/case-law/ingestion/supplement-erasure.ts",
  "apps/api/src/lib/case-law/provision-state-backfill/backfill.ts",
  "apps/api/src/scripts/replay-case-law-source.ts",
];

/** Follow value imports rather than assigning write ownership by directory. */
export const replayImportClosure = (root: string) => {
  const found = new Set<string>();
  const pending = [...REPLAY_ENTRYPOINTS];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (relative === undefined || found.has(relative)) {
      continue;
    }
    const absolute = path.join(root, relative);
    const source = readFileSync(absolute, "utf-8");
    found.add(relative);
    const { program, errors } = parseSync(relative, source, {
      sourceType: "module",
      range: true,
    });
    if (errors.length > 0) {
      panic(`Cannot parse replay import ${relative}`);
    }
    const modules: string[] = [];
    for (const statement of program.body) {
      if (
        statement.type === "ImportDeclaration" &&
        statement.importKind !== "type"
      ) {
        modules.push(statement.source.value);
      }
      if (
        (statement.type === "ExportNamedDeclaration" ||
          statement.type === "ExportAllDeclaration") &&
        statement.exportKind !== "type" &&
        statement.source
      ) {
        modules.push(statement.source.value);
      }
    }
    const dynamicImports = (node: unknown): void => {
      if (!isAstNode(node)) {
        return;
      }
      if (node.type === "ImportExpression") {
        if (
          !isAstNode(node.source) ||
          node.source.type !== "Literal" ||
          typeof node.source.value !== "string"
        ) {
          panic(
            `Replay import in ${relative} must have a static module identity`,
          );
        }
        modules.push(node.source.value);
      }
      if (
        node.type === "CallExpression" &&
        isIdentifier(node.callee, "require") &&
        Array.isArray(node.arguments)
      ) {
        const argument = node.arguments.at(0);
        if (
          !isAstNode(argument) ||
          argument.type !== "Literal" ||
          typeof argument.value !== "string"
        ) {
          panic(
            `Replay require in ${relative} must have a static module identity`,
          );
        }
        modules.push(argument.value);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "parent") {
          continue;
        }
        if (Array.isArray(value)) {
          for (const child of value) {
            dynamicImports(child);
          }
        } else {
          dynamicImports(value);
        }
      }
    };
    dynamicImports(program);
    for (const specifier of modules) {
      if (specifier.startsWith("@stll/")) {
        const resolved = realpathSync(
          fileURLToPath(import.meta.resolve(specifier)),
        );
        const workspace = repoRelativePath(root, resolved);
        if (isPathInside(root, resolved)) {
          pending.push(workspace);
        }
        continue;
      }
      const base = specifier.startsWith("@/api/")
        ? path.join(root, "apps/api/src", specifier.slice("@/api/".length))
        : specifier.startsWith(".")
          ? path.resolve(path.dirname(absolute), specifier)
          : null;
      if (base === null) {
        continue;
      }
      if (/\.(?:json|md|wasm|node)$/u.test(base)) {
        if (!existsSync(base)) {
          panic(
            `Replay asset import ${specifier} from ${relative} cannot be resolved`,
          );
        }
        continue;
      }
      const sourceBase = base.replace(/\.(?:js|mjs|cjs)$/u, "");
      const candidates = [
        base,
        ...["ts", "tsx", "mts", "cts"].flatMap((extension) => [
          `${sourceBase}.${extension}`,
          path.join(base, `index.${extension}`),
        ]),
      ];
      const target = candidates.find(
        (candidate) =>
          /\.[cm]?[jt]sx?$/u.test(candidate) && existsSync(candidate),
      );
      if (target === undefined) {
        panic(`Replay import ${specifier} from ${relative} cannot be resolved`);
      }
      pending.push(repoRelativePath(root, target));
    }
  }
  return found;
};
