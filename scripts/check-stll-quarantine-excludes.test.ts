import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

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
  test("rejects a duplicated package with every declaration line", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"@stll/native", # quarantine-excluded-since: 2026-08-08T00:22:40.000Z',
      ),
      lockfile,
    });

    expect(result.errors).toContain(
      'bunfig.toml minimumReleaseAgeExcludes lists duplicate package "@stll/native" on lines 5, 6',
    );
  });

  test("accepts a list without duplicate packages", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
      ),
      lockfile,
    });

    expect(result.errors).toEqual([]);
  });

  test("rejects every spelling of the same package", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"@stll/\\u006eative", # quarantine-excluded-since: 2026-08-08T00:22:40.000Z',
      ),
      lockfile,
    });

    expect(result.errors).toContain(
      'bunfig.toml minimumReleaseAgeExcludes lists duplicate package "@stll/native" on lines 5, 6',
    );
  });

  // Dates in the live file are checked against the real clock by the check
  // itself; this test owns only the duplicate rule, which no date affects.
  test("the repository bunfig lists each package once", () => {
    const repositoryRoot = path.resolve(import.meta.dir, "..");
    const result = checkQuarantineExcludes({
      bunfig: readFileSync(path.join(repositoryRoot, "bunfig.toml"), "utf-8"),
      lockfile: readFileSync(path.join(repositoryRoot, "bun.lock"), "utf-8"),
    });

    expect(
      result.errors.filter((error) => error.includes("duplicate package")),
    ).toEqual([]);
  });

  test("rejects every undated third-party exclusion", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig('"better-result",'),
      lockfile,
    });

    expect(result.errors).toContain(
      'bunfig.toml third-party quarantine exclude "better-result" is missing an exact UTC expiry',
    );
  });

  test("rejects a container quarantine exception without an exact expiry", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
      ),
      lockfile,
      releaseAgeExceptionSources: {
        "docker-compose.yml": "# release-age-quarantine-exception:",
      },
    });

    expect(result.errors).toContain(
      "docker-compose.yml:1 release-age quarantine exception is missing an exact UTC expiry",
    );
  });

  test("accepts a container quarantine exception with an exact expiry", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
      ),
      lockfile,
      releaseAgeExceptionSources: {
        "docker-compose.yml":
          "# release-age-quarantine-exception: 2026-08-13T09:51:27.645Z",
      },
      now: new Date("2026-08-11T00:00:00.000Z"),
    });

    expect(result.errors).toEqual([]);
  });

  // scripts/dated-waivers.ts owns the expiry and scopes it to changes that
  // touch the exception, so the clock alone never turns this guard red.
  test("leaves an elapsed container quarantine exception to the dated waiver check", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
      ),
      lockfile,
      releaseAgeExceptionSources: {
        "docker-compose.yml":
          "# release-age-quarantine-exception: 2026-08-13T09:51:27.645Z",
      },
      now: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(result.errors).toEqual([]);
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

  test("rejects compact exclusion arrays that cannot carry per-entry annotations", () => {
    const result = checkQuarantineExcludes({
      bunfig: `
[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = ["@stll/native", "better-result"]
`,
      lockfile,
    });

    expect(result.errors).toContain(
      "bunfig.toml minimumReleaseAgeExcludes must declare one annotated package per line; unrecognized entries: @stll/native, better-result",
    );
  });

  test("does not treat a closing bracket in a comment as the array end", () => {
    const result = checkQuarantineExcludes({
      bunfig: `
[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  "@stll/native", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z
  # Temporary exceptions [remove after expiry]
  "better-result",
]
`,
      lockfile,
    });

    expect(result.errors).toContain(
      'bunfig.toml third-party quarantine exclude "better-result" is missing an exact UTC expiry',
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

  // The prune workflow removes the entry, the lockfile release-age guard
  // stops exempting it, and scripts/dated-waivers.ts inventories it; none of
  // them fails an unrelated change, and neither does this guard.
  test.each([
    "2026-08-06T21:35:30.036Z",
    "2026-08-07T21:35:30.036Z",
    "2099-01-01T00:00:00.000Z",
  ])(
    "leaves an elapsed temporary exclusion to its expiry owners: %s",
    (now) => {
      const result = checkQuarantineExcludes({
        bunfig: createBunfig(
          '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
        ),
        lockfile,
        now: new Date(now),
      });
      expect(result.errors).toEqual([]);
      expect(result.activeTemporaryCount).toBe(1);
    },
  );

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
  # Security patches [temporary] for dependency-audit findings.
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
