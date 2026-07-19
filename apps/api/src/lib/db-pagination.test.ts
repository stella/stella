import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { invoices } from "@/api/db/schema";
import {
  createTimestampIdCursorCodec,
  parsePgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import { brandPersistedInvoiceId } from "@/api/lib/safe-id-boundaries";

const cursorTimestamp = (date: Date, microseconds: number): string =>
  `${date.toISOString().slice(0, 19)}.${microseconds.toString().padStart(6, "0")}`;

describe("PostgreSQL timestamp cursor values", () => {
  test("INVARIANT: valid microsecond values round-trip without precision loss", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2099-12-31T23:59:59.999Z"),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 999_999 }),
        (date, microseconds) => {
          const value = cursorTimestamp(date, microseconds);
          expect(parsePgTimestampCursorValue(value)).toEqual({
            type: "pgTimestampCursor",
            value,
            precision: "microseconds",
          });
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("keeps already-issued ISO cursor values readable, tagged millisecond", () => {
    const value = "2026-07-10T08:15:30.123Z";
    expect(parsePgTimestampCursorValue(value)).toEqual({
      type: "pgTimestampCursor",
      value,
      precision: "milliseconds",
    });
  });

  test("rejects non-canonical timestamp values", () => {
    for (const value of [
      "2026-07-10T08:15:30.12345",
      "2026-07-10T08:15:30.123456Z",
      "2026-13-10T08:15:30.123456",
      "2026-02-30T08:15:30.123456",
      "2026-07-10T24:15:30.123456",
      "0000-07-10T08:15:30.123456",
      "2026-07-10 08:15:30.123456",
      "not-a-timestamp",
    ]) {
      expect(parsePgTimestampCursorValue(value)).toBeNull();
    }
  });
});

describe("createTimestampIdCursorCodec", () => {
  // `cursorValue`/`boundary` build SQL; encode/decode never touch the column,
  // so a placeholder column is enough to exercise the wire codec.
  const codec = createTimestampIdCursorCodec({
    column: sql`created_at`,
    brandId: brandPersistedInvoiceId,
  });

  test("INVARIANT: decode ∘ encode round-trips any (timestamp, id)", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2099-12-31T23:59:59.999Z"),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 999_999 }),
        fc.uuid(),
        (date, microseconds, id) => {
          const timestamp = cursorTimestamp(date, microseconds);
          const decoded = codec.decode(codec.encode(timestamp, id));
          expect(decoded).toEqual({
            timestamp: {
              type: "pgTimestampCursor",
              value: timestamp,
              precision: "microseconds",
            },
            id: brandPersistedInvoiceId(id),
          });
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("garbage or malformed cursors decode to null (→ first page)", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const decoded = codec.decode(raw);
        expect(decoded === null || typeof decoded.id === "string").toBe(true);
      }),
      propertyConfig({ numRuns: 500 }),
    );
    // A well-formed cursor whose id is not a UUID is rejected.
    expect(
      codec.decode(codec.encode("2026-07-10T08:15:30.123456", "nope")),
    ).toBeNull();
    // Wrong arity (single-part payload) is rejected.
    expect(
      codec.decode(
        Buffer.from(JSON.stringify(["only-one"])).toString("base64url"),
      ),
    ).toBeNull();
  });

  test("accepts the legacy pipe-delimited `timestamp|uuid` form", () => {
    const timestamp = "2026-07-10T08:15:30.123456";
    const id = "6f5b2c1a-1111-4222-8333-444455556666";
    expect(codec.decode(`${timestamp}|${id}`)).toEqual({
      timestamp: {
        type: "pgTimestampCursor",
        value: timestamp,
        precision: "microseconds",
      },
      id: brandPersistedInvoiceId(id),
    });
  });

  test("accepts already-issued millisecond ISO timestamps in the tuple", () => {
    const timestamp = "2026-07-10T08:15:30.123Z";
    const id = "6f5b2c1a-1111-4222-8333-444455556666";
    expect(codec.decode(codec.encode(timestamp, id))).toEqual({
      timestamp: {
        type: "pgTimestampCursor",
        value: timestamp,
        precision: "milliseconds",
      },
      id: brandPersistedInvoiceId(id),
    });
  });
});

describe("createTimestampIdCursorCodec keysetAfter", () => {
  // `keysetAfter` builds the SQL keyset predicate; render it with the Postgres
  // dialect so the class guard asserts on the emitted comparison, not internals.
  const dialect = new PgDialect();
  const codec = createTimestampIdCursorCodec({
    column: invoices.createdAt,
    brandId: brandPersistedInvoiceId,
  });
  const id = "6f5b2c1a-1111-4222-8333-444455556666";

  const renderAfter = (
    rawTimestamp: string,
    direction: "ascending" | "descending",
  ): string => {
    const cursor = codec.decode(codec.encode(rawTimestamp, id));
    if (cursor === null) {
      throw new Error("cursor failed to decode");
    }
    const predicate = codec.keysetAfter({
      cursor,
      idColumn: invoices.id,
      direction,
    });
    if (predicate === undefined) {
      throw new Error("keysetAfter produced no predicate");
    }
    return dialect.sqlToQuery(predicate).sql;
  };

  test("canonical microsecond cursor compares the raw column", () => {
    const ascending = renderAfter("2026-07-10T08:15:30.123456", "ascending");
    expect(ascending).not.toContain("date_trunc");
    // Forward page: timestamp `>` boundary, id `>` on the tie-break.
    expect(ascending).toContain('"created_at" >');
    expect(ascending).toContain('"id" >');

    const descending = renderAfter("2026-07-10T08:15:30.123456", "descending");
    expect(descending).not.toContain("date_trunc");
    expect(descending).toContain('"created_at" <');
    expect(descending).toContain('"id" <');
  });

  test("INVARIANT: legacy millisecond cursor truncates the column on both sides", () => {
    // A page issued before the microsecond migration truncated created_at to the
    // millisecond and ordered on that; resuming it must compare the truncated
    // column so a row at `…​.123456` is not re-emitted (asc) or skipped (desc)
    // against a `…​.123` boundary. Both the range and tie-break clauses must
    // truncate, so require two date_trunc occurrences.
    const cases = [
      { direction: "ascending", op: ">" },
      { direction: "descending", op: "<" },
    ] as const;
    for (const { direction, op } of cases) {
      const rendered = renderAfter("2026-07-10T08:15:30.123Z", direction);
      const truncation = `date_trunc('milliseconds', "invoices"."created_at")`;
      // Both the range clause and the tie-break clause truncate the column.
      const truncations = rendered.match(
        /date_trunc\('milliseconds', "invoices"\."created_at"\)/gu,
      );
      expect(truncations?.length).toBe(2);
      expect(rendered).toContain(`${truncation} ${op}`);
      expect(rendered).toContain(`${truncation} =`);
    }
  });
});
