import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { SK_COURTS_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/sk-courts.metadata-urls";
import {
  checkedDecisionMetadata,
  readDecisionTextMetadata,
} from "@/api/lib/case-law/decision-text";
import { toPlainTextMetadataObject } from "@/api/lib/case-law/plain-text";
import {
  approveMetadataUrls,
  META_URL_DIAGNOSTICS,
  rehydrateMetadataUrls,
} from "@/api/lib/legal-search/metadata-urls";
import { toMetadataUrl } from "@/api/lib/sanitize-url";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(!enabled)(
  "metadata URL scalar persistence in PostgreSQL",
  () => {
    test("a canonical decision row preserves stated URLs, null and diagnostics through JSONB replay", async () => {
      const url =
        databaseUrl ??
        panic("DATABASE_URL required for PostgreSQL metadata URL regression");
      const stated =
        "https://example.test/?single=&amp;&double=&amp;amp;&encoded=%26";
      const metadata = approveMetadataUrls(
        checkedDecisionMetadata({
          referencedLegislation: [
            { nazov: "Zákon", url: toMetadataUrl(stated, "transport-json") },
            {
              nazov: "Unpublished",
              url: toMetadataUrl(null, "transport-json"),
            },
            {
              nazov: "Rejected",
              url: toMetadataUrl("ftp://example.test/file", "transport-json"),
            },
          ],
        }),
        SK_COURTS_METADATA_URL_SCHEMA,
      );
      await withGatedTestClients(url, async ({ openClient }) => {
        await openClient().sql.begin(async (tx) => {
          // LIKE derives column types and checks from the actual decision schema.
          // The transaction owns this temporary row and drops it on completion.
          await tx`CREATE TEMP TABLE metadata_url_roundtrip (LIKE public.case_law_decisions INCLUDING ALL) ON COMMIT DROP`;
          await tx`INSERT INTO metadata_url_roundtrip (id, source_id, case_number, court, country, language, metadata)
          VALUES (${Bun.randomUUIDv7()}, ${Bun.randomUUIDv7()}, 'JSONB fixture', 'Court', 'SVK', 'sk', ${JSON.stringify(metadata)}::text::jsonb)`;
          const row = (
            await tx`SELECT metadata FROM metadata_url_roundtrip`
          ).at(0);
          expect(row?.["metadata"]).toEqual(metadata);
          const replayed = rehydrateMetadataUrls(
            row?.["metadata"],
            SK_COURTS_METADATA_URL_SCHEMA,
          );
          expect(replayed).toEqual(metadata);
          expect({
            value: toPlainTextMetadataObject(
              structuredClone(replayed),
              SK_COURTS_METADATA_URL_SCHEMA,
            ).unwrap(),
          }).toHaveProperty("value", metadata);
          expect(replayed["referencedLegislation"]).toEqual([
            { nazov: "Zákon", url: stated },
            { nazov: "Unpublished", url: null },
            { nazov: "Rejected" },
          ]);
          expect(replayed[META_URL_DIAGNOSTICS]).toEqual({
            entries: [
              {
                address: "referencedLegislation[2].url",
                reason: "unsafe-protocol",
              },
            ],
            overflowCount: 0,
          });
          expect(
            readDecisionTextMetadata(replayed).metadata,
          ).not.toHaveProperty(META_URL_DIAGNOSTICS);
        });
      });
    });
  },
);
