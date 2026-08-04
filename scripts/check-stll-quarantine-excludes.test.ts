import { describe, expect, test } from "bun:test";

import { checkQuarantineExcludes } from "./check-stll-quarantine-excludes";

const lockfile = `
"packages": {
  "@stll/native": ["@stll/native@1.0.0", "", {}, "sha512-test"],
}
`;

const createBunfig = (temporaryLine: string) => `
[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  "@stll/native",
  ${temporaryLine}
]
`;

describe("quarantine exclude guard", () => {
  test("accepts a temporary exclusion before its exact expiry", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
      ),
      lockfile,
      now: new Date("2026-08-06T21:35:30.035Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.activeTemporaryCount).toBe(1);
  });

  test("rejects a temporary exclusion at its exact expiry", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
      ),
      lockfile,
      now: new Date("2026-08-06T21:35:30.036Z"),
    });

    expect(result.errors).toContain(
      'bunfig.toml temporary quarantine exclude "better-result" expired at 2026-08-06T21:35:30.036Z. Remove it: the configured release-age gate can admit the package now.',
    );
  });

  test("rejects malformed expiry annotations", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig('"better-result", # quarantine-expires: 2026-08-06'),
      lockfile,
    });

    expect(result.errors).toContain(
      'bunfig.toml temporary quarantine exclude "better-result" has an invalid UTC expiry: 2026-08-06',
    );
  });

  // A fixed-width lookahead read past the entry, so a workspace member on the
  // next line marked its registry-resolved neighbour as a workspace member
  // too, and the coverage check silently stopped requiring it.
  test("counts a registry package followed by a workspace member", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig('"better-result",'),
      lockfile: `
"packages": {
  "@stll/native": ["@stll/native@1.0.0", "", {}, "sha512-test"],
  "@stll/shipped": ["@stll/shipped@1.0.0", "", { "dependencies": { "valibot": "1.4.1" } }, "sha512-test"],
  "@stll/local": ["@stll/local@workspace:packages/local"],
}
`,
    });

    expect(result.firstPartyCount).toBe(2);
    expect(result.errors.at(0)).toContain('"@stll/shipped",');
  });

  test("retains the first-party package coverage guard", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig('"better-result",'),
      lockfile: `${lockfile}\n"@stll/missing": ["@stll/missing@1.0.0"]`,
    });

    expect(result.errors.at(0)).toContain('"@stll/missing",');
  });
});
