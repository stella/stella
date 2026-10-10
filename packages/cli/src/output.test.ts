import { describe, expect, test } from "bun:test";

import { generatedToolAnnotations as TOOL_ANNOTATIONS } from "./generated/tool-annotations.js";
import type { CallToolResult } from "./mcp-client.js";
import { EXIT_CODES } from "./mcp-constants.js";
import {
  buildRenderPlan,
  displayWidth,
  renderPlanExitCode,
  renderResult,
  selectFormat,
  TEXT_UNAVAILABLE_REASONS,
  type Writers,
} from "./output.js";
import { parsePayload } from "./run-leaf-command.js";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const writers: Writers = {
    stdout: (t) => {
      out.push(t);
    },
    stderr: (t) => {
      err.push(t);
    },
  };
  return { out, err, writers };
};

describe("selectFormat (S4)", () => {
  test("table on a TTY, JSON off a TTY by default", () => {
    expect(selectFormat({ flags: {}, isTTY: true })).toBe("table");
    expect(selectFormat({ flags: {}, isTTY: false })).toBe("json");
  });

  test("--output / --json / --table override the TTY default", () => {
    expect(selectFormat({ flags: { output: "json" }, isTTY: true })).toBe(
      "json",
    );
    expect(selectFormat({ flags: { json: true }, isTTY: true })).toBe("json");
    expect(selectFormat({ flags: { table: true }, isTTY: false })).toBe(
      "table",
    );
  });

  test("--output jsonl is honored on and off a TTY", () => {
    expect(selectFormat({ flags: { output: "jsonl" }, isTTY: true })).toBe(
      "jsonl",
    );
    expect(selectFormat({ flags: { output: "jsonl" }, isTTY: false })).toBe(
      "jsonl",
    );
  });
});

describe("renderResult: jsonl (spec 049 §3)", () => {
  test("a page emits one item per line to stdout, nothing extra on stderr", () => {
    const { out, err, writers } = capture();
    const plan = buildRenderPlan({
      payload: { items: [{ id: 1 }, { id: 2 }], nextCursor: null },
      itemsKey: "items",
      textPath: undefined,
      singleReadActive: false,
      columns: undefined,
    });
    renderResult({ plan, format: "jsonl", writers, allActive: false });
    expect(out.join("")).toBe('{"id":1}\n{"id":2}\n');
    expect(err.join("")).toBe("");
  });

  test("a single object emits exactly one line", () => {
    const { out, writers } = capture();
    const plan = buildRenderPlan({
      payload: { ok: true },
      itemsKey: undefined,
      textPath: undefined,
      singleReadActive: false,
      columns: undefined,
    });
    renderResult({ plan, format: "jsonl", writers, allActive: false });
    expect(out.join("")).toBe('{"ok":true}\n');
  });
});

describe("buildRenderPlan (S4)", () => {
  test("detects a page envelope by its itemsKey array", () => {
    const plan = buildRenderPlan({
      payload: { matters: [{ id: "m1" }], nextCursor: "c1" },
      itemsKey: "matters",
      textPath: undefined,
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan.kind).toBe("page");
    if (plan.kind === "page") {
      expect(plan.items).toHaveLength(1);
      expect(plan.nextCursor).toBe("c1");
    }
  });

  test("a single-read payload (no items array) renders as a single object", () => {
    // list_matters with matter_id returns {matter, overview,...}: no `matters`.
    const plan = buildRenderPlan({
      payload: {
        matter: { id: "m1" },
        overview: {},
        contacts: [],
        members: [],
      },
      itemsKey: "matters",
      textPath: undefined,
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan.kind).toBe("single");
  });

  test("windowed-text extracts text and nextCursor", () => {
    const plan = buildRenderPlan({
      payload: { text: "hello", nextCursor: "next" },
      itemsKey: undefined,
      textPath: "text",
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan).toEqual({
      kind: "windowed-text",
      text: "hello",
      nextCursor: "next",
    });
  });

  test("windowed-text follows a nested path to the text", () => {
    // read_statute answers `{ nextCursor, statute: { text } }`: a leaf
    // states where its window lives, so it never renders an empty string.
    const plan = buildRenderPlan({
      payload: {
        nextCursor: "next",
        statute: { charCount: 5, text: "hello", truncated: true },
      },
      itemsKey: undefined,
      textPath: "statute.text",
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan).toEqual({
      kind: "windowed-text",
      text: "hello",
      nextCursor: "next",
    });
  });

  test("a null text is a typed no_text outcome, never an empty document", () => {
    const payload = {
      nextCursor: null,
      statute: { text: null, textWithheldReason: "licence" },
    };
    const plan = buildRenderPlan({
      payload,
      itemsKey: undefined,
      textPath: "statute.text",
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan).toEqual({
      kind: "text-unavailable",
      reason: TEXT_UNAVAILABLE_REASONS.noText,
      textPath: "statute.text",
      payload,
    });
    expect(renderPlanExitCode(plan)).toBe(EXIT_CODES.ok);
  });

  // Every non-string the path can hold. A batch response read through a
  // single-text leaf (`{ items: [...] }` at `decision.text`) is the shape that
  // printed `{"text":""}` before; the others are the rest of the JSON kinds.
  test.each([
    ["an absent path", { nextCursor: null }],
    ["a batch envelope", { items: [{ decision: { text: "BODY" } }] }],
    ["a number", { statute: { text: 3 } }],
    ["an object", { statute: { text: { value: "BODY" } } }],
    ["an array", { statute: { text: ["BODY"] } }],
    ["a boolean", { statute: { text: false } }],
    ["a non-object parent", { statute: "BODY" }],
  ])("%s is a typed not_in_response outcome", (_label, payload) => {
    const plan = buildRenderPlan({
      payload,
      itemsKey: undefined,
      textPath: "statute.text",
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan).toEqual({
      kind: "text-unavailable",
      reason: TEXT_UNAVAILABLE_REASONS.notInResponse,
      textPath: "statute.text",
      payload,
    });
    expect(renderPlanExitCode(plan)).toBe(EXIT_CODES.unexpected);
  });

  test("an empty string is still text: the server said the window is empty", () => {
    const plan = buildRenderPlan({
      payload: { text: "", nextCursor: null },
      itemsKey: undefined,
      textPath: "text",
      singleReadActive: false,
      columns: undefined,
    });
    expect(plan).toEqual({ kind: "windowed-text", text: "", nextCursor: null });
    expect(renderPlanExitCode(plan)).toBeUndefined();
  });
});

describe("renderResult (S4)", () => {
  test("table mode renders rows and emits a stderr cursor hint", () => {
    const { out, err, writers } = capture();
    renderResult({
      plan: {
        kind: "page",
        itemsKey: "matters",
        items: [{ id: "m1", name: "Acme" }],
        payload: {},
        nextCursor: "c9",
        columns: undefined,
      },
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("id");
    expect(out.join("")).toContain("m1");
    expect(err.join("")).toBe("more: --cursor c9\n");
  });

  test("json mode prints the parsed payload and no cursor hint under --all", () => {
    const { out, err, writers } = capture();
    renderResult({
      plan: {
        kind: "page",
        itemsKey: "matters",
        items: [{ id: "m1" }],
        payload: { matters: [{ id: "m1" }], nextCursor: null },
        nextCursor: null,
        columns: undefined,
      },
      format: "json",
      writers,
      allActive: true,
    });
    expect(JSON.parse(out.join(""))).toEqual({
      matters: [{ id: "m1" }],
      nextCursor: null,
    });
    expect(err.join("")).toBe("");
  });

  test("windowed-text prints raw text", () => {
    const { out, writers } = capture();
    renderResult({
      plan: { kind: "windowed-text", text: "raw body", nextCursor: null },
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toBe("raw body\n");
  });

  const unavailable = {
    kind: "text-unavailable",
    reason: TEXT_UNAVAILABLE_REASONS.noText,
    textPath: "statute.text",
    payload: { statute: { text: null, textWithheldReason: "licence" } },
  } as const;

  test("a read without text emits a typed JSON field and keeps the response", () => {
    const { out, err, writers } = capture();
    renderResult({
      plan: unavailable,
      format: "json",
      writers,
      allActive: false,
    });
    expect(JSON.parse(out.join(""))).toEqual({
      text: null,
      textUnavailable: { reason: "no_text", textPath: "statute.text" },
      response: unavailable.payload,
    });
    expect(err.join("")).toContain("No text");
  });

  test("a read without text is one JSONL line with the same shape", () => {
    const { out, writers } = capture();
    renderResult({
      plan: unavailable,
      format: "jsonl",
      writers,
      allActive: false,
    });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out.join(""))).toMatchObject({
      text: null,
      textUnavailable: { reason: "no_text" },
    });
  });

  test("a read without text prints the response fields, not an empty line", () => {
    const { out, err, writers } = capture();
    renderResult({
      plan: unavailable,
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("licence");
    expect(err.join("")).toContain("`statute.text` is null");
  });
});

describe("renderResult: table fitting and flattening", () => {
  const page = (items: readonly unknown[]) =>
    buildRenderPlan({
      payload: { items, nextCursor: null },
      itemsKey: "items",
      textPath: undefined,
      singleReadActive: false,
      columns: undefined,
    });

  test("an inferred column that is empty on every row is dropped", () => {
    const { out, writers } = capture();
    renderResult({
      plan: page([
        { id: "a", tags: [], color: null, name: "One" },
        { id: "b", tags: [], color: null, name: "Two" },
      ]),
      format: "table",
      writers,
      allActive: false,
    });
    const header = out.join("").split("\n")[0] ?? "";
    expect(header).toContain("id");
    expect(header).toContain("name");
    expect(header).not.toContain("tags");
    expect(header).not.toContain("color");
  });

  test("scalar arrays render as a comma list, not JSON", () => {
    const { out, writers } = capture();
    renderResult({
      plan: page([{ id: "a", tags: ["urgent", "client"] }]),
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("urgent, client");
  });

  test("rows are fitted to the terminal width with an ellipsis", () => {
    const { out, writers } = capture();
    renderResult({
      plan: page([{ id: "a", headline: "x".repeat(200) }]),
      format: "table",
      writers,
      allActive: false,
      width: 40,
    });
    const lines = out.join("").trimEnd().split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(lines.at(-1)).toContain("\u2026");
  });

  test("a key-value view keeps opaque values whole at any width", () => {
    const { out, writers } = capture();
    const token = `fb1.1800000000000.${"A".repeat(43)}`;
    renderResult({
      plan: buildRenderPlan({
        payload: { approval_token: token, next_step: "y ".repeat(100) },
        itemsKey: undefined,
        textPath: undefined,
        singleReadActive: true,
        columns: undefined,
      }),
      format: "table",
      writers,
      allActive: false,
      width: 40,
    });
    const text = out.join("");
    expect(text).toContain(token);
    // Prose is still fitted to the terminal.
    expect(text).toContain("\u2026");
  });

  test("without a width nothing is truncated", () => {
    const { out, writers } = capture();
    renderResult({
      plan: page([{ id: "a", headline: "x".repeat(200) }]),
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("x".repeat(200));
  });

  test("an empty nested record keeps its key instead of vanishing", () => {
    const { out, writers } = capture();
    renderResult({
      plan: buildRenderPlan({
        payload: { id: "m1", meta: {} },
        itemsKey: undefined,
        textPath: undefined,
        singleReadActive: true,
        columns: undefined,
      }),
      format: "table",
      writers,
      allActive: false,
    });
    expect(out.join("")).toContain("meta");
    expect(out.join("")).toContain("{}");
  });

  test("a single object flattens one level of nesting to dotted keys", () => {
    const { out, writers } = capture();
    renderResult({
      plan: buildRenderPlan({
        payload: {
          matter: { id: "m1", name: "Probe" },
          overview: { entityCount: 3 },
          members: [{ userId: "u1" }],
        },
        itemsKey: undefined,
        textPath: undefined,
        singleReadActive: true,
        columns: undefined,
      }),
      format: "table",
      writers,
      allActive: false,
    });
    const text = out.join("");
    expect(text).toContain("matter.name");
    expect(text).toContain("Probe");
    expect(text).toContain("overview.entityCount");
    expect(text).not.toContain('{"id":"m1"');
  });
});

describe("displayWidth and Unicode-aware truncation", () => {
  test("counts terminal cells, not UTF-16 code units", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("\u6cd5\u5f8b")).toBe(4);
    expect(displayWidth("caf\u00e9")).toBe(4);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("\u{1F4C4}")).toBe(2);
  });

  test("a CJK cell is cut on a character boundary and stays within the column", () => {
    const { out, writers } = capture();
    renderResult({
      plan: buildRenderPlan({
        payload: {
          items: [{ id: "a", name: "\u6cd5\u5f8b".repeat(30) }],
          nextCursor: null,
        },
        itemsKey: "items",
        textPath: undefined,
        singleReadActive: false,
        columns: undefined,
      }),
      format: "table",
      writers,
      allActive: false,
      width: 30,
    });
    for (const line of out.join("").trimEnd().split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(30);
      expect(line).not.toContain("\uFFFD");
    }
  });
});

describe("composite results", () => {
  const view = TOOL_ANNOTATIONS["check_counterparty"]?.composite;
  if (view === undefined) {
    throw new Error("check_counterparty declares no composite view");
  }
  const list = (overrides: Record<string, unknown>) => ({
    classification: "informational",
    reason: null,
    editionId: "ed-1",
    publishedAt: "2026-09-28",
    verifiedAt: "2026-09-29T07:00:00.000Z",
    pendingUpdate: null,
    totalMatches: 0,
    truncated: false,
    possibleMatches: [],
    ...overrides,
  });
  const sanctions = {
    kind: "sanctions",
    status: "possible-match",
    subject: {
      type: "organization",
      name: "Acme Trading s.r.o.",
      identifiers: ["26863154"],
      resolvedFrom: {
        type: "company-id",
        value: "26863154",
        country: "CZ",
        registry: "ares",
      },
    },
    checkedAt: "2026-09-29T08:00:00.000Z",
    cutoff: 0.8,
    lists: [
      list({
        source: "eu",
        issuer: "EU",
        classification: "binding",
        status: "possible-match",
        totalMatches: 1,
        possibleMatches: [
          {
            sourceEntryId: "EU.123.45",
            editionId: "ed-1",
            score: 0.91,
            sourceUrl: "https://lists.example/eu/123",
            name: "ACME TRADING",
            referenceNumber: null,
            entityType: "organisation",
            programme: null,
            listedOn: "2022-03-15",
            evidence: {
              nameScore: 0.91,
              matchedName: "ACME TRADING",
              birthDate: "not-compared",
              nationality: "not-compared",
              entityType: "match",
              identifier: "not-compared",
              conflicts: ["entity-type"],
            },
          },
        ],
      }),
      list({
        source: "ch",
        issuer: "CH",
        status: "unavailable",
        reason: "stale",
        pendingUpdate: {
          code: "contracted",
          heldAt: "2026-09-28T06:00:00.000Z",
          previousCount: 4000,
          nextCount: 12,
        },
      }),
    ],
  };
  const render = (payload: unknown, format: "table" | "json" | "jsonl") => {
    const { out, writers } = capture();
    renderResult({
      plan: buildRenderPlan({
        payload,
        itemsKey: TOOL_ANNOTATIONS["check_counterparty"]?.itemsKey,
        textPath: undefined,
        singleReadActive: false,
        columns: undefined,
        composite: view,
      }),
      format,
      writers,
      allActive: false,
    });
    return out.join("");
  };

  test("a sanctions check shows its status, the subject screened, every list and every match", () => {
    const [summary = "", lists = "", matches = ""] = render(
      sanctions,
      "table",
    ).split("\n\n");
    expect(summary).toMatch(/^status\s+possible-match$/mu);
    expect(summary).toMatch(/^subject\.name\s+Acme Trading s\.r\.o\.$/mu);
    expect(summary).toMatch(/^subject\.resolvedFrom\.registry\s+ares$/mu);
    expect(lists.split("\n").at(0)).toBe("Lists");
    expect(lists).toMatch(/^source\s+issuer\s+classification\s+status/mu);
    expect(lists).toMatch(/^eu\s+EU\s+binding\s+possible-match/mu);
    expect(lists).toMatch(/^ch\s+CH\s+informational\s+unavailable\s+stale/mu);
    expect(lists).toMatch(/contracted$/mu);
    expect(matches.split("\n").at(0)).toBe("Possible matches");
    expect(matches).toMatch(
      /^eu\s+ACME TRADING\s+0\.91\s+EU\.123\.45\s+entity-type/mu,
    );
  });

  test("a clean sanctions check says there are no matches", () => {
    const clear = {
      ...sanctions,
      status: "clear",
      lists: [list({ source: "eu", issuer: "EU", status: "clear" })],
    };
    expect(render(clear, "table")).toContain("Possible matches: none");
  });

  test("a rows path ending in [] reads the array it names", () => {
    const { out, writers } = capture();
    renderResult({
      plan: buildRenderPlan({
        payload: sanctions,
        itemsKey: undefined,
        textPath: undefined,
        singleReadActive: false,
        columns: undefined,
        composite: {
          summary: ["status"],
          sections: [{ title: "Lists", rows: "lists[]", columns: ["source"] }],
        },
      }),
      format: "table",
      writers,
      allActive: false,
    });
    const table = out.join("");
    expect(table).not.toContain("Lists: none");
    expect(table).toMatch(/^eu\s*$/mu);
    expect(table).toMatch(/^ch\s*$/mu);
  });

  test("JSON and JSONL print the whole result, not only the lists", () => {
    expect(JSON.parse(render(sanctions, "json"))).toEqual(sanctions);
    const lines = render(sanctions, "jsonl").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(sanctions);
  });

  test("a register check of the same tool still renders as one record", () => {
    const register = {
      status: "clear",
      kind: "cz-insolvency",
      source: { name: "ISIR" },
      checkedAt: "2026-09-29T08:00:00.000Z",
    };
    const table = render(register, "table");
    expect(table).toMatch(/^status\s+clear$/mu);
    expect(table).toMatch(/^source\.name\s+ISIR$/mu);
    expect(table).not.toContain("Lists");
    expect(JSON.parse(render(register, "json"))).toEqual(register);
  });
});

describe("CLI legal citation projection", () => {
  for (const format of ["json", "jsonl"] as const) {
    for (const path of [
      "/law/cze/statutes/89-2012-sb",
      "/law/cze/statutes/89-2012-sb/v/2014-01-01#par_1729",
      "/law/cze/cases/ns/1-24",
    ]) {
      for (const held of [true, false]) {
        test(`${format} preserves ${held ? "held" : "external"} citation ${path} through the MCP payload`, () => {
          const source = "https://publisher.example/legal-source";
          const links = held
            ? { url: `https://app.example${path}`, source_url: source }
            : { url: source };
          const subject = { text: "Quoted legal text", ...links };
          const wire = {
            content: [
              {
                type: "text",
                text: JSON.stringify({ nextCursor: null, statute: subject }),
              },
            ],
          } satisfies CallToolResult;
          const payload = parsePayload(wire);
          const plan = buildRenderPlan({
            payload,
            textPath: "statute.text",
            itemsKey: undefined,
            singleReadActive: false,
            columns: undefined,
          });
          const { out, writers } = capture();
          renderResult({ plan, format, writers, allActive: false });
          expect(JSON.parse(out.join(""))).toEqual(subject);
          const searchPlan = buildRenderPlan({
            payload: parsePayload({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    results: [subject],
                    nextCursor: null,
                  }),
                },
              ],
            }),
            textPath: undefined,
            itemsKey: "results",
            singleReadActive: false,
            columns: undefined,
          });
          const search = capture();
          renderResult({
            plan: searchPlan,
            format,
            writers: search.writers,
            allActive: false,
          });
          const result = JSON.parse(search.out.join(""));
          expect(format === "json" ? result.results.at(0) : result).toEqual(
            subject,
          );
        });
      }
    }
  }
});

describe("audit detail status output", () => {
  for (const format of ["json", "jsonl", "table"] as const) {
    for (const changesStatus of ["visible", "feature_unavailable"] as const) {
      test(`${format} preserves ${changesStatus} beside audit changes`, () => {
        const item = {
          id: "entry",
          changes:
            changesStatus === "visible"
              ? { amount: { old: 100, new: 200 } }
              : null,
          changesStatus,
        };
        const envelope = { result: { items: [item], nextCursor: null } };
        const payload = parsePayload({
          content: [{ type: "text", text: JSON.stringify(envelope) }],
        });
        const plan = buildRenderPlan({
          payload,
          itemsKey: "items",
          textPath: undefined,
          singleReadActive: false,
          columns: undefined,
        });
        const { out, err, writers } = capture();
        renderResult({ plan, format, writers, allActive: false });
        const output = out.join("");
        expect(output).toContain("changesStatus");
        expect(output).toContain(changesStatus);
        if (format === "json") {
          expect(JSON.parse(output)).toEqual(envelope.result);
        }
        if (format === "jsonl") {
          expect(JSON.parse(output)).toEqual(item);
        }
        expect(err).toEqual([]);
      });
    }
  }
});
