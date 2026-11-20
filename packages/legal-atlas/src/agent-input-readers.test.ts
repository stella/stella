import { describe, expect, test } from "bun:test";

import { MCP_AGENT_INPUT_READERS } from "./agent-input-readers";

const { readCitation } = MCP_AGENT_INPUT_READERS.eli;

describe("citations read as one work identifier", () => {
  test.each([
    ["89/2012 Sb.", "https://www.e-sbirka.cz/eli/cz/sb/2012/89"],
    ["2013. évi V. törvény", "urn:hu:magyar-kozlony:2013-evi-v-torveny"],
    [
      "123/2020. Korm. rendelet (123/2020. (IV. 30.) Korm. rendelet)",
      "urn:hu:magyar-kozlony:123-2020-iv-30-korm-rendelet",
    ],
  ])("%s names %s", (text, work) => {
    expect(readCitation(text)).toBe(work);
  });

  test.each([
    "89/2012 Sb. és 2013. évi V. törvény",
    "2013. évi V. törvény és 2012. évi I. törvény",
    "123/2020. Korm. rendelet",
    "a polgári törvénykönyv",
  ])("%s names no single work", (text) => {
    expect(readCitation(text)).toBeUndefined();
  });
});
