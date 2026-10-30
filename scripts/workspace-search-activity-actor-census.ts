import { panic } from "better-result";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { mapWithConcurrency } from "@stll/concurrency";
import { repoRelativePath } from "@stll/portable-path";

import { findImportedFunctionCalls } from "./root-connection-shapes.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const API_SOURCE_ROOT = "apps/api/src";
const ACTOR_MODULE = "apps/api/src/lib/db/workspace-search-activity-actor";
const ACTOR_OWNER = "apps/api/src/lib/db/recovery-bookkeeping/search.ts";
const ACTOR_CONSTRUCTOR = "createWorkspaceSearchActivityActor";
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;

export type WorkspaceSearchActivityActorCallSite = {
  readonly file: string;
};

export type WorkspaceSearchActivityActorInventory = {
  readonly importers: readonly string[];
  readonly callSites: readonly WorkspaceSearchActivityActorCallSite[];
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(file);
    }
    return /\.[cm]?tsx?$/u.test(entry.name) ? [file] : [];
  });

const resolvesToActor = (importer: string, specifier: string): boolean => {
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
  return resolved.replace(SOURCE_EXTENSION, "") === ACTOR_MODULE;
};

export const inspectWorkspaceSearchActivityActorSource = (
  file: string,
  content: string,
): {
  readonly imported: boolean;
  readonly callSites: readonly WorkspaceSearchActivityActorCallSite[];
} => {
  const scan = findImportedFunctionCalls({
    content,
    exportName: ACTOR_CONSTRUCTOR,
    file,
    modulePattern: (specifier) => resolvesToActor(file, specifier),
  });
  const callSites = scan.calls.map(() => ({ file }));
  if (callSites.length > 0 && file !== ACTOR_OWNER) {
    panic(
      `${file} calls ${ACTOR_CONSTRUCTOR} outside its owner ${ACTOR_OWNER}`,
    );
  }
  if (scan.imported && callSites.length === 0) {
    panic(`${file} imports ${ACTOR_CONSTRUCTOR} without a direct call`);
  }
  return { imported: scan.imported, callSites };
};

export const readWorkspaceSearchActivityActorInventory = async (
  root = repoRoot,
): Promise<WorkspaceSearchActivityActorInventory> => {
  const results = await mapWithConcurrency({
    items: sourceFiles(path.join(root, API_SOURCE_ROOT)),
    limit: 32,
    operation: async (file) => {
      const relativeFile = repoRelativePath(root, file);
      return {
        file: relativeFile,
        ...inspectWorkspaceSearchActivityActorSource(
          relativeFile,
          await readFile(file, "utf-8"),
        ),
      };
    },
  });
  const inventory = {
    importers: results
      .filter(({ imported }) => imported)
      .map(({ file }) => file)
      .toSorted(compareCodeUnit),
    callSites: results
      .flatMap(({ callSites }) => callSites)
      .toSorted((left, right) => compareCodeUnit(left.file, right.file)),
  };
  if (
    inventory.importers.length !== 1 ||
    inventory.importers.at(0) !== ACTOR_OWNER ||
    inventory.callSites.length !== 1 ||
    inventory.callSites.at(0)?.file !== ACTOR_OWNER
  ) {
    return panic(
      "Workspace search actor constructor must remain private to its owner",
    );
  }
  return inventory;
};
