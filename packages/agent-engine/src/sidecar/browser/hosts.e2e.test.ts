import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { waitFor } from "@stll/test-kit";

import {
  FIXTURE_CANARIES,
  FIXTURE_CITATION,
} from "../../../scripts/fake-browser";
import {
  connectDesktop,
  startApiStandIn,
  toolResults,
} from "../../../scripts/fake-desktop";
import { startFixtureSite } from "../../../scripts/fixture-site";
import { CDP_METHOD_ALLOWLIST } from "./stella-browser/cdp-client";

const ALLOWED: readonly string[] = CDP_METHOD_ALLOWLIST;

/**
 * One reading scenario, run against each browser host: a local Codex run
 * searches the fixture library by its results page's address, opens the
 * decision, reads it a window at a time, finds in it, lists its headings,
 * is sent to the member at the sign-in page and cites the decision. The
 * canary checks are the transport canary's: the pages' canary strings reach
 * the agent and never the desktop or stella's API.
 *
 * The stella browser runs a real browser, so it needs one named by
 * `STELLA_BROWSER_E2E_EXECUTABLE`: CI's Linux job names its Chrome and runs
 * it with a window under a virtual display. Without it the leg is skipped.
 * An app bundle is never started from a test.
 */

const MAIN = path.join(import.meta.dir, "../main.ts");
const FAKE_CODEX = path.join(
  import.meta.dir,
  "../../../scripts/fake-codex-app-server.ts",
);
const WAIT = { timeoutMs: 60_000 } as const;

// timeout: the holder, a browser and a fake harness start for the scenario.
setDefaultTimeout(180_000);

const cleanups: (() => Promise<void> | void)[] = [];
const register = (cleanup: (typeof cleanups)[number]) => {
  cleanups.push(cleanup);
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

/** The browser the stella browser leg runs; null skips it. */
const stellaBrowserExecutable = (): string | null => {
  const executable = process.env["STELLA_BROWSER_E2E_EXECUTABLE"];
  if (executable === undefined || executable === "") {
    return null;
  }
  // A macOS app bundle started from a process joins that process's group:
  // never from a test.
  return executable.includes(".app/") ? null : executable;
};

type HostLeg = {
  name: string;
  /** Why the leg does not run here; null when it does. */
  skip: string | null;
  /** The holder's environment for this host. */
  environment: (
    site: ReturnType<typeof startFixtureSite>,
    root: string,
  ) => Record<string, string>;
};

const HOSTS: readonly HostLeg[] = [
  {
    name: "the stella browser",
    skip:
      stellaBrowserExecutable() === null
        ? "no browser named for the stella browser"
        : null,
    environment: (site, root) => ({
      STELLA_BROWSER_DEV_HOST: "1",
      STELLA_BROWSER_TEST_HOOKS: "1",
      STELLA_BROWSER_TEST_EXECUTABLE: stellaBrowserExecutable() ?? "",
      STELLA_BROWSER_TEST_HOST_RULES: site.hostRules,
      STELLA_BROWSER_TEST_SPKI: site.spki,
      STELLA_BROWSER_TEST_METHOD_LOG: path.join(root, "methods.log"),
    }),
  },
  {
    // The extension needs Chrome with the stella extension loaded; the
    // extension's own end-to-end job drives that, and joins this file
    // with the shared orchestration.
    name: "the member's Chrome",
    skip: "the extension's end-to-end job covers this host",
    environment: () => ({}),
  },
];

/** The methods the reading scenario sends: a new one is a deliberate change. */
const READ_SCENARIO_METHODS = [
  "Browser.close",
  "Browser.getVersion",
  "Browser.setDownloadBehavior",
  "Page.createIsolatedWorld",
  "Page.enable",
  "Page.getFrameTree",
  "Page.navigate",
  "Runtime.callFunctionOn",
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.createTarget",
  "Target.setAutoAttach",
  "Target.setDiscoverTargets",
];

const notesSchema = v.object({
  readScenario: v.object({
    windows: v.number(),
    matches: v.number(),
    headings: v.array(v.string()),
    clickRefused: v.nullable(v.string()),
    signIn: v.nullable(v.string()),
    webdriver: v.nullable(v.string()),
  }),
});

const alive = (pid: number) => {
  const probed = Bun.spawnSync(["kill", "-0", String(pid)], {
    stderr: "ignore",
    stdout: "ignore",
  });
  return probed.exitCode === 0;
};

/** A measurement the run reports without failing on: a CI annotation there. */
const report = (title: string, value: string) => {
  const line =
    process.env["GITHUB_ACTIONS"] === "true"
      ? `::notice title=${title}::${value}`
      : `${title}: ${value}`;
  process.stdout.write(`${line}\n`);
};

const read = async (leg: HostLeg) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-hosts-"));
  register(() => {
    rmSync(root, { force: true, recursive: true });
  });
  const dir = path.join(root, "agent-holder", "1.4.0");
  const endpoint = path.join(root, "holder.sock");
  const api = startApiStandIn(register);
  const site = startFixtureSite();
  register(site.stop);
  // No Chrome profile in this home: the extension's host is not registered.
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  // The virtual display a CI window goes to, and its access file.
  const display = Object.fromEntries(
    ["DISPLAY", "XAUTHORITY"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const holder = Bun.spawn(
    [process.execPath, MAIN, "--dir", dir, "--endpoint", endpoint],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: process.env["STELLA_E2E_DEBUG"] === "1" ? "inherit" : "ignore",
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        ...display,
        FAKE_HARNESS_LOG: path.join(root, "fake.log"),
        FAKE_BROWSER_START: `${site.origin}/`,
        FAKE_BROWSER_SCENARIO: "read",
        ...leg.environment(site, root),
      },
    },
  );
  register(async () => {
    holder.kill();
    await holder.exited;
  });
  const secretFile = path.join(dir, "holder.secret");
  await waitFor(() => (existsSync(secretFile) ? true : undefined), {
    ...WAIT,
    description: "the holder to start",
  });
  const desktop = await connectDesktop(
    {
      apiOrigin: api.origin,
      endpoint,
      secret: readFileSync(secretFile, "utf-8"),
    },
    register,
  );
  const executable = path.join(root, "codex-browse");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" browse "$@"\n`,
  );
  chmodSync(executable, 0o755);
  const workspaceDir = path.join(root, "workspace");
  mkdirSync(path.join(root, "codex-home"), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const runId = crypto.randomUUID();
  desktop.send({
    type: "run.start",
    runId,
    threadId: "thread-1",
    attachments: [],
    skillFolders: [],
    toolPath: [],
    harness: "codex",
    executable,
    model: "gpt-test",
    reasoningEffort: null,
    configDir: path.join(root, "codex-home"),
    launch: {
      configOverrides: [],
      environment: {},
      removedEnvironment: [],
      clientName: null,
      processGrant: false,
    },
    workspaceDir,
    cacheDir: path.join(root, "agent-package-cache"),
    unreadablePaths: [],
    stepOutputDir: path.join(root, "runs", "chat.step-outputs"),
    instructions: "Use the stella MCP server.",
    messages: [{ role: "user", content: "Find the notice period decision." }],
    harnessSessionId: null,
    policy: { network: "open", fs: "workspace", approvals: "auto" },
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
  const harnessLogFile = path.join(root, "fake.log");
  const harnessLog = (
    existsSync(harnessLogFile) ? readFileSync(harnessLogFile, "utf-8") : ""
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line));
  return { api, chunks, desktop, finished, harnessLog, holder, root, site };
};

describe.each(HOSTS)("reading the fixture library in $name", (leg) => {
  test.skipIf(leg.skip !== null)(
    "searches, opens, reads by cursor, finds, outlines, hands the sign-in to the member and cites, with no page content leaving the computer",
    async () => {
      const { api, chunks, desktop, finished, harnessLog, holder, root, site } =
        await read(leg);
      // The holder's log says why a run failed; it holds no page content.
      const holderLog = path.join(root, "agent-holder", "1.4.0", "holder.log");
      if (
        finished.type === "run.finished" &&
        finished.outcome !== "completed"
      ) {
        process.stdout.write(
          `${existsSync(holderLog) ? readFileSync(holderLog, "utf-8") : "no holder log"}\n${JSON.stringify(harnessLog)}\n`,
        );
      }
      expect(finished).toMatchObject({ outcome: "completed" });

      const notes = harnessLog.flatMap((entry) => {
        const parsed = v.safeParse(notesSchema, entry);
        return parsed.success ? [parsed.output.readScenario] : [];
      });
      expect(notes).toHaveLength(1);
      const [scenario] = notes;
      // The decision needs more than one window, and the second canary is
      // only in a later one: the agent read on by cursor.
      expect(scenario?.windows).toBeGreaterThan(1);
      // Four paragraphs and the heading of their section.
      expect(scenario?.matches).toBe(5);
      expect(scenario?.headings).toEqual(
        expect.arrayContaining([
          FIXTURE_CITATION.title,
          "I. Facts",
          "II. Reasoning",
          "Notice period",
          "III. Holding",
        ]),
      );
      expect(scenario?.clickRefused).toBe("not_available_on_this_browser");
      expect(scenario?.signIn).toBe("needs_member");
      expect(toolResults(chunks)).toContainEqual({ status: "needs_member" });
      report(
        "navigator.webdriver in the stella browser",
        scenario?.webdriver ?? "not read",
      );

      // It cites the decision it opened.
      expect(JSON.stringify(chunks)).toContain(
        `[${FIXTURE_CITATION.title}](${site.origin}${FIXTURE_CITATION.path})`,
      );

      // Both canaries reached the agent, and nothing of the pages reached
      // the desktop or stella's API.
      expect(harnessLog).toContainEqual({
        pageCanaries: [...FIXTURE_CANARIES],
      });
      expect(api.received.length).toBeGreaterThan(0);
      for (const canary of FIXTURE_CANARIES) {
        for (const line of desktop.lines) {
          expect(line).not.toContain(canary);
        }
        for (const request of api.received) {
          expect(request).not.toContain(canary);
        }
      }

      // The run's harness exits with its turn, its endpoint goes, and with
      // the last chat's tab gone the browser closes.
      const started = /the stella browser started: .* \(pid (\d+)\)/u.exec(
        readFileSync(holderLog, "utf-8"),
      );
      const pid = Number.parseInt(started?.[1] ?? "", 10);
      expect(Number.isSafeInteger(pid)).toBe(true);
      report("stella browser product", started?.[0] ?? "not logged");
      await waitFor(() => (alive(pid) ? undefined : true), {
        timeoutMs: 30_000,
        description: "the browser to close",
      });
      expect(readdirSync(path.join(root, "browser"))).toHaveLength(1);

      // Every protocol method the scenario sent is on the allowlist, and
      // the set is the one this scenario is known to need.
      const methods = readFileSync(path.join(root, "methods.log"), "utf-8")
        .split("\n")
        .filter((line) => line !== "");
      for (const method of methods) {
        expect(ALLOWED).toContain(method);
      }
      expect(methods.toSorted()).toEqual(READ_SCENARIO_METHODS);
      holder.kill("SIGTERM");
      await holder.exited;
    },
  );
});
