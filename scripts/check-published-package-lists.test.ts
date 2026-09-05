import { describe, expect, test } from "bun:test";

import {
  publishedPackageNames,
  renderPublishedPackageBlock,
  replacePublishedPackageBlock,
} from "./check-published-package-lists";

/** A policy shaped like the real one: several paths per package, apps absent. */
const RELEASE_PATHS = [
  "packages/ui/README.md",
  "packages/ui/package.json",
  "packages/ui/src/**",
  "packages/cli/src/**",
  "packages/cli/skills/**",
  "packages/auth-model/tsconfig.json",
] as const;

describe("published package lists", () => {
  test("one name per package, sorted, whatever the path order", () => {
    expect(publishedPackageNames(RELEASE_PATHS)).toEqual([
      "auth-model",
      "cli",
      "ui",
    ]);
  });

  test("renders one scoped bullet per package", () => {
    expect(renderPublishedPackageBlock(RELEASE_PATHS)).toContain(
      "- `@stll/auth-model`\n- `@stll/cli`\n- `@stll/ui`",
    );
  });

  test("replaces the marked region and leaves the prose around it", () => {
    const replaced = replacePublishedPackageBlock({
      block: renderPublishedPackageBlock(RELEASE_PATHS),
      contents:
        "before\n\n<!-- published-packages:start -->\nstale\n<!-- published-packages:end -->\n\nafter\n",
      file: "CONTRIBUTING.md",
    });

    expect(replaced.startsWith("before\n\n")).toBe(true);
    expect(replaced.endsWith("\n\nafter\n")).toBe(true);
    expect(replaced).not.toContain("stale");
    expect(replaced).toContain("- `@stll/ui`");
  });

  test("rendering is a fixed point: a rendered file re-renders unchanged", () => {
    const block = renderPublishedPackageBlock(RELEASE_PATHS);
    const once = replacePublishedPackageBlock({
      block,
      contents:
        "<!-- published-packages:start -->\n<!-- published-packages:end -->\n",
      file: "CONTRIBUTING.md",
    });

    expect(
      replacePublishedPackageBlock({ block, contents: once, file: "x.md" }),
    ).toBe(once);
  });

  test("a file with no marked region fails instead of rendering nothing", () => {
    expect(() =>
      replacePublishedPackageBlock({
        block: renderPublishedPackageBlock(RELEASE_PATHS),
        contents: "no markers here\n",
        file: "CONTRIBUTING.md",
      }),
    ).toThrow("expected exactly one");
  });

  test("a duplicated region fails rather than leaving the second stale", () => {
    expect(() =>
      replacePublishedPackageBlock({
        block: renderPublishedPackageBlock(RELEASE_PATHS),
        contents:
          "<!-- published-packages:start -->\nfirst\n<!-- published-packages:end -->\n\n<!-- published-packages:start -->\nsecond\n<!-- published-packages:end -->\n",
        file: "CONTRIBUTING.md",
      }),
    ).toThrow("expected exactly one");
  });

  test("an empty policy fails instead of emptying both files", () => {
    expect(() => renderPublishedPackageBlock(["apps/api/src/**"])).toThrow(
      "no published package",
    );
  });
});
