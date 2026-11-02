import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { refreshRegistryWithDiagnostics } from "./registry-refresh-output.js";

// Both callers use this boundary, including the refresh after credentials are saved.
test("successful refresh reports projection persistence failures without discarding the registry", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stella-registry-output-"),
  );
  try {
    const configDir = path.join(directory, "config");
    await mkdir(configDir);
    await writeFile(path.join(configDir, "registry"), "not a directory");
    const messages: string[] = [];
    const tool = {
      name: "list_matters",
      description: "List matters",
      inputSchema: { type: "object", properties: {} },
    };
    const outcome = await refreshRegistryWithDiagnostics(
      {
        serverOrigin: "https://example.invalid",
        token: "synthetic-token",
        configDir,
        env: { XDG_CACHE_HOME: path.join(directory, "cache") },
        force: true,
        now: 1_800_000_000_000,
        currentVersion: "6.2.0",
        bakedListings: [tool],
        fetchRaw: async () =>
          Result.ok({ rawBody: JSON.stringify({ tools: [tool] }) }),
      },
      (message) => {
        messages.push(message);
      },
    );
    expect(outcome.status).toBe("refreshed");
    if (outcome.status === "refreshed") {
      expect(outcome.registry.listings).toEqual([tool]);
      expect(outcome.cacheWarning).toBe(
        "Registry cache could not be saved; a later command may fetch it again.",
      );
    }
    expect(messages).toEqual([
      "Registry cache could not be saved; a later command may fetch it again.",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
