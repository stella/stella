import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CHAT_LOCAL_RUN_TOOL_LIMITS } from "@stll/api-contract/chat-local-run-tool";

import type { HarnessTurn } from "./adapter";
import { toolCallForUse, toolResultFor } from "./claude-code/items";
import { toolCallForItem, toolResultForItem } from "./codex/items";
import {
  approvalMessage,
  type HarnessApprovalRequest,
  type HarnessEvent,
  type HarnessToolCall,
} from "./events";
import { redactingSkillPaths, type SkillPathScope } from "./skill-redaction";
import { HARNESS_TOOL_NAMES, shownToolInput } from "./tool-parts";

const FOLDER = "/srv/member/skills/fixture-skill";
const PLUGIN = "/data/harness-home/claude-code/stella-skill-plugins/abc";
const SCOPE: SkillPathScope = {
  folders: [{ name: "fixture-skill", path: FOLDER }],
  plugin: { dir: PLUGIN, name: "local-skills" },
};
const STATUS_ONLY = JSON.stringify({ status: "completed" });

const through = async (
  events: readonly HarnessEvent[],
  scope: SkillPathScope = SCOPE,
) => {
  const turn: HarnessTurn = {
    events: (async function* () {
      yield* events;
    })(),
    respond: async () => Result.ok(),
    steer: async () => Result.ok(),
    interrupt: async () => undefined,
    dispose: async () => undefined,
  };
  const seen: HarnessEvent[] = [];
  for await (const event of redactingSkillPaths(turn, scope).events) {
    seen.push(event);
  }
  return seen;
};

const completed = (
  toolCall: HarnessToolCall,
  result: { content: string; status: "succeeded" | "failed" },
): HarnessEvent => ({ type: "tool.completed", toolCall, result });

const lastCompleted = (events: readonly HarnessEvent[]) => {
  const event = events.at(-1);
  if (event?.type !== "tool.completed") {
    throw new Error("the last event is not a completed tool call");
  }
  return event;
};

/** A Claude tool call in the shape `toolResultFor` takes. */
const claudeCall = async (
  name: string,
  input: Record<string, unknown>,
  content: string,
) =>
  lastCompleted(
    await through([
      completed(
        toolCallForUse({ id: "call-1", name, input }, "stella"),
        toolResultFor(
          { name, input },
          { type: "tool_result", tool_use_id: "call-1", content },
        ),
      ),
    ]),
  );

const codexCommand = (command: string, aggregatedOutput: string) => ({
  type: "commandExecution" as const,
  id: "call-1",
  command,
  cwd: "/data/runs/1",
  status: "completed" as const,
  aggregatedOutput,
  exitCode: 0,
});

describe("what a turn reports about its skill folders", () => {
  test("a Claude Read of a skill file reports only the status, and what it read goes nowhere", async () => {
    const event = await claudeCall(
      "Read",
      { file_path: `${FOLDER}/references/commentary.md` },
      "Licensed commentary.",
    );
    expect(event.toolCall).toEqual({
      id: "call-1",
      name: "harness_native_tool",
      input: {
        tool: "Read",
        detail: {
          kind: "read",
          path: "<skill:fixture-skill>/references/commentary.md",
        },
      },
    });
    expect(event.result).toEqual({ content: STATUS_ONLY, status: "succeeded" });
    expect(JSON.stringify(event)).not.toContain(FOLDER);
  });

  test("a Claude Grep over a skill folder reports only the status", async () => {
    const { result, toolCall } = await claudeCall(
      "Grep",
      { pattern: "clause", path: FOLDER },
      "a licensed clause",
    );
    expect(toolCall.input).toEqual({
      tool: "Grep",
      detail: {
        kind: "search",
        pattern: "clause",
        path: "<skill:fixture-skill>",
      },
    });
    expect(result.content).toBe(STATUS_ONLY);
  });

  test("a skill path past a long command's cut is named before the cut, never shown in part", async () => {
    const event = await claudeCall(
      "Bash",
      { command: `echo ${"x".repeat(280)} && cat ${FOLDER}/SKILL.md` },
      "Licensed text.",
    );
    const shown = JSON.stringify(
      shownToolInput(event.toolCall, "/data/runs/1"),
    );
    // The cut falls inside where the folder's path stood.
    expect(`echo ${"x".repeat(280)} && cat ${FOLDER}`.length).toBeGreaterThan(
      CHAT_LOCAL_RUN_TOOL_LIMITS.command,
    );
    expect(shown).toContain("…");
    expect(shown).not.toContain("/srv");
    expect(event.result.content).toBe(STATUS_ONLY);
  });

  test("a Claude read through the plugin's own link does the same", async () => {
    const { toolCall, result } = await claudeCall(
      "Read",
      { file_path: `${PLUGIN}/skills/fixture-skill/SKILL.md` },
      "Licensed commentary.",
    );
    expect(toolCall.input).toEqual({
      tool: "Read",
      detail: { kind: "read", path: "<skill:fixture-skill>/SKILL.md" },
    });
    expect(result.content).toBe(STATUS_ONLY);
  });

  test("a Claude Bash on a skill script loses its output, and its command names the skill", async () => {
    const { toolCall, result } = await claudeCall(
      "Bash",
      {
        command: `bun ${FOLDER}/scripts/run.ts`,
        description: "Run the skill",
      },
      "Licensed output.",
    );
    expect(toolCall.input).toEqual({
      command: "bun <skill:fixture-skill>/scripts/run.ts",
    });
    expect(result.content).toBe(STATUS_ONLY);
  });

  test("invoking a skill by its plugin name reports only the status", async () => {
    const { toolCall, result } = await claudeCall(
      "Skill",
      { skill: "local-skills:fixture-skill" },
      "Launching skill: fixture-skill",
    );
    expect(toolCall.input).toEqual({ tool: "Skill" });
    expect(result.content).toBe(STATUS_ONLY);
  });

  test("a question names a skill by its name and keeps each option's answer", async () => {
    const [event] = await through([
      {
        type: "question.requested",
        request: {
          requestId: "request-1",
          toolCall: { id: "call-1", name: "question", input: {} },
          answerWith: "response",
          questions: [
            {
              id: "q1",
              header: `Run ${FOLDER}/scripts/run.ts?`,
              prompt: `It reads ${FOLDER}/SKILL.md.`,
              options: [
                { label: `${FOLDER}/a.md`, description: `From ${FOLDER}.` },
              ],
              allowsFreeText: false,
              multiSelect: false,
              secret: false,
            },
          ],
        },
      },
    ]);
    if (event?.type !== "question.requested") {
      throw new Error("the question did not pass");
    }
    const [question] = event.request.questions;
    expect(question?.header).toBe("Run <skill:fixture-skill>/scripts/run.ts?");
    expect(question?.prompt).toBe("It reads <skill:fixture-skill>/SKILL.md.");
    expect(question?.options).toEqual([
      { label: `${FOLDER}/a.md`, description: "From <skill:fixture-skill>." },
    ]);
  });

  test("a Claude Bash that never names a skill keeps its command, and its output stays here", async () => {
    const event = await claudeCall("Bash", { command: "ls" }, "notes.md\n");
    expect(event.toolCall.input).toEqual({ command: "ls" });
    expect(JSON.parse(event.result.content)).toEqual({ status: "completed" });
  });

  test("a Codex command reading a skill shows the name and reports only the status", async () => {
    const item = codexCommand(`cat ${FOLDER}/SKILL.md`, "Licensed text.");
    const { toolCall, result } = lastCompleted(
      await through([
        completed(toolCallForItem(item, "stella"), toolResultForItem(item)),
      ]),
    );
    expect(toolCall.input).toEqual({
      command: "cat <skill:fixture-skill>/SKILL.md",
    });
    expect(result).toEqual({ content: STATUS_ONLY, status: "succeeded" });
  });

  test("a call that never named a skill but printed its path reports only the status", async () => {
    const item = codexCommand(
      "grep -r clause /srv/member",
      `${FOLDER}/references/commentary.md: a licensed clause`,
    );
    const { toolCall, result } = lastCompleted(
      await through([
        completed(toolCallForItem(item, "stella"), toolResultForItem(item)),
      ]),
    );
    expect(toolCall.input).toEqual({ command: "grep -r clause /srv/member" });
    expect(JSON.parse(result.content)).toEqual({
      exit_code: 0,
      status: "completed",
    });
  });

  test("a call known to have touched a skill when it started stays status only", async () => {
    const started: HarnessToolCall = {
      id: "call-1",
      name: "Bash",
      input: { command: `cat ${FOLDER}/SKILL.md` },
    };
    const events = await through([
      { type: "tool.started", toolCall: started },
      completed(
        { ...started, input: {} },
        { content: "Licensed text.", status: "succeeded" },
      ),
    ]);
    expect(lastCompleted(events).result.content).toBe(STATUS_ONLY);
  });

  test("a failed call says it failed, without its output", async () => {
    const { result } = lastCompleted(
      await through([
        completed(
          {
            id: "call-1",
            name: "Read",
            input: { file_path: `${FOLDER}/SKILL.md` },
          },
          { content: "denied", status: "failed" },
        ),
      ]),
    );
    expect(result).toEqual({
      content: JSON.stringify({ status: "failed" }),
      status: "failed",
    });
  });

  test("an approval's summary and reason name the skill, not the path", async () => {
    const request: HarnessApprovalRequest = {
      requestId: "r-1",
      kind: "command",
      // An adapter asks about the call it built, named as chat keeps it.
      toolCall: {
        id: "call-1",
        name: HARNESS_TOOL_NAMES.commandExecution,
        input: { command: `bun ${FOLDER}/scripts/run.ts` },
      },
      reason: `Runs a script in ${FOLDER}`,
      options: [],
    };
    const [event] = await through([{ type: "approval.requested", request }]);
    if (event?.type !== "approval.requested") {
      throw new Error("the approval did not come through");
    }
    expect(approvalMessage(event.request)).toBe(
      "bun <skill:fixture-skill>/scripts/run.ts",
    );
    expect(event.request.reason).toBe("Runs a script in <skill:fixture-skill>");
  });

  test("a folder whose name only starts the same is not a skill", async () => {
    const { toolCall, result } = await claudeCall(
      "Read",
      { file_path: `${FOLDER}-old/notes.md` },
      "Not a skill.",
    );
    expect(toolCall.input).toEqual({
      tool: "Read",
      detail: { kind: "read", path: `${FOLDER}-old/notes.md` },
    });
    expect(result.content).toBe(STATUS_ONLY);
  });

  test("a path with a space, as a shell writes it, counts too", async () => {
    const spaced = "/srv/member/my skills/fixture-skill";
    const { result, toolCall } = lastCompleted(
      await through(
        [
          completed(
            {
              id: "call-1",
              name: "Bash",
              input: {
                command: String.raw`cat /srv/member/my\ skills/fixture-skill/SKILL.md`,
              },
            },
            { content: "Licensed text.", status: "succeeded" },
          ),
        ],
        { folders: [{ name: "fixture-skill", path: spaced }], plugin: null },
      ),
    );
    expect(toolCall.input).toEqual({
      command: "cat <skill:fixture-skill>/SKILL.md",
    });
    expect(result.content).toBe(STATUS_ONLY);
  });

  test("a Windows path counts however a tool spells it, JSON and case included", async () => {
    const windows = String.raw`C:\Skills\fixture-skill`;
    const scope = {
      folders: [{ name: "fixture-skill", path: windows }],
      plugin: null,
    };
    const { result, toolCall } = lastCompleted(
      await through(
        [
          completed(
            {
              id: "call-1",
              name: "Bash",
              input: { command: "cat c:/skills/fixture-skill/SKILL.md" },
            },
            {
              content: JSON.stringify({
                aggregated_output: String.raw`C:\Skills\fixture-skill\SKILL.md`,
              }),
              status: "succeeded",
            },
          ),
        ],
        scope,
      ),
    );
    expect(toolCall.input).toEqual({
      command: "cat <skill:fixture-skill>/SKILL.md",
    });
    expect(result.content).toBe(STATUS_ONLY);
  });

  test("a failure's message names the skill, not the path", async () => {
    const [event] = await through([
      {
        type: "turn.failed",
        failure: {
          type: "protocol_violation",
          message: `Could not read ${FOLDER}/SKILL.md`,
        },
      },
    ]);
    expect(event).toEqual({
      type: "turn.failed",
      failure: {
        type: "protocol_violation",
        message: "Could not read <skill:fixture-skill>/SKILL.md",
      },
    });
  });

  test("what it cannot see: a relative read after a cd, and the model's own words", async () => {
    const events = await through([
      completed(
        { id: "call-1", name: "Bash", input: { command: `cd ${FOLDER}` } },
        { content: "", status: "succeeded" },
      ),
      completed(
        { id: "call-2", name: "Bash", input: { command: "cat SKILL.md" } },
        { content: "Licensed text.", status: "succeeded" },
      ),
      { type: "text.completed", messageId: "m-1", text: "Licensed text." },
    ]);
    expect(events[1]).toMatchObject({
      result: { content: "Licensed text." },
    });
    expect(events[2]).toMatchObject({ text: "Licensed text." });
  });

  test("with no folder listed the turn is the harness's own", async () => {
    const turn: HarnessTurn = {
      events: (async function* () {
        yield* [];
      })(),
      respond: async () => Result.ok(),
      steer: async () => Result.ok(),
      interrupt: async () => undefined,
      dispose: async () => undefined,
    };
    expect(redactingSkillPaths(turn, { folders: [], plugin: null })).toBe(turn);
  });
});
