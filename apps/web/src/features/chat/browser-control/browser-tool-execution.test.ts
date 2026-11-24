import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  type BrowserControlCommand,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";
import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";

import { createBrowserApprovalState } from "./browser-approval-state";
import { createBrowserToolExecutionCache } from "./browser-tool-execution";

const success = {
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  snapshot: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    elements: [],
    elementsLeftOut: false,
    facts: { meta: [] },
    revision: "revision-1",
    tabId: 7,
    tabs: [
      {
        active: true,
        tabId: 7,
        url: "https://example.com/",
      },
    ],
    text: "Ready",
    title: "Example",
    url: "https://example.com/",
    window: { cursor: "r1.window", fromPercent: 0, toPercent: 100 },
  },
  status: "success",
} satisfies BrowserControlResult;

const redirected = {
  code: BROWSER_CONTROL_ERROR_CODE.redirected,
  message: "The page redirected to another website.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
} satisfies BrowserControlResult;

const untracked = () => () => undefined;

const RUN = { signal: new AbortController().signal, turnId: "turn-1" };

const NO_GRANTS: ReadonlySet<string> = new Set();

/** An executor whose gate decides at `level` on what `state` was told. */
const cacheAt = (
  level: DesktopRunnerApprovalMode,
  execute: Parameters<typeof createBrowserToolExecutionCache>[0],
  state = createBrowserApprovalState(),
) => ({
  cache: createBrowserToolExecutionCache(
    execute,
    state.beginCommand,
    (command) => state.decide({ command, grantedOrigins: NO_GRANTS, level }),
  ),
  state,
});

const ABSENT = { type: BROWSER_CONTROL_TARGET_METADATA.absent } as const;
const onPage = (role: string) => ({
  page: { revision: "revision-1", url: "https://example.com/" },
  target: {
    context: ABSENT,
    href: ABSENT,
    name: "Field",
    ref: "e:0:0.1",
    role,
  },
});

/** Every element step, and the kind Jan's rule names it by. */
const ELEMENT_STEPS = [
  { kind: "click", command: { action: "click", ...onPage("button") } },
  {
    kind: "click",
    command: { action: "press-key", key: "Enter", ...onPage("textbox") },
  },
  {
    kind: "click",
    command: { action: "press-key", key: "Enter", ...onPage("searchbox") },
  },
  {
    kind: "search",
    command: { action: "fill", value: "notice", ...onPage("searchbox") },
  },
  {
    kind: "type",
    command: { action: "fill", value: "Jane", ...onPage("textbox") },
  },
  {
    kind: "type",
    command: { action: "select", value: "2024", ...onPage("combobox") },
  },
] as const satisfies readonly {
  kind: "click" | "search" | "type";
  command: BrowserControlCommand;
}[];

const READS = [
  { action: "open", url: "https://example.com/" },
  { action: "snapshot" },
  { action: "find", search: { query: "notice", type: "text" } },
  { action: "go-back" },
  { action: "switch-tab", tabId: 7, url: "https://example.com/" },
] as const satisfies readonly BrowserControlCommand[];

const signInHandOver = {
  code: BROWSER_CONTROL_ERROR_CODE.needsMember,
  message: "The page asks for a sign-in.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
} satisfies BrowserControlResult;

describe("chat browser tool execution cache", () => {
  test("concurrent and later retries execute one real browser action", async () => {
    let calls = 0;
    const cache = createBrowserToolExecutionCache(
      async () => {
        calls += 1;
        await Promise.resolve();
        return success;
      },
      untracked,
      () => ({ type: "run", by: "level" }),
    );

    const first = cache.executeOnce("call-1", { action: "snapshot" }, RUN);
    const concurrent = cache.executeOnce("call-1", { action: "snapshot" }, RUN);
    expect(await Promise.all([first, concurrent])).toEqual([success, success]);
    expect(
      await cache.executeOnce("call-1", { action: "snapshot" }, RUN),
    ).toEqual(success);
    expect(calls).toBe(1);
  });

  test("different tool-call ids remain independent", async () => {
    let calls = 0;
    const { cache } = cacheAt("ask", async () => {
      calls += 1;
      return success;
    });

    await cache.executeOnce("call-1", { action: "snapshot" }, RUN);
    await cache.executeOnce("call-2", { action: "snapshot" }, RUN);
    expect(calls).toBe(2);
  });

  test("a failed result leaves no page reported, and a retry is not a new outcome", async () => {
    const results: BrowserControlResult[] = [success, redirected];
    const { cache, state } = cacheAt("ask", async () => {
      const result = results.shift() ?? success;
      state.observeResult(result);
      return result;
    });
    const click = ELEMENT_STEPS[0].command;
    const granted = new Set(["https://example.com"]);
    const byGrant = () =>
      state.decide({ command: click, grantedOrigins: granted, level: "ask" });

    await cache.executeOnce("call-1", { action: "snapshot" }, RUN);
    expect(byGrant()).toEqual({
      type: "run",
      by: "site-grant",
      origin: "https://example.com",
    });
    await cache.executeOnce(
      "call-2",
      { action: "open", url: "https://a.test" },
      RUN,
    );
    expect(byGrant()).toEqual({ type: "ask", site: "https://example.com" });
    // A coalesced retry of the earlier success is not a new outcome.
    await cache.executeOnce("call-1", { action: "snapshot" }, RUN);
    expect(byGrant()).toMatchObject({ type: "ask" });
  });

  test("a command still running leaves no page reported", async () => {
    const state = createBrowserApprovalState();
    state.observeResult(success);
    state.beginCommand()(true);
    let answer: (result: BrowserControlResult) => void = () => undefined;
    const { cache } = cacheAt(
      "ask",
      async () =>
        await new Promise<BrowserControlResult>((resolve) => {
          answer = resolve;
        }),
      state,
    );
    const click = ELEMENT_STEPS[0].command;
    const granted = new Set(["https://example.com"]);

    const pending = cache.executeOnce("call-1", { action: "snapshot" }, RUN);
    expect(
      state.decide({ command: click, grantedOrigins: granted, level: "ask" }),
    ).toMatchObject({ type: "ask" });
    answer(success);
    await pending;
    expect(
      state.decide({ command: click, grantedOrigins: granted, level: "ask" }),
    ).toMatchObject({ type: "run", by: "site-grant" });
  });

  test("an executor failure counts as a failed command", async () => {
    const state = createBrowserApprovalState();
    state.observeResult(success);
    state.beginCommand()(true);
    const { cache } = cacheAt(
      "ask",
      async () => await Promise.reject(new Error("postMessage failed")),
      state,
    );

    const outcome = await cache
      .executeOnce("call-1", { action: "snapshot" }, RUN)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(Error);
    expect(
      state.decide({
        command: ELEMENT_STEPS[0].command,
        grantedOrigins: new Set(["https://example.com"]),
        level: "ask",
      }),
    ).toMatchObject({ type: "ask" });
  });
});

describe("steps the level does not run", () => {
  test("every level and step: only Plan and a sign-in stop a step before the extension", async () => {
    for (const level of DESKTOP_RUNNER_APPROVAL_MODES) {
      for (const signIn of [false, true]) {
        for (const command of [
          ...READS,
          ...ELEMENT_STEPS.map((step) => step.command),
        ]) {
          const reached: string[] = [];
          const state = createBrowserApprovalState();
          state.observeResult(success);
          if (signIn) {
            state.observeResult(signInHandOver);
          }
          const { cache } = cacheAt(
            level,
            async () => {
              reached.push(command.action);
              return success;
            },
            state,
          );
          const result = await cache.executeOnce("call-1", command, RUN);
          const onElement = "target" in command;
          const held = onElement && (signIn || level === "plan");
          expect({ level, signIn, action: command.action, reached }).toEqual({
            level,
            signIn,
            action: command.action,
            reached: held ? [] : [command.action],
          });
          if (!held) {
            expect(result).toEqual(success);
          } else if (signIn) {
            expect(result).toMatchObject({
              code: BROWSER_CONTROL_ERROR_CODE.needsMember,
              message: expect.stringContaining("sign in"),
              status: "error",
            });
          } else {
            expect(result).toMatchObject({
              code: BROWSER_CONTROL_ERROR_CODE.permissionDenied,
              message: expect.stringContaining("Plan mode is read-only"),
              status: "error",
            });
          }
        }
      }
    }
  });

  test("a malformed command reaches the extension, which refuses it", async () => {
    const reached: unknown[] = [];
    const { cache } = cacheAt("plan", async (input) => {
      reached.push(input);
      return success;
    });
    await cache.executeOnce("call-1", { action: "click", ref: "e:0" }, RUN);
    expect(reached).toEqual([{ action: "click", ref: "e:0" }]);
  });
});

describe("chat browser tool run", () => {
  test("passes the chat turn and stop signal to the executor", async () => {
    const runs: unknown[] = [];
    const { cache } = cacheAt("ask", async (_input, _id, run) => {
      runs.push(run);
      return success;
    });

    await cache.executeOnce("call-1", { action: "snapshot" }, RUN);
    expect(runs).toEqual([RUN]);
  });
});
