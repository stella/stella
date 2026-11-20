import { describe, expect, test } from "bun:test";

import {
  checkPatchedDependencies,
  type PatchedDependencyInputs,
  UNPATCHED_COPIES_FILE,
} from "./check-patched-dependencies";

const PATCH_FILE = "patches/@scope%2Fpatched@1.0.3.patch";

const manifest = (patches: Record<string, string>) =>
  JSON.stringify({ name: "root", patchedDependencies: patches }, null, 2);

// Bun writes bun.lock with trailing commas; the fixtures keep them so the
// parser sees the real shape.
const lockfile = ({
  packages,
  patches,
}: {
  packages: Record<string, string>;
  patches: Record<string, string>;
}) => {
  const packageLines = Object.entries(packages)
    .map(
      ([key, ident]) =>
        `    "${key}": ["${ident}", "", {}, "sha512-AAAA=="],\n`,
    )
    .join("");
  const patchLines = Object.entries(patches)
    .map(([key, file]) => `    "${key}": "${file}",\n`)
    .join("");
  return `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "root",\n    },\n  },\n  "patchedDependencies": {\n${patchLines}  },\n  "packages": {\n${packageLines}  },\n}\n`;
};

const copies = (entries: unknown[] = []) => JSON.stringify({ copies: entries });

const matching = (): PatchedDependencyInputs => ({
  manifestText: manifest({ "@scope/patched@1.0.3": PATCH_FILE }),
  lockText: lockfile({
    packages: {
      "@scope/patched": "@scope/patched@1.0.3",
      "other/@scope/patched": "@scope/patched@1.0.3",
      unrelated: "unrelated@2.0.0",
    },
    patches: { "@scope/patched@1.0.3": PATCH_FILE },
  }),
  unpatchedCopiesText: copies(),
  patchFileExists: (file) => file === PATCH_FILE,
});

describe("checkPatchedDependencies", () => {
  test("passes when every patch matches a resolved version", () => {
    expect(checkPatchedDependencies(matching())).toEqual([]);
  });

  test("fails when the package was bumped and bun.lock dropped the patch", () => {
    const errors = checkPatchedDependencies({
      ...matching(),
      lockText: lockfile({
        packages: { "@scope/patched": "@scope/patched@1.0.4" },
        patches: {},
      }),
    });
    expect(errors).toEqual([
      "@scope/patched: package.json patches @scope/patched@1.0.3, but bun.lock resolves @scope/patched only at 1.0.4; the patch no longer applies to the installed version: re-key it to the new version (bun patch) or hold the package.",
      '@scope/patched: bun.lock resolves "@scope/patched" at 1.0.4, which no patch covers (patched: 1.0.3); the patch no longer applies to the installed version: re-key it to the new version (bun patch) or hold the package.',
    ]);
  });

  test("fails when bun.lock resolves the version but no longer records the patch", () => {
    const errors = checkPatchedDependencies({
      ...matching(),
      lockText: lockfile({
        packages: { "@scope/patched": "@scope/patched@1.0.3" },
        patches: {},
      }),
    });
    expect(errors).toEqual([
      "@scope/patched: package.json patches @scope/patched@1.0.3, but bun.lock does not record the patch; the patch no longer applies to the installed version: re-key it to the new version (bun patch) or hold the package.",
    ]);
  });

  test("fails on an extra unpatched copy next to the patched one", () => {
    const errors = checkPatchedDependencies({
      ...matching(),
      lockText: lockfile({
        packages: {
          "@scope/patched": "@scope/patched@1.0.3",
          "consumer/@scope/patched": "@scope/patched@1.0.4",
        },
        patches: { "@scope/patched@1.0.3": PATCH_FILE },
      }),
    });
    expect(errors).toEqual([
      '@scope/patched: bun.lock resolves "consumer/@scope/patched" at 1.0.4, which no patch covers (patched: 1.0.3); the patch no longer applies to the installed version: re-key it to the new version (bun patch) or hold the package.',
    ]);
  });

  test("accepts an unpatched copy declared under its parent", () => {
    const inputs: PatchedDependencyInputs = {
      ...matching(),
      lockText: lockfile({
        packages: {
          "@scope/patched": "@scope/patched@1.0.3",
          "@build/tool/@scope/patched": "@scope/patched@1.0.1",
        },
        patches: { "@scope/patched@1.0.3": PATCH_FILE },
      }),
      unpatchedCopiesText: copies([
        {
          package: "@scope/patched@1.0.1",
          parents: ["@build/tool"],
          reason: "Build tool only.",
        },
      ]),
    };
    expect(checkPatchedDependencies(inputs)).toEqual([]);

    // Hoisting may move the copy below another prefix; the parent stays.
    expect(
      checkPatchedDependencies({
        ...inputs,
        lockText: lockfile({
          packages: {
            "@scope/patched": "@scope/patched@1.0.3",
            "app/@build/tool/@scope/patched": "@scope/patched@1.0.1",
          },
          patches: { "@scope/patched@1.0.3": PATCH_FILE },
        }),
      }),
    ).toEqual([]);

    // The declaration covers that parent only, not a new copy at the same
    // version elsewhere.
    const spread = checkPatchedDependencies({
      ...inputs,
      lockText: lockfile({
        packages: {
          "@scope/patched": "@scope/patched@1.0.3",
          "@build/tool/@scope/patched": "@scope/patched@1.0.1",
          "web/@scope/patched": "@scope/patched@1.0.1",
        },
        patches: { "@scope/patched@1.0.3": PATCH_FILE },
      }),
    });
    expect(spread).toHaveLength(1);
    expect(spread[0]).toContain('"web/@scope/patched" at 1.0.1');
  });

  test("fails on a declaration bun.lock no longer needs", () => {
    const errors = checkPatchedDependencies({
      ...matching(),
      unpatchedCopiesText: copies([
        {
          package: "@scope/patched@1.0.1",
          parents: ["@build/tool"],
          reason: "Build tool only.",
        },
      ]),
    });
    expect(errors).toEqual([
      `${UNPATCHED_COPIES_FILE} declares @build/tool > @scope/patched@1.0.1 unpatched, but bun.lock has no such unpatched copy; remove or update the declaration.`,
    ]);
  });

  test("fails when bun.lock patches a key package.json does not", () => {
    const errors = checkPatchedDependencies({
      ...matching(),
      manifestText: manifest({}),
    });
    expect(errors).toEqual([
      "bun.lock patchedDependencies lists @scope/patched@1.0.3, which package.json does not patch; run bun install to refresh bun.lock.",
    ]);
  });

  test("fails when the patch file is missing", () => {
    const errors = checkPatchedDependencies({
      ...matching(),
      patchFileExists: () => false,
    });
    expect(errors).toEqual([
      `@scope/patched: patch file ${PATCH_FILE} for @scope/patched@1.0.3 is missing.`,
    ]);
  });

  test("fails on a patch key without a version", () => {
    const errors = checkPatchedDependencies({
      ...matching(),
      manifestText: manifest({ "@scope/patched": PATCH_FILE }),
    });
    expect(errors).toContain(
      'package.json patchedDependencies "@scope/patched" must be keyed name@version',
    );
  });

  test("fails closed on a malformed lockfile", () => {
    const truncated = matching().lockText.slice(0, 120);
    const errors = checkPatchedDependencies({
      ...matching(),
      lockText: truncated,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("bun.lock does not parse:");

    expect(
      checkPatchedDependencies({
        ...matching(),
        lockText: '{ "lockfileVersion": 1 }',
      }),
    ).toEqual(["bun.lock has no packages map"]);

    const badEntry = checkPatchedDependencies({
      ...matching(),
      lockText: matching().lockText.replace(
        '["unrelated@2.0.0"',
        '["unrelated"',
      ),
    });
    expect(badEntry).toEqual([
      'bun.lock package "unrelated" has no name@version ident',
    ]);
  });

  test("fails closed on a malformed manifest or declaration file", () => {
    expect(
      checkPatchedDependencies({ ...matching(), manifestText: "{" })[0],
    ).toStartWith("package.json does not parse:");
    expect(
      checkPatchedDependencies({
        ...matching(),
        manifestText: JSON.stringify({ patchedDependencies: [] }),
      }),
    ).toEqual(["package.json patchedDependencies must be an object"]);
    expect(
      checkPatchedDependencies({
        ...matching(),
        unpatchedCopiesText: copies([
          { package: "@scope/patched@1.0.1", parents: ["x"] },
        ]),
      }),
    ).toEqual([
      `${UNPATCHED_COPIES_FILE} copies[0] needs "package" (name@version), a non-empty "parents" list and a "reason"`,
    ]);
  });
});
