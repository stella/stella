import { describe, expect, test } from "bun:test";

import {
  AGENT_CASE_LAW_SEARCH_WARNING_PRODUCERS,
  CASE_LAW_SEARCH_WARNING_PRODUCERS,
  caseLawSearchWarnings,
} from "../lib/case-law/search-warnings";
import { searchNotesForCall } from "./search-notes";
import { MCP_NOTE_AUDIENCE } from "./tool-note-audience";

describe("search note audiences", () => {
  test("every produced kind has an audience and stays available to the agent", () => {
    const producers = {
      ...CASE_LAW_SEARCH_WARNING_PRODUCERS,
      ...AGENT_CASE_LAW_SEARCH_WARNING_PRODUCERS,
    };
    expect(Object.keys(MCP_NOTE_AUDIENCE).toSorted()).toEqual(
      [...Object.keys(producers), "input_read"].toSorted(),
    );
    for (const produce of Object.values(producers)) {
      const warning = produce();
      const [search] = searchNotesForCall(
        [{ warnings: [warning] }],
        warning.code === "function_words_optional"
          ? [{ interpretation: { droppedFunctionWords: ["na"] } }]
          : [],
      );
      expect(search?.warnings).toEqual([{ ...warning, audience: "agent" }]);
    }
  });

  test("one grammar note per call names the union of every phrasing's words", () => {
    const wordLists = [["za", "vůči"], ["vůči"], ["na", "za"], ["na"]];
    const searches = wordLists.map((droppedFunctionWords) => ({
      warnings: caseLawSearchWarnings({
        droppedFunctionWords,
        filters: [],
        emptyResultSet: false,
      }),
    }));
    expect(searches.flatMap(({ warnings }) => warnings)).toHaveLength(4);
    const result = searchNotesForCall(
      searches,
      wordLists.map((droppedFunctionWords) => ({
        interpretation: { droppedFunctionWords },
      })),
    );
    expect(result.flatMap(({ warnings }) => warnings)).toEqual([
      expect.objectContaining({
        code: "function_words_optional",
        audience: "agent",
        message: expect.stringContaining("za, vůči, na."),
        hint: expect.stringContaining("strict: true"),
      }),
    ]);
    expect(result.slice(1).every(({ warnings }) => warnings.length === 0)).toBe(
      true,
    );
  });

  test("repeated filter notes are emitted once across the call", () => {
    const warning = AGENT_CASE_LAW_SEARCH_WARNING_PRODUCERS.filter_read();
    const result = searchNotesForCall(
      [{ warnings: [warning, warning] }, { warnings: [warning] }],
      [],
    );
    expect(result.flatMap(({ warnings }) => warnings)).toEqual([
      { ...warning, audience: "agent" },
    ]);
  });
});
