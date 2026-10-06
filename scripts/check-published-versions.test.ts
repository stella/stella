import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareCodeUnit } from "../packages/collation/src/collation";
import {
  checkRegistry,
  classifyPackage,
  readPackageManifest,
  readPublishablePackages,
  versionBumpTime,
  type RegistryResult,
} from "./check-npm-publish-lag";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

const NOW = 2_000_000_000;
const SENTINEL = "registry-private-response";

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

const POLICY_RESULTS = {
  passed: { status: "passed", reason: "ok" },
  skipped: { status: "skipped", reason: "publish_pending" },
  failed: { status: "failed", reason: "version_mismatch" },
} as const satisfies Record<RegistryResult["status"], RegistryResult>;

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
            bumpedAt: NOW - (window === "recent" ? 86_399 : 86_400),
            now: NOW,
            registry: server.url.toString(),
            timeoutMs: 5000,
          });
          expect(result).toEqual(POLICY_RESULTS[row[window]]);
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
