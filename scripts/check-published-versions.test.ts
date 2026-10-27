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
  type RegistryResult,
  versionBumpTime,
} from "./check-npm-publish-lag";
import {
  checkPublishedVersions,
  type GitRunner,
} from "./check-published-versions";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

const NOW = 2_000_000_000;
const SENTINEL = "registry-private-response";
const BUMP_COMMIT = "a".repeat(40);
const DEPLOYED_COMMIT = "b".repeat(40);

const journeyGit =
  ({
    deployedContainsBump = false,
    tag = "v1.2.3",
    recent = false,
    shallow = "false",
  }: {
    deployedContainsBump?: boolean;
    tag?: string;
    recent?: boolean;
    shallow?: string;
  } = {}): GitRunner =>
  (args) => {
    const command = args.join(" ");
    if (command === "rev-parse --is-shallow-repository") {
      return { exitCode: 0, stdout: `${shallow}\n` };
    }
    if (args.at(0) === "show" && args.at(1)?.includes(":packages/")) {
      const directory =
        args.at(1)?.split(":packages/").at(1)?.split("/").at(0) ?? "unknown";
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          name: `@stll/${directory}`,
          version: "1.2.3",
        }),
      };
    }
    if (args.at(0) === "log" && args.includes("--format=journey-commit %ct")) {
      return {
        exitCode: 0,
        stdout: recent
          ? `journey-commit ${NOW - 60}\n- "version": "1.2.2"\n+ "version": "1.2.3"`
          : "",
      };
    }
    if (args.at(0) === "log" && args.includes("--format=%H")) {
      return { exitCode: 0, stdout: `${BUMP_COMMIT}\n` };
    }
    if (args.at(0) === "cat-file") {
      return { exitCode: 0, stdout: "" };
    }
    if (args.at(0) === "merge-base") {
      return { exitCode: deployedContainsBump ? 0 : 1, stdout: "" };
    }
    if (args.at(0) === "tag") {
      return { exitCode: 0, stdout: `${tag}\n` };
    }
    if (command === `show ${BUMP_COMMIT}:VERSION`) {
      return { exitCode: 0, stdout: "1.2.4\n" };
    }
    return { exitCode: 2, stdout: "" };
  };

const runJourney = async ({
  gitRunner = journeyGit(),
  healthFetch = async () => Response.json({ commit: DEPLOYED_COMMIT }),
  registryVersion = "1.2.2",
  directories = ["cli"],
}: {
  gitRunner?: GitRunner;
  healthFetch?: RegistryFetch;
  registryVersion?: string;
  directories?: readonly (typeof ALL_PACKAGE_ORDER)[number][];
} = {}) => {
  const lines: string[] = [];
  let healthRequests = 0;
  const failed = await checkPublishedVersions({
    ref: "main",
    registry: "https://registry.invalid",
    cliUrl: "https://api.invalid",
    timeoutMs: 50,
    now: NOW,
    directories,
    gitRunner,
    healthFetch: async (...args) => {
      healthRequests += 1;
      return healthFetch(...args);
    },
    registryFetch: async () => Response.json({ version: registryVersion }),
    log: (line) => {
      lines.push(line);
    },
  });
  return { failed, lines, healthRequests };
};

describe("release promotion diagnosis", () => {
  test("names the oldest stable release containing an undeployed bump", async () => {
    const result = await runJourney();
    expect(result).toEqual({
      failed: true,
      healthRequests: 1,
      lines: [
        "journey registry-@stll/cli failed publish_awaits_promote",
        "journey-detail registry-@stll/cli awaits v1.2.3",
      ],
    });
  });

  test("names the earliest stable version despite reversed annotated-tag creation dates", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "journey-release-tags-"),
    );
    const runGit = (args: readonly string[], date = "2026-01-01T00:00:00Z") => {
      const result = Bun.spawnSync(
        [
          "git",
          "-C",
          directory,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        {
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_COMMITTER_DATE: date,
            GIT_AUTHOR_DATE: date,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(0);
      return {
        exitCode: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
      };
    };
    try {
      runGit(["init", "--quiet"]);
      runGit(["commit", "--allow-empty", "-qm", "fixture"]);
      const commit = runGit(["rev-parse", "HEAD"]).stdout.trim();
      runGit(["tag", "-a", "v1.2.5-rc.1", "-m", "prerelease"]);
      runGit(
        ["tag", "-a", "v1.2.4", "-m", "later version"],
        "2026-01-02T00:00:00Z",
      );
      runGit(
        ["tag", "-a", "v1.2.3", "-m", "earlier version"],
        "2026-01-03T00:00:00Z",
      );
      expect(
        runGit(["tag", "--contains", commit, "--sort=creatordate"])
          .stdout.trim()
          .split("\n"),
      ).toEqual(["v1.2.5-rc.1", "v1.2.4", "v1.2.3"]);
      const base = journeyGit();
      const gitRunner: GitRunner = (args) =>
        args.at(0) === "tag"
          ? runGit(args.map((arg) => (arg === BUMP_COMMIT ? commit : arg)))
          : base(args);
      const { lines } = await runJourney({ gitRunner });
      expect(lines).toContain(
        "journey-detail registry-@stll/cli awaits v1.2.3",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("names an untagged bump from its VERSION file", async () => {
    const { lines } = await runJourney({
      gitRunner: journeyGit({ tag: "preview" }),
    });
    expect(lines).toContain(
      "journey-detail registry-@stll/cli awaits v1.2.4 (untagged)",
    );
  });

  test("keeps a registry ahead of main as a mismatch without fetching health", async () => {
    const { lines, healthRequests } = await runJourney({
      registryVersion: "1.2.4",
    });
    expect(healthRequests).toBe(0);
    expect(lines).toEqual([
      "journey registry-@stll/cli failed version_mismatch",
    ]);
  });

  test("keeps a deployed bump as a registry mismatch", async () => {
    const { lines } = await runJourney({
      gitRunner: journeyGit({ deployedContainsBump: true }),
    });
    expect(lines).toEqual([
      "journey registry-@stll/cli failed version_mismatch",
    ]);
  });

  test.each([
    [
      "times out",
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ],
    ["returns non-JSON", async () => new Response("not json")],
    ["omits commit", async () => Response.json({ status: "ok" })],
  ] as const)("fails closed when health %s", async (_, healthFetch) => {
    const { lines } = await runJourney({ healthFetch });
    expect(lines).toEqual([
      "journey registry-@stll/cli failed version_mismatch",
    ]);
  });

  test.each([
    ["is shallow", journeyGit({ shallow: "true" })],
    [
      "cannot report its depth",
      (
        (base: GitRunner): GitRunner =>
        (args) =>
          args.at(0) === "rev-parse"
            ? { exitCode: 128, stdout: "" }
            : base(args)
      )(journeyGit()),
    ],
  ] as const)(
    "fails closed without fetching health when history %s",
    async (_, gitRunner) => {
      const { lines, healthRequests } = await runJourney({ gitRunner });
      expect(healthRequests).toBe(0);
      expect(lines).toEqual([
        "journey registry-@stll/cli failed version_mismatch",
      ]);
    },
  );

  test("fails closed when the deployed commit is absent locally", async () => {
    const base = journeyGit();
    const gitRunner: GitRunner = (args) =>
      args.at(0) === "cat-file" ? { exitCode: 1, stdout: "" } : base(args);
    const { lines } = await runJourney({ gitRunner });
    expect(lines).toEqual([
      "journey registry-@stll/cli failed version_mismatch",
    ]);
  });

  test.each([
    ["matching npm version", { registryVersion: "1.2.3" }],
    ["recent bump", { gitRunner: journeyGit({ recent: true }) }],
  ] as const)("does not fetch health for a %s", async (_, options) => {
    const { healthRequests, lines } = await runJourney(options);
    expect(healthRequests).toBe(0);
    expect(lines.at(0)).toMatch(/ (passed ok|skipped publish_pending)$/u);
  });

  test("fetches health once for several lagging packages", async () => {
    const { healthRequests } = await runJourney({
      directories: ["cli", "chat", "ui"],
    });
    expect(healthRequests).toBe(1);
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
      const directory = await mkdtemp(path.join(tmpdir(), "registry-journey-"));
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response(body, { status: httpStatus });
        },
      });
      try {
        const fakeGit = path.join(directory, "git");
        const history = bump
          ? `journey-commit ${Math.floor(Date.now() / 1000) - 60}\n- "version": "1.2.2"\n+ "version": "1.2.3"`
          : "";
        await Bun.write(
          fakeGit,
          `#!${process.execPath}\nconsole.error(${JSON.stringify(SENTINEL)});\nif (Bun.argv[2] === "show") { const directory = Bun.argv[3].split(":")[1].split("/")[1]; console.log(JSON.stringify({name:"@stll/"+directory, version:"1.2.3"})); } else console.log(${JSON.stringify(history)});\n`,
        );
        await chmod(fakeGit, 0o755);
        const child = Bun.spawn(
          [
            process.execPath,
            new URL("check-published-versions.ts", import.meta.url).pathname,
          ],
          {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
              JOURNEY_NPM_REGISTRY_URL: server.url.toString(),
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
        expect(exit).toBe(expectedExit);
        expect(stderr).toBe("");
        expect(stdout).not.toContain(SENTINEL);
        expect(stdout.trim().split("\n").toSorted(compareCodeUnit)).toEqual(
          ALL_PACKAGE_ORDER.map(
            (name) => `journey registry-@stll/${name} ${status} ${reason}`,
          ).toSorted(compareCodeUnit),
        );
      } finally {
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
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

const policyResult = (
  status: RegistryResult["status"],
  latest: string,
): RegistryResult => {
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
  versionFile?: string;
  tags?: readonly string[];
};

const runLagCli = async ({
  args,
  manifest = '{"name":"@stll/cli","version":"1.2.3"}',
  npmOutput = '{"dist-tags":{"latest":"1.2.4"},"versions":["1.2.4"]}',
  npmError,
  versionFile = "1.2.4",
  tags = ["v9.0.0", "v1.2.4", "v1.2.4-rc.1", "v1.0.0"],
}: RunLagCliOptions) => {
  const directory = await mkdtemp(path.join(tmpdir(), "publish-lag-cli-"));
  try {
    const fakeGit = path.join(directory, "git");
    const fakeNpm = path.join(directory, "npm");
    await Bun.write(
      fakeGit,
      `#!${process.execPath}\nif (Bun.argv[2] === "tag") console.log(${JSON.stringify(tags.join("\n"))}); else if (Bun.argv[2] === "show" && Bun.argv[3].endsWith(":VERSION")) console.log(${JSON.stringify(versionFile)}); else console.log(${JSON.stringify(manifest)});\n`,
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
