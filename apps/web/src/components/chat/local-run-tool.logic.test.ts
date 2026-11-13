import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  localRunProposedPlan,
  type LocalRunStepCall,
  type LocalRunStepStanding,
  localRunSubagentGroups,
  type LocalRunSubagentStatus,
  localRunSubagentStatus,
  localRunSubagentType,
  localRunToolView,
} from "@/components/chat/local-run-tool.logic";

const view = (name: string, input: unknown, output?: unknown) =>
  localRunToolView({ name, input, output });

describe("a step a coding agent took on the member's computer", () => {
  test("a command shows its line, and a failed one its exit code", () => {
    expect(view("command_execution", { command: "rg lease" })).toEqual({
      titleKey: null,
      subtitle: { type: "text", text: "rg lease" },
    });
    expect(
      view(
        "command_execution",
        { command: "bun test" },
        { aggregated_output: "1 fail", exit_code: 1, status: "failed" },
      ),
    ).toEqual({
      titleKey: null,
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
      titleKey: null,
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
      titleKey: "chat.toolCall.readFile",
      subtitle: { type: "text", text: "drafts/lease.md" },
    });
    expect(
      view("harness_native_tool", {
        tool: "Grep",
        detail: { kind: "search", pattern: "termination", path: "drafts" },
      }),
    ).toEqual({
      titleKey: "chat.toolCall.searchFiles",
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
      titleKey: "chat.tool.fetch_url",
      subtitle: { type: "text", text: "https://example.test/law" },
    });
    expect(
      view("harness_native_tool", {
        tool: "update_plan",
        detail: { kind: "plan", items: ["Read the lease", "Draft the notice"] },
      }),
    ).toEqual({
      titleKey: "chat.toolCall.updatePlan",
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
      titleKey: "chat.toolCall.proposedPlan",
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
      titleKey: null,
      subtitle: { type: "text", text: "Skill" },
    });
    expect(
      view("harness_native_tool", {
        tool: "Read",
        detail: { kind: "read", content: "Private text" },
      }),
    ).toEqual({ titleKey: null, subtitle: { type: "text", text: "Read" } });
  });

  test("a stella or connector call keeps its own row", () => {
    expect(view("search_case_law", { query: "lease" })).toBeNull();
    expect(view("mcp__docs__search", { query: "lease" })).toBeNull();
    expect(view("command_execution", { output: "not a command" })).toBeNull();
  });
});

const subagentStep = (
  id: string,
  extra: Partial<LocalRunStepCall> & { parentCallId?: string } = {},
): LocalRunStepCall => {
  const { parentCallId, ...call } = extra;
  return {
    id,
    name: "harness_native_tool",
    input: {
      tool: "Agent",
      detail: { kind: "subagent", description: "Check the lease" },
      ...(parentCallId === undefined ? {} : { parentCallId }),
    },
    shownAs: "row",
    ...call,
  };
};

const commandStep = (
  id: string,
  parentCallId: string | undefined,
  shownAs: LocalRunStepCall["shownAs"] = "row",
): LocalRunStepCall => ({
  id,
  name: "command_execution",
  input: {
    command: "ls",
    ...(parentCallId === undefined ? {} : { parentCallId }),
  },
  shownAs,
});

const groupsOf = (calls: readonly LocalRunStepCall[]) => {
  const { stepsOf, rowIn } = localRunSubagentGroups(calls);
  return {
    stepsOf: Object.fromEntries(stepsOf),
    rowIn: Object.fromEntries(rowIn),
  };
};

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
      titleKey: "chat.toolCall.subagent",
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
      titleKey: "chat.toolCall.subagent",
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
      titleKey: "chat.toolCall.viewImage",
      subtitle: { type: "text", text: "scans/page-1.png" },
    });
  });

  test("the steps it took show inside its group, and one waiting on the member stays on the turn", () => {
    expect(
      groupsOf([
        commandStep("before", undefined),
        subagentStep("agent"),
        commandStep("read", "agent"),
        commandStep("asks", "agent", "card"),
        {
          id: "docs",
          name: "mcp__docs__search",
          input: { query: "lease" },
          shownAs: "row",
        },
        commandStep("after", "agent"),
        subagentStep("idle"),
      ]),
    ).toEqual({
      // Every step counts, the one shown as a card included.
      stepsOf: { agent: ["read", "asks", "after"], idle: [] },
      rowIn: { read: "agent", after: "agent" },
    });
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
        commandStep("plain", undefined),
        commandStep("of-plain", "plain"),
      ]),
    ).toEqual({ stepsOf: {}, rowIn: {} });
  });

  test("no step is ever hidden: a row shows on the turn or inside a group that shows on the turn", () => {
    const id = fc.constantFrom("a", "b", "c", "d", "e");
    const calls = fc.uniqueArray(
      fc.record({
        id,
        kind: fc.constantFrom("subagent", "command"),
        parentCallId: fc.option(fc.oneof(id, fc.constant("missing")), {
          nil: undefined,
        }),
        shownAs: fc.constantFrom("row", "card"),
      }),
      { selector: (call) => call.id },
    );
    assertProperty(
      "no step is ever hidden: a row shows on the turn or inside a group that shows on the turn",
      fc.property(calls, (generated) => {
        const turn = generated.map((call) =>
          call.kind === "subagent"
            ? subagentStep(call.id, {
                shownAs: call.shownAs,
                ...(call.parentCallId === undefined
                  ? {}
                  : { parentCallId: call.parentCallId }),
              })
            : commandStep(call.id, call.parentCallId, call.shownAs),
        );
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
