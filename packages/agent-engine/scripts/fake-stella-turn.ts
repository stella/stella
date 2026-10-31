import type { StellaMcpToolName } from "@stll/api-contract/mcp-tool-names";

/**
 * One turn of stella tool calls, shared by every fake harness and by the
 * cloud chat turn the tests compare them with. The calls are grouped into
 * the model steps that make them: the calls of one step run together, and a
 * step starts once the previous step's results are in. A fake harness and
 * the cloud reference both replay these steps, so the turns they compare
 * cannot make different calls in a different order.
 */

/** The server name tests register the stella MCP binding under. */
export const FAKE_STELLA_SERVER = "stella";

export type FakeStellaCall = {
  id: string;
  tool: StellaMcpToolName;
  arguments: object;
  /** What the stella MCP server returns: the tool's validated output. */
  output: object;
};

const searchCaseLaw = {
  id: "call-case-law",
  tool: "search_case_law",
  arguments: { query: "lease termination", jurisdiction: "CZ" },
  output: {
    results: [
      {
        title: "Lease termination for unpaid rent",
        url: "https://stll.app/case-law/cz/nejvyssi-soud/26-cdo-1-2024",
        caseLaw: { decisionId: "dec-1", decisionDate: "2024-03-01" },
      },
    ],
    nextCursor: null,
  },
} as const satisfies FakeStellaCall;

const listMatters = {
  id: "call-list-matters",
  tool: "list_matters",
  arguments: { query: "lease" },
  output: { items: [], nextCursor: null },
} as const satisfies FakeStellaCall;

const saveMatter = {
  id: "call-save-matter",
  tool: "save_matter",
  arguments: { name: "Lease dispute" },
  output: {
    applied: true,
    matter: { ref: "matter-1", name: "Lease dispute" },
  },
} as const satisfies FakeStellaCall;

/** Two calls made together, then one that depends on their results. */
export const FAKE_STELLA_STEPS = [
  [searchCaseLaw, listMatters],
  [saveMatter],
] as const satisfies readonly (readonly FakeStellaCall[])[];

export const FAKE_STELLA_CALLS: readonly FakeStellaCall[] =
  FAKE_STELLA_STEPS.flat();

/** Markdown with a link, as the agent writes its answer. */
export const FAKE_STELLA_ANSWER = [
  "One decision matches: [26 Cdo 1/2024](https://stll.app/case-law/cz/nejvyssi-soud/26-cdo-1-2024).",
  "",
  "- Matter **Lease dispute** saved.",
].join("\n");
