import { describe, expect, test } from "bun:test";

import { GRAPH_EVAL_TASKS } from "./graph-tools-case";
import type { GraphEvalTask } from "./graph-tools-case";
import { GRAPH_TOOL_NAMES, scoreGraphRun } from "./graph-tools-score";
import type { GraphToolCall } from "./graph-tools-score";

const task =
  GRAPH_EVAL_TASKS.find(({ id }) => id === "en-conflict-quote") ??
  (() => {
    throw new Error("task missing");
  })();

const FACT = "a1111111-1111-4111-8111-111111111111";
const CLAIM = "a2222222-2222-4222-8222-222222222222";

const call = (
  name: string,
  input: unknown,
  returnedIds: readonly string[] = [],
  rejected: readonly string[] | null = null,
): GraphToolCall => ({ name, input, returnedIds, rejected });

describe("graph tools eval scoring", () => {
  test("a run that looks up, navigates by returned ids with the right filter and quotes passes every step", () => {
    expect(
      scoreGraphRun(
        task,
        [
          call(GRAPH_TOOL_NAMES.nodes, { text: "cargo" }, [CLAIM, FACT]),
          call(
            GRAPH_TOOL_NAMES.neighbours,
            { nodeKind: "claim", nodeId: CLAIM, stance: "conflicts" },
            [FACT],
          ),
        ],
        "The survey says: Hold 2: seawater ingress, 41 pallets wet and unsaleable.",
      ),
    ).toEqual({
      found: true,
      grounded: true,
      navigated: true,
      filtered: true,
      answered: true,
      rejectedCalls: 0,
      calls: 2,
    });
  });

  test("an invented id, a rejected call and a missing quote each cost their own step", () => {
    const score = scoreGraphRun(
      task,
      [
        call(GRAPH_TOOL_NAMES.neighbours, { nodeKind: "fact", nodeId: FACT }),
        call(GRAPH_TOOL_NAMES.nodes, { text: "" }, [], ["text: too short"]),
      ],
      "The cargo was damaged.",
    );
    expect(score).toMatchObject({
      found: false,
      grounded: false,
      navigated: true,
      filtered: false,
      answered: false,
      rejectedCalls: 1,
    });
  });

  test("a task with no direct filter does not score one", () => {
    const open: GraphEvalTask = {
      id: "open",
      prompt: "",
      expectedInAnswer: [],
      expectedFilter: null,
    };
    expect(scoreGraphRun(open, [], "").filtered).toBeNull();
  });
});
