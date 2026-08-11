import { describe, expect, test } from "bun:test";

import {
  checkQuarantineExcludes,
  pruneExpiredExcludes,
} from "./check-stll-quarantine-excludes";

const lockfile = `
"packages": {
  "@stll/native": ["@stll/native@1.0.0", "", {}, "sha512-test"],
}
`;

const createBunfig = (temporaryLine: string) => `
[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  "@stll/native", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z
  ${temporaryLine}
]
`;

describe("quarantine exclude guard", () => {
  test("rejects every undated third-party exclusion", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig('"better-result",'),
      lockfile,
    });

    expect(result.errors).toContain(
      'bunfig.toml third-party quarantine exclude "better-result" is missing an exact UTC expiry',
    );
  });

  test("rejects every undated first-party exclusion", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"@stll/shipped", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z',
      ).replace(
        '"@stll/native", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z',
        '"@stll/native",',
      ),
      lockfile,
    });

    expect(result.errors).toContain(
      'bunfig.toml first-party quarantine exclude "@stll/native" is missing an exact UTC exclusion date',
    );
  });

  test("rejects malformed and future first-party exclusion dates", () => {
    const malformed = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"@stll/shipped", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z',
      ).replace("2026-07-08T00:22:40.000Z", "2026-07-08"),
      lockfile,
    });
    const future = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"@stll/shipped", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z',
      ).replace("2026-07-08T00:22:40.000Z", "2099-01-01T00:00:00.000Z"),
      lockfile,
      now: new Date("2026-08-11T00:00:00.000Z"),
    });

    expect(malformed.errors.at(0)).toContain(
      'minimum-release-age exclude "@stll/native" has an invalid exclusion-date UTC timestamp',
    );
    expect(future.errors.at(0)).toContain(
      'first-party quarantine exclude "@stll/native" has a future exclusion date',
    );
  });

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

  // An expiry is a wall-clock instant. Failing at it turned every open branch
  // red at once for a change nobody made, so the instant only warns.
  test("warns rather than fails at the exact expiry", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
      ),
      lockfile,
      now: new Date("2026-08-06T21:35:30.036Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings.at(0)).toContain(
      'temporary quarantine exclude "better-result" expired at',
    );
  });

  // Nothing to say before it expires: the removal arrives on its own.
  test("stays silent until the expiry", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
      ),
      lockfile,
      now: new Date("2026-08-06T21:35:30.035Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("fails once an expired exclusion is ignored past the notice window", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
      ),
      lockfile,
      now: new Date("2026-08-07T21:35:30.036Z"),
    });

    expect(result.warnings).toEqual([]);
    expect(result.errors.at(0)).toContain(
      'temporary quarantine exclude "better-result" expired at 2026-08-06T21:35:30.036Z and is still here',
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
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
      ),
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

  test("counts first-party packages resolved under nested lock paths", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
      ),
      lockfile: `
"packages": {
  "@stll/folio-core/@stll/template-conditions": ["@stll/template-conditions@0.1.0", "", { "dependencies": { "@stll/conditions": "^0.1.0" } }, "sha512-test"],
  "@stll/folio-core/@stll/template-conditions/@stll/conditions": ["@stll/conditions@0.1.0", "", { "dependencies": { "valibot": "1.4.1" } }, "sha512-test"],
  "@stll/folio-core/better-result": ["better-result@2.10.0", "", {}, "sha512-test"],
}
`,
    });

    expect(result.firstPartyCount).toBe(2);
    expect(result.errors.at(0)).toContain('"@stll/conditions",');
    expect(result.errors.at(0)).toContain('"@stll/template-conditions",');
  });

  test("prunes only the expired entries", () => {
    const bunfig = `
[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  "@stll/native", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z
  # Security patches for dependency-audit findings.
  "brace-expansion", # quarantine-expires: 2026-08-04T10:00:32.762Z
  "fast-uri", # quarantine-expires: 2026-08-05T09:16:56.212Z
  "drizzle-kit", # quarantine-expires: 2099-01-01T00:00:00.000Z
]
`;
    const result = pruneExpiredExcludes({
      bunfig,
      now: new Date("2026-08-04T10:37:00.000Z"),
    });

    expect(result.pruned).toEqual(["brace-expansion"]);
    expect(result.bunfig).not.toContain("brace-expansion");
    expect(result.bunfig).toContain('"fast-uri", # quarantine-expires:');
    expect(result.bunfig).toContain(
      '"@stll/native", # quarantine-excluded-since:',
    );
    expect(result.bunfig).toContain('"drizzle-kit"');
    // The pruned file is what the guard should then accept.
    expect(
      checkQuarantineExcludes({
        bunfig: result.bunfig,
        lockfile,
        now: new Date("2026-08-04T10:37:00.000Z"),
      }).errors,
    ).toEqual([]);
  });

  // Matching by name would take the renewed entry with the expired one, which
  // silently drops a package back out of the quarantine before its time.
  test("keeps a renewed entry when an expired one shares its name", () => {
    const bunfig = `
[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  "@stll/native", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z
  "fast-uri", # quarantine-expires: 2026-08-05T09:16:56.212Z
  "fast-uri", # quarantine-expires: 2026-09-01T09:16:56.212Z
]
`;
    const result = pruneExpiredExcludes({
      bunfig,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(result.pruned).toEqual(["fast-uri"]);
    expect(result.bunfig).toContain(
      '"fast-uri", # quarantine-expires: 2026-09-01T09:16:56.212Z',
    );
    expect(result.bunfig).not.toContain("2026-08-05T09:16:56.212Z");
  });

  test("leaves a malformed annotation for the guard to report", () => {
    const bunfig = createBunfig('"better-result", # quarantine-expires: nope');
    const result = pruneExpiredExcludes({
      bunfig,
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result.pruned).toEqual([]);
    expect(result.bunfig).toBe(bunfig);
  });

  test("leaves a file with nothing expired untouched", () => {
    const bunfig = createBunfig(
      '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
    );
    const result = pruneExpiredExcludes({
      bunfig,
      now: new Date("2026-08-04T00:00:00.000Z"),
    });

    expect(result.pruned).toEqual([]);
    expect(result.bunfig).toBe(bunfig);
  });

  test("retains the first-party package coverage guard", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
      ),
      lockfile: `${lockfile}\n"@stll/missing": ["@stll/missing@1.0.0"]`,
    });

    expect(result.errors.at(0)).toContain('"@stll/missing",');
  });
});
