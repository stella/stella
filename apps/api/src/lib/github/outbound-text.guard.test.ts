/**
 * Every module in the API that talks to GitHub is found by a scan, and each
 * one either writes through the outbound owner (`outbound-text.ts`) or is
 * listed below as sending no user text, with the reason. A listed module that
 * starts writing, or a new module that talks to GitHub, fails this test.
 *
 * "Talks to GitHub" is any source naming the REST host or an Octokit package.
 * "Writes" is any request whose method is not a literal GET or HEAD, any
 * dynamic method, or any Octokit use. `githubMarkdown` builds bodies from
 * literals, so it may only be called as a template tag.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

const API_ROOT = path.resolve(import.meta.dir, "../../..");
const OWNER = "src/lib/github/outbound-text.ts";
const OWNER_IMPORT = "@/api/lib/github/outbound-text";
const GITHUB_HOST = /api\.github\.com|@octokit\//u;
const READ_METHODS = new Set(["GET", "HEAD"]);

/** Modules that reach GitHub only to read; each says why no user text leaves. */
const NO_USER_TEXT: Readonly<Record<string, string>> = {
  "src/lib/skills/skill-package.ts":
    "reads refs, commits and trees of a skill repository; GET requests with no body",
};

type GithubModule = {
  file: string;
  talksToGithub: boolean;
  writes: boolean;
  importsOwner: boolean;
  /** `githubMarkdown` references that are not a template tag, as line numbers. */
  untaggedMarkdown: number[];
};

const propertyName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

const scanGithubModule = (file: string, source: string): GithubModule => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result: GithubModule = {
    file,
    talksToGithub: GITHUB_HOST.test(source),
    writes: /@octokit\//u.test(source),
    importsOwner: false,
    untaggedMarkdown: [],
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === OWNER_IMPORT
    ) {
      result.importsOwner = true;
      return;
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "method") {
      const value = node.initializer;
      const literal =
        ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
          ? value.text.toUpperCase()
          : undefined;
      if (literal === undefined || !READ_METHODS.has(literal)) {
        result.writes = true;
      }
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "method") {
      result.writes = true;
    }
    if (ts.isIdentifier(node) && node.text === "githubMarkdown") {
      const parent = node.parent;
      const isTag =
        ts.isTaggedTemplateExpression(parent) && parent.tag === node;
      const isImport =
        ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
      if (!isTag && !isImport) {
        result.untaggedMarkdown.push(
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
};

const apiSources = async (): Promise<GithubModule[]> =>
  await Promise.all(
    [
      ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: API_ROOT }),
      ...new Bun.Glob("scripts/**/*.ts").scanSync({ cwd: API_ROOT }),
    ]
      .filter((file) => !/\.(?:test|spec|d)\.ts$/u.test(file) && file !== OWNER)
      .toSorted()
      .map(async (file) =>
        scanGithubModule(
          file,
          await Bun.file(path.join(API_ROOT, file)).text(),
        ),
      ),
  );

describe("GitHub outbound text guard", () => {
  test("every GitHub writer goes through the owner; every reader is listed", async () => {
    const modules = await apiSources();
    const github = modules.filter((module) => module.talksToGithub);
    const writers = github.filter((module) => module.writes);
    const readers = github.filter((module) => !module.writes);

    // Not vacuous: the feedback issue writer is found as a writer.
    expect(writers.map((module) => module.file)).toContain(
      "src/handlers/feedback/github-delivery.ts",
    );
    expect(
      writers
        .filter((module) => !module.importsOwner)
        .map((module) => module.file),
    ).toEqual([]);
    expect(writers.filter((module) => module.file in NO_USER_TEXT)).toEqual([]);
    expect(readers.map((module) => module.file)).toEqual(
      Object.keys(NO_USER_TEXT).toSorted(),
    );
  });

  test("githubMarkdown is only ever a template tag", async () => {
    const modules = await apiSources();
    expect(
      modules
        .filter((module) => module.untaggedMarkdown.length > 0)
        .map(({ file, untaggedMarkdown }) => ({ file, untaggedMarkdown })),
    ).toEqual([]);
  });
});

describe("scanGithubModule", () => {
  const host = 'const url = "https://api.github.com/repos/o/r/issues";';

  test("classifies requests by method", () => {
    expect(
      scanGithubModule("a.ts", `${host} fetch(url, { method: "POST" });`),
    ).toMatchObject({ talksToGithub: true, writes: true, importsOwner: false });
    expect(
      scanGithubModule("a.ts", `${host} fetch(url, { method: "get" });`),
    ).toMatchObject({ talksToGithub: true, writes: false });
    expect(scanGithubModule("a.ts", `${host} fetch(url);`)).toMatchObject({
      writes: false,
    });
    expect(
      scanGithubModule("a.ts", `${host} fetch(url, { method: verb });`),
    ).toMatchObject({ writes: true });
    expect(
      scanGithubModule("a.ts", `${host} fetch(url, { method });`),
    ).toMatchObject({ writes: true });
    expect(
      scanGithubModule("a.ts", 'import { Octokit } from "@octokit/rest";'),
    ).toMatchObject({ talksToGithub: true, writes: true });
    expect(
      scanGithubModule(
        "a.ts",
        'fetch("https://example.test", { method: "POST" });',
      ),
    ).toMatchObject({ talksToGithub: false });
  });

  test("sees the owner import", () => {
    expect(
      scanGithubModule(
        "a.ts",
        `import type { GithubSafeText } from "${OWNER_IMPORT}"; ${host}`,
      ),
    ).toMatchObject({ importsOwner: true });
  });

  test("flags githubMarkdown used other than as a tag", () => {
    expect(
      scanGithubModule(
        "a.ts",
        [
          `import { githubMarkdown } from "${OWNER_IMPORT}";`,
          "githubMarkdown`ok`;",
          "githubMarkdown(Object.assign([text], { raw: [text] }));",
          "const alias = githubMarkdown;",
        ].join("\n"),
      ).untaggedMarkdown,
    ).toEqual([3, 4]);
  });
});
