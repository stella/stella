import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  configFilePath,
  getRegisteredClient,
  readCliConfig,
  registeredClientSupportsScopes,
  setRegisteredClient,
} from "./cli-config.js";

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

describe("OAuth client registration cache", () => {
  test("treats a legacy scope-less entry as requiring one-time registration", async () => {
    await withConfigDir(async (configDir) => {
      await writeFile(
        configFilePath(configDir),
        JSON.stringify({
          oauthClients: {
            "https://api.example.com": {
              clientId: "legacy-client",
              registeredAt: 1,
            },
          },
          version: 1,
        }),
      );

      const client = await getRegisteredClient(
        configDir,
        "https://api.example.com",
      );
      expect(client).toBeDefined();
      if (client !== undefined) {
        expect(registeredClientSupportsScopes(client, ["stella:read"])).toBe(
          false,
        );
      }
    });
  });

  test("persists negotiated scopes and detects a later scope expansion", async () => {
    await withConfigDir(async (configDir) => {
      await setRegisteredClient(
        configDir,
        "https://api.example.com",
        "current-client",
        ["openid", "stella:read"],
      );

      const client = await getRegisteredClient(
        configDir,
        "https://api.example.com",
      );
      expect(client).toBeDefined();
      if (client !== undefined) {
        expect(
          registeredClientSupportsScopes(client, ["openid", "stella:read"]),
        ).toBe(true);
        expect(
          registeredClientSupportsScopes(client, [
            "openid",
            "stella:read",
            "stella:admin_write",
          ]),
        ).toBe(false);
      }

      const config = await readCliConfig(configDir);
      expect(
        config.oauthClients["https://api.example.com"]?.registeredScopes,
      ).toEqual(["openid", "stella:read"]);
    });
  });
});
