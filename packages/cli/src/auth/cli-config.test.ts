import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { configFilePath, readCliConfig, writeCliConfig } from "./cli-config.js";

const withConfigDir = async (
  run: (configDir: string) => Promise<void>,
): Promise<void> => {
  const configDir = await mkdtemp(path.join(tmpdir(), "stella-cli-config-"));
  try {
    await run(configDir);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
};

describe("CLI config", () => {
  test("keeps the default server of a file holding clients an earlier version registered", async () => {
    await withConfigDir(async (configDir) => {
      await writeFile(
        configFilePath(configDir),
        JSON.stringify({
          defaultServerUrl: "https://api.example.com",
          oauthClients: {
            "https://api.example.com": {
              clientId: "registered-client",
              registeredAt: 1,
              registeredScopes: ["openid", "stella:read"],
            },
          },
          version: 1,
        }),
      );

      const config = await readCliConfig(configDir);
      expect(config).toEqual({
        defaultServerUrl: "https://api.example.com",
        version: 1,
      });

      await writeCliConfig(configDir, config);
      const written: unknown = JSON.parse(
        await readFile(configFilePath(configDir), "utf-8"),
      );
      expect(written).toEqual({
        defaultServerUrl: "https://api.example.com",
        version: 1,
      });
    });
  });

  test("a missing or corrupt file reads as the empty config", async () => {
    await withConfigDir(async (configDir) => {
      expect(await readCliConfig(configDir)).toEqual({ version: 1 });
      await writeFile(configFilePath(configDir), "{ not json");
      expect(await readCliConfig(configDir)).toEqual({ version: 1 });
    });
  });
});
