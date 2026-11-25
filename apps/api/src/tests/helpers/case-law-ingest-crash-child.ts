/**
 * The process `batch-concurrency.postgres.test.ts` kills mid-run: it applies
 * the fixture stream concurrently into the schema it is given until the test
 * sends SIGKILL. Nothing here cleans up or settles; that is the point.
 *
 * Usage: bun case-law-ingest-crash-child.ts --s3 <endpoint> --schema <name>
 *   --source <id> --count <n> --namespace <n> --concurrency <n>
 */
import { panic } from "better-result";
import { parseArgs } from "node:util";

import { toSafeId } from "@/api/lib/branded-types";
import { configureS3ForTesting } from "@/api/lib/s3";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { courtListenerIngestFixture } from "@/api/tests/helpers/case-law-ingest-fixture";
import {
  applyIngestStream,
  objectStoreCorpus,
  schemaScopedDb,
} from "@/api/tests/helpers/case-law-ingest-schema";

const { values } = parseArgs({
  options: {
    s3: { type: "string" },
    schema: { type: "string" },
    source: { type: "string" },
    count: { type: "string" },
    namespace: { type: "string" },
    concurrency: { type: "string" },
  },
});
const required = (value: string | undefined, name: string): string =>
  value ?? panic(`--${name} is required`);

configureS3ForTesting({ endpoint: required(values.s3, "s3") });

await withGatedTestClients(
  process.env["DATABASE_URL"] ?? panic("DATABASE_URL is required"),
  async ({ openClient }) => {
    await applyIngestStream({
      scopedDb: schemaScopedDb(
        openClient({ max: 8 }).db,
        required(values.schema, "schema"),
      ),
      sourceId: toSafeId<"caseLawSource">(required(values.source, "source")),
      decisions: courtListenerIngestFixture({
        count: Number(required(values.count, "count")),
        namespace: Number(required(values.namespace, "namespace")),
      }),
      concurrency: Number(required(values.concurrency, "concurrency")),
      corpus: objectStoreCorpus(),
    });
  },
);
