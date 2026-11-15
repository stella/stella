import { expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { corpusIndexProjectionIntents } from "@/api/db/schema";
import { corpusIndexCommittedIngestTimeoutMs } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusProjectionAppendIngestBudgetMs } from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  corpusProjectionAcceptedAppendCleanupFence,
  corpusProjectionAppendPublishBarrier,
  corpusProjectionUnrecordedAppendCleanupFence,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";

const MANIFESTS = Object.values(CORPUS_INDEX_MANIFESTS);
const dialect = new PgDialect();

const commitWindowMs = (manifest: CorpusIndexManifest) =>
  manifest.engine.indexConfig.indexing_settings.commit_timeout_secs * 1000;

/** The accepted barrier as it was written before one function owned it. */
const acceptedBarrierBefore = (
  acceptedAt: SQL,
  manifest: CorpusIndexManifest,
) =>
  sql`(${acceptedAt}::timestamptz + ${commitWindowMs(manifest) + 5000}::double precision * interval '1 millisecond')`;

test("an unknown append's barrier is unchanged for every generation", () => {
  assertProperty(
    "an unknown append's barrier is unchanged for every generation",
    fc.property(
      fc.constantFrom(...MANIFESTS),
      fc.date({
        min: new Date("2000-01-01T00:00:00.000Z"),
        max: new Date("2100-01-01T00:00:00.000Z"),
        noInvalidDate: true,
      }),
      (manifest, appendStartedAt) => {
        // Request budget (commit window + 60 s upload), then the publish
        // delay (commit window + 5 s).
        expect(
          corpusProjectionAppendPublishBarrier(
            { type: "unknown", appendStartedAt },
            manifest,
          ).getTime(),
        ).toBe(
          appendStartedAt.getTime() +
            (commitWindowMs(manifest) + 60_000) +
            (commitWindowMs(manifest) + 5000),
        );
      },
    ),
  );
});

test("the append ingest budget is the wait_for client timeout", () => {
  for (const manifest of MANIFESTS) {
    const commitTimeoutSecs =
      manifest.engine.indexConfig.indexing_settings.commit_timeout_secs;
    expect(corpusProjectionAppendIngestBudgetMs(manifest)).toBe(
      commitTimeoutSecs * 1000 + 60_000,
    );
    expect(corpusProjectionAppendIngestBudgetMs(manifest)).toBe(
      corpusIndexCommittedIngestTimeoutMs(commitTimeoutSecs),
    );
  }
});

test("an accepted append's barrier renders the same SQL for every generation", () => {
  const transitionAt = new Date("2026-08-25T12:00:00.000Z");
  for (const manifest of MANIFESTS) {
    for (const acceptedAt of [
      sql`${corpusIndexProjectionIntents.appendCommittedAt}`,
      sql`clock_timestamp()`,
    ]) {
      expect(
        dialect.sqlToQuery(
          corpusProjectionAppendPublishBarrier(
            { type: "accepted", acceptedAt },
            manifest,
          ),
        ),
      ).toEqual(
        dialect.sqlToQuery(acceptedBarrierBefore(acceptedAt, manifest)),
      );
    }
    expect(
      dialect.sqlToQuery(
        corpusProjectionAcceptedAppendCleanupFence(manifest, transitionAt)
          .appendPublishBarrierAt,
      ),
    ).toEqual(
      dialect.sqlToQuery(
        acceptedBarrierBefore(
          sql`${corpusIndexProjectionIntents.appendCommittedAt}`,
          manifest,
        ),
      ),
    );
    expect(
      dialect.sqlToQuery(
        corpusProjectionUnrecordedAppendCleanupFence(manifest, transitionAt)
          .appendPublishBarrierAt,
      ),
    ).toEqual(
      dialect.sqlToQuery(acceptedBarrierBefore(sql`${transitionAt}`, manifest)),
    );
  }
});

test("an unknown append without a valid start has no barrier", () => {
  expect(() =>
    corpusProjectionAppendPublishBarrier(
      { type: "unknown", appendStartedAt: new Date(Number.NaN) },
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
  ).toThrow("append barrier contract is invalid");
});
