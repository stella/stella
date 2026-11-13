import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  localRunProposedPlan,
  type LocalRunStepCall,
  localRunStepOutputKind,
  type LocalRunStepStanding,
  localRunSubagentGroups,
  type LocalRunSubagentStatus,
  localRunSubagentStatus,
  localRunSubagentType,
  localRunToolView,
} from "./chat-local-run-steps";
import fixtures from "./chat-local-run-steps.fixtures.json";
import { chatLocalRunParentCallId } from "./chat-local-run-tool";

const view = (name: string, input: unknown, output?: unknown) =>
  localRunToolView({ name, input, output });

describe("a step a coding agent took on the member's computer", () => {
  test("a command shows its line, and a failed one its exit code", () => {
    expect(view("command_execution", { command: "rg lease" })).toEqual({
      titleKind: null,
      subtitle: { type: "text", text: "rg lease" },
    });
    expect(
      view(
        "command_execution",
        { command: "bun test" },
        { aggregated_output: "1 fail", exit_code: 1, status: "failed" },
      ),
    ).toEqual({
      titleKind: null,
      subtitle: { type: "command", command: "bun test", exitCode: 1 },
    });
    // Success needs no code; the status mark says it.
    expect(
      view("command_execution", { command: "ls" }, { exit_code: 0 }),
    ).toMatchObject({ subtitle: { type: "text", text: "ls" } });
  });

  test("a stored command from before the bound is shown within it, on one line", () => {
    const shown = view("command_execution", {
      command: `cat > notes.md <<'EOF'\nPrivate terms\nEOF`,
    });
    expect(shown?.subtitle).toEqual({
      type: "text",
      text: "cat > notes.md <<'EOF'…",
    });
  });

  test("a file change names its files", () => {
    expect(
      view("file_change", {
        changes: [
          { path: "drafts/lease.md", kind: "update" },
          { path: "drafts/notice.md", kind: "add" },
        ],
      }),
    ).toEqual({
      titleKind: null,
      subtitle: { type: "text", text: "drafts/lease.md, drafts/notice.md" },
    });
  });

  test("a read, a search, a fetch and a plan are named by their kind", () => {
    expect(
      view("harness_native_tool", {
        tool: "Read",
        detail: { kind: "read", path: "drafts/lease.md" },
      }),
    ).toEqual({
      titleKind: "read",
      subtitle: { type: "text", text: "drafts/lease.md" },
    });
    expect(
      view("harness_native_tool", {
        tool: "Grep",
        detail: { kind: "search", pattern: "termination", path: "drafts" },
      }),
    ).toEqual({
      titleKind: "search",
      subtitle: { type: "search", pattern: "termination", path: "drafts" },
    });
    expect(
      view("harness_native_tool", {
        tool: "Glob",
        detail: { kind: "search", pattern: "**/*.md" },
      }),
    ).toMatchObject({ subtitle: { type: "text", text: "**/*.md" } });
    expect(
      view("harness_native_tool", {
        tool: "WebFetch",
        detail: { kind: "fetch", url: "https://example.test/law" },
      }),
    ).toEqual({
      titleKind: "fetch",
      subtitle: { type: "text", text: "https://example.test/law" },
    });
    expect(
      view("harness_native_tool", {
        tool: "update_plan",
        detail: { kind: "plan", items: ["Read the lease", "Draft the notice"] },
      }),
    ).toEqual({
      titleKind: "plan",
      subtitle: { type: "text", text: "Read the lease, Draft the notice" },
    });
  });

  test("a proposed plan is named in its row and read whole from its call", () => {
    const plan = "## Plan\n\n1. Read the lease.\n2. Draft the notice.";
    const input = {
      tool: "ExitPlanMode",
      detail: { kind: "proposed_plan", text: plan },
    };
    expect(view("harness_native_tool", input)).toEqual({
      titleKind: "proposed_plan",
      subtitle: null,
    });
    expect(localRunProposedPlan({ name: "harness_native_tool", input })).toBe(
      plan,
    );
    expect(
      localRunProposedPlan({
        name: "harness_native_tool",
        input: { tool: "TodoWrite", detail: { kind: "plan", items: [] } },
      }),
    ).toBeNull();
    expect(localRunProposedPlan({ name: "mcp__docs__plan", input })).toBeNull();
  });

  test("any other native tool shows its name, and a malformed detail its name only", () => {
    expect(view("harness_native_tool", { tool: "Skill" })).toEqual({
      titleKind: null,
      subtitle: { type: "text", text: "Skill" },
    });
    expect(
      view("harness_native_tool", {
        tool: "Read",
        detail: { kind: "read", content: "Private text" },
      }),
    ).toEqual({ titleKind: null, subtitle: { type: "text", text: "Read" } });
  });

  test("a stella or connector call keeps its own row", () => {
    expect(view("search_case_law", { query: "lease" })).toBeNull();
    expect(view("mcp__docs__search", { query: "lease" })).toBeNull();
    expect(view("command_execution", { output: "not a command" })).toBeNull();
  });
});

describe("a browser step on the member's computer", () => {
  test("an opened page is named by its address, other steps by their kind", () => {
    expect(
      view("local_browser", {
        action: "open",
        url: "https://fixture-library.test/search",
      }),
    ).toEqual({
      titleKind: null,
      subtitle: { type: "text", text: "https://fixture-library.test/search" },
    });
    expect(view("local_browser", { action: "click" })).toEqual({
      titleKind: null,
      subtitle: null,
    });
  });

  test("a step that stopped at a sign-in asks the member to sign in", () => {
    expect(
      view(
        "local_browser",
        { action: "open", url: "https://fixture-library.test/account" },
        { status: "needs_member" },
      ),
    ).toEqual({
      titleKind: "sign_in",
      subtitle: { type: "text", text: "https://fixture-library.test/account" },
    });
  });
});

const subagentStep = (
  id: string,
  extra: Partial<LocalRunStepCall> = {},
): LocalRunStepCall => ({
  id,
  name: "harness_native_tool",
  input: {
    tool: "Agent",
    detail: { kind: "subagent", description: "Check the lease" },
  },
  parentCallId: null,
  shownAs: "row",
  ...extra,
});

const commandStep = (
  id: string,
  parentCallId: string | null,
  shownAs: LocalRunStepCall["shownAs"] = "row",
): LocalRunStepCall => ({
  id,
  name: "command_execution",
  input: { command: "ls" },
  parentCallId,
  shownAs,
});

/** A connected server's tool: its input is the tool's own. */
const connectorStep = (
  id: string,
  parentCallId: string | null,
): LocalRunStepCall => ({
  id,
  name: "mcp__docs__search",
  input: { query: "lease" },
  parentCallId,
  shownAs: "row",
});

const groupsOf = (calls: readonly LocalRunStepCall[]) => {
  const { stepsOf, rowIn } = localRunSubagentGroups(calls);
  return {
    stepsOf: Object.fromEntries(stepsOf),
    rowIn: Object.fromEntries(rowIn),
  };
};

test("a step names what it kept on the computer for the member to open, by what the step is", () => {
  const kind = (name: string, input: unknown) =>
    localRunStepOutputKind({ name, input });
  expect(kind("command_execution", { command: "ls" })).toBe("command");
  expect(kind("file_change", { changes: [] })).toBe("diff");
  expect(
    kind("harness_native_tool", {
      tool: "Agent",
      detail: { kind: "subagent", description: "Check the lease" },
    }),
  ).toBe("conversation");
  expect(
    kind("harness_native_tool", {
      tool: "Read",
      detail: { kind: "image", path: "scans/page-1.png" },
    }),
  ).toBe("image");
  // A file that was read, a search and any other call keep nothing to open.
  expect(
    kind("harness_native_tool", {
      tool: "Read",
      detail: { kind: "read", path: "drafts/lease.md" },
    }),
  ).toBeNull();
  expect(kind("harness_web_search", { query: "lease" })).toBeNull();
  expect(kind("mcp__docs__search", { query: "lease" })).toBeNull();
  // An input that is not the step's own names nothing.
  expect(kind("command_execution", "ls")).toBeNull();
});

describe("a subagent a coding agent started on the member's computer", () => {
  test("its step names the task and the kind of agent, and an image its file", () => {
    const input = {
      tool: "Agent",
      detail: {
        kind: "subagent",
        description: "Check the lease",
        agentType: "Explore",
      },
    };
    expect(view("harness_native_tool", input)).toEqual({
      titleKind: "subagent",
      subtitle: { type: "text", text: "Check the lease" },
    });
    expect(localRunSubagentType({ name: "harness_native_tool", input })).toBe(
      "Explore",
    );
    // A harness that names neither shows the step as a subagent, no more.
    const unnamed = {
      tool: "spawnAgent",
      detail: { kind: "subagent", description: "" },
    };
    expect(view("harness_native_tool", unnamed)).toEqual({
      titleKind: "subagent",
      subtitle: null,
    });
    expect(
      localRunSubagentType({ name: "harness_native_tool", input: unnamed }),
    ).toBeNull();
    expect(
      localRunSubagentType({
        name: "command_execution",
        input: { command: "ls" },
      }),
    ).toBeNull();
    expect(
      view("harness_native_tool", {
        tool: "view_image",
        detail: { kind: "image", path: "scans/page-1.png" },
      }),
    ).toEqual({
      titleKind: "image",
      subtitle: { type: "text", text: "scans/page-1.png" },
    });
  });

  test("the steps it took show inside its group, and one waiting on the member stays on the turn", () => {
    expect(
      groupsOf([
        commandStep("before", null),
        subagentStep("agent"),
        commandStep("read", "agent"),
        commandStep("asks", "agent", "card"),
        // A connected server's tool the subagent called is its step too;
        // one the main thread called stays on the turn.
        connectorStep("docs", "agent"),
        connectorStep("main-docs", null),
        commandStep("after", "agent"),
        subagentStep("idle"),
      ]),
    ).toEqual({
      // Every step counts, the one shown as a card included.
      stepsOf: { agent: ["read", "asks", "docs", "after"], idle: [] },
      rowIn: { read: "agent", docs: "agent", after: "agent" },
    });
  });

  test("a stored turn groups by the link in each call's metadata, never by a step's input", () => {
    // The fixture the web's and the phone's tests draw too.
    const { stepsOf, rowIn } = localRunSubagentGroups(
      fixtures.parts.map((part) => ({
        id: part.id,
        name: part.name,
        input: part.input,
        parentCallId: chatLocalRunParentCallId(
          "metadata" in part ? part.metadata : undefined,
        ),
        shownAs: "row",
      })),
    );
    expect(Object.fromEntries(stepsOf)).toEqual({
      [fixtures.subagentCallId]: fixtures.stepsOfSubagent,
    });
    for (const step of fixtures.onTheTurn) {
      expect(rowIn.has(step)).toBe(false);
    }
  });

  test("a subagent started by a subagent shows in the outermost one's group with the steps it took", () => {
    expect(
      groupsOf([
        subagentStep("outer"),
        subagentStep("inner", { parentCallId: "outer" }),
        commandStep("deep", "inner"),
      ]),
    ).toEqual({
      stepsOf: { outer: ["inner", "deep"] },
      rowIn: { inner: "outer", deep: "outer" },
    });
  });

  test("a step stays on the turn when its subagent is not a group there", () => {
    // The subagent's step waits on the member, the turn does not have it, or
    // the step names a call that is no subagent.
    expect(
      groupsOf([
        subagentStep("asks", { shownAs: "card" }),
        commandStep("of-asks", "asks"),
        commandStep("of-missing", "missing"),
        commandStep("plain", null),
        commandStep("of-plain", "plain"),
      ]),
    ).toEqual({ stepsOf: {}, rowIn: {} });
  });

  test("no step is ever hidden: a row shows on the turn or inside a group that shows on the turn", () => {
    const id = fc.constantFrom("a", "b", "c", "d", "e");
    const calls = fc.uniqueArray(
      fc.record({
        id,
        kind: fc.constantFrom("subagent", "command", "connector"),
        parentCallId: fc.option(fc.oneof(id, fc.constant("missing")), {
          nil: null,
        }),
        shownAs: fc.constantFrom("row", "card"),
      }),
      { selector: (call) => call.id },
    );
    assertProperty(
      "no step is ever hidden: a row shows on the turn or inside a group that shows on the turn",
      fc.property(calls, (generated) => {
        const turn = generated.map((call) => {
          switch (call.kind) {
            case "subagent":
              return subagentStep(call.id, {
                shownAs: call.shownAs,
                parentCallId: call.parentCallId,
              });
            case "command":
              return commandStep(call.id, call.parentCallId, call.shownAs);
            case "connector":
              return {
                ...connectorStep(call.id, call.parentCallId),
                shownAs: call.shownAs,
              };
            default:
              call.kind satisfies never;
              return panic("Unhandled generated call");
          }
        });
        const { stepsOf, rowIn } = localRunSubagentGroups(turn);
        for (const [step, subagent] of rowIn) {
          // The group it shows in is drawn on the turn itself, as a row.
          expect(stepsOf.get(subagent)).toContain(step);
          expect(rowIn.has(subagent)).toBe(false);
          expect(turn.find((call) => call.id === subagent)?.shownAs).toBe(
            "row",
          );
          expect(turn.find((call) => call.id === step)?.shownAs).toBe("row");
        }
        // A step is one subagent's at most.
        const counted = [...stepsOf.values()].flat();
        expect(new Set(counted).size).toBe(counted.length);
      }),
    );
  });

  test("it reads as one status: waiting on the member first, then work under way, then how its own step ended", () => {
    const status = (
      own: LocalRunStepStanding,
      steps: readonly LocalRunStepStanding[] = [],
    ) => localRunSubagentStatus({ own, steps });
    expect(status("running", ["done", "awaiting_approval"])).toBe(
      "needs_approval",
    );
    expect(status("running", ["done", "failed"])).toBe("running");
    // A harness may end the call that started a subagent before the
    // subagent ends: a step still under way keeps it running.
    expect(status("done", ["running"])).toBe("running");
    // A step that failed is the subagent's to work around.
    expect(status("done", ["failed", "interrupted"])).toBe("done");
    expect(status("failed", ["done"])).toBe("failed");
    expect(status("interrupted", ["interrupted"])).toBe("interrupted");
    expect(status("done")).toBe("done");
    // Every standing of the subagent with every standing of a step reaches
    // every status, and no other.
    const reaches = {
      needs_approval: status("running", ["awaiting_approval"]),
      running: status("done", ["running"]),
      failed: status("failed", ["done"]),
      interrupted: status("interrupted", ["done"]),
      done: status("done", ["failed"]),
    } satisfies Record<LocalRunSubagentStatus, LocalRunSubagentStatus>;
    expect(
      Object.entries(reaches).filter(([name, reached]) => reached !== name),
    ).toEqual([]);
  });
});
