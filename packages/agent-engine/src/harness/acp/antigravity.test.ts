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
import { Temporal } from "temporal-polyfill/full";

import {
  ANTIGRAVITY,
  ANTIGRAVITY_CLI,
  antigravityCliTokenPath,
  antigravityCommandOutlivesPrompt,
  antigravityDefinition,
  antigravityTokenPath,
  classifyAntigravityError,
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
    ANTIGRAVITY.discardSession?.({
      configDir,
      sessionId: "probe-1",
      environment: {},
      cwd: "/tmp/probe",
    });
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

  test("CLI probe session cleanup removes only our probe session from GEMINI_HOME", () => {
    const home = stateDir();
    const state = path.join(home, "antigravity-acp");
    const probeCwd = path.join(home, "probe-cwd");
    const otherCwd = path.join(home, "other-cwd");
    mkdirSync(probeCwd, { recursive: true });
    mkdirSync(otherCwd, { recursive: true });
    mkdirSync(path.join(state, "brain", "probe-2"), { recursive: true });
    mkdirSync(path.join(state, "brain", "real-chat"), { recursive: true });
    mkdirSync(path.join(state, "conversations"), { recursive: true });
    mkdirSync(path.join(state, "annotations"), { recursive: true });
    writeFileSync(path.join(state, "conversations", "probe-2.db"), "");
    writeFileSync(
      path.join(state, "conversations", "probe-2.meta"),
      JSON.stringify({ cwd: probeCwd }),
    );
    writeFileSync(path.join(state, "annotations", "probe-2.pbtxt"), "");
    writeFileSync(path.join(state, "conversations", "real-chat.db"), "");
    writeFileSync(
      path.join(state, "conversations", "real-chat.meta"),
      JSON.stringify({ cwd: otherCwd }),
    );

    ANTIGRAVITY_CLI.discardSession?.({
      configDir: "/unused",
      sessionId: "probe-2",
      environment: { GEMINI_HOME: home },
      cwd: probeCwd,
    });
    expect(existsSync(path.join(state, "brain", "probe-2"))).toBe(false);
    expect(existsSync(path.join(state, "conversations", "probe-2.db"))).toBe(
      false,
    );
    expect(existsSync(path.join(state, "annotations", "probe-2.pbtxt"))).toBe(
      false,
    );

    // Mismatched cwd leaves the member's real session untouched.
    ANTIGRAVITY_CLI.discardSession?.({
      configDir: "/unused",
      sessionId: "real-chat",
      environment: { GEMINI_HOME: home },
      cwd: probeCwd,
    });
    expect(existsSync(path.join(state, "brain", "real-chat"))).toBe(true);
    expect(existsSync(path.join(state, "conversations", "real-chat.db"))).toBe(
      true,
    );
  });

  test("execute commands outlive the prompt unless marked as a daemon", () => {
    const base = {
      id: "call-1",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
      content: [],
      locations: [],
      rawOutput: null,
    };
    expect(
      antigravityCommandOutlivesPrompt({
        ...base,
        rawInput: { CommandLine: "bun test" },
      }),
    ).toBe(true);
    expect(
      antigravityCommandOutlivesPrompt({
        ...base,
        rawInput: { CommandLine: "bun dev", IsDaemon: true },
      }),
    ).toBe(false);
    expect(
      antigravityCommandOutlivesPrompt({
        ...base,
        kind: "read",
        rawInput: null,
      }),
    ).toBe(false);
  });

  test("classifies Antigravity stderr errors: quota with reset delay, thinking signature, auth, and mid-turn 404", () => {
    const now = Temporal.Instant.from("2026-11-22T09:00:00Z");
    const quota = classifyAntigravityError({
      stderr:
        "Error 429, Message: Quota exceeded reason:QUOTA_EXHAUSTED quotaResetDelay:2m30s, Status: RESOURCE_EXHAUSTED",
      errorMessage: null,
      stopReason: "end_turn",
      reachedModel: false,
      now,
    });
    expect(quota).toEqual({
      failure: {
        type: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        resetsAt: "2026-11-22T09:02:30Z",
      },
      brokenSession: false,
    });

    const broken = classifyAntigravityError({
      stderr: "messages.2.content.0.thinking.signature: Field required",
      errorMessage: null,
      stopReason: "end_turn",
      reachedModel: false,
      now,
    });
    expect(broken?.brokenSession).toBe(true);
    expect(broken?.failure.type).toBe("provider_error");

    const auth = classifyAntigravityError({
      stderr: "UNAUTHENTICATED (code 401): Token expired",
      errorMessage: null,
      stopReason: null,
      reachedModel: false,
      now,
    });
    expect(auth?.failure.type).toBe("auth_required");

    const midTurn404 = classifyAntigravityError({
      stderr: "Error 404, Message: Not found, Status: NOT_FOUND",
      errorMessage: null,
      stopReason: null,
      reachedModel: true,
      now,
    });
    expect(midTurn404).toEqual({
      failure: {
        type: "provider_error",
        message: "Not found",
        code: "NOT_FOUND",
      },
      brokenSession: false,
    });
  });
});
