import { Generator, getConfig } from "@tanstack/router-generator";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROUTE_TREE_OPTIONS } from "../route-tree.config";

const ROUTES_PREFIX = `apps/web/${ROUTE_TREE_OPTIONS.srcDirectory}/${ROUTE_TREE_OPTIONS.routesDirectory}/`;
const MAX_ROUTE_BYTES = 20 * 1024 * 1024;
const MAX_ROUTE_FILES = 5000;

const fail: (message: string) => never = (message) => {
  process.stderr.write(`network-baseline-route-tree: ${message}\n`);
  process.exit(1);
};

const git = (repository: string, args: string[]) => {
  const child = Bun.spawnSync(["git", "-C", repository, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!child.success) {
    fail(`git ${args.join(" ")} failed: ${child.stderr.toString()}`);
  }
  return child.stdout;
};

// A blob-filtered checkout holds only the checked-out revision's blobs. Reading
// another revision then fetches each blob separately; one batched fetch of the
// missing blobs replaces a network round trip per route file.
const prefetchMissingBlobs = (repository: string, blobs: readonly string[]) => {
  if (blobs.length === 0) {
    return;
  }
  const encoder = new TextEncoder();
  const check = Bun.spawnSync(
    ["git", "-C", repository, "cat-file", "--batch-check=%(objectname)"],
    {
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdin: encoder.encode(`${blobs.join("\n")}\n`),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!check.success) {
    fail(`git cat-file --batch-check failed: ${check.stderr.toString()}`);
  }
  const missing = check.stdout
    .toString()
    .split("\n")
    .flatMap((line) => /^([a-f0-9]{40}) missing$/u.exec(line)?.[1] ?? []);
  if (missing.length === 0) {
    return;
  }
  const fetch = Bun.spawnSync(
    [
      "git",
      "-C",
      repository,
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
      "origin",
    ],
    {
      stdin: encoder.encode(`${missing.join("\n")}\n`),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!fetch.success) {
    fail(
      `fetching ${String(missing.length)} route sources failed: ${fetch.stderr.toString()}`,
    );
  }
};

type GenerateRevisionRouteTreeOptions = {
  repository: string;
  revision: string;
  output: string;
};

export const generateRevisionRouteTree = async ({
  repository,
  revision,
  output,
}: GenerateRevisionRouteTreeOptions): Promise<void> => {
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    fail("revision must be a full commit SHA");
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "baseline-routes-"));
  try {
    const srcRoot = path.join(directory, ROUTE_TREE_OPTIONS.srcDirectory);
    const routesRoot = path.join(srcRoot, ROUTE_TREE_OPTIONS.routesDirectory);
    mkdirSync(routesRoot, { recursive: true });
    const entries = git(repository, [
      "ls-tree",
      "-rz",
      revision,
      "--",
      ROUTES_PREFIX,
    ]);
    const listing = entries.toString().split("\0").filter(Boolean);
    if (listing.length > MAX_ROUTE_FILES) {
      fail("route sources exceed the file limit");
    }
    prefetchMissingBlobs(
      repository,
      listing.flatMap(
        (entry) =>
          /^(?:100644|100755) blob ([a-f0-9]{40})\t/u.exec(entry)?.[1] ?? [],
      ),
    );
    let bytes = 0;
    let files = 0;
    for (const entry of listing) {
      files += 1;
      if (files > MAX_ROUTE_FILES) {
        fail("route sources exceed the file limit");
      }
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
      const blob = match?.[2];
      const file = match?.[3];
      if (!blob || !file || !file.startsWith(ROUTES_PREFIX)) {
        fail("route tree may contain only regular files");
      }
      const relative = file.slice(ROUTES_PREFIX.length);
      if (
        relative
          .split("/")
          .some((part) => part === ".." || part === "." || part === "")
      ) {
        fail("invalid route source path");
      }
      // TanStack executes virtual route configuration. Physical route modules
      // are parsed as data; reject every executable configuration entry point.
      if (/__virtual\.[mc]?[jt]s$/u.test(relative)) {
        fail("virtual route configuration cannot be evaluated from a revision");
      }
      const size = Number(git(repository, ["cat-file", "-s", blob]).toString());
      if (!Number.isSafeInteger(size) || size < 0) {
        fail("invalid route source size");
      }
      bytes += size;
      if (bytes > MAX_ROUTE_BYTES) {
        fail("route sources exceed the size limit");
      }
      const contents = git(repository, ["cat-file", "blob", blob]);
      const destination = path.join(routesRoot, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    const generatedRouteTree = path.join(
      srcRoot,
      ROUTE_TREE_OPTIONS.generatedRouteTree,
    );
    // Only trusted options and defaults enter the generator. This fresh root
    // contains no revision-supplied tsr.config.json, plugins, or node_modules.
    const config = getConfig(
      { routesDirectory: routesRoot, generatedRouteTree },
      directory,
    );
    await new Generator({ config, root: directory }).run();
    writeFileSync(output, readFileSync(generatedRouteTree));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const [repository, revision, output, ...extra] = Bun.argv.slice(2);
  if (!repository || !revision || !output || extra.length > 0) {
    fail(
      "Usage: bun apps/web/scripts/network-baseline-route-tree.ts REPOSITORY SHA OUTPUT",
    );
  }
  await generateRevisionRouteTree({ repository, revision, output });
}
