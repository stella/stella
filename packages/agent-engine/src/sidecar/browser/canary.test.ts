import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CHAT_LOCAL_RUN_TOOL_NAMES } from "@stll/api-contract/chat-local-run-tool";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";
import { waitFor } from "@stll/test-kit";

import {
  FIXTURE_CANARIES,
  FIXTURE_CITATION,
  startFakeExtension,
  startFixtureLibrary,
} from "../../../scripts/fake-browser";
import {
  connectDesktop,
  startApiStandIn,
  toolCalls,
  toolResults,
} from "../../../scripts/fake-desktop";
import { browserEndpointFor } from "./holder-browser";

/**
 * Proof that page content stays on the computer. The holder runs as the
 * desktop starts it, Chrome is a stand-in behind the real native host, and
 * a fake harness (Codex, then Claude Code) searches a fixture library,
 * opens a result, tries a sign-in page and cites the decision. The library
 * serves canary strings the agent reads but never repeats. Everything that
 * leaves the computer goes to the desktop (run events) or to the stand-in
 * for stella's API (the MCP proxy): neither may carry a canary byte.
 */

const MAIN = path.join(import.meta.dir, "../main.ts");
const FAKES = {
  codex: path.join(
    import.meta.dir,
    "../../../scripts/fake-codex-app-server.ts",
  ),
  "claude-code": path.join(
    import.meta.dir,
    "../../../scripts/fake-claude-code-cli.ts",
  ),
} as const;
const MODELS = { codex: "gpt-test", "claude-code": "sonnet" } as const;
const PLAIN_LAUNCH = {
  configOverrides: [],
  environment: {},
  removedEnvironment: [],
  clientName: null,
  processGrant: false,
};
const WAIT = { timeoutMs: 20_000 } as const;

// timeout: each test starts the holder, the native host and a fake harness.
setDefaultTimeout(60_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

const browse = async (
  harness: keyof typeof FAKES,
  approvals: DesktopRunnerApprovalMode,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-canary-"));
  cleanups.push(() => {
    rmSync(root, { force: true, recursive: true });
  });
  const dir = path.join(root, "1.4.0");
  const endpoint = path.join(root, "stella-holder-1.4.0.sock");
  const register = (cleanup: (typeof cleanups)[number]) => {
    cleanups.push(cleanup);
  };
  const api = startApiStandIn(register);
  const library = startFixtureLibrary();
  // A home folder with a Chrome profile, where the holder registers the
  // native host: without one it offers no browser tools.
  const home = path.join(root, "home");
  const profile = path.join(
    home,
    ...(process.platform === "darwin"
      ? ["Library", "Application Support", "Google", "Chrome"]
      : [".config", "google-chrome"]),
  );
  mkdirSync(profile, { recursive: true });
  cleanups.push(library.stop);

  const holder = Bun.spawn(
    [process.execPath, MAIN, "--dir", dir, "--endpoint", endpoint],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        PATH: process.env["PATH"] ?? "",
        FAKE_HARNESS_LOG: path.join(root, "fake.log"),
        FAKE_BROWSER_START: `${library.origin}/`,
        HOME: home,
      },
    },
  );
  cleanups.push(async () => {
    holder.kill();
    await holder.exited;
  });
  const secretFile = path.join(dir, "holder.secret");
  await waitFor(() => (existsSync(secretFile) ? true : undefined), {
    ...WAIT,
    description: "the holder to start",
  });

  // Chrome starts the host the holder registers once its browser is up.
  const manifest = path.join(
    profile,
    "NativeMessagingHosts",
    "app.stll.browser.json",
  );
  await waitFor(() => (existsSync(manifest) ? true : undefined), {
    ...WAIT,
    description: "the holder to register the browser host",
  });
  const chrome = startFakeExtension({
    hostCommand: [
      process.execPath,
      MAIN,
      "--native-host",
      "--browser-endpoint",
      browserEndpointFor(endpoint),
      "--browser-secret-file",
      path.join(dir, "browser.secret"),
      "chrome-extension://fixture/",
    ],
  });
  cleanups.push(chrome.stop);
  await chrome.connected;

  const desktop = await connectDesktop(
    {
      apiOrigin: api.origin,
      endpoint,
      secret: readFileSync(secretFile, "utf-8"),
    },
    register,
  );
  const executable = path.join(root, `${harness}-browse`);
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKES[harness]}" browse "$@"\n`,
  );
  chmodSync(executable, 0o755);
  const configDir = path.join(root, `${harness}-home`);
  const workspaceDir = path.join(root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const runId = crypto.randomUUID();
  desktop.send({
    type: "run.start",
    runId,
    threadId: "thread-1",
    attachments: [],
    skillFolders: [],
    toolPath: [],
    harness,
    executable,
    model: MODELS[harness],
    reasoningEffort: null,
    configDir,
    launch: PLAIN_LAUNCH,
    workspaceDir,
    cacheDir: path.join(root, "agent-package-cache"),
    unreadablePaths: [],
    stepOutputDir: path.join(root, "runs", "chat.step-outputs"),
    instructions: "Use the stella MCP server.",
    messages: [{ role: "user", content: "Find the notice period decision." }],
    session: { type: "fresh" },
    policy: { network: "open", fs: "workspace", approvals },
    mcp: {
      serverName: "stella",
      url: `${api.origin}/mcp`,
      token: "run-token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  });
  const finished = await waitFor(
    () =>
      desktop.messages.find(
        (message) => message.type === "run.finished" && message.runId === runId,
      ),
    { ...WAIT, description: "the run to finish" },
  );
  const chunks = desktop.messages.flatMap((message) =>
    message.type === "run.event" && message.runId === runId
      ? [message.chunk]
      : [],
  );
  // What the fake agent noted on this computer about the pages it read.
  const harnessLogFile = path.join(root, "fake.log");
  // No file when the harness never started; the run's outcome says why.
  const harnessLog = (
    existsSync(harnessLogFile) ? readFileSync(harnessLogFile, "utf-8") : ""
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line));
  return { api, chrome, chunks, desktop, finished, harnessLog, library };
};

/**
 * The steps the member is asked about, by approval mode: the agent clicks
 * the search button and a result, and types into a search field and into
 * a note field. Plan is read-only and refuses those steps, so this journey
 * does not apply to it; the browser tools' own tests cover it.
 */
const ASKED = {
  ask: ["click", "click", "type"],
  auto: ["type"],
  full_auto: [],
} as const satisfies Record<
  Exclude<DesktopRunnerApprovalMode, "plan">,
  readonly string[]
>;

const APPROVAL_STEP_PREFIX = "browser-step-";

/** Claude Code offers full auto only where its sandbox runs. */
const offersMode = (
  harness: keyof typeof FAKES,
  approvals: keyof typeof ASKED,
) =>
  approvals !== "full_auto" ||
  harness === "codex" ||
  process.platform === "darwin";

describe.each(
  (["codex", "claude-code"] as const).flatMap((harness) =>
    (["ask", "auto", "full_auto"] as const).flatMap((approvals) =>
      offersMode(harness, approvals) ? [[harness, approvals] as const] : [],
    ),
  ),
)("a local %s run browsing the member's Chrome (%s)", (harness, approvals) => {
  test("searches, opens and cites a result, and no page content leaves the computer", async () => {
    const { api, chrome, chunks, desktop, finished, harnessLog, library } =
      await browse(harness, approvals);
    expect(finished).toMatchObject({ outcome: "completed" });

    // The agent searched the library, opened the decision and was sent
    // to the member at the sign-in page.
    expect(chrome.commands.map(({ action }) => action)).toEqual([
      "open",
      "fill",
      "snapshot",
      "click",
      "click",
      "fill",
      "open",
    ]);
    const calls = toolCalls(chunks);
    // The member was asked exactly about the steps the mode holds back:
    // the step's kind and what it acts on (the element's role and name and
    // the page's address), never the page's text.
    expect(
      desktop.messages.filter(
        (message) => message.type === "run.approval_request",
      ),
    ).toHaveLength(ASKED[approvals].length);
    expect(
      calls
        .filter(({ id }) => id.startsWith(APPROVAL_STEP_PREFIX))
        .map(({ input, name }) => ({ input, name })),
    ).toMatchObject(
      ASKED[approvals].map((action) => ({
        name: "local_browser",
        input: {
          action,
          asked: {
            name: expect.any(String),
            role: expect.any(String),
            url: expect.stringContaining(library.origin),
          },
        },
      })),
    );
    expect(
      calls
        .filter(
          ({ id, name }) =>
            name === CHAT_LOCAL_RUN_TOOL_NAMES.browser &&
            !id.startsWith(APPROVAL_STEP_PREFIX),
        )
        .map(({ input, name }) => ({ input, name })),
    ).toEqual([
      {
        name: "local_browser",
        input: { action: "open", url: `${library.origin}/` },
      },
      { name: "local_browser", input: { action: "type" } },
      { name: "local_browser", input: { action: "snapshot" } },
      { name: "local_browser", input: { action: "click" } },
      { name: "local_browser", input: { action: "click" } },
      { name: "local_browser", input: { action: "type" } },
      {
        name: "local_browser",
        input: { action: "open", url: `${library.origin}/account` },
      },
    ]);
    expect(calls.some(({ name }) => name === "search_case_law")).toBe(true);
    expect(toolResults(chunks)).toContainEqual({ status: "needs_member" });

    // It cites the decision it opened.
    expect(JSON.stringify(chunks)).toContain(
      `[${FIXTURE_CITATION.title}](${library.origin}${FIXTURE_CITATION.path})`,
    );

    // Both canaries reached the agent: the check below has something to
    // find.
    expect(harnessLog).toContainEqual({ pageCanaries: [...FIXTURE_CANARIES] });

    // Nothing of the pages it read reached the desktop or stella's API,
    // while the agent's own stella call did reach the API.
    expect(api.received.length).toBeGreaterThan(0);
    for (const canary of FIXTURE_CANARIES) {
      for (const line of desktop.lines) {
        expect(line).not.toContain(canary);
      }
      for (const request of api.received) {
        expect(request).not.toContain(canary);
      }
    }
  });
});
