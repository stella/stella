import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("provision applied-version constraints (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  test("the deployed provision CHECK enforces every temporal discriminator and evidence branch", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql } = openClient();
      // A temporary clone carries the real deployed constraints, without foreign keys or corpus writes.
      await sql.begin(async (tx) => {
        await tx`CREATE TEMP TABLE provision_version_check (LIKE case_law_provision_citations INCLUDING CONSTRAINTS) ON COMMIT DROP`;
        const insert = async (
          basis: string | null,
          fields: Record<string, string | number | null>,
        ) => {
          const row = {
            id: Bun.randomUUIDv7(),
            decision_id: Bun.randomUUIDv7(),
            jurisdiction: "CZE",
            work_identifier: "89/2012 Sb.",
            work_number: 89,
            work_year: 2012,
            work_collection: "Sb.",
            unit: "section",
            section: 1,
            open_ended: false,
            anchor: "par_1",
            sentence_text: "§ 1",
            span_start: 0,
            span_end: 3,
            confidence: 1,
            created_at: "2026-01-01",
            applied_version_basis: basis,
            ...fields,
          };
          await tx`INSERT INTO provision_version_check ${tx(row)}`;
        };
        const date = {
          applied_version_date: "2013-12-31",
          applied_version_date_relation: "until",
          version_evidence_start: 0,
          version_evidence_end: 42,
          version_evidence_kind: "stated_date",
        };
        const amendment = {
          applied_version_amendment_work_identifier: "303/2013 Sb.",
          version_evidence_start: 0,
          version_evidence_end: 42,
          version_evidence_kind: "stated_version",
        };
        const cases = [
          { basis: null, fields: {} },
          { basis: "not_stated", fields: {} },
          { basis: "stated_date", fields: date },
          { basis: "stated_version", fields: amendment },
        ];
        for (const { basis, fields } of cases) {
          await insert(basis, fields);
        }
        const rejected = [
          ...[null, "not_stated", "unknown"].flatMap((basis) => [
            { basis, fields: date },
            { basis, fields: amendment },
          ]),
          ...["stated_date", "stated_version"].map((basis) => ({
            basis,
            fields: {},
          })),
          ...Object.keys(date).map((key) => ({
            basis: "stated_date",
            fields: { ...date, [key]: null },
          })),
          ...Object.keys(amendment).map((key) => ({
            basis: "stated_version",
            fields: { ...amendment, [key]: null },
          })),
          ...[date, amendment].flatMap((fields) => [
            {
              basis: fields.version_evidence_kind,
              fields: { ...fields, version_evidence_kind: "inferred" },
            },
            {
              basis: fields.version_evidence_kind,
              fields: { ...fields, version_evidence_start: -1 },
            },
            {
              basis: fields.version_evidence_kind,
              fields: { ...fields, version_evidence_end: 0 },
            },
            {
              basis: fields.version_evidence_kind,
              fields: {
                ...fields,
                applied_version_expression_date: "2014-01-01",
              },
            },
            {
              basis: fields.version_evidence_kind,
              fields: {
                ...fields,
                applied_version_expression_eli: "/eli/expression",
              },
            },
          ]),
          {
            basis: "stated_date",
            fields: { ...date, applied_version_date_relation: "unknown" },
          },
          {
            basis: "stated_date",
            fields: {
              ...date,
              applied_version_amendment_work_identifier: "303/2013 Sb.",
            },
          },
          {
            basis: "stated_version",
            fields: { ...amendment, applied_version_date: "2014-01-01" },
          },
          {
            basis: "stated_version",
            fields: {
              ...amendment,
              applied_version_amendment_work_identifier: "",
            },
          },
        ];
        for (const { basis, fields } of rejected) {
          await tx`SAVEPOINT temporal_invalid_row`;
          const error = await rejectionOf(insert(basis, fields));
          expect(error).toHaveProperty(
            "constraint",
            "provision_citations_applied_version_shape",
          );
          await tx`ROLLBACK TO SAVEPOINT temporal_invalid_row`;
        }
        for (const { basis, fields } of cases.filter(
          ({ basis: candidateBasis }) =>
            candidateBasis === "stated_date" ||
            candidateBasis === "stated_version",
        )) {
          await insert(basis, {
            ...fields,
            applied_version_expression_date: "2014-01-01",
            applied_version_expression_eli: "/eli/expression",
          });
        }
      });
    });
  });
}
