import { describe, expect, test } from "bun:test";

import { summarizeCodeToolSource } from "@stll/api-contract/chat-code-step";
import { CHAT_LOCAL_RUN_TOOL_NAMES } from "@stll/api-contract/chat-local-run-tool";
import { STELLA_MCP_TOOL_NAMES } from "@stll/api-contract/mcp-tool-names";
import {
  CHAT_STEP_LEDGER_KEY,
  type ChatStepLedger,
} from "@stll/api-contract/chat-step-ledger";

import { getChatToolTitleKey } from "@/components/chat/chat-ui-tools";

import { getToolCallTitle, getToolCallTitleKey } from "./tool-call-title.logic";

const codeCall = (typescriptCode: string, ledger?: ChatStepLedger) => ({
  input: { typescriptCode },
  name: "execute_typescript",
  output:
    ledger === undefined
      ? undefined
      : { success: true, [CHAT_STEP_LEDGER_KEY]: ledger },
});

const ledgerOf = (tools: readonly string[]): ChatStepLedger => ({
  calls: tools.map((tool) => ({
    tool,
    queries: [],
    filters: [],
    outcome: "ok",
    found: [],
    foundOmitted: 0,
  })),
  callsOmitted: 0,
});

describe("a code-mode step's title names the research its script does", () => {
  test("statute reads alone read as legislation", () => {
    expect(
      getToolCallTitleKey(
        codeCall(
          'const r = await external_read_statute_provisions({items:[{eli:"https://www.e-sbirka.cz/eli/cz/sb/2006/262",anchor:"par_52"}]});\nreturn JSON.stringify(r);',
        ),
      ),
    ).toBe("chat.toolCall.readingLegislation");
  });

  test("case-law reads alone read as case law", () => {
    expect(
      getToolCallTitleKey(
        codeCall(
          'const r = await external_read_case_law_decision({decision_ids:["f46d5994"], full:true});',
        ),
      ),
    ).toBe("chat.toolCall.searchingCaseLaw");
  });

  test("both together read as legislation and case law", () => {
    expect(
      getToolCallTitleKey(
        codeCall(
          'const r = await external_search_case_law({country:"CZE", queries:["dovolání"]});\nconst s = await external_search_legislation({country:"CZE", query:"občanský soudní řád"});',
        ),
      ),
    ).toBe("chat.toolCall.searchingLegislationAndCaseLaw");
  });

  test("a script that also reads the workspace keeps the tool's own title", () => {
    expect(
      getToolCallTitleKey(
        codeCall(
          'const m = await external_list_matters({});\nconst r = await external_search_case_law({queries:["x"]});',
        ),
      ),
    ).toBe(getChatToolTitleKey("execute_typescript"));
  });

  test("an unknown read, no read and an unreadable input keep the tool's own title", () => {
    for (const call of [
      codeCall("await external_not_a_tool({});"),
      codeCall("return 1 + 1;"),
      {
        input: { typescriptCode: 42 },
        name: "execute_typescript",
        output: undefined,
      },
      { input: undefined, name: "execute_typescript", output: undefined },
    ]) {
      expect(getToolCallTitleKey(call)).toBe(
        getChatToolTitleKey("execute_typescript"),
      );
    }
  });

  test("a tool other than code mode keeps its own title", () => {
    expect(
      getToolCallTitleKey({
        input: { toolNames: ["external_search_case_law"] },
        name: "discover_tools",
        output: undefined,
      }),
    ).toBe(getChatToolTitleKey("discover_tools"));
  });

  test("the reads a step's ledger records decide its title over its script", () => {
    // The script names a statute read through a helper the scan cannot
    // see; the ledger records what actually ran.
    const script =
      "const read = external_read_statute_provisions; await read({items: []});";
    expect(getToolCallTitleKey(codeCall(script))).toBe(
      getChatToolTitleKey("execute_typescript"),
    );
    expect(
      getToolCallTitleKey(
        codeCall(script, ledgerOf(["search_case_law", "read_statute"])),
      ),
    ).toBe("chat.toolCall.searchingLegislationAndCaseLaw");
    expect(
      getToolCallTitleKey(codeCall(script, ledgerOf(["list_matters"]))),
    ).toBe(getChatToolTitleKey("execute_typescript"));
  });
});

describe("a code-mode step names what it looked up", () => {
  test("a cited provision wins over the first search phrasing", () => {
    const summary = summarizeCodeToolSource(
      'const r = await external_search_case_law({queries:["předseda senátu odmítl dovolání","§ 243c odst. 2 o. s. ř. předseda senátu odmítne dovolání"]});',
    );
    expect(summary.topic).toBe("§ 243c odst. 2 o. s. ř.");
    expect(summary.lookupCount).toBe(1);
  });

  test("without a citation the first search phrasing names it", () => {
    const summary = summarizeCodeToolSource(
      "const s = await external_search_legislation({country:'CZE', query:'občanský\\nsoudní řád'});\nconst t = await external_search_legislation({query:\"243f\"});",
    );
    expect(summary.topic).toBe("občanský soudní řád");
    expect(summary.lookupCount).toBe(2);
  });

  test("a long phrasing is shortened on a code point", () => {
    const phrasing = "ř".repeat(80);
    const summary = summarizeCodeToolSource(
      `await external_search_case_law({queries:["${phrasing}"]});`,
    );
    expect(summary.topic?.endsWith("…")).toBe(true);
    expect(Array.from(summary.topic ?? "").length).toBeLessThanOrEqual(57);
  });

  test("a read by id alone names nothing", () => {
    expect(
      summarizeCodeToolSource(
        'await external_read_case_law_decision({decision_ids:["f46d5994"]});',
      ).topic,
    ).toBeUndefined();
  });
});

/** A call the way a coding agent on the member's computer reports it. */
const directCall = (name: string) => ({ input: {}, name, output: undefined });

const UNKNOWN_TITLE = { type: "key", key: "chat.tool.unknown" } as const;

describe("a coding agent's direct calls say what they did", () => {
  test("no stella registry tool reads as the generic title", () => {
    const generic = STELLA_MCP_TOOL_NAMES.filter(
      (name) =>
        JSON.stringify(getToolCallTitle(directCall(name))) ===
        JSON.stringify(UNKNOWN_TITLE),
    );
    expect(generic).toEqual([]);
  });

  test("statute and case-law reads take the research titles a code step takes", () => {
    expect(getToolCallTitle(directCall("read_statute_provisions"))).toEqual({
      type: "key",
      key: "chat.toolCall.readingLegislation",
    });
    expect(getToolCallTitle(directCall("search_case_law"))).toEqual({
      type: "key",
      key: "chat.toolCall.searchingCaseLaw",
    });
  });

  test("a tool stella keeps no title for is named by its own name", () => {
    expect(getToolCallTitle(directCall("read_guidance"))).toEqual({
      type: "name",
      name: "Read guidance",
    });
    expect(
      getToolCallTitle(directCall("mcp__docs-server__search_docs")),
    ).toEqual({ type: "name", name: "Search docs" });
  });

  test("a registered tool and a harness step keep their catalogue titles", () => {
    expect(getToolCallTitle(directCall("web_search"))).toEqual({
      type: "key",
      key: getChatToolTitleKey("web_search"),
    });
    expect(
      getToolCallTitle(directCall(CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool)),
    ).toEqual(UNKNOWN_TITLE);
  });
});
