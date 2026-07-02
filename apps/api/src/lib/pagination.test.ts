import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isMicrosecondTimestampPaginationCursorPart,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
} from "@/api/lib/pagination";

describe("cursor pagination", () => {
  test("returns the requested window and a cursor when another row exists", () => {
    const page = createCursorPage({
      rows: [{ id: "one" }, { id: "two" }, { id: "three" }],
      limit: 2,
      cursorForItem: (item) => item.id,
    });

    expect(page).toEqual({
      items: [{ id: "one" }, { id: "two" }],
      limit: 2,
      nextCursor: "two",
    });
  });

  test("returns a null cursor on the last page", () => {
    const page = createCursorPage({
      rows: [{ id: "one" }, { id: "two" }],
      limit: 2,
      cursorForItem: (item) => item.id,
    });

    expect(page).toEqual({
      items: [{ id: "one" }, { id: "two" }],
      limit: 2,
      nextCursor: null,
    });
  });

  test("roundtrips opaque cursor parts", () => {
    const cursor = encodePaginationCursor([
      "2026-05-16T10:30:00.000Z",
      "invoice_123",
      7,
    ]);

    expect(decodePaginationCursor(cursor)).toEqual([
      "2026-05-16T10:30:00.000Z",
      "invoice_123",
      7,
    ]);
  });

  test("rejects malformed cursors", () => {
    expect(decodePaginationCursor("not-json")).toBeNull();
    expect(decodePaginationCursor(encodePaginationCursor(["valid"]))).toEqual([
      "valid",
    ]);
  });

  test("validates date-only cursor parts", () => {
    expect(isDateOnlyPaginationCursorPart("2026-05-16")).toBe(true);
    expect(isDateOnlyPaginationCursorPart("2026-02-30")).toBe(false);
    expect(isDateOnlyPaginationCursorPart("2026-99-99")).toBe(false);
    expect(isDateOnlyPaginationCursorPart("2026-5-16")).toBe(false);
  });

  test("validates UUID cursor parts", () => {
    expect(
      isUuidPaginationCursorPart("018f3d26-388b-7b90-9e39-86c58be5f97a"),
    ).toBe(true);
    expect(isUuidPaginationCursorPart("not-a-uuid")).toBe(false);
    expect(isUuidPaginationCursorPart("invoice_123")).toBe(false);
  });

  test("parses canonical ISO datetime cursor parts", () => {
    expect(
      parseDateTimePaginationCursorPart("2026-05-16T10:30:00.000Z"),
    ).toEqual(new Date("2026-05-16T10:30:00.000Z"));
    expect(parseDateTimePaginationCursorPart("2026-99-99")).toBeNull();
    expect(
      parseDateTimePaginationCursorPart("2026-05-16T10:30:00Z"),
    ).toBeNull();
  });

  test("validates microsecond timestamp cursor parts", () => {
    // to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.US') output — accepted verbatim.
    expect(
      isMicrosecondTimestampPaginationCursorPart("2026-05-16T10:30:00.123456"),
    ).toBe(true);
    // The millisecond ISO form Date.toISOString() emits must be rejected:
    // it is the format that silently broke cursor decoding.
    expect(
      isMicrosecondTimestampPaginationCursorPart("2026-05-16T10:30:00.123Z"),
    ).toBe(false);
    expect(
      isMicrosecondTimestampPaginationCursorPart("2026-05-16T10:30:00.000Z"),
    ).toBe(false);
    // Out-of-range calendar values are rejected.
    expect(
      isMicrosecondTimestampPaginationCursorPart("2026-13-01T00:00:00.000000"),
    ).toBe(false);
    expect(isMicrosecondTimestampPaginationCursorPart("not-a-timestamp")).toBe(
      false,
    );
    expect(isMicrosecondTimestampPaginationCursorPart(12345)).toBe(false);
  });
});

describe("cursor pagination — properties", () => {
  const cursorPrimitive = fc.oneof(
    fc.string(),
    fc.integer(),
    fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Object.is(n, -0)),
    fc.boolean(),
    fc.constant(null),
  );

  const boundedDate = fc.date({
    min: new Date("1900-01-01T00:00:00.000Z"),
    max: new Date("2200-12-31T23:59:59.999Z"),
    noInvalidDate: true,
  });

  test("encode → decode round-trips any cursor primitive array", () => {
    fc.assert(
      fc.property(fc.array(cursorPrimitive), (parts) => {
        expect(decodePaginationCursor(encodePaginationCursor(parts))).toEqual(
          parts,
        );
      }),
      propertyConfig(),
    );
  });

  test("decode is total on arbitrary input — never throws", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = decodePaginationCursor(input);
        expect(result === null || Array.isArray(result)).toBe(true);
      }),
      propertyConfig(),
    );
  });

  test("createCursorPage — items is the prefix slice of rows", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string() }), { maxLength: 50 }),
        fc.integer({ min: 1, max: 100 }),
        (rows, limit) => {
          const page = createCursorPage({
            rows,
            limit,
            cursorForItem: (row) => row.id,
          });

          expect(page.limit).toBe(limit);
          expect(page.items.length).toBe(Math.min(rows.length, limit));
          expect(page.items).toEqual(rows.slice(0, page.items.length));
        },
      ),
      propertyConfig(),
    );
  });

  test("createCursorPage — nextCursor is null iff rows fit within limit", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string() }), { maxLength: 50 }),
        fc.integer({ min: 1, max: 100 }),
        (rows, limit) => {
          const page = createCursorPage({
            rows,
            limit,
            cursorForItem: (row) => row.id,
          });

          if (rows.length > limit) {
            // rows.length > limit ≥ 1, so rows[limit - 1] always exists.
            expect(page.nextCursor).toBe(rows[limit - 1]?.id ?? null);
          } else {
            expect(page.nextCursor).toBeNull();
          }
        },
      ),
      propertyConfig(),
    );
  });

  test("isDateOnlyPaginationCursorPart accepts every canonical UTC date", () => {
    fc.assert(
      fc.property(boundedDate, (d) => {
        expect(
          isDateOnlyPaginationCursorPart(d.toISOString().slice(0, 10)),
        ).toBe(true);
      }),
      propertyConfig(),
    );
  });

  test("isDateOnlyPaginationCursorPart only accepts strings that round-trip through Date", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (!isDateOnlyPaginationCursorPart(s)) {
          return;
        }
        expect(new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10)).toBe(
          s,
        );
      }),
      propertyConfig(),
    );
  });

  test("parseDateTimePaginationCursorPart accepts every canonical ISO datetime", () => {
    fc.assert(
      fc.property(boundedDate, (d) => {
        expect(parseDateTimePaginationCursorPart(d.toISOString())).toEqual(d);
      }),
      propertyConfig(),
    );
  });

  test("parseDateTimePaginationCursorPart rejects non-canonical variants", () => {
    fc.assert(
      fc.property(boundedDate, (d) => {
        // Stripping milliseconds produces a valid ISO string but not the canonical form
        // toISOString() emits — parser must reject to preserve cursor equality semantics.
        const stripped = d.toISOString().replace(/\.\d{3}Z$/u, "Z");
        expect(parseDateTimePaginationCursorPart(stripped)).toBeNull();
      }),
      propertyConfig(),
    );
  });

  test("isMicrosecondTimestampPaginationCursorPart accepts to_char-style microsecond timestamps", () => {
    fc.assert(
      fc.property(boundedDate, (d) => {
        // Mimic Postgres to_char(...'.US'): ISO without Z, ms padded to µs.
        const microsecond = d.toISOString().replace(/\.(\d{3})Z$/u, ".$1000");
        expect(isMicrosecondTimestampPaginationCursorPart(microsecond)).toBe(
          true,
        );
      }),
    );
  });

  test("isUuidPaginationCursorPart accepts every RFC-4122 UUID", () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        expect(isUuidPaginationCursorPart(id)).toBe(true);
      }),
      propertyConfig(),
    );
  });
});
