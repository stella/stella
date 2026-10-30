import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  backgroundUpdateCheckEnabled,
  detectInstallChannel,
  upgradeCommandFor,
} from "../install-channel.js";
import { sha256Hex } from "../sha256.js";
import { type UpdateFetch, updateNative } from "./update.js";

const replacement = new TextEncoder().encode("new executable");
const fakeRelease =
  (checksum: string): UpdateFetch =>
  async (input) =>
    new Response(
      String(input).endsWith("checksums.txt")
        ? `${checksum}  stella-linux-x64\n`
        : replacement,
    );

describe("native self update", () => {
  test("a missing channel marker defaults to npm", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-channel-"));
    try {
      expect(
        await detectInstallChannel({
          configDir: dir,
          entrypoint: "/tmp/stella",
          executablePath: "/tmp/stella",
        }),
      ).toEqual(Result.ok("npm"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("channel read failures and invalid records return tagged errors", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "stella-channel-failure-"),
    );
    const options = {
      configDir: dir,
      entrypoint: "/native/stella",
      executablePath: "/native/stella",
    };
    try {
      await mkdir(path.join(dir, "install-channel"));
      const unreadable = await detectInstallChannel(options);
      expect(Result.isError(unreadable)).toBe(true);
      if (Result.isError(unreadable)) {
        expect(unreadable.error._tag).toBe("InstallChannelError");
        expect(unreadable.error.cause).toMatchObject({ code: "EISDIR" });
      }
      await rm(path.join(dir, "install-channel"), { recursive: true });
      await writeFile(path.join(dir, "install-channel"), "unknown-channel");
      const invalid = await detectInstallChannel(options);
      expect(Result.isError(invalid)).toBe(true);
      if (Result.isError(invalid)) {
        expect(invalid.error.message).toContain("invalid");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an insecure release redirect before requesting its target", async () => {
    const requests: string[] = [];
    const result = await updateNative({
      channel: "native",
      executablePath: "/unused",
      platform: "linux",
      arch: "x64",
      fetcher: async (input) => {
        requests.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: "http://example.test/stella" },
        });
      },
    });
    expect(Result.isError(result)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(
      requests.every((url) =>
        url.startsWith("https://github.com/stella/stella/releases/"),
      ),
    ).toBe(true);
  });

  test("checksum failure preserves the executable and leaves no staged binary", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-update-"));
    try {
      const executablePath = path.join(dir, "stella");
      await writeFile(executablePath, "old executable");
      const result = await updateNative({
        channel: "native",
        executablePath,
        platform: "linux",
        arch: "x64",
        fetcher: fakeRelease("0".repeat(64)),
      });
      expect(Result.isError(result)).toBe(true);
      expect(await readFile(executablePath, "utf-8")).toBe("old executable");
      expect(await readdir(dir)).toEqual(["stella"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a verified release atomically replaces the executable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-update-"));
    try {
      const executablePath = path.join(dir, "stella");
      await writeFile(executablePath, "old executable");
      const oldHandle = await open(executablePath, "r");
      try {
        const result = await updateNative({
          channel: "native",
          executablePath,
          platform: "linux",
          arch: "x64",
          fetcher: fakeRelease(sha256Hex(replacement)),
          version: "6.2.0",
        });
        expect(Result.isOk(result)).toBe(true);
        expect(await readFile(executablePath, "utf-8")).toBe("new executable");
        expect(await oldHandle.readFile("utf-8")).toBe("old executable");
        expect(await readdir(dir)).toEqual(["stella"]);
      } finally {
        await oldHandle.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each(["npm", "homebrew"] as const)(
    "%s stays with its package manager without making a request",
    async (channel) => {
      let requests = 0;
      const result = await updateNative({
        channel,
        executablePath: "/unused",
        fetcher: async () => {
          requests += 1;
          return new Response();
        },
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain(upgradeCommandFor(channel));
      }
      expect(requests).toBe(0);
    },
  );

  test("CI and explicit opt out disable background checks", () => {
    expect(backgroundUpdateCheckEnabled({ CI: "true" })).toBe(false);
    expect(backgroundUpdateCheckEnabled({ STELLA_NO_UPDATE_CHECK: "1" })).toBe(
      false,
    );
    expect(backgroundUpdateCheckEnabled({})).toBe(true);
  });

  test("a native marker never takes ownership of the npm entrypoint", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-channel-"));
    try {
      await writeFile(path.join(dir, "install-channel"), "native\n");
      expect(
        await detectInstallChannel({
          configDir: dir,
          entrypoint: "/prefix/lib/node_modules/@stll/cli/dist/cli.js",
          executablePath: "/prefix/bin/node",
        }),
      ).toEqual(Result.ok("npm"));
      expect(
        await detectInstallChannel({
          configDir: dir,
          entrypoint: "/source/packages/cli/src/cli.ts",
          executablePath: "/usr/local/bin/bun",
        }),
      ).toEqual(Result.ok("npm"));
      expect(
        await detectInstallChannel({
          configDir: dir,
          entrypoint: "/home/user/.local/bin/stella",
          executablePath: "/home/user/.local/bin/stella",
        }),
      ).toEqual(Result.ok("native"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
