import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  checkQuarantineExcludes,
  pruneExpiredExcludes,
  pruneQuarantineBunfigs,
  quarantineBunfigFiles,
  quarantineOwningFiles,
  SCRIPT_PATH,
} from "./check-stll-quarantine-excludes";
import { expiryScopeBase } from "./expiry-check-scope";

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

describe("expiry ownership", () => {
  test.each([
    { catalog: { "better-result": "2.0.0" } },
    { catalogs: { server: { "better-result": "2.0.0" } } },
  ])("recognizes catalog pins in either manifest tree: %j", (manifest) => {
    for (const manifests of [
      { packageManifests: { "package.json": JSON.stringify(manifest) } },
      { basePackageManifests: { "package.json": JSON.stringify(manifest) } },
    ]) {
      expect(
        quarantineOwningFiles({
          bunfigFile: "bunfig.toml",
          packageName: "better-result",
          ...manifests,
        }),
      ).toEqual(["bunfig.toml", "bun.lock", "package.json"]);
    }
  });
  test("retains ownership when a change deletes a manifest pin", () => {
    expect(
      quarantineOwningFiles({
        bunfigFile: "bunfig.toml",
        packageName: "better-result",
        packageManifests: { "package.json": "{}" },
        basePackageManifests: {
          "package.json": '{"dependencies":{"better-result":"2.0.0"}}',
        },
      }),
    ).toEqual(["bunfig.toml", "bun.lock", "package.json"]);
    expect(
      quarantineOwningFiles({
        bunfigFile: ".claude/mcp/bunfig.toml",
        packageName: "better-result",
        basePackageManifests: {
          "package.json": '{"dependencies":{"better-result":"2.0.0"}}',
        },
      }),
    ).toEqual([".claude/mcp/bunfig.toml", ".claude/mcp/bun.lock"]);
  });
  const bunfig = createBunfig(
    '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
  );
  const now = new Date("2026-08-07T00:00:00.000Z");

  test.each(["pull_request", "merge_group"])(
    "reads the exact %s base",
    (eventName) => {
      const sha = "a".repeat(40);
      expect(
        expiryScopeBase(eventName, {
          pull_request: { base: { sha } },
          merge_group: { base_sha: sha },
        }),
      ).toBe(sha);
      expect(() => expiryScopeBase(eventName, {})).toThrow(
        "exact event base SHA",
      );
    },
  );

  test.each(["bunfig.toml", "bun.lock", "packages/client/package.json"])(
    "blocks the owning file: %s",
    (file) => {
      const result = checkQuarantineExcludes({
        bunfig,
        lockfile,
        now,
        scope: { type: "changes", changedFiles: new Set([file]) },
        packageManifests: {
          "packages/client/package.json":
            '{"devDependencies":{"better-result":"2.0.0"}}',
        },
      });
      expect(result.errors.join(" ")).toContain("expired at");
      expect(result.warnings).toEqual([]);
    },
  );

  test.each(["README.md", "packages/other/package.json"])(
    "warns unrelated changes: %s",
    (file) => {
      const result = checkQuarantineExcludes({
        bunfig,
        lockfile,
        now,
        scope: { type: "changes", changedFiles: new Set([file]) },
        packageManifests: {
          "packages/other/package.json": '{"dependencies":{"other":"1.0.0"}}',
        },
      });
      expect(result.errors).toEqual([]);
      expect(result.warnings.join(" ")).toContain('"better-result" expired at');
      expect(result.warnings.join(" ")).toContain("--prune");
    },
  );

  test.each([
    '"better-result",',
    '"better-result", # quarantine-expires: nope',
    '"@stll/*", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z',
  ])("retains structural failures: %s", (line) => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(line),
      lockfile,
      now,
      scope: { type: "changes", changedFiles: new Set(["README.md"]) },
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("keeps first-party completeness blocking outside ownership", () => {
    const result = checkQuarantineExcludes({
      bunfig,
      lockfile: `${lockfile}\n"@stll/missing": ["@stll/missing@1.0.0"]`,
      now,
      scope: { type: "changes", changedFiles: new Set(["README.md"]) },
    });
    expect(result.errors.join(" ")).toContain("missing 1 first-party");
    expect(result.warnings.join(" ")).toContain("expired at");
  });

  test("scopes container exception expiry to its source", () => {
    const input = {
      bunfig: createBunfig(""),
      lockfile,
      now,
      releaseAgeExceptionSources: {
        "docker-compose.yml":
          "# release-age-quarantine-exception: 2026-08-01T00:00:00.000Z",
      },
    };
    const unrelated = checkQuarantineExcludes({
      ...input,
      scope: { type: "changes", changedFiles: new Set(["README.md"]) },
    });
    expect(unrelated.errors).toEqual([]);
    expect(unrelated.warnings.join(" ")).toContain("Remove the exception");
    const related = checkQuarantineExcludes({
      ...input,
      scope: { type: "changes", changedFiles: new Set(["docker-compose.yml"]) },
    });
    expect(related.errors.join(" ")).toContain("expired at");
  });

  test("prunes every scanned bunfig and reaches a fixed point", () => {
    const scanned = quarantineBunfigFiles([
      "bunfig.toml",
      ".claude/mcp/bunfig.toml",
      "node_modules/pkg/bunfig.toml",
      "package.json",
    ]);
    expect(scanned).toEqual(["bunfig.toml", ".claude/mcp/bunfig.toml"]);
    const result = pruneQuarantineBunfigs({
      bunfigs: Object.fromEntries(scanned.map((file) => [file, bunfig])),
      now,
    });
    expect(Object.keys(result)).toEqual(scanned);
    for (const entry of Object.values(result)) {
      expect(entry.pruned).toEqual(["better-result"]);
      expect(entry.bunfig).not.toContain("better-result");
    }
    const repeated = pruneQuarantineBunfigs({
      bunfigs: Object.fromEntries(
        Object.entries(result).map(([file, entry]) => [file, entry.bunfig]),
      ),
      now,
    });
    for (const entry of Object.values(repeated)) {
      expect(entry.pruned).toEqual([]);
    }
  });
});

describe("quarantine exclude guard", () => {
  test.each(["2099-01-01T00:00:00.000Z", "2099-02-01T00:00:00.000Z"])(
    "rejects duplicate packages regardless of expiry or change scope: %s",
    (expiresAt) => {
      const bunfig =
        createBunfig(`"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z
  "better-result", # quarantine-expires: ${expiresAt}`);
      for (const scope of [
        { type: "all" } as const,
        { type: "changes", changedFiles: new Set(["README.md"]) } as const,
      ]) {
        const result = checkQuarantineExcludes({
          bunfig,
          lockfile,
          now: new Date("2026-08-01T00:00:00.000Z"),
          scope,
        });
        expect(result.errors).toContain(
          'bunfig.toml minimumReleaseAgeExcludes repeats package "better-result"; keep one annotated entry per package',
        );
        expect(result.warnings).toEqual([]);
      }
    },
  );

  test("permits one declaration of the same package in each bunfig", () => {
    for (const bunfigFile of quarantineBunfigFiles([
      "bunfig.toml",
      ".claude/mcp/bunfig.toml",
    ])) {
      expect(
        checkQuarantineExcludes({
          bunfig: createBunfig(
            '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
          ),
          bunfigFile,
          lockfile,
          now: new Date("2026-08-01T00:00:00.000Z"),
        }).errors,
      ).toEqual([]);
    }
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

  test("rejects an expired container quarantine exception", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2099-01-01T00:00:00.000Z',
      ),
      lockfile,
      releaseAgeExceptionSources: {
        "docker-compose.yml":
          "# release-age-quarantine-exception: 2026-08-13T09:51:27.645Z",
      },
      now: new Date("2026-08-13T09:51:27.645Z"),
    });

    expect(result.errors).toContain(
      "docker-compose.yml:1 release-age quarantine exception expired at 2026-08-13T09:51:27.645Z",
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

  test.each([
    "2026-08-06T21:35:30.036Z",
    "2026-08-06T21:35:30.037Z",
    "2026-08-07T21:35:30.035Z",
    "2026-08-07T21:35:30.036Z",
  ])(
    "fails exactly at expiry and throughout the former notice window: %s",
    (now) => {
      const result = checkQuarantineExcludes({
        bunfig: createBunfig(
          '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
        ),
        lockfile,
        now: new Date(now),
      });
      expect(result.errors.at(0)).toContain(
        'temporary quarantine exclude "better-result" expired at 2026-08-06T21:35:30.036Z and is still here',
      );
      expect(result.errors.at(0)).toContain(
        "bun scripts/check-stll-quarantine-excludes-cli.ts --prune",
      );
      // The named command must be the entry point that handles --prune.
      const cli = readFileSync(
        path.join(import.meta.dir, "..", SCRIPT_PATH),
        "utf-8",
      );
      expect(cli).toContain("if (import.meta.main)");
      expect(cli).toContain('process.argv.includes("--prune")');
    },
  );

  test("stays silent immediately before expiry", () => {
    const result = checkQuarantineExcludes({
      bunfig: createBunfig(
        '"better-result", # quarantine-expires: 2026-08-06T21:35:30.036Z',
      ),
      lockfile,
      now: new Date("2026-08-06T21:35:30.035Z"),
    });
    expect(result.errors).toEqual([]);
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
