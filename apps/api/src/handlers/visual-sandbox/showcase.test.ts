import { describe, expect, test } from "bun:test";
import { load } from "cheerio";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import fixture from "./fixtures/court-year-showcase.json";
import { sanitizeVisualHtml } from "./sanitize";

const html = readFileSync(
  new URL("fixtures/court-year-showcase.html", import.meta.url),
  "utf-8",
);

class FixtureElement {
  textContent = "";
  lang = "";
  type = "";
  style = { cssText: "" };
  children: FixtureElement[] = [];
  listeners = new Map<string, () => void>();
  append(...children: FixtureElement[]) {
    this.children.push(...children);
  }
  addEventListener(event: string, callback: () => void) {
    this.listeners.set(event, callback);
  }
}

const render = (data: unknown) => {
  const elements = new Map<string, FixtureElement>();
  const $ = load(sanitizeVisualHtml(html).unwrap());
  $("[id]").each((_index, node) => {
    const id = $(node).attr("id");
    if (id) {
      elements.set(id, new FixtureElement());
    }
  });
  const element = (id: string) => {
    const found = elements.get(id);
    if (!found) {
      throw new TypeError(`Showcase element absent: ${id}`);
    }
    return found;
  };
  const charts: {
    data: unknown;
    value: unknown;
    color: unknown;
    onSelect: (node: unknown) => void;
  }[] = [];
  const drills: unknown[] = [];
  const opened: string[] = [];
  let ready = 0;
  runInNewContext($("script").text(), {
    Intl,
    document: {
      documentElement: new FixtureElement(),
      querySelector: () => new FixtureElement(),
      getElementById: element,
      createElement: () => new FixtureElement(),
    },
    stella: {
      data,
      charts: {
        treemap: (_element: unknown, options: (typeof charts)[number]) => {
          charts.push(options);
        },
      },
      drill: (selection: unknown) => drills.push(selection),
      openDecision: (id: string) => opened.push(id),
      ready: () => {
        ready += 1;
      },
    },
  });
  return { element, charts, drills, opened, ready };
};

describe("court/year showcase page", () => {
  test("sizes every bucket from aggregate decisions and scopes the citation ranking", () => {
    const { element, charts, ready, opened, drills } = render(fixture.data);
    expect(
      element("stats").children.map(
        (group) => group.children.at(1)?.textContent,
      ),
    ).toEqual(["266", "2", "4", "31"]);
    const chart = charts.at(0);
    expect(chart?.value).toBe("count");
    expect(chart?.color).toEqual({
      mode: "category",
      field: "tier",
      legend: true,
    });
    expect(chart?.data).toEqual({
      type: "group",
      id: "decisions",
      label: fixture.data.labels["map-title"],
      children: ["CZ:ns", "CZ:nss"].map((court) => ({
        type: "group",
        id: court,
        label:
          court === "CZ:ns"
            ? "Nejvyšší soud · NS"
            : "Nejvyšší správní soud · NSS",
        tier: "supreme",
        children: fixture.data.courtYear.buckets
          .filter((bucket) => bucket.court === court)
          .map((bucket) => ({
            type: "bucket",
            id: `${court}:${bucket.year}`,
            label: String(bucket.year),
            court,
            year: bucket.year,
            count: bucket.count,
            citationSum: null,
            treatment: null,
            tier: "supreme",
          })),
      })),
    });
    expect(element("ranking-title").textContent).toBe(
      fixture.data.labels["ranking-title"],
    );
    expect(element("ranking-scope").textContent).toBe(
      fixture.data.labels["ranking-scope"],
    );
    const first = element("ranking").children.at(0)?.children.at(0);
    expect(first?.textContent).toContain("30 Cdo 100/2021");
    first?.listeners.get("click")?.();
    expect(opened).toEqual(["decision-c"]);
    chart?.onSelect({ type: "group", id: "CZ:ns" });
    expect(drills).toEqual([]);
    chart?.onSelect({ type: "bucket", court: "CZ:ns", year: 2023 });
    expect(drills).toEqual([{ court: "CZ:ns", year: 2023 }]);
    expect(element("selection").textContent).toBe(
      fixture.data.labels.drillOffered,
    );
    expect(ready).toBe(1);
    expect(fixture.data.topResults.map((hit) => hit.citationCount)).toEqual([
      18, 7, 31,
    ]);
  });

  test("marks truncated aggregates instead of presenting an exact total", () => {
    const { element } = render({
      ...fixture.data,
      courtYear: { ...fixture.data.courtYear, truncated: true },
    });
    expect(element("aggregate-note").textContent).toBe(
      fixture.data.labels.truncated,
    );
  });

  for (const courtYear of [null, { buckets: [], truncated: false }]) {
    test(`unavailable or empty aggregate ${JSON.stringify(courtYear)} stays empty and ready`, () => {
      const { element, charts, ready } = render({
        ...fixture.data,
        courtYear,
        topResults: [],
      });
      expect(charts).toEqual([]);
      expect(element("chart").textContent).toBe(
        fixture.data.labels.emptyAggregate,
      );
      expect(element("stats").children.at(0)?.children.at(1)?.textContent).toBe(
        courtYear === null ? "—" : "0",
      );
      expect(element("ranking").textContent).toBe(
        fixture.data.labels.emptyRanking,
      );
      expect(element("stats").children.at(3)?.children.at(1)?.textContent).toBe(
        "—",
      );
      expect(ready).toBe(1);
    });
  }

  test("renders tool-returned labels as text rather than executable markup", () => {
    const malicious = '<img src=x onerror="throw 1">';
    const { element, ready } = render({
      ...fixture.data,
      labels: { ...fixture.data.labels, title: malicious },
    });
    expect(element("title").textContent).toBe(malicious);
    expect(ready).toBe(1);
  });
});
