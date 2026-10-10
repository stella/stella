import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { rootDb } from "@/api/db/root";
import { documentProcessingEnvInvariantViolation } from "@/api/env-document-processing-worker-schema";
import { createBullMqWorkerHost } from "@/api/lib/bullmq-queue";

const SRC_DIR = path.resolve(import.meta.dir, "..");
const HOST_ENTRYPOINTS = [
  "api-background-workers.ts",
  "scripts/document-processing-worker.ts",
];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.")
      ? [full]
      : [];
  });

describe("createBullMqWorkerHost mode", () => {
  const start = (mode: "enabled" | "disabled") => {
    const events: string[] = [];
    const host = createBullMqWorkerHost(
      "document-processing-worker",
      { db: rootDb },
      mode,
      [
        () => {
          events.push("started");
          return {
            queues: ["document-processing"],
            close: async () => {
              events.push("closed");
            },
          };
        },
      ],
    );
    return { events, host };
  };

  test("a disabled host starts no worker", async () => {
    const { events, host } = start("disabled");
    await host.close();
    expect(events).toEqual([]);
  });

  test("an enabled host starts and closes its workers", async () => {
    const { events, host } = start("enabled");
    await host.close();
    expect(events).toEqual(["started", "closed"]);
  });
});

describe("background queue workers", () => {
  test("every queue worker is started by a host, so the mode switch covers it", () => {
    const hosted = new Set(
      HOST_ENTRYPOINTS.flatMap((entrypoint) =>
        [
          ...readFileSync(path.join(SRC_DIR, entrypoint), "utf-8").matchAll(
            /from "@\/api\/([^"]+)"/gu,
          ),
        ].map(([, specifier]) => `${specifier ?? ""}.ts`),
      ),
    );
    const unhosted = sourceFiles(SRC_DIR)
      .filter((file) => /new BullMqWorker\b/u.test(readFileSync(file, "utf-8")))
      .map((file) => repoRelativePath(SRC_DIR, file))
      .filter((file) => !hosted.has(file));

    expect(unhosted).toEqual([]);
  });
});

describe("document-processing worker mode", () => {
  const input = {
    contentEncryptionKey: undefined,
    redisUrl: "redis://localhost:6379",
    scheduledJobsMode: "disabled",
  } as const;

  test("disabled workers are accepted only in local development", () => {
    expect(
      documentProcessingEnvInvariantViolation({
        ...input,
        runtimeMode: { mode: "open" },
      }),
    ).toBeNull();
    expect(
      documentProcessingEnvInvariantViolation({
        ...input,
        contentEncryptionKey: "a".repeat(64),
        runtimeMode: { mode: "strict" },
      }),
    ).toContain("only supported in local development");
  });
});
