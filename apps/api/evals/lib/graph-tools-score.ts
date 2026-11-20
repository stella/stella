/**
 * Scores one model run of the graph tools eval, step by step, from the calls
 * it made and the answer it gave. Pure, so the scoring itself is tested.
 */

import type { GraphEvalTask } from "./graph-tools-case";

export const GRAPH_TOOL_NAMES = {
  nodes: "lists_graph_nodes_list",
  neighbours: "lists_graph_neighbours_list",
  paths: "lists_graph_paths_list",
} as const;

export type GraphToolCall = {
  name: string;
  /** The raw arguments the model sent, kept whole: the case is synthetic. */
  input: unknown;
  /** Null when the handler's schema accepted the call; else its issues. */
  rejected: readonly string[] | null;
  /** Node ids the call's result named, which later calls may use. */
  returnedIds: readonly string[];
};

export type GraphRunScore = {
  /** It looked a node up before navigating. */
  found: boolean;
  /** Every node id it passed came from an earlier result. */
  grounded: boolean;
  /** It navigated (neighbours or paths) at least once. */
  navigated: boolean;
  /** It used the filter the direct path uses, when the task has one. */
  filtered: boolean | null;
  /** The answer holds every expected passage. */
  answered: boolean;
  rejectedCalls: number;
  calls: number;
};

const nodeIdOf = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null || !("nodeId" in input)) {
    return null;
  }
  const { nodeId } = input;
  return typeof nodeId === "string" ? nodeId : null;
};

const filterValue = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null && key in input
    ? Reflect.get(input, key)
    : undefined;

export const scoreGraphRun = (
  task: GraphEvalTask,
  calls: readonly GraphToolCall[],
  answer: string,
): GraphRunScore => {
  const accepted = calls.filter((call) => call.rejected === null);
  const firstLookup = accepted.findIndex(
    (call) => call.name === GRAPH_TOOL_NAMES.nodes,
  );
  const navigation = accepted.filter(
    (call) =>
      call.name === GRAPH_TOOL_NAMES.neighbours ||
      call.name === GRAPH_TOOL_NAMES.paths,
  );
  const seen = new Set<string>();
  let grounded = true;
  for (const call of accepted) {
    const nodeId = nodeIdOf(call.input);
    if (nodeId !== null && !seen.has(nodeId)) {
      grounded = false;
    }
    for (const id of call.returnedIds) {
      seen.add(id);
    }
  }
  const expected = task.expectedFilter;
  const filtered =
    expected === null
      ? null
      : navigation.some((call) =>
          Object.entries(expected).every(
            ([key, value]) => filterValue(call.input, key) === value,
          ),
        );
  const normalizedAnswer = answer.toLowerCase();
  return {
    found:
      firstLookup !== -1 &&
      navigation.every((call) => accepted.indexOf(call) > firstLookup),
    grounded,
    navigated: navigation.length > 0,
    filtered,
    answered: task.expectedInAnswer.every((text) =>
      normalizedAnswer.includes(text.toLowerCase()),
    ),
    rejectedCalls: calls.length - accepted.length,
    calls: calls.length,
  };
};
