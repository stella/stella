import { describe, expect, test } from "bun:test";
import { load } from "@stll/html";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as v from "valibot";

import { generatedVisualInputSchema } from "@stll/api-contract/generated-visual";
import { compareCodeUnit } from "@stll/collation";

import { prepareGeneratedVisual } from "../../prepare";
import { sanitizeVisualHtml } from "../../sanitize";
import fixture from "./change-of-control-exposure.json";

// The fixture carries the page chrome; the seed supplies the data room
// (apps/api/scripts/seed-marketing-agent-thread.ts). These rows are this
// test's own sample input, not a copy of the seed: the figures asserted below
// follow from them alone.
const pageData = {
  ...fixture.data,
  positions: ["consent", "confirm", "notice"],
  risks: ["Critical", "High", "Medium", "Low"],
  counterparties: [
    {
      name: "Aurora Retail GmbH",
      agreement: "Shareholder Register",
      documents: 9,
      value: 20_250_000,
      risk: "Low",
      position: "notice",
    },
    {
      name: "Delta Logistics Kft.",
      agreement: "Customer Contract",
      documents: 9,
      value: 21_487_500,
      risk: "Critical",
      position: "consent",
    },
    {
      name: "Granite Properties B.V.",
      agreement: "Supplier Agreement",
      documents: 9,
      value: 22_725_000,
      risk: "High",
      position: "consent",
    },
    {
      name: "BluePeak Manufacturing s.r.o.",
      agreement: "Employment Agreement",
      documents: 9,
      value: 23_962_500,
      risk: "Medium",
      position: "confirm",
    },
    {
      name: "Edison Bank plc",
      agreement: "Permit",
      documents: 9,
      value: 20_250_000,
      risk: "Low",
      position: "notice",
    },
    {
      name: "Helios Energy a.s.",
      agreement: "Loan Agreement",
      documents: 9,
      value: 21_487_500,
      risk: "Critical",
      position: "consent",
    },
    {
      name: "Cedar Cloud Ltd.",
      agreement: "Lease",
      documents: 9,
      value: 22_725_000,
      risk: "High",
      position: "consent",
    },
    {
      name: "Fjord Analytics AB",
      agreement: "Insurance Policy",
      documents: 9,
      value: 23_962_500,
      risk: "Medium",
      position: "confirm",
    },
  ],
};

const html = readFileSync(
  new URL("change-of-control-exposure.html", import.meta.url),
  "utf-8",
);

class FixtureElement {
  textContent = "";
  className = "";
  lang = "";
  scope = "";
  style = { cssText: "" };
  attributes = new Map<string, string>();
  children: FixtureElement[] = [];
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
  get text(): string {
    return this.textContent + this.children.map((child) => child.text).join("");
  }
}

const render = (data: unknown) => {
  const elements = new Map<string, FixtureElement>();
  // Run the page as the sandbox would: after the sanitizer, so a stripped id
  // or script fails here instead of rendering an empty frame in the chat.
  const $ = load(sanitizeVisualHtml(html).unwrap());
  $("[id]").each((_index, node) => {
    const id = $(node).attr("id");
    if (id) {
      elements.set(id, new FixtureElement(node.tagName));
    }
  });
  const element = (id: string) => {
    const found = elements.get(id);
    if (!found) {
      throw new TypeError(`Exposure page element absent: ${id}`);
    }
    return found;
  };
  let ready = 0;
  runInNewContext($("script").text(), {
    Intl,
    document: {
      documentElement: new FixtureElement("html"),
      getElementById: element,
      createElement: (tag: string) => new FixtureElement(tag),
    },
    stella: {
      data,
      ready: () => {
        ready += 1;
      },
    },
  });
  return { element, ready: () => ready };
};

describe("change-of-control exposure page", () => {
  test("totals each position's counterparties, documents, value and share", () => {
    const { element, ready } = render(pageData);
    const stats = element("stats").children.map((group) =>
      group.children.map((child) => child.text),
    );
    expect(stats).toEqual([
      [
        "Consent or termination review",
        "€88.4m",
        "4 counterparties · 36 documents · 50% of value",
      ],
      [
        "Consent to confirm",
        "€47.9m",
        "2 counterparties · 18 documents · 27% of value",
      ],
      [
        "Notice only",
        "€40.5m",
        "2 counterparties · 18 documents · 23% of value",
      ],
    ]);
    // The split bar grows each segment by its value, in position order.
    expect(element("split").children.map(({ style }) => style.cssText)).toEqual(
      [
        expect.stringContaining("flex:88425000 1 0"),
        expect.stringContaining("flex:47925000 1 0"),
        expect.stringContaining("flex:40500000 1 0"),
      ],
    );
    expect(element("split").attributes.get("aria-label")).toBe(
      pageData.labels.splitLabel,
    );
    expect(ready()).toBe(1);
  });

  test("orders the matrix by position, then severity, then value, without dropping a counterparty", () => {
    const { element } = render(pageData);
    expect(element("matrix-head").children.map(({ text }) => text)).toEqual(
      pageData.labels.columns,
    );
    const rows = element("matrix-body").children.map((row) =>
      row.children.map((cell) => cell.text),
    );
    expect(rows.map((cells) => cells.at(0))).toEqual([
      "Delta Logistics Kft.",
      "Helios Energy a.s.",
      "Granite Properties B.V.",
      "Cedar Cloud Ltd.",
      "BluePeak Manufacturing s.r.o.",
      "Fjord Analytics AB",
      "Aurora Retail GmbH",
      "Edison Bank plc",
    ]);
    expect(rows.at(0)).toEqual([
      "Delta Logistics Kft.",
      "Customer Contract",
      "9",
      "€21.5m",
      "Critical",
      "Consent or termination review",
    ]);
    expect(
      rows.map((cells) => cells.at(0) ?? "").toSorted(compareCodeUnit),
    ).toEqual(
      pageData.counterparties.map(({ name }) => name).toSorted(compareCodeUnit),
    );
  });

  test("an empty data room renders zero totals and still signals ready", () => {
    const { element, ready } = render({
      ...pageData,
      counterparties: [],
    });
    expect(
      element("stats").children.map((group) => group.children.at(2)?.text),
    ).toEqual([
      "0 counterparties · 0 documents · 0% of value",
      "0 counterparties · 0 documents · 0% of value",
      "0 counterparties · 0 documents · 0% of value",
    ]);
    expect(element("matrix-body").children).toEqual([]);
    expect(ready()).toBe(1);
  });

  test("renders counterparty names as text rather than executable markup", () => {
    const malicious = '<img src=x onerror="throw 1">';
    const { element } = render({
      ...pageData,
      counterparties: pageData.counterparties.map((row) => ({
        ...row,
        name: malicious,
      })),
    });
    expect(element("matrix-body").children.at(0)?.children.at(0)?.text).toBe(
      malicious,
    );
  });
});

describe("prepared exposure page", () => {
  test("survives the API's preparation unchanged in data and keeps its script", () => {
    const prepared = prepareGeneratedVisual(
      v.parse(generatedVisualInputSchema, { ...fixture, data: pageData, html }),
    ).unwrap();
    expect(prepared.title).toBe(fixture.title);
    expect(prepared.data).toEqual(pageData);
    expect(prepared.links).toEqual([]);
    const $ = load(prepared.html);
    expect($("script").text()).toContain("stella.ready()");
    for (const id of ["title", "scope", "stats", "split", "matrix-body"]) {
      expect($(`#${id}`).length).toBe(1);
    }
  });
});
