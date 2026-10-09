import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PromotedReleaseAmbiguousError,
  PromotedReleaseManifestError,
  PromotedReleaseMissingError,
  resolvePromotedRelease,
} from "./resolve-promoted-release";

test("selects the most recently recorded production promotion", () => {
  const result = resolvePromotedRelease({
    _note: "fixture",
    "v1.2.2": "2026-01-01T00:00:00Z",
    "v1.2.3": null,
    "v1.2.4": "2026-02-01T00:00:00Z",
  });

  expect(result.unwrap()).toBe("v1.2.4");
});

test("orders valid publication times with supported precision and offsets", () => {
  const result = resolvePromotedRelease({
    "v1.2.2": "2026-02-01T01:30:00.123+02:00",
    "v1.2.3": "2026-02-01T00:00:00.456Z",
    "v1.2.4": "2026-01-31T20:00:00-04:00",
  });

  expect(result.unwrap()).toBe("v1.2.3");
});

test.each(["2026-02-30T00:00:00Z", "2026-01-01 00:00:00Z"])(
  "rejects invalid publication time %s",
  (publishedAt) => {
    const result = resolvePromotedRelease({ "v1.2.3": publishedAt });

    if (!Result.isError(result)) {
      panic("the invalid publication time unexpectedly resolved");
    }
    expect(result.error).toBeInstanceOf(PromotedReleaseManifestError);
  },
);

test("returns typed failures for malformed, missing, or ambiguous promotions", () => {
  const malformed = resolvePromotedRelease({ "v1.2.2": 1_769_990_400_000 });
  if (!Result.isError(malformed)) {
    panic("the malformed promotion unexpectedly resolved");
  }
  expect(malformed.error).toBeInstanceOf(PromotedReleaseManifestError);

  const missing = resolvePromotedRelease({ "v1.2.3": null });
  if (!Result.isError(missing)) {
    panic("the missing promotion unexpectedly resolved");
  }
  expect(missing.error).toBeInstanceOf(PromotedReleaseMissingError);

  const ambiguous = resolvePromotedRelease({
    "v1.2.3": "2026-02-01T00:00:00Z",
    "v1.2.4": "2026-02-01T00:00:00Z",
  });
  if (!Result.isError(ambiguous)) {
    panic("the ambiguous promotion unexpectedly resolved");
  }
  expect(ambiguous.error).toBeInstanceOf(PromotedReleaseAmbiguousError);
});

test("resolves fixture promotions with network transports disabled", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "resolve-promoted-release-"),
  );
  try {
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    const curl = path.join(bin, "curl");
    await writeFile(
      curl,
      "#!/usr/bin/env bash\necho 'curl was called' >&2\nexit 97\n",
    );
    await chmod(curl, 0o755);
    const manifest = path.join(directory, "release-manifest.json");

    for (const { contents, expectedRef } of [
      {
        contents: {
          "v1.2.3": "2026-01-01T00:00:00Z",
          "v1.2.4": "2026-02-01T00:00:00Z",
        },
        expectedRef: "v1.2.4",
      },
      {
        contents: {
          "v1.2.3": "2026-01-01T00:00:00Z",
          "v1.2.4": "2026-02-01T00:00:00Z",
          "v1.2.5": "2026-03-01T00:00:00Z",
        },
        expectedRef: "v1.2.5",
      },
    ]) {
      await writeFile(manifest, JSON.stringify(contents));
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "--preload",
          path.join(import.meta.dir, "offline-network-preload.ts"),
          path.join(import.meta.dir, "resolve-promoted-release.ts"),
          "--check",
          "--manifest",
          manifest,
        ],
        cwd: path.join(import.meta.dir, ".."),
        env: {
          PATH: `${bin}:${Bun.env["PATH"] ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toBe(`${expectedRef}\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the migration rehearsal resolves its base from the offline release record", async () => {
  const workflow = await readFile(
    path.join(import.meta.dir, "../.github/workflows/ci.yml"),
    "utf-8",
  );
  const start = workflow.indexOf("      - name: Resolve the promoted release");
  const end = workflow.indexOf("\n      - name:", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const step = workflow.slice(start, end);

  expect(step).toContain("scripts/resolve-promoted-release.ts --check");
  expect(step).toContain("scripts/offline-network-preload.ts");
  expect(step).not.toContain("curl");
  expect(step).not.toContain("/ready");
});
