import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ANTIGRAVITY,
  ANTIGRAVITY_CLI,
  antigravityCliTokenPath,
  antigravityDefinition,
  antigravityTokenPath,
} from "./antigravity";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const stateDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-antigravity-"));
  roots.push(root);
  return root;
};

describe("Antigravity over ACP", () => {
  test("runs with stella's state directory, its own harness file and none of the member's Google credentials", () => {
    expect(
      ANTIGRAVITY.environment({
        configDir: "/state/antigravity",
        executable: "/tools/antigravity/agy_acp_server.par",
        platform: "darwin",
      }),
    ).toEqual({
      GEMINI_HOME: "/state/antigravity",
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      PYTHONUNBUFFERED: "1",
      ANTIGRAVITY_HARNESS_PATH: "/tools/antigravity/localharness_external",
    });
    expect(ANTIGRAVITY.removedEnvironment).toContain("GEMINI_API_KEY");
    expect(ANTIGRAVITY.removedEnvironment).toContain(
      "GOOGLE_APPLICATION_CREDENTIALS",
    );
    expect(ANTIGRAVITY.args("linux")).toEqual(["--uid="]);
    expect(ANTIGRAVITY.args("darwin")).toEqual([]);
    expect(ANTIGRAVITY.approvalModes).toEqual(["ask", "auto"]);
  });

  test("is signed in once its token is in the state directory", () => {
    const configDir = stateDir();
    expect(ANTIGRAVITY.storedSignIn?.signedIn(configDir, {})).toBe(false);
    mkdirSync(path.dirname(antigravityTokenPath(configDir)), {
      recursive: true,
    });
    writeFileSync(antigravityTokenPath(configDir), "{}");
    expect(ANTIGRAVITY.storedSignIn?.signedIn(configDir, {})).toBe(true);
  });

  test("steers from 1.5.0", () => {
    expect(ANTIGRAVITY.steers("1.4.5")).toBe(false);
    expect(ANTIGRAVITY.steers("1.5.0")).toBe(true);
    expect(ANTIGRAVITY.steers("1.6.2")).toBe(true);
  });

  test.each([
    "messages.3.content.0.thinking.signature: Field required",
    "Invalid `signature` in `thinking` block",
  ])("a lost thinking signature breaks the session: %s", (message) => {
    expect(ANTIGRAVITY.brokenSession(message)).toBe(true);
  });

  test("other failures leave the session to resume", () => {
    expect(ANTIGRAVITY.brokenSession("Rate limit exceeded")).toBe(false);
  });

  test("a probe's session is removed from the agent's history, and nothing else", () => {
    const configDir = stateDir();
    const state = path.join(configDir, "antigravity-acp");
    mkdirSync(path.join(state, "brain", "probe-1"), { recursive: true });
    mkdirSync(path.join(state, "brain", "chat-1"), { recursive: true });
    mkdirSync(path.join(state, "conversations"), { recursive: true });
    for (const file of ["probe-1.db", "probe-1.db-wal", "chat-1.db"]) {
      writeFileSync(path.join(state, "conversations", file), "");
    }
    ANTIGRAVITY.discardSession?.(configDir, "probe-1");
    expect(existsSync(path.join(state, "brain", "probe-1"))).toBe(false);
    expect(existsSync(path.join(state, "brain", "chat-1"))).toBe(true);
    expect(readdirSync(path.join(state, "conversations"))).toEqual([
      "chat-1.db",
    ]);
  });

  test("the member's own CLI runs as `agy acp` with their own Antigravity home", () => {
    expect(antigravityDefinition("/home/m/.local/bin/agy")).toBe(
      ANTIGRAVITY_CLI,
    );
    expect(antigravityDefinition("C:\\Tools\\agy.exe")).toBe(ANTIGRAVITY_CLI);
    expect(antigravityDefinition("/state/agy_acp_server.par")).toBe(
      ANTIGRAVITY,
    );
    expect(ANTIGRAVITY_CLI.args("darwin")).toEqual(["acp"]);
    expect(
      ANTIGRAVITY_CLI.environment({
        configDir: "/state/antigravity",
        executable: "/home/m/.local/bin/agy",
        platform: "darwin",
      }),
    ).toEqual({});
    expect(ANTIGRAVITY_CLI.removedEnvironment).not.toContain("GEMINI_HOME");
    expect(ANTIGRAVITY_CLI.removedEnvironment).toContain("GEMINI_API_KEY");
    expect(antigravityCliTokenPath({ HOME: "/home/m" })).toBe(
      "/home/m/.gemini/antigravity-cli/antigravity-oauth-token",
    );
    expect(
      antigravityCliTokenPath({ GEMINI_HOME: "/g", HOME: "/home/m" }),
    ).toBe("/g/antigravity-cli/antigravity-oauth-token");
  });

  test("the CLI's version is read with --version, before it is started", async () => {
    const dir = stateDir();
    const agy = path.join(dir, "agy");
    writeFileSync(agy, "#!/bin/sh\necho 'agy 1.3.5'\n");
    chmodSync(agy, 0o755);
    expect(ANTIGRAVITY_CLI.minimumVersion?.version).toBe("1.5.0");
    expect(await ANTIGRAVITY_CLI.minimumVersion?.read(agy)).toBe("1.3.5");
    // An executable that cannot be run rejects: it is not "no version".
    const [missing] = await Promise.allSettled([
      ANTIGRAVITY_CLI.minimumVersion?.read(path.join(dir, "missing")),
    ]);
    expect(missing.status).toBe("rejected");
  });
});
