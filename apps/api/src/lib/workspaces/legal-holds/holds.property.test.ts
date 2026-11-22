import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { createSafeId } from "@/api/lib/branded-types";

import { type HoldTarget, holdTargetPredicate } from "./holds";

const dialect = new PgDialect();

const objectKeyArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{4,12}$/u),
    fc.stringMatching(/^[a-z0-9]{4,12}$/u),
    fc.stringMatching(/^[a-z0-9_-]{3,16}$/u),
  )
  .map(([org, matter, name]) => `${org}/${matter}/${name}.pdf`);

const buildHoldTarget = (
  kind: "matter" | "entity" | "entityVersion" | "thread" | "organization",
): HoldTarget => {
  switch (kind) {
    case "matter":
      return { type: "matter", workspaceId: createSafeId<"workspace">() };
    case "entity":
      return { type: "entity", entityId: createSafeId<"entity">() };
    case "entityVersion":
      return {
        type: "entityVersion",
        entityVersionId: createSafeId<"entityVersion">(),
      };
    case "thread":
      return { type: "thread", threadId: createSafeId<"chatThread">() };
    default:
      return { type: "organization" };
  }
};

describe("legal hold target predicate properties", () => {
  test("file-set targets always parameterize object keys and empty sets compile to false", () => {
    assertProperty(
      "file-set targets always parameterize object keys and empty sets compile to false",
      fc.property(fc.array(objectKeyArb, { maxLength: 8 }), (objectKeys) => {
        const target: HoldTarget = { type: "files", objectKeys };
        const query = dialect.sqlToQuery(holdTargetPredicate(target));
        if (objectKeys.length === 0) {
          expect(query.sql).toBe("false");
          expect(query.params).toEqual([]);
          return;
        }
        for (const key of objectKeys) {
          expect(query.sql).not.toContain(key);
          expect(query.params).toContain(key);
        }
      }),
    );
  });

  test("single-entity and matter targets always emit parameterized SQL without literal id interpolation", () => {
    assertProperty(
      "single-entity and matter targets always emit parameterized SQL without literal id interpolation",
      fc.property(
        fc.constantFrom<
          "matter" | "entity" | "entityVersion" | "thread" | "organization"
        >("matter", "entity", "entityVersion", "thread", "organization"),
        (kind) => {
          const target = buildHoldTarget(kind);
          const query = dialect.sqlToQuery(holdTargetPredicate(target));
          if (target.type === "organization") {
            expect(query.sql).toBe("true");
            expect(query.params).toEqual([]);
          } else {
            expect(query.params.length).toBeGreaterThan(0);
            for (const param of query.params) {
              if (typeof param === "string") {
                expect(query.sql).not.toContain(param);
              }
            }
          }
        },
      ),
    );
  });
});
