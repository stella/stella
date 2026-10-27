import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareCodeUnit } from "../packages/collation/src/collation";
import {
  checkRegistry,
  classifyPackage,
  type NpmRunner,
  readPackageManifest,
  readPublishablePackages,
  type RegistryFetch,
  versionBumpTime,
} from "./check-npm-publish-lag";
import {
  checkPublishedVersions,
  type GitRunner,
} from "./check-published-versions";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

const NOW = 2_000_000_000;
const SENTINEL = "registry-private-response";
const releaseEntry = (publishedAt: number, tag = "v1.0.0") => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: new Date(publishedAt * 1000).toISOString(),
});

const runJourney = async ({
  mainVersion = "1.2.3",
  promotedVersion = "1.0.0",
  registryVersion = "1.0.0",
  promotedAt = NOW - 10 * 86_400,
  now = NOW,
  bumpedAt = now - 1,
  releases = [releaseEntry(promotedAt)],
  promotionFetch = async () => Response.json(releases),
  missingTag = false,
  releaseVersions = {},
}: {
  mainVersion?: string;
  promotedVersion?: string;
  registryVersion?: string;
  promotedAt?: number;
  now?: number;
  bumpedAt?: number;
  releases?: unknown;
  promotionFetch?: RegistryFetch;
  missingTag?: boolean;
  releaseVersions?: Record<string, string>;
} = {}) => {
  const lines: string[] = [];
  const reads: string[] = [];
  const gitRunner: GitRunner = (args) => {
    reads.push(args.join(" "));
    if (args.at(0) === "log") {
      return {
        exitCode: 0,
        stdout: `journey-commit ${bumpedAt}\n- "version": "0.0.0"\n+ "version": "${mainVersion}"`,
      };
    }
    if (args.at(0) !== "show" || (missingTag && args.at(1)?.startsWith("v"))) {
      return { exitCode: 1, stdout: "" };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        name: "@stll/cli",
        version: args.at(1)?.startsWith("main:")
          ? mainVersion
          : (releaseVersions[args.at(1)?.split(":").at(0) ?? ""] ??
            promotedVersion),
      }),
    };
  };
  const failed = await checkPublishedVersions({
    ref: "main",
    registry: "https://registry.invalid",
    timeoutMs: 50,
    now,
    directories: ["cli"],
    gitRunner,
    promotionFetch,
    registryFetch: async () => Response.json({ version: registryVersion }),
    log: (line) => {
      lines.push(line);
    },
  });
  return { failed, lines, reads };
};

describe("promoted CLI publication", () => {
  test("CLI main bumps cannot reset promotion grace", async () => {
    // Install-free CI enumerates sequences across both sides of the grace boundary.
    for (const firstInterval of [1, 86_399, 86_400, 86_401, 200_000]) {
      for (const drift of [0, 1, 86_399]) {
        for (let length = 1; length <= 25; length += 1) {
          const intervals = Array.from(
            { length },
            (_, index) => ((firstInterval - 1 + index * drift) % 200_000) + 1,
          );
          let now = NOW;
          for (const [index, interval] of intervals.entries()) {
            now += interval;
            const mainVersion = `2.${index}.0`;
            // No new promotion: arbitrarily old/new main bumps remain pending.
            const pending = await runJourney({
              mainVersion,
              now: now + 86_400,
              bumpedAt: now,
            });
            expect(pending.failed).toBe(false);
            // A promotion promises a new CLI; later bumps never change its deadline.
            const promoted = await runJourney({
              mainVersion,
              promotedVersion: "1.1.0",
              promotedAt: NOW,
              now,
              releases: [releaseEntry(NOW), releaseEntry(now, "v2.0.0")],
            });
            expect(promoted.failed).toBe(now - NOW >= 86_400);
            // Publishing the promoted CLI fulfills the promise despite further bumps.
            const published = await runJourney({
              mainVersion,
              promotedVersion: "1.1.0",
              registryVersion: "1.1.0",
              promotedAt: NOW,
              now,
            });
            expect(published.failed).toBe(false);
          }
        }
      }
    }
  });

  test("unpromoted main stays pending without consulting bump history", async () => {
    const pending = await runJourney();
    expect(pending.lines).toContain(
      "journey registry-@stll/cli skipped pending_release",
    );
    expect(pending.reads).toEqual([
      "show main:packages/cli/package.json",
      "show v1.0.0:packages/cli/package.json",
    ]);
  });

  test("publication is green at the promoted version and grace expires exactly once", async () => {
    const published = await runJourney({ mainVersion: "1.0.0" });
    expect(published.lines).toContain(
      "journey registry-@stll/cli passed published",
    );
    for (const age of [0, 86_399, 86_400, 86_401]) {
      expect(
        (await runJourney({ promotedVersion: "1.1.0", promotedAt: NOW - age }))
          .failed,
      ).toBe(age >= 86_400);
    }
  });

  test("re-promoting an unpublished CLI never renews its grace", async () => {
    const result = await runJourney({
      promotedVersion: "1.1.0",
      releases: [releaseEntry(NOW - 1, "v2.0.0"), releaseEntry(NOW - 86_400)],
    });
    expect(result.failed).toBe(true);
    expect(result.lines).toContain(
      "journey registry-@stll/cli failed publish_lagging",
    );
  });

  test("an older promotion of another CLI version does not consume the grace", async () => {
    const result = await runJourney({
      promotedVersion: "1.1.0",
      releases: [releaseEntry(NOW - 1, "v2.0.0"), releaseEntry(NOW - 86_400)],
      releaseVersions: { "v1.0.0": "1.0.0" },
    });
    expect(result.failed).toBe(false);
    expect(result.lines).toContain(
      "journey registry-@stll/cli skipped publish_pending",
    );
  });

  test("selects promotion time rather than tag order or an unpromoted release", async () => {
    const result = await runJourney({
      releases: [
        releaseEntry(NOW - 100, "v1.0.1"),
        { ...releaseEntry(NOW, "v9.0.0"), draft: true },
        { ...releaseEntry(NOW, "v9.0.0-rc.1"), prerelease: true },
        releaseEntry(NOW - 200, "v2.0.0"),
      ],
    });
    expect(result.failed).toBe(false);
    expect(result.reads).toContain("show v1.0.1:packages/cli/package.json");
  });

  test.each([
    ["no promotion", []],
    [
      "invalid timestamp",
      [
        releaseEntry(NOW),
        { ...releaseEntry(NOW, "v2.0.0"), published_at: "invalid" },
      ],
    ],
    ["ambiguous promotion", [releaseEntry(NOW), releaseEntry(NOW, "v2.0.0")]],
    ["invalid listing", {}],
    ["invalid entry", [null]],
    ["future promotion", [releaseEntry(NOW + 1)]],
  ])("fails closed for %s", async (_, releases) => {
    const result = await runJourney({ releases });
    expect(result.failed).toBe(true);
    expect(result.lines).toContain(
      "journey registry-@stll/cli failed contract_error",
    );
  });

  test("fails closed when promotion metadata or its tag is unavailable", async () => {
    expect((await runJourney({ missingTag: true })).failed).toBe(true);
    const unavailable = await runJourney({
      promotionFetch: async () => new Response(null, { status: 503 }),
    });
    expect(unavailable.failed).toBe(true);
    expect(unavailable.lines).toContain(
      "journey registry-@stll/cli failed promotion_unavailable",
    );
    expect(
      (
        await runJourney({
          promotionFetch: async () => {
            throw new DOMException("timeout", "TimeoutError");
          },
        })
      ).failed,
    ).toBe(true);
  });

  test("paginates release history with a fixed request budget", async () => {
    let requests = 0;
    const older = Array.from({ length: 100 }, (_, index) =>
      releaseEntry(NOW - 1000 - index, `v1.0.${index}`),
    );
    const result = await runJourney({
      promotionFetch: async (url) => {
        requests += 1;
        const requestUrl = new URL(url instanceof Request ? url.url : url);
        expect(requestUrl.searchParams.get("page")).toBe(requests.toString());
        return Response.json(
          requests === 1 ? older : [releaseEntry(NOW - 1, "v2.0.0")],
        );
      },
    });
    expect(result.reads).toContain("show v2.0.0:packages/cli/package.json");
    expect(requests).toBe(2);
    requests = 0;
    const exhausted = await runJourney({
      promotionFetch: async () => {
        requests += 1;
        return Response.json(older);
      },
    });
    expect(exhausted.failed).toBe(true);
    expect(requests).toBe(10);
  });
});

const run = async ({
  body = '{"version":"1.2.3"}',
  status = 200,
  delay = 0,
  bumpedAt,
}: {
  body?: string;
  status?: number;
  delay?: number;
  bumpedAt?: number;
} = {}) => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(new URL(request.url).pathname);
      if (delay) {
        await Bun.sleep(delay);
      }
      return new Response(body, { status });
    },
  });
  try {
    const result = await checkRegistry({
      name: "@stll/fixture",
      version: "1.2.3",
      movedRepository: undefined,
      bumpedAt,
      now: NOW,
      registry: server.url.toString(),
      timeoutMs: 50,
    });
    expect(requests).toEqual(["/%40stll%2Ffixture/latest"]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    return result;
  } finally {
    await server.stop(true);
  }
};

describe("published registry versions", () => {
  test("checks the same complete package set the publisher selects", async () => {
    const selection = await Bun.file(
      new URL("publish-package-selection.ts", import.meta.url),
    ).text();
    expect(selection).toMatch(
      /import\s*\{[^}]*ALL_PACKAGE_ORDER[^}]*\}\s*from "\.\/publish-packages"/u,
    );
    const checker = await Bun.file(
      new URL("check-published-versions.ts", import.meta.url),
    ).text();
    expect(checker).toMatch(
      /import\s*\{[^}]*ALL_PACKAGE_ORDER[^}]*\}\s*from "\.\/publish-packages"/u,
    );
    expect(selection).toMatch(
      /if \(manualPackage === "all"\)\s*\{\s*return ALL_PACKAGE_ORDER;\s*\}/u,
    );
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();
    expect(workflow).toContain(
      'bun scripts/publish-package-selection.ts "$EVENT_NAME" "$MANUAL_PACKAGE"',
    );
    const options = workflow
      .split("        options:\n")
      .at(1)
      ?.split("        default:")
      .at(0)
      ?.matchAll(/^ {10}- (.+)$/gmu);
    expect(
      [...(options ?? [])]
        .flatMap((match) => match.at(1) ?? [])
        .filter((name) => name !== "all")
        .toSorted(compareCodeUnit),
    ).toEqual([...ALL_PACKAGE_ORDER].toSorted(compareCodeUnit));
  });
  test("accepts matching published versions regardless of bump age", async () => {
    expect(await run()).toEqual({ status: "passed", reason: "ok" });
    expect(await run({ bumpedAt: NOW - 60 })).toEqual({
      status: "passed",
      reason: "ok",
    });
  });
  test("only a version change within the publication window permits a mismatch", async () => {
    for (const bumpedAt of [undefined, NOW - 86_400, NOW - 86_401, NOW + 1]) {
      expect(
        await run({
          body: '{"version":"1.2.2"}',
          ...(bumpedAt === undefined ? {} : { bumpedAt }),
        }),
      ).toEqual({
        status: "failed",
        reason: "version_mismatch",
        latest: "1.2.2",
      });
    }
    expect(
      await run({ body: '{"version":"1.2.2"}', bumpedAt: NOW - 86_399 }),
    ).toEqual({ status: "skipped", reason: "publish_pending" });
  });
  test("classifies unavailable and timed-out registries", async () => {
    expect(await run({ status: 503, body: SENTINEL })).toEqual({
      status: "failed",
      reason: "http_status",
    });
    expect(await run({ delay: 100 })).toEqual({
      status: "failed",
      reason: "timeout",
    });
  });
  test("rejects malformed registry contracts even during the publication window", async () => {
    for (const body of [
      SENTINEL,
      "null",
      "[]",
      "{}",
      '{"version":2}',
      `{"version":"${SENTINEL}"}`,
    ]) {
      expect(await run({ body, bumpedAt: NOW - 1 })).toEqual({
        status: "failed",
        reason: "contract_error",
      });
    }
  });
  test("dates version changes rather than manifest maintenance", () => {
    const history = `journey-commit ${NOW}\n-  "description": "before"\n+  "description": "after"\njourney-commit ${NOW - 86_401}\n-  "version": "1.2.2",\n+  "version": "1.2.3",\n`;
    expect(versionBumpTime(history)).toBe(NOW - 86_401);
    expect(
      versionBumpTime(
        `journey-commit ${NOW}\n- "version": "1.2.3"\n+   "version": "1.2.3"`,
      ),
    ).toBeUndefined();
    expect(
      versionBumpTime(`journey-commit ${NOW}\n+ "version": "1.2.3"`),
    ).toBeUndefined();
    expect(versionBumpTime("")).toBeUndefined();
  });
  test.each([
    {
      label: "HTTP failure",
      body: SENTINEL,
      httpStatus: 503,
      bump: false,
      status: "failed",
      reason: "http_status",
      exit: 1,
    },
    {
      label: "matching version",
      body: '{"version":"1.2.3"}',
      httpStatus: 200,
      bump: false,
      status: "passed",
      reason: "ok",
      exit: 0,
    },
    {
      label: "pending publication",
      body: '{"version":"1.2.2"}',
      httpStatus: 200,
      bump: true,
      status: "skipped",
      reason: "publish_pending",
      exit: 0,
    },
    {
      label: "version mismatch",
      body: '{"version":"1.2.4"}',
      httpStatus: 200,
      bump: false,
      status: "failed",
      reason: "version_mismatch",
      exit: 1,
    },
    {
      label: "malformed response",
      body: SENTINEL,
      httpStatus: 200,
      bump: true,
      status: "failed",
      reason: "contract_error",
      exit: 1,
    },
  ])(
    "reports exact fixed-code lines for $label",
    async ({ body, httpStatus, bump, status, reason, exit: expectedExit }) => {
      const lines: string[] = [];
      const history = bump
        ? `journey-commit ${NOW - 60}\n- "version": "1.2.2"\n+ "version": "1.2.3"`
        : "";
      const failed = await checkPublishedVersions({
        ref: "main",
        registry: "https://registry.invalid",
        timeoutMs: 50,
        now: NOW,
        directories: ["ui"],
        gitRunner: (args) => ({
          exitCode: 0,
          stdout:
            args.at(0) === "show"
              ? JSON.stringify({ name: "@stll/ui", version: "1.2.3" })
              : history,
        }),
        registryFetch: async () => new Response(body, { status: httpStatus }),
        log: (line) => {
          lines.push(line);
        },
      });
      expect(failed).toBe(expectedExit === 1);
      expect(lines).toEqual([`journey registry-@stll/ui ${status} ${reason}`]);
      expect(lines.join("\n")).not.toContain(SENTINEL);
    },
  );
});

const provenanceStatement = ({
  version = "1.2.4",
  repository = "https://github.com/stella/moved.git",
}: {
  version?: string;
  repository?: string;
} = {}) => ({
  subject: [{ name: `pkg:npm/%40stll/fixture@${version}` }],
  predicate: {
    buildDefinition: { externalParameters: { workflow: { repository } } },
  },
});

const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const NPM_PUBLISH_ATTESTATION =
  "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";

const signedBundle = (
  statement: unknown,
  predicateType: string = SLSA_PROVENANCE,
) => ({
  predicateType,
  bundle: {
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toBase64(),
    },
  },
});

// The shape npm 11.20.0 prints for `npm audit signatures --json
// --include-attestations`: each verified package with its verified bundles.
const verifiedEntry = (
  version: string,
  bundles: readonly unknown[] = [
    signedBundle(provenanceStatement({ version }), NPM_PUBLISH_ATTESTATION),
    signedBundle(provenanceStatement({ version })),
  ],
) => ({
  name: "@stll/fixture",
  version,
  location: "node_modules/@stll/fixture",
  registry: "https://registry.npmjs.org/",
  attestations: {
    url: `https://registry.npmjs.org/-/npm/v1/attestations/@stll%2ffixture@${version}`,
    provenance: { predicateType: SLSA_PROVENANCE },
  },
  attestationBundles: bundles,
});
const auditReport = (verified: readonly unknown[]) =>
  JSON.stringify({ invalid: [], missing: [], verified });

const MOVED_LATEST = {
  version: "1.2.4",
  repository: "git+https://github.com/stella/moved.git/",
};

const runRepositoryCheck = async ({
  latest = MOVED_LATEST,
  movedRepository = "github.com/stella/moved",
  bumpedAt = NOW - 60,
  installedVersion = "1.2.4",
  npmResults = [
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: auditReport([verifiedEntry("1.2.4")]) },
  ],
}: {
  latest?: Record<string, unknown>;
  movedRepository?: string | undefined;
  bumpedAt?: number | undefined;
  installedVersion?: string;
  npmResults?: { exitCode: number; stdout: string }[];
} = {}) => {
  const npmCalls: Parameters<NpmRunner>[0][] = [];
  const npmRunner: NpmRunner = async (options) => {
    npmCalls.push(options);
    const result = npmResults.at(npmCalls.length - 1) ?? {
      exitCode: 1,
      stdout: "",
    };
    if (options.args.at(0) === "install" && result.exitCode === 0) {
      await Bun.write(
        path.join(
          options.cwd,
          "node_modules",
          "@stll",
          "fixture",
          "package.json",
        ),
        JSON.stringify({ name: "@stll/fixture", version: installedVersion }),
      );
    }
    return result;
  };
  const server = Bun.serve({ port: 0, fetch: () => Response.json(latest) });
  try {
    const result = await checkRegistry({
      name: "@stll/fixture",
      version: "1.2.3",
      movedRepository,
      bumpedAt,
      now: NOW,
      registry: server.url.toString(),
      timeoutMs: 5000,
      npmRunner,
    });
    return { result, npmCalls };
  } finally {
    await server.stop(true);
  }
};

const UNATTESTED = { status: "failed", reason: "unattested_publish" } as const;

describe("published repository provenance", () => {
  test.each([
    ["exact", "1.2.3", undefined, { status: "passed", reason: "ok" }],
    [
      "pending",
      "1.2.2",
      NOW - 60,
      { status: "skipped", reason: "publish_pending" },
    ],
    [
      "mismatch",
      "1.2.4",
      undefined,
      { status: "failed", reason: "version_mismatch", latest: "1.2.4" },
    ],
  ] as const)(
    "keeps %s behavior for the same repository",
    async (_, version, bumpedAt, expected) => {
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          Response.json({
            version,
            repository: { url: "git+https://github.com/STELLA/stella.git/" },
          }),
      });
      try {
        expect(
          await checkRegistry({
            name: "@stll/fixture",
            version: "1.2.3",
            movedRepository: undefined,
            bumpedAt,
            now: NOW,
            registry: server.url.toString(),
            timeoutMs: 5000,
          }),
        ).toEqual(expected);
      } finally {
        await server.stop(true);
      }
    },
  );

  test("accepts a moved package only with npm's verified provenance", async () => {
    const { result, npmCalls } = await runRepositoryCheck();
    expect(result).toEqual({
      status: "passed",
      reason: "published_from_declared_repository",
    });
    expect(npmCalls.map(({ args }) => args)).toEqual([
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry",
        expect.any(String),
      ],
      [
        "exec",
        "--yes",
        "npm@11.20.0",
        "--",
        "audit",
        "signatures",
        "--json",
        "--include-attestations",
        "--registry",
        expect.any(String),
      ],
    ]);
    expect(npmCalls.at(0)?.env["npm_config_cache"]).toStartWith(
      npmCalls.at(0)?.cwd ?? "not-called",
    );
  });

  test.each([
    [
      "an invalid attestation",
      JSON.stringify({
        invalid: [{ name: "@stll/fixture", version: "1.2.4" }],
        missing: [],
        verified: [],
      }),
    ],
    [
      "a missing attestation",
      JSON.stringify({
        invalid: [],
        missing: [{ name: "@stll/fixture", version: "1.2.4" }],
        verified: [],
      }),
    ],
    ["another package version", auditReport([verifiedEntry("9.9.9")])],
    [
      "an invalid dependency signature",
      JSON.stringify({
        invalid: [{ name: "@stll/fixture-dependency", version: "1.0.0" }],
        missing: [],
        verified: [verifiedEntry("1.2.4")],
      }),
    ],
    [
      "failures only, with no verified record (older npm)",
      JSON.stringify({ invalid: [], missing: [] }),
    ],
    [
      "a verified signature without a provenance bundle",
      auditReport([
        verifiedEntry("1.2.4", [
          signedBundle(provenanceStatement(), NPM_PUBLISH_ATTESTATION),
        ]),
      ]),
    ],
    [
      "verified provenance from another repository",
      auditReport([
        verifiedEntry("1.2.4", [
          signedBundle(
            provenanceStatement({
              repository: "https://github.com/stella/other",
            }),
          ),
        ]),
      ]),
    ],
    [
      "verified provenance for another subject version",
      auditReport([
        verifiedEntry("1.2.4", [
          signedBundle(provenanceStatement({ version: "1.2.3" })),
        ]),
      ]),
    ],
    [
      "a verified bundle with a malformed payload",
      auditReport([
        verifiedEntry("1.2.4", [
          {
            predicateType: SLSA_PROVENANCE,
            bundle: { dsseEnvelope: { payload: "not JSON" } },
          },
        ]),
      ]),
    ],
    ["a report without its lists", JSON.stringify({})],
  ])("rejects npm reporting %s", async (_, stdout) => {
    const { result } = await runRepositoryCheck({
      npmResults: [
        { exitCode: 0, stdout: "" },
        { exitCode: 0, stdout },
      ],
    });
    expect(result).toEqual(UNATTESTED);
  });

  test.each([
    [
      "a package that is not on the moved list",
      undefined,
      "https://github.com/stella/stella",
    ],
    [
      "a declared repository other than the listed move",
      "github.com/stella/moved",
      "https://github.com/stella/other",
    ],
  ])(
    "compares versions for %s without consulting provenance",
    async (_, movedRepository, declared) => {
      const { result, npmCalls } = await runRepositoryCheck({
        movedRepository,
        // Outside the publication window, so only an exact match could pass.
        bumpedAt: NOW - 2 * 24 * 60 * 60,
        latest: { version: "1.2.4", repository: declared },
      });
      expect(result).toEqual({
        status: "failed",
        reason: "version_mismatch",
        latest: "1.2.4",
      });
      expect(npmCalls).toHaveLength(0);
    },
  );

  test("rejects a verified audit when npm installed another version", async () => {
    const { result } = await runRepositoryCheck({ installedVersion: "1.2.3" });
    expect(result).toEqual(UNATTESTED);
  });

  test.each([
    ["an install failure", [{ exitCode: 1, stdout: "" }]],
    [
      "an audit failure",
      [
        { exitCode: 0, stdout: "" },
        { exitCode: 1, stdout: "{}" },
      ],
    ],
    [
      "malformed audit JSON",
      [
        { exitCode: 0, stdout: "" },
        { exitCode: 0, stdout: "not JSON" },
      ],
    ],
  ])("rejects npm returning %s", async (_, npmResults) => {
    const { result } = await runRepositoryCheck({ npmResults });
    expect(result).toEqual(UNATTESTED);
  });
});

type RegistryCheckResult = Awaited<ReturnType<typeof checkRegistry>>;

const policyResult = (
  status: RegistryCheckResult["status"],
  latest: string,
): RegistryCheckResult => {
  switch (status) {
    case "passed":
      return { status: "passed", reason: "ok" };
    case "skipped":
      return { status: "skipped", reason: "publish_pending" };
    case "failed":
      return { status: "failed", reason: "version_mismatch", latest };
    default: {
      status satisfies never;
      throw new Error("Unhandled policy status");
    }
  }
};

// Each row goes through both callers, including their different bump policies.
const POLICY_MATRIX = [
  {
    latest: "1.2.2",
    release: "unpublished",
    recent: "skipped",
    expired: "failed",
  },
  { latest: "1.2.3", release: "current", recent: "passed", expired: "passed" },
  { latest: "1.2.4", release: "current", recent: "skipped", expired: "failed" },
] as const;

describe("published version policy matrix", () => {
  for (const row of POLICY_MATRIX) {
    for (const window of ["recent", "expired"] as const) {
      test(`${row.latest} with ${window} bump keeps each caller's policy`, async () => {
        const pkg = { directory: "cli", name: "@stll/cli", version: "1.2.3" };
        expect(
          classifyPackage(pkg, {
            kind: "found",
            latest: row.latest,
            versions: [row.latest],
          }).status,
        ).toBe(row.release);
        const server = Bun.serve({
          port: 0,
          fetch: () => Response.json({ version: row.latest }),
        });
        try {
          const result = await checkRegistry({
            name: pkg.name,
            version: pkg.version,
            movedRepository: undefined,
            bumpedAt: NOW - (window === "recent" ? 86_399 : 86_400),
            now: NOW,
            registry: server.url.toString(),
            timeoutMs: 5000,
          });
          expect(result).toEqual(policyResult(row[window], row.latest));
        } finally {
          await server.stop(true);
        }
      });
    }
  }

  test("manifest selection keeps private and absent policies explicit", () => {
    const pkg = { directory: "cli", name: "@stll/cli", version: "1.2.3" };
    const text = JSON.stringify({ ...pkg, private: true });
    expect(
      readPublishablePackages({ only: ["cli"], readManifest: () => text }),
    ).toEqual([]);
    expect(
      readPackageManifest({ directory: "cli", text, policy: "journey" }),
    ).toEqual(pkg);
    expect(
      readPublishablePackages({ only: ["cli"], readManifest: () => undefined }),
    ).toEqual([]);
    expect(() =>
      readPackageManifest({
        directory: "cli",
        text: undefined,
        policy: "journey",
      }),
    ).toThrow(/package.json is absent/u);
    for (const policy of ["release", "journey"] as const) {
      expect(() =>
        readPackageManifest({ directory: "cli", text: "{}", policy }),
      ).toThrow(/has no name or version/u);
    }
  });
});

type RunLagCliOptions = {
  args: string[];
  manifest?: string;
  npmOutput?: string;
  npmError?: string;
};

const runLagCli = async ({
  args,
  manifest = '{"name":"@stll/cli","version":"1.2.3"}',
  npmOutput = '{"dist-tags":{"latest":"1.2.4"},"versions":["1.2.4"]}',
  npmError,
}: RunLagCliOptions) => {
  const directory = await mkdtemp(path.join(tmpdir(), "publish-lag-cli-"));
  try {
    const fakeGit = path.join(directory, "git");
    const fakeNpm = path.join(directory, "npm");
    await Bun.write(
      fakeGit,
      `#!${process.execPath}\nif (Bun.argv[2] === "tag") console.log("v1.0.0"); else console.log(${JSON.stringify(manifest)});\n`,
    );
    await Bun.write(
      fakeNpm,
      `#!${process.execPath}\n${npmError === undefined ? `console.log(${JSON.stringify(npmOutput)});` : `console.error(${JSON.stringify(npmError)}); process.exitCode = 1;`}\n`,
    );
    await chmod(fakeGit, 0o755);
    await chmod(fakeNpm, 0o755);
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("check-npm-publish-lag.ts", import.meta.url).pathname,
        ...args,
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("release CLI output contract", () => {
  test("keeps release and publish flags, stdout and exit zero exact", async () => {
    for (const [args, ref] of [
      [
        [
          "--ref",
          "published-sha",
          "--packages",
          "cli",
          "--attempts",
          "10",
          "--interval-seconds",
          "30",
        ],
        "published-sha",
      ],
      [["--previous-release-of", "HEAD", "--packages", "cli"], "v1.0.0"],
    ] as const) {
      expect(await runLagCli({ args: [...args] })).toEqual({
        exit: 0,
        stderr: "",
        stdout: `npm-publish-lag: ok, 1 package(s) at ${ref} are on npm.\npackage    repo   npm latest  status\n@stll/cli  1.2.3  1.2.4       current\n`,
      });
    }
  });

  test("keeps lagging stdout, stderr and exit one exact", async () => {
    expect(
      await runLagCli({
        args: ["--ref", "published-sha", "--packages", "cli"],
        npmOutput: '{"dist-tags":{"latest":"1.2.2"},"versions":"1.2.2"}',
      }),
    ).toEqual({
      exit: 1,
      stdout: "",
      stderr:
        "::error::npm-publish-lag: 1 package(s) at published-sha are not on npm: @stll/cli@1.2.3 (unpublished). Publish them with publish-npm.yml before releasing again.\npackage    repo   npm latest  status\n@stll/cli  1.2.3  1.2.2       unpublished\n",
    });
  });

  test("keeps bad arguments and manifests at exit two", async () => {
    expect(await runLagCli({ args: [] })).toEqual({
      exit: 2,
      stdout: "",
      stderr:
        "::error::npm-publish-lag: pass exactly one of --ref or --previous-release-of\n",
    });
    expect(
      await runLagCli({
        args: ["--ref", "HEAD", "--packages", "cli"],
        manifest: "{}",
      }),
    ).toEqual({
      exit: 2,
      stdout: "",
      stderr:
        "::error::npm-publish-lag: packages/cli/package.json has no name or version\n",
    });
  });

  test("keeps malformed registry JSON at guard exit three", async () => {
    const result = await runLagCli({
      args: ["--ref", "HEAD", "--packages", "cli"],
      npmOutput: "{",
    });
    expect(result.exit).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "::error::npm-publish-lag: JSON Parse error: Expected '}'\n",
    );
  });
});

const FIRST_RELEASE_CHANGESET =
  '---\n"@stll/fetch": minor\n---\n\nFirst release.\n';
const OTHER_CHANGESET = '---\n"@stll/ui": patch\n---\n\nOther.\n';

// Pending changeset files on main by path; null when the tree is unreadable.
type Changesets = Readonly<Record<string, string>> | null;
type ChangesetCase = { label: string; changesets: Changesets };

const runFirstPublish = async ({
  version,
  changesets,
  bumpedAt = NOW - 2 * 86_400,
}: {
  version: string;
  changesets: Changesets;
  bumpedAt?: number;
}) => {
  const lines: string[] = [];
  let registryReads = 0;
  const failed = await checkPublishedVersions({
    ref: "main",
    registry: "https://registry.invalid",
    timeoutMs: 50,
    now: NOW,
    directories: ["fetch"],
    gitRunner: (args) => {
      if (args.at(0) === "ls-tree") {
        return changesets === null
          ? { exitCode: 128, stdout: "" }
          : {
              exitCode: 0,
              stdout: [
                ".changeset/README.md",
                ...Object.keys(changesets),
                "",
              ].join("\n"),
            };
      }
      if (args.at(0) === "log") {
        return {
          exitCode: 0,
          stdout: `journey-commit ${bumpedAt}\n- "version": "0.0.0"\n+ "version": "${version}"`,
        };
      }
      const file = args.at(1)?.split(":").slice(1).join(":") ?? "";
      if (file === "packages/fetch/package.json") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ name: "@stll/fetch", version }),
        };
      }
      const entry = changesets?.[file];
      return entry === undefined
        ? { exitCode: 1, stdout: "" }
        : { exitCode: 0, stdout: entry };
    },
    registryFetch: async () => {
      registryReads += 1;
      return Response.json({ version: "0.0.1-placeholder.0" });
    },
    log: (line) => {
      lines.push(line);
    },
  });
  return { failed, lines, registryReads };
};

describe("first publish of an enrolled package", () => {
  test("is pending while main holds the enrollment version and a changeset names the package", async () => {
    const { failed, lines, registryReads } = await runFirstPublish({
      version: "0.0.0",
      changesets: {
        ".changeset/other.md": OTHER_CHANGESET,
        ".changeset/fetch-first-release.md": FIRST_RELEASE_CHANGESET,
      },
    });
    expect(failed).toBe(false);
    expect(registryReads).toBe(0);
    expect(lines).toEqual([
      "journey-detail registry-@stll/fetch first publish expected in the release that consumes .changeset/fetch-first-release.md",
      "journey registry-@stll/fetch skipped pending_first_publish",
    ]);
  });

  const unplannedCases: readonly ChangesetCase[] = [
    { label: "no pending changeset", changesets: {} },
    {
      label: "changesets for other packages only",
      changesets: { ".changeset/other.md": OTHER_CHANGESET },
    },
  ];
  test.each(unplannedCases)(
    "fails at the enrollment version with $label",
    async ({ changesets }) => {
      const { failed, lines, registryReads } = await runFirstPublish({
        version: "0.0.0",
        changesets,
      });
      expect(failed).toBe(true);
      expect(registryReads).toBe(0);
      expect(lines.at(-1)).toBe(
        "journey registry-@stll/fetch failed first_publish_unplanned",
      );
    },
  );

  test("is red again once the release that carries the first publish bumped main", async () => {
    // A later changeset for the same package must not reopen the pending state.
    const releasedCases: readonly Changesets[] = [
      {},
      { ".changeset/fetch-next.md": FIRST_RELEASE_CHANGESET },
    ];
    for (const changesets of releasedCases) {
      const { failed, lines } = await runFirstPublish({
        version: "0.1.0",
        changesets,
      });
      expect(failed).toBe(true);
      expect(lines).toEqual([
        "journey registry-@stll/fetch failed version_mismatch",
      ]);
    }
  });

  test("keeps only the ordinary bump grace after the release", async () => {
    const { failed, lines } = await runFirstPublish({
      version: "0.1.0",
      changesets: { ".changeset/fetch-next.md": FIRST_RELEASE_CHANGESET },
      bumpedAt: NOW - 60,
    });
    expect(failed).toBe(false);
    expect(lines).toEqual([
      "journey registry-@stll/fetch skipped publish_pending",
    ]);
  });

  const contractCases: readonly ChangesetCase[] = [
    { label: "an unreadable changeset tree", changesets: null },
    {
      label: "unterminated changeset frontmatter",
      changesets: { ".changeset/broken.md": '---\n"@stll/fetch": minor\n' },
    },
  ];
  test.each(contractCases)(
    "reports a contract error for $label",
    async ({ changesets }) => {
      const { failed, lines } = await runFirstPublish({
        version: "0.0.0",
        changesets,
      });
      expect(failed).toBe(true);
      expect(lines).toEqual([
        "journey registry-@stll/fetch failed contract_error",
      ]);
    },
  );
});
