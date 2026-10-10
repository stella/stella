import { expect, test } from "bun:test";

import type { SanctionsEntry } from "@stll/sanctions";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { SanctionsReadTransaction } from "./read-db";
import { loadEditionEntries } from "./screening-index";

const edition = {
  id: toSafeId<"sanctionsEdition">(Bun.randomUUIDv7()),
  publishedAt: "2026-09-29",
  fileId: null,
  entryCount: 4000,
};
const payload: SanctionsEntry = {
  source: "eu",
  issuer: "EU",
  sourceId: "one",
  referenceNumber: null,
  entityType: "person",
  names: [{ name: "Synthetic Person", quality: "strong" }],
  birthDates: [],
  nationalities: [],
  identifiers: [],
  addresses: [],
  programme: null,
  legalBasis: null,
  listedOn: null,
  sourceUrl: "https://example.test/list",
};
const page = Array.from({ length: 2000 }, (_, index) => ({
  sourceEntryId: String(index),
  payload,
}));

// The held acquisition and statement are separate boundaries: cancellation
// must stop a queued statement and must stop the next page after a running one.
test.each(["acquisition", "statement"] as const)(
  "cancelled %s never starts another page",
  async (boundary) => {
    const controller = new AbortController();
    const held = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    let acquisitions = 0;
    let statements = 0;
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: async () => {
        statements += 1;
        started.resolve(undefined);
        if (boundary === "statement") {
          await held.promise;
        }
        return page;
      },
    };
    const tx = asTestRaw<SanctionsReadTransaction>({ select: () => query });
    const pending = loadEditionEntries({
      edition,
      signal: controller.signal,
      db: async (read) => {
        acquisitions += 1;
        if (boundary === "acquisition") {
          started.resolve(undefined);
          await held.promise;
        }
        return await read(tx);
      },
    });
    await started.promise;
    controller.abort();
    held.resolve(undefined);
    expect(await pending).toEqual([]);
    expect(acquisitions).toBe(1);
    expect(statements).toBe(boundary === "acquisition" ? 0 : 1);
  },
);
