import { Result } from "better-result";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import type { AcpAgentDefinition } from "./definition";

/**
 * Google Antigravity's ACP server, as its release ships it: the server
 * beside the local harness it drives. It keeps its state, sign-in included,
 * in `GEMINI_HOME`, here the stella-owned directory, with its token in a
 * file there rather than the keychain, so the member's own Antigravity and
 * Gemini setup is never read or changed.
 */

const harnessFile = (platform: NodeJS.Platform) =>
  platform === "win32" ? "localharness_external.exe" : "localharness_external";

/** Credentials and projects the member set for their own Google tools. */
const GOOGLE_ENVIRONMENT = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "CHROME_CRASHPAD_PIPE_NAME",
] as const;

/** Where the server keeps the sign-in a member made through it. */
export const antigravityTokenPath = (configDir: string) =>
  path.join(configDir, "antigravity-acp", "acp_token.json");

/** Signing in with a Google account, the method stella offers. */
export const ANTIGRAVITY_SIGN_IN_METHOD = "oauth-personal";

const LOST_THINKING_SIGNATURE =
  /thinking\.signature|invalid `?signature`? in `?thinking`? block/iu;

/** Every launch unpacks the server, so a probe's answer is kept this long. */
const PROBE_CACHE_MS = 6 * 60 * 60 * 1000;

const removeQuietly = (target: string) => {
  Result.try(() => {
    rmSync(target, { recursive: true, force: true });
  });
};

export const ANTIGRAVITY: AcpAgentDefinition = {
  harness: "antigravity",
  displayName: "Antigravity",
  // The Linux build asks for a user id it does not use.
  args: (platform) => (platform === "linux" ? ["--uid="] : []),
  environment: ({ configDir, executable, platform }) => ({
    GEMINI_HOME: configDir,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    PYTHONUNBUFFERED: "1",
    ANTIGRAVITY_HARNESS_PATH: path.join(
      path.dirname(executable),
      harnessFile(platform),
    ),
  }),
  removedEnvironment: GOOGLE_ENVIRONMENT,
  approvalModes: ["ask", "auto"],
  // stella answers or asks every permission request; the agent's own modes
  // that skip them stay off.
  sessionModes: { ask: "default", auto: "default" },
  storedSignIn: {
    methodId: ANTIGRAVITY_SIGN_IN_METHOD,
    signedIn: (configDir) => existsSync(antigravityTokenPath(configDir)),
  },
  // Each launch unpacks the server into the temporary directory and leaves
  // it there when the process is stopped.
  ownTempDir: true,
  probeCacheMs: PROBE_CACHE_MS,
  // From 1.5.0 a prompt sent during a turn steers it, keeping its tools and
  // subagents running; earlier releases queue it.
  steers: (version) => Bun.semver.satisfies(version, ">=1.5.0"),
  // A model request that lost its thinking block's signature fails every
  // later request of the saved session too.
  brokenSession: (message) => LOST_THINKING_SIGNATURE.test(message),
  // A probe's session would otherwise stay in the member's history.
  discardSession: (configDir, sessionId) => {
    const state = path.join(configDir, "antigravity-acp");
    removeQuietly(path.join(state, "brain", sessionId));
    const conversations = path.join(state, "conversations");
    const entries = Result.try(() => readdirSync(conversations));
    for (const entry of Result.isOk(entries) ? entries.value : []) {
      if (entry.startsWith(sessionId)) {
        removeQuietly(path.join(conversations, entry));
      }
    }
  },
};
