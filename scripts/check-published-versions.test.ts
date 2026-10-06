import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareCodeUnit } from "../packages/collation/src/collation";
import { checkRegistry, versionBumpTime } from "./check-published-versions";
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
  test("reports every registry probe and contains command and response diagnostics", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "registry-journey-"));
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(SENTINEL, { status: 503 });
      },
    });
    try {
      const fakeGit = path.join(directory, "git");
      await Bun.write(
        fakeGit,
        `#!${process.execPath}\nconsole.error(${JSON.stringify(SENTINEL)});\nif (Bun.argv[2] === "show") { const directory = Bun.argv[3].split(":")[1].split("/")[1]; console.log(JSON.stringify({name:"@stll/"+directory, version:"1.2.3"})); }\n`,
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
      expect(exit).toBe(1);
      expect(stderr).toBe("");
      expect(stdout).not.toContain(SENTINEL);
      expect(stdout.trim().split("\n").toSorted(compareCodeUnit)).toEqual(
        ALL_PACKAGE_ORDER.map(
          (name) => `journey registry-@stll/${name} failed http_status`,
        ).toSorted(compareCodeUnit),
      );
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
