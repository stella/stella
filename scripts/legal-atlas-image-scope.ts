import { panic, Result } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  commandEntries,
  dockerInstructions,
  dockerPruneScopes,
  sourceClosureProblems,
  unresolvedRuntimeImports,
} from "./docker-source-closure";
import { lexShell } from "./install-free-ci";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = "apps/legal-atlas-runner/Dockerfile";
const MODULE = /\.[cm]?[jt]sx?$/u;
const API_MODULE = /^apps\/api\/src\/.+\.[cm]?[jt]sx?$/u;
const API_METADATA =
  /(?:^|\/)(?:tsconfig[^/]*|[^/]*\.config\.[cm]?[jt]sx?)$|\.d\.[cm]?ts$/u;

type LegalAtlasClosureOptions = {
  root?: string;
  trackedFiles?: readonly string[];
};

export const legalAtlasApiSourceClosure = ({
  root = ROOT,
  trackedFiles,
}: LegalAtlasClosureOptions = {}) => {
  const resolved = Result.try(() => {
    const tracked =
      trackedFiles ??
      (() => {
        const inventory = Bun.spawnSync(["git", "ls-files", "-z"], {
          cwd: root,
        });
        if (inventory.exitCode !== 0) {
          return undefined;
        }
        return inventory.stdout.toString().split("\0").filter(Boolean);
      })();
    if (tracked === undefined) {
      return {
        status: "unresolved",
        problems: ["Cannot enumerate image sources"],
      } as const;
    }
    const tree = new Map(tracked.map((file) => [`/app/${file}`, file]));
    const dockerfile = readFileSync(path.join(root, DOCKERFILE), "utf-8");
    const instructions = dockerInstructions(dockerfile);
    if (
      instructions.some(
        (instruction) =>
          instruction.startsWith("WORKDIR ") &&
          instruction.slice(8).trim() !== "/app",
      )
    ) {
      return {
        status: "unresolved",
        problems: ["Unknown image build working directory"],
      } as const;
    }
    const scopes = dockerPruneScopes(dockerfile);
    const owner = scopes.at(0)?.at(0);
    if (
      scopes.length !== 1 ||
      scopes.at(0)?.length !== 1 ||
      owner === undefined
    ) {
      return {
        status: "unresolved",
        problems: ["Unknown image build owner"],
      } as const;
    }
    // The Dockerfile chooses the build commands; package scripts choose their
    // entrypoints. Additional direct Bun build commands contribute roots too.
    const commands = instructions
      .filter((instruction) => instruction.startsWith("RUN "))
      .map((instruction) => instruction.slice(4));
    const ownerBuild = commands.some((command) =>
      lexShell(command).some(
        (event) =>
          event.type === "command" &&
          event.words.includes(owner) &&
          event.words.includes("build"),
      ),
    );
    const entries = commands.flatMap((command) =>
      lexShell(command).some(
        (event) =>
          event.type === "command" &&
          event.words.at(0) === "bun" &&
          event.words.includes("build"),
      )
        ? commandEntries(root, tree, command, "/app")
        : [],
    );
    if (!ownerBuild || entries.length === 0) {
      return {
        status: "unresolved",
        problems: ["Cannot derive image build entrypoints"],
      } as const;
    }
    const seen = new Set<string>();
    const problems = sourceClosureProblems(root, tree, entries, seen);
    for (const file of seen) {
      const origin = tree.get(file);
      if (origin === undefined || !MODULE.test(file)) {
        continue;
      }
      problems.push(
        ...unresolvedRuntimeImports(
          origin,
          readFileSync(path.join(root, origin), "utf-8"),
        ),
      );
    }
    if (problems.length > 0) {
      return { status: "unresolved", problems } as const;
    }
    return {
      status: "resolved",
      files: new Set([...seen].map((file) => file.slice("/app/".length))),
    } as const;
  });
  if (resolved.isErr()) {
    return {
      status: "unresolved",
      problems: ["Cannot resolve image source closure"],
    } as const;
  }
  return resolved.value;
};

export const legalAtlasApiSourcePredicate = (
  options: LegalAtlasClosureOptions = {},
) => {
  let closure: ReturnType<typeof legalAtlasApiSourceClosure> | undefined;
  return (changed: readonly string[]): boolean => {
    if (changed.length === 0) {
      return false;
    }
    // Narrow only API implementation modules. Existing image scopes continue
    // to own every other source, manifest, config, asset and tooling input.
    if (
      changed.some((file) => !API_MODULE.test(file) || API_METADATA.test(file))
    ) {
      return true;
    }
    closure ??= legalAtlasApiSourceClosure(options);
    const currentClosure = closure;
    switch (currentClosure.status) {
      case "unresolved":
        return true;
      case "resolved":
        return changed.some((file) => currentClosure.files.has(file));
      default:
        currentClosure satisfies never;
        return panic("Unknown legal-atlas source closure status");
    }
  };
};

type LegalAtlasApiSourceOptions = LegalAtlasClosureOptions & {
  changed: readonly string[];
};

export const legalAtlasApiSourceRequired = ({
  changed,
  ...options
}: LegalAtlasApiSourceOptions): boolean =>
  legalAtlasApiSourcePredicate(options)(changed);

if (import.meta.main) {
  console.log(legalAtlasApiSourceRequired({ changed: process.argv.slice(2) }));
}
