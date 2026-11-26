import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  deriveCapabilityId,
  deriveHandlerImportPath,
} from "./capability-catalog";
import { toEndpointIdentifier } from "./enumerate-safe-handlers";
import { relativePathWithin, toPosixPath } from "./repo-relative-path";

const HANDLER_SEGMENTS = [
  "apps",
  "api",
  "src",
  "handlers",
  "account-exports",
  "create.ts",
] as const;

const PLATFORMS = [
  {
    name: "posix",
    root: path.posix.join("/", "home", "runner", "stella"),
    flavour: path.posix,
  },
  {
    name: "win32",
    root: path.win32.join("D:\\", "a", "stella", "stella"),
    flavour: path.win32,
  },
] as const;

/** The projection the capability codegen derives from one discovered module. */
const projectEndpoint = (absPath: string, repoRoot: string) => {
  const file = toEndpointIdentifier(absPath, repoRoot);
  return {
    file,
    id: deriveCapabilityId({ file, exportName: undefined }),
    namedId: deriveCapabilityId({ file, exportName: "archive" }),
    importPath: deriveHandlerImportPath(file),
  };
};

describe("handler path projection", () => {
  test("a win32 path projects to the same endpoint as a POSIX path", () => {
    const [posix, win32] = PLATFORMS.map(({ root, flavour }) =>
      projectEndpoint(flavour.join(root, ...HANDLER_SEGMENTS), root),
    );
    expect(win32).toEqual(posix);
    expect(posix).toEqual({
      file: "apps/api/src/handlers/account-exports/create.ts",
      id: "account-exports.create",
      namedId: "account-exports.create.archive",
      importPath: "@/api/handlers/account-exports/create",
    });
  });

  test("a trailing separator on the root does not change the projection", () => {
    for (const { root, flavour } of PLATFORMS) {
      expect(
        projectEndpoint(
          flavour.join(root, ...HANDLER_SEGMENTS),
          `${root}${flavour.sep}`,
        ).id,
      ).toBe("account-exports.create");
    }
  });

  test("a repo-relative win32 glob result derives the same id and import path", () => {
    const relative = path.win32.join(...HANDLER_SEGMENTS);
    expect(deriveCapabilityId({ file: relative, exportName: undefined })).toBe(
      "account-exports.create",
    );
    expect(deriveHandlerImportPath(relative)).toBe(
      "@/api/handlers/account-exports/create",
    );
  });

  for (const { name, root, flavour } of PLATFORMS) {
    test(`${name}: a module outside the handler tree panics`, () => {
      const file = toEndpointIdentifier(
        flavour.join(root, "apps", "api", "src", "lib", "x.ts"),
        root,
      );
      expect(() => deriveCapabilityId({ file, exportName: undefined })).toThrow(
        "handler path is outside apps/api/src/handlers/",
      );
    });

    test(`${name}: a sibling directory sharing the handlers prefix panics`, () => {
      const file = toEndpointIdentifier(
        flavour.join(root, "apps", "api", "src", "handlers-old", "x.ts"),
        root,
      );
      expect(() => deriveCapabilityId({ file, exportName: undefined })).toThrow(
        "handler path is outside apps/api/src/handlers/",
      );
    });

    test(`${name}: a module outside the repo root panics`, () => {
      expect(() =>
        toEndpointIdentifier(
          flavour.join(root, "..", "other", ...HANDLER_SEGMENTS),
          root,
        ),
      ).toThrow("module is outside the repo root");
    });

    test(`${name}: an absolute handler path is not mistaken for a repo-relative one`, () => {
      expect(() =>
        deriveCapabilityId({
          file: flavour.join(root, ...HANDLER_SEGMENTS),
          exportName: undefined,
        }),
      ).toThrow("handler path is outside apps/api/src/handlers/");
    });
  }
});

describe("relativePathWithin", () => {
  test("is undefined for the root itself and for parent escapes", () => {
    expect(relativePathWithin({ root: "a/b", file: "a/b" })).toBeUndefined();
    expect(
      relativePathWithin({ root: "a/b", file: "a/b/../c.ts" }),
    ).toBeUndefined();
    expect(
      relativePathWithin({ root: "a\\b", file: "a\\b\\..\\c.ts" }),
    ).toBeUndefined();
  });

  test("returns a POSIX path for either separator", () => {
    expect(relativePathWithin({ root: "a/b", file: "a\\b\\c\\d.ts" })).toBe(
      "c/d.ts",
    );
    expect(toPosixPath("a\\b\\c.ts")).toBe("a/b/c.ts");
  });
});
