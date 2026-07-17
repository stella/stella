import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  assertIdentifierLiteral,
  jsonField,
  jsonLiteral,
  jsonValueLiteral,
} from "@/api/db/json-utils";
import { fields } from "@/api/db/schema";
import type { PropertyContent } from "@/api/db/schema-validators";

const dialect = new PgDialect();

describe("assertIdentifierLiteral", () => {
  // Real call-site values: jsonField(fields.content, "v1")("type") in
  // workflow-queue.ts, jsonField(fields.content, "v1")("fileName") in
  // entity-create.ts and upload.ts, and the TASK_STATUS_VALUES constants
  // (open/in_progress/in_review/done/cancelled) in read-group-counts.ts.
  test.each([
    "type",
    "fileName",
    "open",
    "in_progress",
    "in_review",
    "done",
    "cancelled",
    // Schema literal values (single-select/multi-select property types, etc.)
    "single-select",
    "multi-select",
    "text",
    "1",
  ])("accepts identifier-like value %p", (value) => {
    expect(() => assertIdentifierLiteral(value)).not.toThrow();
  });

  test.each([
    "fo'o",
    "'; DROP TABLE entities; --",
    "back\\slash",
    "has space",
    'quote"double',
    "new\nline",
    "",
    "emoji-🙂",
  ])("rejects non-identifier value %p", (value) => {
    expect(() => assertIdentifierLiteral(value)).toThrow();
  });
});

describe("jsonField", () => {
  test("builds a JSON path lookup for identifier-like keys used at real call sites", () => {
    const query = dialect.sqlToQuery(jsonField(fields.content, "v1")("type"));

    expect(query.sql).toBe(`"fields"."content"->>'type'`);
    expect(query.params).toEqual([]);
  });

  test("builds a JSON path lookup for the fileName key", () => {
    const query = dialect.sqlToQuery(
      jsonField(fields.content, "v1")("fileName"),
    );

    expect(query.sql).toBe(`"fields"."content"->>'fileName'`);
  });
});

describe("jsonLiteral", () => {
  test("builds a quoted literal for an identifier-like value", () => {
    // "options" is a real key of the single-select/multi-select branch of
    // PropertyContent (see propertyContentSchema); jsonLiteral's generic
    // narrows its argument to keyof the versioned union, not to a value
    // literal, so the accepted value here must be a schema key.
    const query = dialect.sqlToQuery(
      jsonLiteral<PropertyContent, 1>("options"),
    );

    expect(query.sql).toBe("'options'");
    expect(query.params).toEqual([]);
  });
});

describe("jsonValueLiteral", () => {
  test("builds a quoted literal for an identifier-like string value", () => {
    const query = dialect.sqlToQuery(
      jsonValueLiteral<PropertyContent, 1>("text"),
    );

    expect(query.sql).toBe("'text'");
  });

  test("builds a quoted literal for a numeric version value", () => {
    const query = dialect.sqlToQuery(jsonValueLiteral<PropertyContent, 1>(1));

    expect(query.sql).toBe("'1'");
  });
});
