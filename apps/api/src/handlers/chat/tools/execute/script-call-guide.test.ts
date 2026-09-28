import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  buildScriptCallGuide,
  classifyScriptName,
  scriptNameMessage,
  type ScriptCallCatalog,
} from "@/api/handlers/chat/tools/execute/script-call-guide";

const CATALOG = {
  readFunctions: [
    "external_list_matters",
    "external_list_documents",
    "external_read_document",
    "external_list_templates",
  ],
  directTools: [
    "save_playbook",
    "ask-user",
    "list_templates",
    "execute_typescript",
  ],
  unavailableTools: new Map([
    ["counterparty_check", "anonymized mode is on"],
    ["check_counterparty", undefined],
  ]),
} satisfies ScriptCallCatalog;

const messageFor = (name: string, catalog: ScriptCallCatalog = CATALOG) =>
  scriptNameMessage(classifyScriptName(name, catalog));

describe("a direct tool called inside a script", () => {
  test("is named exactly and sent outside the script", () => {
    expect(classifyScriptName("save_playbook", CATALOG)).toEqual({
      kind: "direct-tool",
      name: "save_playbook",
      tool: "save_playbook",
      readInstead: undefined,
    });
    expect(messageFor("save_playbook")).toBe(
      "`save_playbook` is a direct tool, not a script function. Call it as its own tool call outside execute_typescript. Do the reads in the script, return the data, then call `save_playbook` with it.",
    );
  });

  test("names the tool as the model must call it when the script spelled it otherwise", () => {
    for (const spelling of [
      "savePlaybook",
      "external_save_playbook",
      "askUser",
      "ask_user",
    ]) {
      const verdict = classifyScriptName(spelling, CATALOG);
      expect(verdict.kind).toBe("direct-tool");
    }
    expect(messageFor("askUser")).toStartWith(
      "`askUser` is not a script function; the direct tool is `ask-user`.",
    );
  });

  test("names both calls, and runs neither, when a read shares the name", () => {
    expect(classifyScriptName("list_templates", CATALOG)).toEqual({
      kind: "direct-tool",
      name: "list_templates",
      tool: "list_templates",
      readInstead: "external_list_templates",
    });
    expect(messageFor("list_templates")).toEndWith(
      "To read inside the script instead, call `external_list_templates`.",
    );
  });
});

describe("a read called without its prefix or in another case", () => {
  test("runs the one read it matches", () => {
    for (const spelling of [
      "list_documents",
      "listDocuments",
      "ListDocuments",
      "externalListDocuments",
      "external_listDocuments",
      "LIST_DOCUMENTS",
    ]) {
      expect(classifyScriptName(spelling, CATALOG)).toEqual({
        kind: "run-read",
        name: spelling,
        target: "external_list_documents",
      });
    }
  });

  test("runs nothing when two reads match equally", () => {
    const catalog: ScriptCallCatalog = {
      ...CATALOG,
      readFunctions: ["external_list_documents", "external_listDocuments"],
    };
    expect(classifyScriptName("list_documents", catalog)).toEqual({
      kind: "ambiguous-read",
      name: "list_documents",
      candidates: ["external_listDocuments", "external_list_documents"],
    });
    expect(messageFor("list_documents", catalog)).toBe(
      "`list_documents` matches several script functions. Call one by its full name: `external_listDocuments`, `external_list_documents`.",
    );
  });

  test("only ever runs a read function of the catalog", () => {
    const nameArb = fc.stringMatching(/^[A-Za-z_]{1,24}$/u);
    fc.assert(
      fc.property(
        fc.array(nameArb, { maxLength: 6 }),
        fc.array(nameArb, { maxLength: 6 }),
        nameArb,
        (reads, direct, called) => {
          const catalog: ScriptCallCatalog = {
            readFunctions: reads.map((name) => `external_${name}`),
            directTools: direct,
            unavailableTools: new Map(),
          };
          const verdict = classifyScriptName(called, catalog);
          if (verdict.kind === "run-read") {
            expect(catalog.readFunctions).toContain(verdict.target);
            // A name that also means a direct tool never runs anything.
            expect(
              classifyScriptName(called, { ...catalog, readFunctions: [] })
                .kind,
            ).not.toBe("direct-tool");
          }
        },
      ),
      propertyConfig(),
    );
  });
});

describe("a misspelled name", () => {
  test("names the one clearly closest function, and runs nothing", () => {
    expect(classifyScriptName("list_maters", CATALOG)).toEqual({
      kind: "near-miss",
      name: "list_maters",
      suggestions: [{ direct: false, name: "external_list_matters" }],
    });
    expect(messageFor("external_list_maters")).toBe(
      "`external_list_maters` is not defined. Did you mean `external_list_matters`?",
    );
    expect(messageFor("save_playbok")).toBe(
      "`save_playbok` is not defined. Did you mean `save_playbook` (a direct tool: call it outside execute_typescript)?",
    );
  });

  test("does not offer a function with another verb as a typo of it", () => {
    expect(classifyScriptName("create_document", CATALOG).kind).toBe("unknown");
  });

  test("lists up to three names when several are equally close", () => {
    const catalog: ScriptCallCatalog = {
      readFunctions: [
        "external_list_aa",
        "external_list_ab",
        "external_list_ac",
        "external_list_ad",
      ],
      directTools: [],
      unavailableTools: new Map(),
    };
    expect(messageFor("list_ax", catalog)).toBe(
      "`list_ax` is not defined. Did you mean one of `external_list_aa`, `external_list_ab`, `external_list_ac`?",
    );
  });
});

describe("a tool this chat does not offer", () => {
  test("is said to be unavailable, with why when known", () => {
    expect(messageFor("counterparty_check")).toBe(
      "`counterparty_check` is not available in this chat (anonymized mode is on). Continue without it.",
    );
  });

  test("points at an offered tool it resembles", () => {
    const catalog: ScriptCallCatalog = {
      ...CATALOG,
      directTools: [...CATALOG.directTools, "counterparty_check"],
      unavailableTools: new Map([["check_counterparty", undefined]]),
    };
    expect(messageFor("check_counterparty", catalog)).toBe(
      "`check_counterparty` is not available in this chat. Did you mean `counterparty_check` (a direct tool: call it outside execute_typescript)?",
    );
  });
});

describe("any other undefined name", () => {
  test("keeps the script's own error", () => {
    for (const name of ["result", "matters", "x", "window", "_"]) {
      expect(classifyScriptName(name, CATALOG).kind).toBe("unknown");
      expect(messageFor(name)).toBeUndefined();
    }
  });
});

describe("the sandbox guide", () => {
  const guide = buildScriptCallGuide(CATALOG);

  test("predefines the plausible spellings, never a script function or a typo", () => {
    expect(guide.names).toEqual(
      expect.arrayContaining([
        "save_playbook",
        "savePlaybook",
        "ask_user",
        "askUser",
        "list_documents",
        "listDocuments",
        "externalListDocuments",
        "counterparty_check",
      ]),
    );
    for (const name of guide.names) {
      expect(CATALOG.readFunctions).not.toContain(name);
      expect(name).toMatch(/^[A-Za-z_$][\w$]*$/u);
    }
    expect(guide.names).not.toContain("list_maters");
  });

  test("runs a read only for a read spelling, and explains everything else", () => {
    expect(guide.resolve("list_documents")).toEqual({
      kind: "run",
      target: "external_list_documents",
      note: "Ran `external_list_documents` for `list_documents`; use the external_ name in scripts.",
    });
    expect(guide.resolve("save_playbook")).toMatchObject({ kind: "explain" });
    expect(guide.resolve("result")).toEqual({ kind: "none" });
  });

  test("explains a missing name the run could not intercept", () => {
    expect(guide.explainMissing("LIST_DOCUMENTS")).toBe(
      "`LIST_DOCUMENTS` is not defined. Call `external_list_documents` in scripts.",
    );
    expect(guide.explainMissing("list_maters")).toContain(
      "Did you mean `external_list_matters`?",
    );
    expect(guide.explainMissing("result")).toBeUndefined();
  });
});
