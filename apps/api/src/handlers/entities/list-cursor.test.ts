import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  decodeEntityFileListCursor,
  decodeEntityListCursor,
  encodeEntityFileListCursor,
  encodeEntityListCursor,
  entityFileListCursorCondition,
} from "@/api/handlers/entities/list-cursor";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

describe("entity list cursor", () => {
  test("round-trips microsecond timestamp precision", () => {
    const cursor = encodeEntityListCursor({
      createdAt: "2026-05-22T09:31:31.123456",
      id: "entity_1",
    });

    expect(decodeEntityListCursor(cursor)).toEqual({
      createdAt: "2026-05-22T09:31:31.123456",
      id: toSafeId<"entity">("entity_1"),
    });
  });

  test("rejects millisecond timestamps", () => {
    const cursor = encodeEntityListCursor({
      createdAt: "2026-05-22T09:31:31.123",
      id: "entity_1",
    });

    expect(() => decodeEntityListCursor(cursor)).toThrow(HandlerError);
  });

  test("file cursor condition includes the field tie-breaker", () => {
    const condition = entityFileListCursorCondition({
      createdAt: "2026-05-22T09:31:31.123456",
      fieldId: toSafeId<"field">("field_1"),
      id: toSafeId<"entity">("entity_1"),
    });
    if (!condition) {
      throw new Error("expected file cursor condition");
    }

    const dialect = new PgDialect();
    const sql = dialect.sqlToQuery(condition).sql;

    expect(sql).toContain('"entities"."id" =');
    expect(sql).toContain('"fields"."id" >');
  });

  test("round-trips file cursor tie-breaker", () => {
    const cursor = encodeEntityFileListCursor({
      createdAt: "2026-05-22T09:31:31.123456",
      fieldId: "field_1",
      id: "entity_1",
    });

    expect(decodeEntityFileListCursor(cursor)).toEqual({
      createdAt: "2026-05-22T09:31:31.123456",
      fieldId: toSafeId<"field">("field_1"),
      id: toSafeId<"entity">("entity_1"),
    });
    expect(() => decodeEntityListCursor(cursor)).toThrow(HandlerError);
  });
});
