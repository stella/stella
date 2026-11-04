import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty, propertySeed } from "@stll/property-testing";

import { recordCellStateSchema, recordCellText } from "./record-cell";
import type { RecordCellState } from "./record-cell";
import {
  projectRecord,
  RECORD_PROJECTION_CASTS,
  RECORD_PROJECTION_TARGETS,
  recordProjectionCompatibility,
} from "./record-projection";
import type {
  ProjectRecordOptions,
  RecordProjectionTarget,
} from "./record-projection";
import {
  isCanonicalDecimal,
  RECORD_FIELD_TYPES,
  recordSchemaSchema,
  recordSetSchema,
  recordValueSchema,
} from "./record-schema";
import type { RecordFieldType, RecordSchema } from "./record-schema";

const company = {
  cardinality: "one",
  fields: [
    { key: "name", label: "Name", type: "text", nullable: false },
    { key: "status", label: "Status", type: "text", nullable: true },
    { key: "founded", label: "Founded", type: "date", nullable: true },
    { key: "employees", label: "Employees", type: "integer", nullable: true },
    { key: "rate", label: "Rate", type: "decimal", nullable: true },
    { key: "capital", label: "Capital", type: "money", nullable: true },
    { key: "active", label: "Active", type: "boolean", nullable: false },
    { key: "source", label: "Source", type: "url", nullable: true },
  ],
} as const satisfies RecordSchema;

const companyRecord = {
  name: "Example s.r.o.",
  status: null,
  founded: "2014-03-01",
  employees: 12,
  rate: "25.345",
  capital: { amountMinor: 20_000_000, currency: "CZK" },
  active: true,
  source: "https://example.test/company/1",
};

const resolvedOne = {
  status: "resolved",
  result: { kind: "one", record: companyRecord },
} as const satisfies RecordCellState;

const project = (
  overrides: Partial<ProjectRecordOptions> &
    Pick<ProjectRecordOptions, "select" | "target">,
) =>
  projectRecord({
    state: resolvedOne,
    storedSchemaVersion: 1,
    schema: company,
    schemaVersion: 1,
    selectOptions: [],
    ...overrides,
  });

describe("record schema", () => {
  test("refuses duplicate field keys", () => {
    expect(
      v.is(recordSchemaSchema, {
        cardinality: "one",
        fields: [
          { key: "a", label: "A", type: "text", nullable: false },
          { key: "a", label: "B", type: "text", nullable: false },
        ],
      }),
    ).toBe(false);
  });

  test("a record holds exactly its declared keys", () => {
    const schema = recordValueSchema(company);
    expect(v.is(schema, companyRecord)).toBe(true);
    expect(v.is(schema, { ...companyRecord, extra: "x" })).toBe(false);
    const { name: _name, ...missingName } = companyRecord;
    expect(v.is(schema, missingName)).toBe(false);
    expect(v.is(schema, { ...companyRecord, name: null })).toBe(false);
  });

  test("a list schema bounds its records", () => {
    const schema = recordSetSchema({ ...company, cardinality: "many" });
    expect(v.is(schema, [companyRecord, companyRecord])).toBe(true);
    expect(v.is(schema, companyRecord)).toBe(false);
  });

  test("canonical decimals survive a numeric round trip unchanged", () => {
    assertProperty(
      "canonical decimals survive a numeric round trip unchanged",
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 6 }),
        (units, scale) => {
          const text = (units / 10 ** scale).toFixed(scale);
          const canonical = text.includes(".")
            ? text.replace(/0+$/u, "").replace(/\.$/u, "")
            : text;
          const normalized = canonical === "-0" ? "0" : canonical;
          expect(isCanonicalDecimal(normalized)).toBe(true);
          if (normalized !== text) {
            expect(isCanonicalDecimal(text)).toBe(false);
          }
        },
      ),
      { seed: propertySeed() },
    );
    expect(isCanonicalDecimal("01.5")).toBe(false);
    expect(isCanonicalDecimal("1e3")).toBe(false);
    expect(isCanonicalDecimal("-0")).toBe(false);
  });
});

describe("candidate policy", () => {
  test("unselected candidates always need review for every select", () => {
    assertProperty(
      "unselected candidates always need review for every select",
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom(...company.fields.map(({ key }) => key)),
        fc.constantFrom(...RECORD_PROJECTION_TARGETS),
        (count, key, target) => {
          const state = {
            status: "resolved",
            result: {
              kind: "candidates",
              records: Array.from({ length: count }, () => companyRecord),
              selected: null,
            },
          } as const satisfies RecordCellState;
          for (const select of [
            { kind: "field", key },
            { kind: "count" },
          ] as const) {
            expect(
              project({
                state,
                schema: { ...company, cardinality: "many" },
                select,
                target,
              }),
            ).toEqual({ type: "needs-review", reason: "selection-required" });
          }
          expect(recordCellText(state, () => "money")).toBe("");
        },
      ),
      { seed: propertySeed() },
    );
  });

  test("a selected candidate projects that candidate", () => {
    const state = {
      status: "resolved",
      result: {
        kind: "candidates",
        records: [companyRecord, { ...companyRecord, name: "Other a.s." }],
        selected: 1,
      },
    } as const satisfies RecordCellState;
    expect(
      project({
        state,
        schema: { ...company, cardinality: "many" },
        select: { kind: "field", key: "name" },
        target: "text",
      }),
    ).toEqual({ type: "value", value: { type: "text", value: "Other a.s." } });
  });

  test("a selection outside the list is not a storable state", () => {
    expect(
      v.is(recordCellStateSchema, {
        status: "resolved",
        result: { kind: "candidates", records: [companyRecord], selected: 1 },
      }),
    ).toBe(false);
  });
});

describe("projection", () => {
  test("a record from another schema version is stale, never read", () => {
    expect(
      project({
        storedSchemaVersion: 1,
        schemaVersion: 2,
        select: { kind: "field", key: "name" },
        target: "text",
      }),
    ).toEqual({ type: "needs-review", reason: "stale-schema" });
  });

  test("a refused input projects to review and a missing record to empty", () => {
    expect(
      project({
        state: {
          status: "input-needs-review",
          input: { ico: "123" },
          issues: [{ key: "ico", code: "invalid", message: "Checksum" }],
        },
        select: { kind: "field", key: "name" },
        target: "text",
      }),
    ).toEqual({ type: "needs-review", reason: "input-needs-review" });
    expect(
      project({
        state: {
          status: "not-found",
          input: { ico: "12345678" },
          provenance: {
            url: "https://example.test/lookup",
            retrievedAt: "2026-11-04T12:00:00.000Z",
            sha256: "0".repeat(64),
          },
        },
        select: { kind: "field", key: "name" },
        target: "text",
      }),
    ).toEqual({ type: "empty" });
  });

  test("a fractional decimal is never rounded into an int", () => {
    expect(
      project({ select: { kind: "field", key: "rate" }, target: "int" }),
    ).toEqual({ type: "needs-review", reason: "not-integral" });
    expect(
      project({ select: { kind: "field", key: "rate" }, target: "text" }),
    ).toEqual({ type: "value", value: { type: "text", value: "25.345" } });
  });

  test("a select projection keeps only a configured option", () => {
    expect(
      project({
        select: { kind: "field", key: "active" },
        target: "single-select",
        selectOptions: ["true", "false"],
      }),
    ).toEqual({
      type: "value",
      value: { type: "single-select", value: "true" },
    });
    expect(
      project({
        select: { kind: "field", key: "name" },
        target: "single-select",
        selectOptions: ["Other"],
      }),
    ).toEqual({ type: "needs-review", reason: "no-matching-option" });
  });

  test("money keeps its minor units and currency", () => {
    expect(
      project({ select: { kind: "field", key: "capital" }, target: "money" }),
    ).toEqual({
      type: "value",
      value: { type: "money", amountCents: 20_000_000, currency: "CZK" },
    });
  });

  test("count reads the length of a list", () => {
    const state = {
      status: "resolved",
      result: {
        kind: "many",
        records: [companyRecord, companyRecord, companyRecord],
        selected: null,
      },
    } as const satisfies RecordCellState;
    const schema = { ...company, cardinality: "many" } as const;
    expect(
      project({ state, schema, select: { kind: "count" }, target: "int" }),
    ).toEqual({ type: "value", value: { type: "int", value: 3 } });
    expect(
      recordProjectionCompatibility(company, { kind: "count" }, "int"),
    ).toEqual({ type: "incompatible", reason: "count-on-one" });
  });

  test("every compatible cast projects a valid value without failing", () => {
    // The compatibility table is what the column picker offers; each pair it
    // allows has to produce a value (or an explicit review state) at run time.
    const sampleByType = {
      text: "Example",
      url: "https://example.test/",
      date: "2026-01-31",
      integer: 42,
      decimal: "7",
      boolean: false,
      money: { amountMinor: 100, currency: "EUR" },
    } as const satisfies Record<RecordFieldType, unknown>;
    for (const type of RECORD_FIELD_TYPES) {
      const schema = {
        cardinality: "one",
        fields: [{ key: "value", label: "Value", type, nullable: false }],
      } as const satisfies RecordSchema;
      const targets: readonly RecordProjectionTarget[] =
        RECORD_PROJECTION_CASTS[type];
      for (const target of RECORD_PROJECTION_TARGETS) {
        const compatibility = recordProjectionCompatibility(
          schema,
          { kind: "field", key: "value" },
          target,
        );
        expect(compatibility.type).toBe(
          targets.includes(target) ? "compatible" : "incompatible",
        );
        if (compatibility.type === "incompatible") {
          continue;
        }
        const outcome = projectRecord({
          state: {
            status: "resolved",
            result: { kind: "one", record: { value: sampleByType[type] } },
          },
          storedSchemaVersion: 1,
          schema,
          schemaVersion: 1,
          select: { kind: "field", key: "value" },
          target,
          selectOptions: ["Example", "false"],
        });
        expect(outcome.type).toBe("value");
      }
    }
  });
});
