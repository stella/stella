import { describe, expect, test } from "bun:test";
import { load } from "@stll/html";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as v from "valibot";

import { generatedVisualInputSchema } from "@stll/api-contract/generated-visual";

import { prepareGeneratedVisual } from "../../prepare";
import fixture from "./legal-analysis-showcase.json";

const html = readFileSync(
  new URL("legal-analysis-showcase.html", import.meta.url),
  "utf-8",
);

class FixtureElement {
  textContent = "";
  className = "";
  lang = "";
  type = "";
  style = { cssText: "" };
  attributes = new Map<string, string>();
  children: FixtureElement[] = [];
  listeners = new Map<string, () => void>();
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  append(...children: FixtureElement[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(event: string, callback: () => void) {
    this.listeners.set(event, callback);
  }
  get text(): string {
    return this.textContent + this.children.map((child) => child.text).join("");
  }
}

const render = (data: typeof fixture.data) => {
  const page = prepareGeneratedVisual(
    v.parse(generatedVisualInputSchema, { ...fixture, data, html }),
  ).unwrap();
  const $ = load(page.html);
  const elements = new Map<string, FixtureElement>();
  $("[id]").each((_index, node) => {
    const id = $(node).attr("id");
    if (id) {
      elements.set(id, new FixtureElement(node.tagName));
    }
  });
  const element = (id: string) => {
    const found = elements.get(id);
    if (!found) {
      throw new TypeError(`Legal analysis element absent: ${id}`);
    }
    return found;
  };
  let ready = 0;
  const opened: string[] = [];
  const root = new FixtureElement("html");
  runInNewContext($("script").text(), {
    document: {
      documentElement: root,
      getElementById: element,
      createElement: (tag: string) => new FixtureElement(tag),
    },
    stella: {
      data: page.data,
      openDecision: (id: string) => opened.push(id),
      ready: () => {
        ready += 1;
      },
    },
  });
  return { page, element, root, opened, ready };
};

describe("legal analysis showcase", () => {
  test("prepares source data and renders every analysis section before ready", () => {
    const { page, element, ready } = render(fixture.data);
    expect(page.data).toEqual(fixture.data);
    expect(
      page.links.map(({ id, decisionId }) => ({
        id,
        decisionId: String(decisionId),
      })),
    ).toEqual(fixture.links);
    expect(element("summary").children.map(({ text }) => text)).toEqual(
      fixture.data.summary.map(
        ({ label, value, detail }) => label + value + detail,
      ),
    );
    expect(element("checklist").children.map(({ text }) => text)).toEqual(
      fixture.data.checklist.map(
        ({ question, status, reason }) => question + status + reason,
      ),
    );
    expect(element("cases").children.map(({ text }) => text)).toEqual(
      fixture.data.cases.map(
        ({ citation, proposition, relevance }) =>
          citation + proposition + relevance,
      ),
    );
    expect(element("table-head").children.map(({ text }) => text)).toEqual(
      fixture.data.labels.columns,
    );
    expect(
      element("table-body").children.map((row) =>
        row.children.map(({ text }) => text),
      ),
    ).toEqual(
      fixture.data.comparison.map(({ issue, evidence, nextStep }) => [
        issue,
        evidence,
        nextStep,
      ]),
    );
    expect(ready).toBe(1);
  });

  test("opens each supplied authority through its allowlisted link id", () => {
    const { element, opened, page } = render(fixture.data);
    const buttons = element("cases").children.map((card) =>
      card.children.at(0),
    );
    for (const button of buttons) {
      button?.listeners.get("click")?.();
    }
    expect(opened).toEqual(page.links.map(({ id }) => id));
    expect(buttons.map((button) => button?.children.at(0)?.tagName)).toEqual([
      "bdi",
      "bdi",
    ]);
  });

  test("keeps a missing date distinct from a known date", () => {
    const { element } = render(fixture.data);
    const dates = element("timeline").children.map((row) => row.children.at(0));
    expect(dates.map((date) => date?.text)).toEqual(
      fixture.data.timeline.map(({ dateLabel }) => dateLabel),
    );
    expect(dates.at(0)?.attributes.get("datetime")).toBe("2026-09-02");
    expect(dates.at(1)?.tagName).toBe("span");
    expect(dates.at(1)?.attributes.has("datetime")).toBe(false);
  });

  test("shows a source-aware empty state in every empty section and remains ready", () => {
    const { element, ready } = render({
      ...fixture.data,
      summary: [],
      checklist: [],
      cases: [],
      timeline: [],
      comparison: [],
    });
    for (const id of [
      "summary",
      "checklist",
      "cases",
      "timeline",
      "table-empty",
    ]) {
      expect(element(id).text).toBe(fixture.data.labels.empty);
    }
    expect(element("table-body").children).toEqual([]);
    expect(ready).toBe(1);
  });

  test("uses supplied labels and direction without rendering data as markup", () => {
    const markup = '<img src=x onerror="throw 1">';
    const { element, root, ready } = render({
      ...fixture.data,
      formattingLocale: "ar-EG",
      direction: "rtl",
      labels: {
        ...fixture.data.labels,
        title: "مراجعة الإخطار التعاقدي",
        "cases-title": "المراجع",
      },
      summary: fixture.data.summary.map((item) => ({ ...item, value: markup })),
      cases: fixture.data.cases.map((item) => ({ ...item, citation: markup })),
    });
    expect(root.lang).toBe("ar-EG");
    expect(element("page").attributes.get("dir")).toBe("rtl");
    expect(element("title").text).toBe("مراجعة الإخطار التعاقدي");
    expect(element("cases-title").text).toBe("المراجع");
    expect(element("summary").children.at(0)?.children.at(1)?.textContent).toBe(
      markup,
    );
    expect(
      element("cases").children.at(0)?.children.at(0)?.children.at(0)
        ?.textContent,
    ).toBe(markup);
    expect(ready).toBe(1);
  });
});
