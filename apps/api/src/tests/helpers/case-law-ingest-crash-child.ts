/**
 * The process `batch-concurrency.postgres.test.ts` kills mid-run: it applies
 * the fixture stream concurrently into the schema it is given until the test
 * sends SIGKILL. Nothing here cleans up or settles; that is the point.
 */
import { panic } from "better-result";

import { toSafeId } from "@/api/lib/branded-types";
import { configureS3ForTesting } from "@/api/lib/s3";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { courtListenerIngestFixture } from "@/api/tests/helpers/case-law-ingest-fixture";
import {
  applyIngestStream,
  objectStoreCorpus,
  schemaScopedDb,
} from "@/api/tests/helpers/case-law-ingest-schema";

const required = (name: string): string =>
  process.env[name] ?? panic(`${name} is required`);

configureS3ForTesting({ endpoint: required("INGEST_CRASH_S3_ENDPOINT") });

await withGatedTestClients(required("DATABASE_URL"), async ({ openClient }) => {
  await applyIngestStream({
    scopedDb: schemaScopedDb(
      openClient({ max: 8 }).db,
      required("INGEST_CRASH_SCHEMA"),
    ),
    sourceId: toSafeId<"caseLawSource">(required("INGEST_CRASH_SOURCE_ID")),
    decisions: courtListenerIngestFixture({
      count: Number(required("INGEST_CRASH_COUNT")),
      namespace: Number(required("INGEST_CRASH_NAMESPACE")),
    }),
    concurrency: Number(required("INGEST_CRASH_CONCURRENCY")),
    corpus: objectStoreCorpus(),
  });
});
