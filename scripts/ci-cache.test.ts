import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCacheWorker } from "./ci-cache";

const fixture = async (
  source: string,
  operation: "restore" | "save",
  stallMs = 1000,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-cache-"));
  const entry = path.join(directory, "worker.cjs");
  writeFileSync(entry, source);
  try {
    return await runCacheWorker({ operation, entry, stallMs });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("a 429 on restore becomes a cache miss with exit zero", async () => {
  expect(
    await fixture(
      "console.error('Rate limited: GetCacheEntryDownloadURL (HTTP 429)'); process.exit(1)",
      "restore",
    ),
  ).toBe(0);
});

test("a stalled save emits typed infrastructure skip telemetry with exit zero", async () => {
  const messages: string[] = [];
  const original = console.log;
  console.log = (message) => {
    messages.push(String(message));
  };
  try {
    expect(await fixture("setInterval(() => {}, 1000)", "save", 50)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(messages).toContain(
    "::warning title=cache-save-skipped::kind=infra class=cache-save outcome=skipped reason=stalled idle_ms=50",
  );
});

test("a corrupt restored archive still fails", async () => {
  expect(
    await fixture(
      "console.error('Failed to extract cache: invalid archive'); process.exit(1)",
      "restore",
    ),
  ).toBe(1);
});
