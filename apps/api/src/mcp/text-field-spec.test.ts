import { describe, expect, test } from "bun:test";

import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";

describe("deriveTextFieldPaths", () => {
  test("mechanically derives the documented path list from a spec list", () => {
    const specs = [
      defineTextFieldSpec({
        path: "matters[].name",
        items: (payload: { matters: { name: string }[] }) => payload.matters,
        scope: () => "org_1",
        read: (item) => item.name,
        apply: (item, value) => {
          item.name = value;
        },
      }),
      defineTextFieldSpec({
        path: "matter.clientName",
        items: (payload: { matter: { clientName: string | null } }) => [
          payload.matter,
        ],
        scope: () => "org_1",
        read: (item) => item.clientName,
        apply: (item, value) => {
          item.clientName = value;
        },
      }),
    ];

    expect(deriveTextFieldPaths(specs)).toEqual([
      "matters[].name",
      "matter.clientName",
    ]);
  });

  test("an empty spec list derives an empty path list", () => {
    expect(deriveTextFieldPaths([])).toEqual([]);
  });
});

describe("runTextFieldSpecs", () => {
  test("per-item scope: each item anonymizes under its own id", () => {
    type Hit = { name: string; workspaceId: string };
    const payload = {
      hits: [
        { name: "John Smith SPA", workspaceId: "ws_1" },
        { name: "Jane Doe NDA", workspaceId: "ws_2" },
      ],
    };
    const spec = defineTextFieldSpec({
      path: "hits[].name",
      items: (p: typeof payload) => p.hits,
      scope: (hit: Hit) => hit.workspaceId,
      read: (hit: Hit) => hit.name,
      apply: (hit: Hit, value) => {
        hit.name = value;
      },
    });

    const fields = runTextFieldSpecs([spec], payload);

    expect(
      fields.map((f) => ({ value: f.value, workspaceId: f.workspaceId })),
    ).toEqual([
      { value: "John Smith SPA", workspaceId: "ws_1" },
      { value: "Jane Doe NDA", workspaceId: "ws_2" },
    ]);

    fields[0]?.apply("[PERSON_1] SPA");
    fields[1]?.apply("[PERSON_2] NDA");
    expect(payload.hits[0]?.name).toBe("[PERSON_1] SPA");
    expect(payload.hits[1]?.name).toBe("[PERSON_2] NDA");
  });

  test("org-constant scope: every item shares one fixed scope regardless of item content", () => {
    type TemplateField = { label: string | null };
    const payload = {
      fields: [{ label: "Party name" }, { label: "Effective date" }],
    };
    const spec = defineTextFieldSpec({
      path: "fields[].label",
      items: (p: typeof payload) => p.fields,
      scope: () => "org_1",
      read: (field: TemplateField) => field.label,
      apply: (field: TemplateField, value) => {
        field.label = value;
      },
    });

    const fields = runTextFieldSpecs([spec], payload);

    expect(fields).toHaveLength(2);
    expect(fields.every((f) => f.workspaceId === "org_1")).toBe(true);
  });

  test("skip-null: a null or empty value is never queued", () => {
    type Entry = { narrative: string | null };
    const payload = {
      entries: [
        { narrative: "Call with client" },
        { narrative: null },
        { narrative: "" },
      ],
    };
    const spec = defineTextFieldSpec({
      path: "entries[].narrative",
      items: (p: typeof payload) => p.entries,
      scope: () => "ws_1",
      read: (entry: Entry) => entry.narrative,
      apply: (entry: Entry, value) => {
        entry.narrative = value;
      },
    });

    const fields = runTextFieldSpecs([spec], payload);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.value).toBe("Call with client");
  });

  test("array write-back: apply writes into the owning array by index, not the (primitive) item", () => {
    const payload = { values: ["Acme Corp", "Beta LLC"] };
    const spec = defineTextFieldSpec({
      path: "values[]",
      items: (p: typeof payload) => p.values,
      scope: () => "ws_1",
      read: (value: string) => value,
      apply: (_item, value, index) => {
        payload.values[index] = value;
      },
    });

    const fields = runTextFieldSpecs([spec], payload);
    for (const field of fields) {
      field.apply(`[REDACTED_${field.value}]`);
    }

    expect(payload.values).toEqual([
      "[REDACTED_Acme Corp]",
      "[REDACTED_Beta LLC]",
    ]);
  });

  test("a spec whose items() returns an empty array queues nothing", () => {
    const payload = { matters: [] as { name: string }[] };
    const spec = defineTextFieldSpec({
      path: "matters[].name",
      items: (p: typeof payload) => p.matters,
      scope: () => "org_1",
      read: (item: { name: string }) => item.name,
      apply: (item: { name: string }, value) => {
        item.name = value;
      },
    });

    expect(runTextFieldSpecs([spec], payload)).toEqual([]);
  });

  test("multiple specs over one payload combine in declaration order", () => {
    const payload = {
      matter: { name: "Acme Corp", clientName: "Acme Client" },
    };
    const nameSpec = defineTextFieldSpec({
      path: "matter.name",
      items: (p: typeof payload) => [p.matter],
      scope: () => "ws_1",
      read: (item: (typeof payload)["matter"]) => item.name,
      apply: (item: (typeof payload)["matter"], value) => {
        item.name = value;
      },
    });
    const clientNameSpec = defineTextFieldSpec({
      path: "matter.clientName",
      items: (p: typeof payload) => [p.matter],
      scope: () => "ws_1",
      read: (item: (typeof payload)["matter"]) => item.clientName,
      apply: (item: (typeof payload)["matter"], value) => {
        item.clientName = value;
      },
    });

    const fields = runTextFieldSpecs([nameSpec, clientNameSpec], payload);

    expect(fields.map((f) => f.value)).toEqual(["Acme Corp", "Acme Client"]);
  });
});
