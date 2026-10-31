/**
 * Every module in the API that talks to GitHub is found by a scan. Exactly one
 * of them writes: the write helper (`github-write.ts`), whose body type admits
 * only values the outbound owner (`outbound-text.ts`) produced. Every other
 * module that talks to GitHub is listed below as a reader, with the reason. A
 * second writer fails this test whatever it imports, so a raw string can only
 * reach GitHub through a body type that rejects it.
 *
 * "Talks to GitHub" is any source naming the REST host or an Octokit package.
 * "Writes" is any request whose method is not a literal GET or HEAD, any
 * dynamic method, or any Octokit use. `githubMarkdown` builds bodies from
 * literals, so it may only be called as a template tag.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  isObjectLiteralProperty,
  type Node,
  type ObjectProperty,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const API_ROOT = path.resolve(import.meta.dir, "../../..");
const OWNER_IMPORT = "@/api/lib/github/outbound-text";
/** The one module allowed to write to GitHub. */
const WRITER = "src/lib/github/github-write.ts";
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
  /** `githubMarkdown` references that are not a template tag, as line numbers. */
  untaggedMarkdown: number[];
};

const propertyName = (property: ObjectProperty): string | undefined => {
  if (property.computed) {
    return undefined;
  }
  if (property.key.type === "Identifier") {
    return property.key.name;
  }
  return property.key.type === "Literal" &&
    typeof property.key.value === "string"
    ? property.key.value
    : undefined;
};

const literalText = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

const scanGithubModule = (file: string, source: string): GithubModule => {
  const parsed = parseSource(file, source);
  const result: GithubModule = {
    file,
    talksToGithub: GITHUB_HOST.test(source),
    writes: /@octokit\//u.test(source),
    untaggedMarkdown: [],
  };
  const untagged = new Set<number>();
  walk(parsed.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (
      isObjectLiteralProperty(node, parent) &&
      node.kind === "init" &&
      !node.method &&
      propertyName(node) === "method"
    ) {
      if (node.shorthand) {
        result.writes = true;
      } else {
        const literal = literalText(node.value)?.toUpperCase();
        if (literal === undefined || !READ_METHODS.has(literal)) {
          result.writes = true;
        }
      }
    }
    if (node.type === "Identifier" && node.name === "githubMarkdown") {
      const isTag =
        parent?.type === "TaggedTemplateExpression" && parent.tag === node;
      const isImport =
        parent?.type === "ImportSpecifier" ||
        parent?.type === "ExportSpecifier";
      // The owner's own definition of the tag.
      const isDefinition =
        parent?.type === "VariableDeclarator" && parent.id === node;
      // A shorthand property carries the name as both key and value.
      if (!isTag && !isImport && !isDefinition && !untagged.has(node.start)) {
        untagged.add(node.start);
        result.untaggedMarkdown.push(parsed.locate(node.start).line);
      }
    }
  });
  return result;
};

const apiSources = async (): Promise<GithubModule[]> =>
  await Promise.all(
    [
      ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: API_ROOT }),
      ...new Bun.Glob("scripts/**/*.ts").scanSync({ cwd: API_ROOT }),
    ]
      .filter((file) => !/\.(?:test|spec|d)\.ts$/u.test(file))
      .toSorted()
      .map(async (file) =>
        scanGithubModule(
          file,
          await Bun.file(path.join(API_ROOT, file)).text(),
        ),
      ),
  );

/** Modules that write to GitHub without being the write helper. */
const strayWriters = (modules: readonly GithubModule[]): string[] =>
  modules
    .filter(
      (module) =>
        module.talksToGithub && module.writes && module.file !== WRITER,
    )
    .map((module) => module.file);

describe("GitHub outbound text guard", () => {
  test("only the write helper writes to GitHub; every reader is listed", async () => {
    const modules = await apiSources();
    const github = modules.filter((module) => module.talksToGithub);

    // Not vacuous: the write helper is found, and found as a writer.
    expect(
      github
        .filter((module) => module.file === WRITER)
        .map(({ file, writes }) => ({ file, writes })),
    ).toEqual([{ file: WRITER, writes: true }]);
    expect(strayWriters(modules)).toEqual([]);
    expect(
      github.filter((module) => !module.writes).map((module) => module.file),
    ).toEqual(Object.keys(NO_USER_TEXT).toSorted());
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
    ).toMatchObject({ talksToGithub: true, writes: true });
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

  test("a raw-string write outside the helper is refused, whatever it imports", () => {
    const rawPost = scanGithubModule(
      "src/handlers/x/raw.ts",
      [
        `import "${OWNER_IMPORT}";`,
        `import type { GithubSafeText } from "${OWNER_IMPORT}";`,
        host,
        'fetch(url, { method: "POST", body: JSON.stringify({ title }) });',
      ].join("\n"),
    );
    const octokit = scanGithubModule(
      "src/handlers/x/octokit.ts",
      'import { Octokit } from "@octokit/rest"; new Octokit().rest.issues.create({ title });',
    );
    const reader = scanGithubModule(
      "src/handlers/x/read.ts",
      `${host} fetch(url, { method: "GET" });`,
    );
    const helper = scanGithubModule(
      WRITER,
      `${host} fetch(url, { method: request.method });`,
    );
    expect(strayWriters([rawPost, octokit, reader, helper])).toEqual([
      "src/handlers/x/raw.ts",
      "src/handlers/x/octokit.ts",
    ]);
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
