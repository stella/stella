import { expect, test } from "bun:test";
import { load } from "cheerio";
import path from "node:path";

import {
  inspectMcpAppDocument,
  inspectMcpAppHtml,
} from "../scripts/lib/mcp-app-html-guard";
import { readMcpAppBundle } from "./bundles";
import { MCP_APP_DOCUMENT_PARTS } from "./generated/bundles";
import { MCP_APPS } from "./manifest";

// React DOM names itself once per copy when it registers its renderer, and
// every copy of React creates its element symbol.
const REACT_DOM_COPY = 'rendererPackageName:"react-dom"';
const REACT_ELEMENT = '"react.transitional.element"';

const occurrences = (text: string, marker: string) =>
  text.split(marker).length - 1;

test.each(MCP_APPS.map(({ directory }) => directory))(
  "%s is served as one self-contained document with one React",
  async (directory) => {
    const html = readMcpAppBundle(directory);
    expect(readMcpAppBundle(directory)).toBe(html);
    expect(html).toBe(
      await Bun.file(
        path.join(import.meta.dirname, directory, "generated/app.html.txt"),
      ).text(),
    );

    expect(html.startsWith("<!doctype html>")).toBe(true);
    const parsed = load(html);
    expect(parsed("html > head").length).toBe(1);
    expect(parsed("html > body #app").length).toBe(1);
    expect(inspectMcpAppHtml(html)).toEqual([]);
    expect(
      inspectMcpAppDocument(html, MCP_APP_DOCUMENT_PARTS[directory]),
    ).toEqual([]);

    const scripts = parsed("script")
      .toArray()
      .map((script) => ({
        module: script.attribs["type"] === "module",
        text: parsed(script).text(),
      }));
    expect(scripts.map(({ module }) => module)).toEqual([false, true]);
    expect(
      scripts.filter(({ text }) => text.includes(REACT_ELEMENT)),
    ).toHaveLength(1);
    expect(occurrences(html, REACT_DOM_COPY)).toBe(1);
  },
);
