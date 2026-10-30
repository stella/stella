import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
import { pathToFileURL } from "node:url";

import { CLI_VERSION } from "../generated/cli-version.js";
import {
  backgroundUpdateCheckEnabled,
  detectInstallChannel,
  upgradeCommandFor,
} from "../install-channel.js";
import { sha256Hex } from "../sha256.js";
import { type UpdateFetch, updateNative } from "./update.js";

const replacement = new TextEncoder().encode("new executable");
const newerVersion = `${Number(CLI_VERSION.split(".").at(0)) + 1}.0.0`;
const fakeRelease =
  (
    checksum: string,
    version = newerVersion,
    requests: string[] = [],
  ): UpdateFetch =>
  async (input) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.pathname.includes("/latest/download/")) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://github.com/stella/stella/releases/download/v${version}/stella-linux-x64`,
        },
      });
    }
    return new Response(
      url.pathname.endsWith("checksums.txt")
        ? `${checksum}  stella-linux-x64\n`
        : replacement,
    );
  };

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
    expect(requests).toHaveLength(1);
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
      if (Result.isError(result)) {
        expect(result.error.message).toContain("checksum verification failed");
      }
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
          beforeReplace: ({ from, to, direction }) => {
            expect({ from, to, direction }).toEqual({
              from: CLI_VERSION,
              to: newerVersion,
              direction: "upgrade",
            });
            expect(readFileSync(executablePath, "utf-8")).toBe(
              "old executable",
            );
          },
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

  test("a lower latest release refuses before changing the executable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-downgrade-"));
    const executablePath = path.join(dir, "stella");
    const requests: string[] = [];
    try {
      await writeFile(executablePath, "old executable");
      const result = await updateNative({
        channel: "native",
        executablePath,
        platform: "linux",
        arch: "x64",
        fetcher: fakeRelease(sha256Hex(replacement), "0.0.1", requests),
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain("--allow-downgrade");
      }
      expect(await readFile(executablePath, "utf-8")).toBe("old executable");
      expect(await readdir(dir)).toEqual(["stella"]);
      expect(requests.some((url) => url.endsWith("checksums.txt"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an equal latest version leaves the executable alone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-equal-update-"));
    const executablePath = path.join(dir, "stella");
    try {
      await writeFile(executablePath, "old executable");
      const result = await updateNative({
        channel: "native",
        executablePath,
        platform: "linux",
        arch: "x64",
        fetcher: fakeRelease(sha256Hex(replacement), CLI_VERSION),
      });
      expect(result).toEqual(
        Result.ok(`stella ${CLI_VERSION} is already current.`),
      );
      expect(await readFile(executablePath, "utf-8")).toBe("old executable");
      expect(await readdir(dir)).toEqual(["stella"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an explicit downgrade verifies and reports the transition before replacing", async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "stella-opt-in-downgrade-"),
    );
    const executablePath = path.join(dir, "stella");
    const transitions: string[] = [];
    try {
      await writeFile(executablePath, "old executable");
      const result = await updateNative({
        channel: "native",
        executablePath,
        platform: "linux",
        arch: "x64",
        allowDowngrade: true,
        fetcher: fakeRelease(sha256Hex(replacement), "0.0.1"),
        beforeReplace: ({ from, to, direction }) => {
          expect(readFileSync(executablePath, "utf-8")).toBe("old executable");
          transitions.push(`${direction}: ${from} -> ${to}`);
        },
      });
      expect(Result.isOk(result)).toBe(true);
      expect(transitions).toEqual([`downgrade: ${CLI_VERSION} -> 0.0.1`]);
      expect(await readFile(executablePath, "utf-8")).toBe("new executable");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each(["not-a-version", "01.2.3", "1.2", "1.2.3-rc.1"])(
    "a malformed release version %s refuses before replacement",
    async (version) => {
      const result = await updateNative({
        channel: "native",
        executablePath: "/unused",
        platform: "linux",
        arch: "x64",
        fetcher: fakeRelease(sha256Hex(replacement), version),
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain("malformed stable version");
      }
    },
  );

  test("a response without a versioned GitHub redirect fails closed", async () => {
    const result = await updateNative({
      channel: "native",
      executablePath: "/unused",
      platform: "linux",
      arch: "x64",
      fetcher: async () => new Response(replacement),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toContain(
        "did not identify a stable target version",
      );
    }
  });

  test("checksums are fetched from the resolved version instead of latest", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-pinned-update-"));
    const requests: string[] = [];
    try {
      const result = await updateNative({
        channel: "native",
        executablePath: path.join(dir, "stella"),
        platform: "linux",
        arch: "x64",
        fetcher: fakeRelease(sha256Hex(replacement), newerVersion, requests),
      });
      expect(Result.isOk(result)).toBe(true);
      expect(requests).toContain(
        `https://github.com/stella/stella/releases/download/v${newerVersion}/checksums.txt`,
      );
      expect(requests).not.toContain(
        "https://github.com/stella/stella/releases/latest/download/checksums.txt",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      environmentVersion: "0.0.1",
      targetVersion: newerVersion,
      allowDowngrade: false,
    },
    {
      environmentVersion: "not-a-version",
      targetVersion: newerVersion,
      allowDowngrade: false,
    },
    {
      environmentVersion: "not-a-version",
      targetVersion: "0.0.1",
      allowDowngrade: true,
    },
  ])(
    "the update command ignores inherited pins and requires explicit downgrade consent: %j",
    async ({ environmentVersion, targetVersion, allowDowngrade }) => {
      const dir = await mkdtemp(
        path.join(os.tmpdir(), "stella-command-update-"),
      );
      try {
        const executablePath = path.join(dir, "stella");
        const configHome = path.join(dir, "config");
        await mkdir(path.join(configHome, "stella"), { recursive: true });
        await writeFile(
          path.join(configHome, "stella", "install-channel"),
          "native\n",
        );
        await writeFile(executablePath, "old executable");
        const entrypoint = path.join(dir, "entry.ts");
        await writeFile(
          entrypoint,
          `process.execPath = ${JSON.stringify(executablePath)};
process.argv = [process.execPath, ${JSON.stringify(path.join(import.meta.dirname, "../cli.ts"))}, "update", ...${JSON.stringify(allowDowngrade ? ["--allow-downgrade"] : [])}];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.includes("/latest/download/")) return new Response(null, { status: 302, headers: { location: ${JSON.stringify(`https://github.com/stella/stella/releases/download/v${targetVersion}/stella-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`)} } });
  return new Response(url.pathname.endsWith("checksums.txt") ? ${JSON.stringify(`${sha256Hex(replacement)}  stella-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}\n`)} : new TextEncoder().encode("new executable"));
};
await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "../cli-main.ts")).href)});
`,
        );
        const child = Bun.spawn([process.execPath, entrypoint], {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: configHome,
            STELLA_VERSION: environmentVersion,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        expect(stdout).toContain(
          `${allowDowngrade ? "Warning: downgrading" : "Updating"} stella ${CLI_VERSION} -> ${targetVersion}`,
        );
        expect(await readFile(executablePath, "utf-8")).toBe("new executable");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

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
