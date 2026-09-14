import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkTestInputCoverage,
  classifyTarget,
  expandBraces,
  literalTargets,
  matchesRootInput,
  readStringLiterals,
  readTestInputs,
} from "./check-test-input-coverage.ts";
import { scopeFilters } from "./test-scope.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const write = (root: string, file: string, contents: string) => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
};

type Fixture = {
  /** turbo.json `tasks` entries, keyed by task id. */
  readonly tasks: Record<string, { readonly inputs: readonly string[] }>;
  readonly files: Record<string, string>;
};

/**
 * A miniature repository: two apps, one package `alpha` depends on, and a root
 * config file that tests read.
 */
const createRoot = ({ files, tasks }: Fixture): string => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-test-inputs-"));
  roots.push(root);

  write(
    root,
    "turbo.json",
    JSON.stringify({
      // A comment is legal in turbo.json, so the parser must tolerate one.
      tasks: { test: { inputs: ["$TURBO_DEFAULT$"] }, ...tasks },
    }),
  );
  write(root, "lint.config.ts", "export default {};\n");
  write(
    root,
    "apps/alpha/package.json",
    JSON.stringify({
      dependencies: { "@stll/shared": "workspace:*" },
      name: "@stll/alpha",
    }),
  );
  write(root, "apps/beta/package.json", JSON.stringify({ name: "@stll/beta" }));
  write(
    root,
    "packages/shared/package.json",
    JSON.stringify({ name: "@stll/shared" }),
  );
  write(root, "apps/beta/src/route.ts", "export const route = 1;\n");
  write(root, "packages/shared/src/index.ts", "export const shared = 1;\n");
  for (const [file, contents] of Object.entries(files)) {
    write(root, file, contents);
  }
  return root;
};

describe("string literals", () => {
  test("tags each literal with the innermost enclosing call", () => {
    const literals = readStringLiterals(
      'readFileSync(path.join(root, "apps/beta/src/route.ts"));\n' +
        'expect(source).toContain("apps/beta/src/route.ts");\n',
    );

    expect(literals).toEqual([
      { callee: "join", line: 1, value: "apps/beta/src/route.ts" },
      { callee: "toContain", line: 2, value: "apps/beta/src/route.ts" },
    ]);
  });

  test("skips comments, regular expressions, and JSX prose", () => {
    const literals = readStringLiterals(
      '// read("apps/beta/commented.ts")\n' +
        "const pattern = /[\"']apps\\/beta[\"']/u;\n" +
        "const node = <p>don't read apps/beta</p>;\n" +
        'read("apps/beta/real.ts");\n',
    );

    expect(literals.map(({ value }) => value)).toEqual(["apps/beta/real.ts"]);
  });

  test("drops a template literal that is built at run time", () => {
    const literals = readStringLiterals(
      `read(\`apps/\${name}/src/route.ts\`);\nread(\`apps/beta/src/route.ts\`);\n`,
    );

    expect(literals.map(({ value }) => value)).toEqual([
      "apps/beta/src/route.ts",
    ]);
  });
});

describe("literal targets", () => {
  test("expands brace alternatives", () => {
    expect(expandBraces("{apps,packages}/**/*.test.{ts,tsx}")).toEqual([
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
    ]);
  });

  test("reduces a glob to the tree it scans", () => {
    expect(literalTargets("{apps,packages}/**/*.test.ts")).toEqual([
      { fromGlob: true, path: "apps" },
      { fromGlob: true, path: "packages" },
    ]);
  });

  test("a wildcard with no directory before it names no path", () => {
    expect(literalTargets("**/*.ts")).toEqual([]);
    expect(literalTargets("apps*")).toEqual([]);
  });

  test("keeps a plain path as itself", () => {
    expect(literalTargets("apps/beta/src/route.ts")).toEqual([
      { fromGlob: false, path: "apps/beta/src/route.ts" },
    ]);
  });
});

describe("target classification", () => {
  const root = createRoot({ files: {}, tasks: {} });
  const classify = (candidate: string, fromGlob = false) =>
    classifyTarget({
      candidate: { fromGlob, path: candidate },
      packageDir: "apps/alpha",
      root,
      testDir: "apps/alpha/src",
    });

  test("resolves against the package before the repository", () => {
    expect(classify("package.json").type).toBe("package-local");
  });

  test("reports a path owned by another package", () => {
    expect(classify("apps/beta/src/route.ts")).toEqual({
      target: "apps/beta/src/route.ts",
      type: "repository",
    });
  });

  test("resolves a relative specifier from the test file's directory", () => {
    expect(classify("./types").type).toBe("package-local");
    expect(classify("..").type).toBe("package-local");
    expect(classify("../../beta/src/route.ts")).toEqual({
      target: "apps/beta/src/route.ts",
      type: "repository",
    });
    expect(classify("../../beta/src/missing.ts").type).toBe("absent");
    expect(classify("../../../../outside").type).toBe("absent");
  });

  test("ignores a value that only looks like a path", () => {
    expect(classify("apps/beta/missing.ts").type).toBe("absent");
    // `apps` names a real directory, but a bare word is a value until a glob
    // says it is a tree.
    expect(classify("apps").type).toBe("absent");
    expect(classify("apps", true)).toEqual({
      target: "apps",
      type: "repository",
    });
  });
});

describe("turbo test inputs", () => {
  test("reads the root inputs of each package test task", () => {
    const root = createRoot({
      files: {},
      tasks: {
        "@stll/alpha#test": {
          inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/lint.config.ts"],
        },
      },
    });

    expect([...readTestInputs(root)]).toEqual([
      ["@stll/alpha", ["lint.config.ts"]],
    ]);
  });

  test("matches an exact path and a subtree, not a sibling", () => {
    expect(matchesRootInput("lint.config.ts", "lint.config.ts")).toBe(true);
    expect(matchesRootInput("apps/beta/src/route.ts", "apps/beta/**")).toBe(
      true,
    );
    expect(matchesRootInput("apps/beta", "apps/beta/**")).toBe(true);
    // A tree-wide read is not covered by an input over one of its branches.
    expect(matchesRootInput("apps", "apps/beta/**")).toBe(false);
    expect(matchesRootInput("apps/gamma/src/route.ts", "apps/beta/**")).toBe(
      false,
    );
  });
});

describe("test input coverage", () => {
  const reading = 'readFileSync(path.join(root, "apps/beta/src/route.ts"));\n';

  test("fails an undeclared read of another package", () => {
    const root = createRoot({
      files: { "apps/alpha/src/guard.test.ts": reading },
      tasks: {},
    });
    const errors = checkTestInputCoverage(root);

    expect(errors).toHaveLength(1);
    expect(errors.at(0)).toContain("apps/alpha/src/guard.test.ts:1");
    expect(errors.at(0)).toContain("$TURBO_ROOT$/apps/beta/src/route.ts");
    expect(errors.at(0)).toContain("move the assertion into the package");
  });

  test("accepts the read once turbo.json declares it", () => {
    const root = createRoot({
      files: { "apps/alpha/src/guard.test.ts": reading },
      tasks: {
        "@stll/alpha#test": {
          inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/apps/beta/**"],
        },
      },
    });

    expect(checkTestInputCoverage(root)).toEqual([]);
  });

  test("ignores a read of a workspace dependency, which Turbo already selects", () => {
    const root = createRoot({
      files: {
        "apps/alpha/src/guard.test.ts":
          'readFileSync(path.join(root, "packages/shared/src/index.ts"));\n',
      },
      tasks: {},
    });

    expect(checkTestInputCoverage(root)).toEqual([]);
  });

  test("ignores a path compared by a matcher rather than read", () => {
    const root = createRoot({
      files: {
        "apps/alpha/src/guard.test.ts":
          'expect(config).toContain("apps/beta/src/route.ts");\n',
      },
      tasks: {},
    });

    expect(checkTestInputCoverage(root)).toEqual([]);
  });

  test("fails an input no test reads any more, so the list can only shrink", () => {
    const root = createRoot({
      files: { "apps/alpha/src/guard.test.ts": "expect(1).toBe(1);\n" },
      tasks: {
        "@stll/alpha#test": {
          inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/apps/beta/**"],
        },
      },
    });
    const errors = checkTestInputCoverage(root);

    expect(errors).toHaveLength(1);
    expect(errors.at(0)).toContain("no test in apps/alpha reads any more");
  });
});

describe("test scope filters", () => {
  const testInputs = new Map([
    ["@stll/alpha", ["apps/**", "lint.config.ts"]],
    ["@stll/beta", ["lint.config.ts"]],
  ]);

  test("adds every package whose declared inputs cover a changed file", () => {
    expect(
      scopeFilters({
        affected: ["@stll/beta"],
        base: "origin/main",
        changed: ["apps/beta/src/route.ts"],
        testInputs,
      }),
    ).toEqual([
      "--filter=...[origin/main...HEAD]",
      "--filter=@stll/alpha",
      "--filter=@stll/beta",
    ]);
  });

  test("keeps the git range alone when no declared input matches", () => {
    expect(
      scopeFilters({
        affected: [],
        base: "origin/main",
        changed: ["README.md"],
        testInputs,
      }),
    ).toEqual(["--filter=...[origin/main...HEAD]"]);
  });
});
