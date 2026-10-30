import { panic } from "better-result";
import { expect } from "bun:test";
import * as cheerio from "cheerio";

import type { BlockContent, Document } from "@stll/docx-core/model";
import { sha256Hex } from "@stll/sha256/bun";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { createParagraphLineReader } from "@/api/lib/legal-search/parsers/document-footnotes";
import { readRtfString } from "@/api/lib/legal-search/parsers/rtf-reader";
import { RTF_SOURCE_OPTIONS } from "@/api/lib/legal-search/rtf-source-registry";

import recordedLines from "./rtf-line-parity.expected.json";

const expectations = new Map(Object.entries(recordedLines));

// Recorded from the removed CZ reader at 8dbc4be0^; ignore whitespace within
// each line, including physical source newlines, without splitting parsed text.
const compact = (text: string): string => text.replace(/\s/gu, "");

const linesOf = (document: Document): string[] => {
  const lines: string[] = [];
  const readLines = createParagraphLineReader(document, (paragraph) => {
    const pieces: string[] = [];
    for (const item of paragraph.content) {
      if (item.type !== "run") {
        continue;
      }
      for (const content of item.content) {
        if (content.type === "text") {
          pieces.push(content.text);
        }
        if (content.type === "tab") {
          pieces.push("\t");
        }
      }
    }
    return compact(pieces.join(""));
  });
  const visit = (blocks: readonly BlockContent[]): void => {
    for (const block of blocks) {
      switch (block.type) {
        case "paragraph": {
          for (const line of readLines(block)) {
            const text = line.kind === "body" ? line.value : line.note.value;
            if (text.length > 0) {
              lines.push(text);
            }
          }
          break;
        }
        case "table":
          for (const row of block.rows) {
            for (const cell of row.cells) {
              visit(cell.content);
            }
          }
          break;
        case "blockSdt":
        case "blockCustomXml":
          visit(block.content);
          break;
        case "preservedBlock":
        case "bookmarkStart":
        case "bookmarkEnd":
        case "moveFromRangeStart":
        case "moveFromRangeEnd":
        case "moveToRangeStart":
        case "moveToRangeEnd":
          break;
        default:
          block satisfies never;
          panic(`Unhandled RTF fixture block: ${JSON.stringify(block)}`);
      }
    }
  };
  visit(document.package.document.content);
  return lines;
};

export const assertRtfLineParity = (
  source: string | Uint8Array,
  document: Document,
): void => {
  const id = sha256Hex(source);
  const recorded = expectations.get(id);
  expect(
    recorded,
    `Missing recorded RTF line segmentation for ${id}`,
  ).toBeDefined();
  if (recorded === undefined) {
    panic(`Missing recorded RTF fixture: ${id}`);
  }
  expect(linesOf(document)).toEqual(recorded.lines);
};

export const assertHtmlRtfLineParity = (html: string): void => {
  const rtf = cheerio.load(html)("input#docContentHidden").attr("value");
  if (rtf === undefined || rtf.trim().length === 0) {
    return;
  }
  assertRtfLineParity(
    rtf,
    readRtfString(rtf, RTF_SOURCE_OPTIONS[ADAPTER_KEYS.CZ_US]),
  );
};
