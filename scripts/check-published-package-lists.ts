#!/usr/bin/env bun

// The published-package lists in prose are rendered, not maintained.
//
// `scripts/changeset-policy.json` already names every release-gated package;
// `CONTRIBUTING.md` and `.changeset/README.md` used to repeat that set by hand
// and had both drifted, so a contributor reading either one was told a package
// needed no changeset when CI would demand one. Both lists now render from
// `releasePaths` between marker comments, and `--check` fails when either file
// is stale.
//
//   bun scripts/check-published-package-lists.ts --check | --write

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadChangesetPolicy } from "./changeset-guard";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const START_MARKER = "<!-- published-packages:start -->";
const END_MARKER = "<!-- published-packages:end -->";
const GENERATED_NOTE =
  "<!-- Rendered from scripts/changeset-policy.json by `bun scripts/check-published-package-lists.ts --write`. Do not edit by hand. -->";

/** The prose files whose package list this script owns. */
const RENDERED_FILES = ["CONTRIBUTING.md", ".changeset/README.md"] as const;

class PublishedPackageListError extends Error {
  readonly _tag = "PublishedPackageListError";

  constructor(message: string) {
    super(message);
    this.name = "PublishedPackageListError";
  }
}

/**
 * A release path is `packages/<name>/<something>`, so the package set is the
 * second segment. Apps are not published and never appear in `releasePaths`.
 */
export const publishedPackageNames = (
  releasePaths: readonly string[],
): readonly string[] => {
  const names = new Set<string>();
  for (const releasePath of releasePaths) {
    const [workspace, name] = releasePath.split("/");
    if (workspace === "packages" && name !== undefined && name.length > 0) {
      names.add(name);
    }
  }
  return [...names].sort();
};

export const renderPublishedPackageBlock = (
  releasePaths: readonly string[],
): string => {
  const names = publishedPackageNames(releasePaths);
  if (names.length === 0) {
    throw new PublishedPackageListError(
      "changeset policy names no published package; refusing to render an empty list",
    );
  }
  return [
    START_MARKER,
    GENERATED_NOTE,
    "",
    ...names.map((name) => `- \`@stll/${name}\``),
    "",
    END_MARKER,
  ].join("\n");
};

export const replacePublishedPackageBlock = ({
  contents,
  file,
  block,
}: {
  readonly contents: string;
  readonly file: string;
  readonly block: string;
}): string => {
  const start = contents.indexOf(START_MARKER);
  const end = contents.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new PublishedPackageListError(
      `${file}: expected one ${START_MARKER} ... ${END_MARKER} region`,
    );
  }
  return (
    contents.slice(0, start) + block + contents.slice(end + END_MARKER.length)
  );
};

type RenderedFile = {
  readonly file: string;
  readonly committed: string;
  readonly rendered: string;
};

const renderFiles = (root: string): readonly RenderedFile[] => {
  const block = renderPublishedPackageBlock(
    loadChangesetPolicy(root).releasePaths,
  );
  return RENDERED_FILES.map((file) => {
    const committed = readFileSync(path.join(root, file), "utf-8");
    return {
      committed,
      file,
      rendered: replacePublishedPackageBlock({
        block,
        contents: committed,
        file,
      }),
    };
  });
};

const main = (argv: readonly string[]): number => {
  const write = argv.includes("--write");
  if (!write && !argv.includes("--check")) {
    console.error(
      "Usage: bun scripts/check-published-package-lists.ts --check | --write",
    );
    return 1;
  }

  const files = renderFiles(REPO_ROOT);
  if (write) {
    for (const { file, rendered } of files) {
      writeFileSync(path.join(REPO_ROOT, file), rendered);
    }
    console.log(
      `published package lists: wrote ${RENDERED_FILES.join(", ")} from scripts/changeset-policy.json.`,
    );
    return 0;
  }

  const stale = files.filter(
    ({ committed, rendered }) => committed !== rendered,
  );
  if (stale.length > 0) {
    console.error("Published package lists are stale:");
    for (const { file } of stale) {
      console.error(`- ${file}`);
    }
    console.error("fix: bun scripts/check-published-package-lists.ts --write");
    return 1;
  }

  console.log(
    `published package lists: OK (${RENDERED_FILES.join(", ")} current).`,
  );
  return 0;
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
