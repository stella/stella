import { describe, expect, test } from "bun:test";

import { getChatToolTitleKey } from "@/components/chat/chat-ui-tools";

import {
  getToolCallTitleKey,
  summarizeCodeToolSource,
} from "./tool-call-title.logic";

const codeCall = (typescriptCode: string) => ({
  input: { typescriptCode },
  name: "execute_typescript",
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
      { input: { typescriptCode: 42 }, name: "execute_typescript" },
      { input: undefined, name: "execute_typescript" },
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
      }),
    ).toBe(getChatToolTitleKey("discover_tools"));
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
