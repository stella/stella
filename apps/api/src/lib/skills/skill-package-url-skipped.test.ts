import { Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type { SafeOutboundFetchResponse } from "@/api/lib/safe-outbound-fetch";
import {
  createSkillPackageFetchContext,
  fetchSkillPackageFromUrl,
  SKIPPED_SKILL_FILE_REASON,
} from "@/api/lib/skills/skill-package";

// URL and GitHub imports keep the same files a zip upload keeps: files outside
// the resource folders or with other extensions are never downloaded, and a
// resource that is not UTF-8 text is left out; both are reported.

const COMMIT_SHA = "a".repeat(40);
const SKILL_TREE_SHA = "b".repeat(40);
const SKILL_SOURCE = `---
name: skipped-files
description: A skill folder with files the skill cannot keep.
---

Instructions.`;
const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);

// One listing per tree sha, paths relative to that tree.
const TREES: Record<string, { path: string; sha?: string; type: string }[]> = {
  [COMMIT_SHA]: [{ path: "skill", sha: SKILL_TREE_SHA, type: "tree" }],
  [SKILL_TREE_SHA]: [
    { path: "SKILL.md", type: "blob" },
    { path: "README.md", type: "blob" },
    { path: "scripts", sha: "1".repeat(40), type: "tree" },
    { path: "references", sha: "2".repeat(40), type: "tree" },
    { path: "assets", sha: "3".repeat(40), type: "tree" },
    { path: "notes", sha: "4".repeat(40), type: "tree" },
  ],
  ["1".repeat(40)]: [{ path: "helper.ts", type: "blob" }],
  ["2".repeat(40)]: [{ path: "latin1.txt", type: "blob" }],
  ["3".repeat(40)]: [{ path: "logo.png", type: "blob" }],
  ["4".repeat(40)]: [{ path: "todo.md", type: "blob" }],
};

let requestedRawPaths: string[] = [];

const respond = (
  body: string | Uint8Array,
  contentType = "application/json",
): Result<SafeOutboundFetchResponse, never> => {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  return Result.ok({
    body: bytes.slice().buffer,
    headers: new Headers({ "content-type": contentType }),
    ok: true,
    status: 200,
  });
};

const serveGithub: Parameters<
  typeof createSkillPackageFetchContext
>[1] = async ({ url }) => {
  const requestUrl = typeof url === "string" ? new URL(url) : url;
  if (requestUrl.hostname === "raw.githubusercontent.com") {
    const path = requestUrl.pathname.split(`/${COMMIT_SHA}/`).at(1) ?? "";
    requestedRawPaths.push(path);
    if (path.endsWith("SKILL.md")) {
      return respond(SKILL_SOURCE, "text/markdown");
    }
    if (path.endsWith("latin1.txt")) {
      return respond(NOT_UTF8, "text/plain");
    }
    return respond("export const helper = true;", "text/plain");
  }
  if (requestUrl.pathname.includes("/git/trees/")) {
    const treeish = requestUrl.pathname.split("/").at(-1) ?? "";
    return respond(JSON.stringify({ tree: TREES[treeish] ?? [] }));
  }
  return respond(JSON.stringify({ default_branch: "main" }));
};

const fetchContext = (
  serve: Parameters<typeof createSkillPackageFetchContext>[1],
) =>
  createSkillPackageFetchContext(
    { deadlineAt: Date.now() + 30_000, maxRequests: 100 },
    serve,
  );

const byPath = <T extends { path: string }>(items: readonly T[]) =>
  items.toSorted((a, b) => (a.path < b.path ? -1 : 1));

beforeEach(() => {
  requestedRawPaths = [];
});

describe("files a URL import leaves out", () => {
  test("a GitHub skill skips files it cannot keep before downloading them and reports them", async () => {
    const result = await fetchSkillPackageFromUrl(
      `https://github.com/example/skills/blob/${COMMIT_SHA}/skill/SKILL.md`,
      fetchContext(serveGithub),
    );

    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.resources.map(({ path }) => path)).toEqual([
      "scripts/helper.ts",
    ]);
    // Folders that hold no resources (notes/) are never listed.
    expect(byPath(result.value.skippedFiles)).toEqual([
      {
        path: "README.md",
        reason: SKIPPED_SKILL_FILE_REASON.UNSUPPORTED_FOLDER,
      },
      {
        path: "assets/logo.png",
        reason: SKIPPED_SKILL_FILE_REASON.UNSUPPORTED_EXTENSION,
      },
      {
        path: "references/latin1.txt",
        reason: SKIPPED_SKILL_FILE_REASON.NOT_UTF8_TEXT,
      },
    ]);
    expect(requestedRawPaths.toSorted()).toEqual([
      "skill/SKILL.md",
      "skill/references/latin1.txt",
      "skill/scripts/helper.ts",
    ]);
  });

  test("a zip package at a URL reports the files it leaves out", async () => {
    const zip = new JSZip();
    zip.file("pack/SKILL.md", SKILL_SOURCE);
    zip.file("pack/scripts/helper.ts", "export const helper = true;");
    zip.file("pack/references/latin1.txt", NOT_UTF8);
    zip.file("pack/notes/todo.md", "Later.");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const result = await fetchSkillPackageFromUrl(
      "https://skills.example/pack.zip",
      fetchContext(async () => respond(bytes, "application/zip")),
    );

    if (Result.isError(result)) {
      throw result.error;
    }
    expect(byPath(result.value.skippedFiles)).toEqual([
      {
        path: "pack/notes/todo.md",
        reason: SKIPPED_SKILL_FILE_REASON.UNSUPPORTED_FOLDER,
      },
      {
        path: "pack/references/latin1.txt",
        reason: SKIPPED_SKILL_FILE_REASON.NOT_UTF8_TEXT,
      },
    ]);
  });

  test("a single SKILL.md at a URL leaves nothing out", async () => {
    const result = await fetchSkillPackageFromUrl(
      "https://skills.example/skill/SKILL.md",
      fetchContext(async () => respond(SKILL_SOURCE, "text/markdown")),
    );

    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.skippedFiles).toEqual([]);
  });
});
