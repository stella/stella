import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { waitFor } from "@stll/test-kit";

import {
  browserArguments,
  browserEnvironment,
  type BrowserProcesses,
  clearOrphan,
  forgetInstance,
  prepareProfile,
  singletonLockPid,
  spawnBrowser,
  writeInstance,
} from "./launch";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const tempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-browser-launch-"));
  roots.push(root);
  return root;
};

/** Flags the stella browser must never run with (design section 2). */
const FORBIDDEN_FLAGS = [
  "--enable-automation",
  "--headless",
  "--remote-debugging-port",
  "--remote-allow-origins",
  "--disable-blink-features",
  "--user-agent",
  "--no-sandbox",
  "--disable-web-security",
  "--disable-site-isolation-trials",
  "--ignore-certificate-errors",
  "--load-extension",
  "--enable-unsafe-extension-debugging",
  "--use-mock-keychain",
  "--password-store",
  "--disable-background-networking",
  "--disable-extensions",
  "--disable-popup-blocking",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
  "--disable-hang-monitor",
  "--metrics-recording-only",
  "--mute-audio",
  "--enable-logging",
  "--proxy-server",
  "--host-resolver-rules",
];

describe("the browser's launch", () => {
  test("runs with exactly its own profile, the pipe and no first-run prompts", () => {
    const args = browserArguments({
      profileDir: "/data/browser/key/profile",
      testArgs: [],
    });
    expect(args).toEqual([
      "--user-data-dir=/data/browser/key/profile",
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ]);
    for (const flag of FORBIDDEN_FLAGS) {
      expect(args.filter((arg) => arg.startsWith(flag))).toEqual([]);
    }
  });

  test("gets the member's environment, minimal: nothing of stella's or a harness's", () => {
    expect(
      browserEnvironment({
        HOME: "/home/member",
        PATH: "/usr/bin",
        LANG: "cs_CZ.UTF-8",
        LC_TIME: "cs_CZ.UTF-8",
        TMPDIR: "/tmp/member",
        HTTPS_PROXY: "http://proxy.example.com:3128",
        DISPLAY: ":99",
        STELLA_BROWSER_DEV_HOST: "1",
        STELLA_BROWSER_TEST_EXECUTABLE: "/bin/true",
        OPENAI_API_KEY: "not for the browser",
        NODE_OPTIONS: "--require=/tmp/x.js",
        UNSET: undefined,
      }),
    ).toEqual({
      HOME: "/home/member",
      PATH: "/usr/bin",
      LANG: "cs_CZ.UTF-8",
      LC_TIME: "cs_CZ.UTF-8",
      TMPDIR: "/tmp/member",
      HTTPS_PROXY: "http://proxy.example.com:3128",
      DISPLAY: ":99",
    });
  });

  test("keeps the profile in folders private to this user, and refuses a shared or linked one", () => {
    const root = tempRoot();
    const profile = prepareProfile(
      path.join(root, "browser"),
      "0123456789abcdef",
    );
    expect(Result.isOk(profile)).toBe(true);
    for (const dir of [
      "browser",
      "browser/0123456789abcdef",
      "browser/0123456789abcdef/profile",
    ]) {
      expect(statSync(path.join(root, dir)).mode % 0o1000).toBe(0o700);
    }

    const shared = path.join(root, "shared");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    expect(Result.isError(prepareProfile(shared, "key"))).toBe(true);

    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    const linked = path.join(root, "linked");
    symlinkSync(elsewhere, linked);
    expect(Result.isError(prepareProfile(linked, "key"))).toBe(true);

    // A folder that cannot even be looked at is refused, not thrown.
    const locked = path.join(root, "locked");
    mkdirSync(locked, { mode: 0o700 });
    chmodSync(locked, 0o000);
    try {
      expect(
        Result.isError(prepareProfile(path.join(locked, "browser"), "key")),
      ).toBe(true);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("hands the browser fds 3 and 4, and no process started later inherits the holder's ends", async () => {
    const root = tempRoot();
    const seen = path.join(root, "browser-fds");
    const browser = path.join(root, "browser");
    // A stand-in that notes the descriptors it got, then waits.
    writeFileSync(
      browser,
      `#!/bin/sh\nls /dev/fd > "${seen}"\nexec sleep 30\n`,
    );
    chmodSync(browser, 0o755);
    const listed = () =>
      spawnSync("/bin/sh", ["-c", "ls /dev/fd"], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024,
      })
        .stdout.split("\n")
        .filter((line) => line !== "")
        .toSorted();
    const before = listed();
    const launched = await spawnBrowser({
      args: [],
      environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      executable: browser,
    });
    expect(Result.isOk(launched)).toBe(true);
    if (Result.isError(launched)) {
      return;
    }
    try {
      await waitFor(
        () =>
          existsSync(seen) && readFileSync(seen, "utf-8").endsWith("\n")
            ? true
            : undefined,
        {
          timeoutMs: 5000,
          description: "the stand-in to list its descriptors",
        },
      );
      expect(readFileSync(seen, "utf-8").split("\n")).toEqual(
        expect.arrayContaining(["3", "4"]),
      );
      // The holder still holds its ends of the pipe here.
      expect(listed()).toEqual(before);
    } finally {
      launched.value.child.kill("SIGKILL");
    }
  });

  test("reports a browser that cannot be started", async () => {
    const started = await spawnBrowser({
      args: [],
      environment: {},
      executable: path.join(tempRoot(), "missing"),
    });
    expect(Result.isError(started)).toBe(true);
  });
});

/** A process table the test sets: which ids are alive, and their command lines. */
const fakeProcesses = (
  table: Record<
    number,
    {
      line: string;
      /** The signal that ends it; SIGKILL ends every process. */
      exitsOn?: "SIGKILL" | "SIGTERM";
    }
  >,
) => {
  const alive = new Set(Object.keys(table).map(Number));
  const signals: { pid: number; signal: string }[] = [];
  const processes: BrowserProcesses = {
    alive: (pid) => alive.has(pid),
    commandLine: (pid) => table[pid]?.line ?? null,
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      const exitsOn = table[pid]?.exitsOn ?? "SIGTERM";
      const wasAlive = alive.has(pid);
      if (signal === "SIGKILL" || exitsOn === signal) {
        alive.delete(pid);
      }
      return wasAlive;
    },
  };
  return { processes, signals };
};

const WAITS = { killMs: 50, termMs: 50 };

describe("a browser left on the profile", () => {
  const profileIn = (root: string) => {
    const profile = prepareProfile(path.join(root, "browser"), "key");
    if (Result.isError(profile)) {
      throw new TypeError(profile.error.message);
    }
    return profile.value;
  };
  const ours = (profileDir: string) =>
    `/Applications/Browser --user-data-dir=${profileDir} --remote-debugging-pipe --no-first-run about:blank`;

  test("is ended when its holder is gone and its command line is ours", async () => {
    const profile = profileIn(tempRoot());
    writeInstance(profile.instanceFile, { browserPid: 4242, holderPid: 4141 });
    const { processes, signals } = fakeProcesses({
      4242: { line: ours(profile.profileDir) },
    });
    expect(await clearOrphan({ processes, profile, waits: WAITS })).toEqual({
      pid: 4242,
      type: "ended",
    });
    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  test("is killed when it does not end on SIGTERM", async () => {
    const profile = profileIn(tempRoot());
    writeInstance(profile.instanceFile, { browserPid: 4242, holderPid: 4141 });
    const { processes, signals } = fakeProcesses({
      4242: { exitsOn: "SIGKILL", line: ours(profile.profileDir) },
    });
    expect(await clearOrphan({ processes, profile, waits: WAITS })).toEqual({
      pid: 4242,
      type: "ended",
    });
    expect(signals.map(({ signal }) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("is left alone while the holder that started it runs", async () => {
    const profile = profileIn(tempRoot());
    writeInstance(profile.instanceFile, { browserPid: 4242, holderPid: 4141 });
    const { processes, signals } = fakeProcesses({
      4141: { line: "stella-agent-sidecar --dir x" },
      4242: { line: ours(profile.profileDir) },
    });
    expect(await clearOrphan({ processes, profile, waits: WAITS })).toEqual({
      type: "in-use",
    });
    expect(signals).toEqual([]);
  });

  test("named by Chrome's lock but not ours holds the profile: nothing is ended", async () => {
    const profile = profileIn(tempRoot());
    symlinkSync(
      `${hostname()}-5151`,
      path.join(profile.profileDir, "SingletonLock"),
    );
    expect(singletonLockPid(profile.profileDir)).toBe(5151);
    const { processes, signals } = fakeProcesses({
      // Another profile whose path starts with this one's.
      5151: {
        line: `/Applications/Browser --user-data-dir=${profile.profileDir}-other --remote-debugging-pipe`,
      },
    });
    expect(await clearOrphan({ processes, profile, waits: WAITS })).toEqual({
      type: "in-use",
    });
    expect(signals).toEqual([]);
  });

  test("a lock or record of a process that is gone, or of another computer, is passed over", async () => {
    const profile = profileIn(tempRoot());
    writeInstance(profile.instanceFile, { browserPid: 4242, holderPid: 4141 });
    symlinkSync(
      `${hostname()}-5151`,
      path.join(profile.profileDir, "SingletonLock"),
    );
    const { processes, signals } = fakeProcesses({});
    expect(await clearOrphan({ processes, profile, waits: WAITS })).toEqual({
      type: "none",
    });
    rmSync(path.join(profile.profileDir, "SingletonLock"));
    symlinkSync(
      "another-computer-5151",
      path.join(profile.profileDir, "SingletonLock"),
    );
    expect(singletonLockPid(profile.profileDir)).toBeNull();
    expect(signals).toEqual([]);
  });

  test("named only by Chrome's lock, with no record of the holder that started it, is in use and not ended", async () => {
    const profile = profileIn(tempRoot());
    symlinkSync(
      `${hostname()}-5151`,
      path.join(profile.profileDir, "SingletonLock"),
    );
    const { processes, signals } = fakeProcesses({
      5151: { line: ours(profile.profileDir) },
    });
    expect(await clearOrphan({ processes, profile, waits: WAITS })).toEqual({
      type: "in-use",
    });
    expect(signals).toEqual([]);
  });

  test("a record is forgotten only while it still names the browser that ended", () => {
    const profile = profileIn(tempRoot());
    writeInstance(profile.instanceFile, { browserPid: 5252, holderPid: 4141 });
    // An older browser ending after the newer one started keeps its record.
    forgetInstance(profile.instanceFile, 4242);
    expect(existsSync(profile.instanceFile)).toBe(true);
    forgetInstance(profile.instanceFile, 5252);
    expect(existsSync(profile.instanceFile)).toBe(false);
  });

  test("a recorded browser id another process took since is not ended", async () => {
    const profile = profileIn(tempRoot());
    writeInstance(profile.instanceFile, { browserPid: 4242, holderPid: 4141 });
    const { processes, signals } = fakeProcesses({
      4242: { line: "/usr/bin/some-editor notes.txt" },
    });
    expect(await clearOrphan({ processes, profile, waits: WAITS })).toEqual({
      type: "none",
    });
    expect(signals).toEqual([]);
  });
});
