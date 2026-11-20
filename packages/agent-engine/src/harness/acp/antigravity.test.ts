import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ANTIGRAVITY, antigravityTokenPath } from "./antigravity";

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
    expect(ANTIGRAVITY.storedSignIn?.signedIn(configDir)).toBe(false);
    mkdirSync(path.dirname(antigravityTokenPath(configDir)), {
      recursive: true,
    });
    writeFileSync(antigravityTokenPath(configDir), "{}");
    expect(ANTIGRAVITY.storedSignIn?.signedIn(configDir)).toBe(true);
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
});
