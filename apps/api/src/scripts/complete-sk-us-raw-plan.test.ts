import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  StoredRawReadError,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { StoredRawReparseInput } from "@/api/handlers/case-law/ingestion/adapter";
import {
  readBodyText,
  type readPublisherText,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import type { PublisherFetchInit } from "@/api/handlers/case-law/ingestion/adapters/retry";
import {
  fetchSkUsListing,
  skUsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { readStoredRawFromS3 } from "@/api/handlers/case-law/ingestion/pipeline/stored-raw";
import { createSafeId } from "@/api/lib/branded-types";
import {
  readAbsent,
  readOutcomeOfStatus,
  readPresent,
  readUnavailable,
  type ReadOutcome,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import {
  openRawSourceWriteWindow,
  RAW_SOURCE_FAMILY,
  writeCaseLawRawPayload,
  writeSourceBinary,
} from "@/api/lib/legal-search/raw-source-storage";
import {
  completedSkUsRawEnvelope,
  completeSkUsRawObservation,
  prepareSkUsRawCompletion,
  runSkUsRawPage,
  runSkUsRawBatch,
} from "@/api/scripts/complete-sk-us-raw-plan";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

/**
 * A served response as the publisher read types it; a 429 rejects as the
 * read's typed rate-limit stop.
 */
const readOf = async (
  response: Response,
  init: PublisherFetchInit,
): Promise<ReadOutcome<Response>> => {
  if (response.status === 429) {
    return await Promise.reject(
      new AdapterFetchError({
        message: "Publisher request refused: 429",
        adapterKey: init.adapterKey,
        cursor: null,
        httpStatus: response.status,
      }),
    );
  }
  const outcome = readOutcomeOfStatus(response.status, "document");
  switch (outcome.type) {
    case "present":
      return readPresent(response);
    case "absent":
      return readAbsent(outcome.evidence);
    case "refused":
      return outcome;
    case "unavailable":
      return readUnavailable(outcome.cause);
    default:
      outcome satisfies never;
      return panic(`Unhandled read outcome: ${String(outcome)}`);
  }
};

/**
 * A publisher text read that answers with the response `respond` serves; the
 * body is read by the owner's bounded reader.
 */
const readWith =
  (
    respond: (url: string | URL, init: PublisherFetchInit) => Promise<Response>,
  ): typeof readPublisherText =>
  async (url, init) =>
    await readBodyText(
      await readOf(await respond(url, init), init),
      init.signal ?? undefined,
    );

/** A fixture row that must exist; a missing one fails loudly, never as `undefined`. */
const rowAt = <T>(items: readonly T[], index: number): T => {
  const item = items.at(index);
  if (item === undefined) {
    throw new TypeError(`fixture row ${index} is missing`);
  }
  return item;
};

const identity = {
  documentId: "7964d54e-6708-48e9-92cc-5cc400aab1e3",
  caseNumber: "PL. ÚS 4/2020",
};
const listing = {
  documentId: identity.documentId,
  mkRSAPNumberOfFile: identity.caseNumber,
  mkDateOfDecision: "03/12/2020 00:00:00",
  mkFormOfDecision: "Nález",
  mkECLI: "ECLI:SK:USSR:2020:PL.US.4.2020.1",
};
const listingJson = JSON.stringify(listing);
const encoder = new TextEncoder();
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 0, 128, 255]);
const cursor = {
  id: createSafeId<"caseLawDecision">(),
  createdAt: "2026-03-01T00:00:00.000001Z",
};

test("listing fetching preserves stored replay results for complete and legacy fixtures", async () => {
  const reparse = skUsAdapter.reparseStoredRaw;
  if (reparse === undefined) {
    expect.unreachable("SK ÚS must support stored replay");
  }
  const fixtures = [
    {
      raw: encoder.encode(
        encodeSourceRawEnvelope({
          listing: listingJson,
          document: "<html><body><span>Rozhodnutie.</span></body></html>",
        }),
      ),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      expectedType: "parsed",
    },
    { raw: PDF, contentType: "application/pdf", expectedType: "rejected" },
    {
      raw: encoder.encode(listingJson),
      contentType: "application/json",
      expectedType: "parsed",
    },
    {
      raw: encoder.encode(
        encodeSourceRawEnvelope({ document: "existing text" }),
      ),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      expectedType: "rejected",
    },
  ] as const;
  for (const { raw, contentType, expectedType } of fixtures) {
    const input = {
      raw,
      contentType,
      caseNumber: identity.caseNumber,
      sourceDocumentId: identity.documentId,
      court: "Ústavný súd Slovenskej republiky",
      language: "sk",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    } as const satisfies StoredRawReparseInput;
    const before = await reparse(input);
    const fetched = await fetchSkUsListing({
      ...identity,
      read: readWith(async () =>
        Response.json({ documents: [listing], numFound: 1 }),
      ),
    });
    expect(fetched.type).toBe("listing");
    const after = await reparse(input);
    expect(after).toEqual(before);
    expect(after.type).toBe(expectedType);
  }
});

test("publisher rows must match the stored document identity and docket", async () => {
  for (const document of [
    listing,
    { ...listing, documentId: "another-document" },
    { ...listing, mkRSAPNumberOfFile: "I. ÚS 1/2020" },
  ]) {
    const outcome = await fetchSkUsListing({
      ...identity,
      read: readWith(async (_url, init) => {
        expect(new Headers(init.headers).get("User-Agent")).toBe(
          INGESTION_USER_AGENT,
        );
        expect(init.adapterKey).toBe("sk-us");
        expect(init.body).toContain(identity.documentId);
        return Response.json({ documents: [document], numFound: 1 });
      }),
    });
    expect(outcome.type).toBe(
      document === listing ? "listing" : "listing_identity_mismatch",
    );
  }
});

test("documented 204 and valid empty search results are unavailable", async () => {
  for (const response of [
    new Response(null, { status: 204 }),
    Response.json({ documents: [], numFound: 0 }),
  ]) {
    const pauses: number[] = [];
    const outcome = await fetchSkUsListing({
      ...identity,
      read: readWith(async () => response),
      pause: async (delay) => {
        pauses.push(delay);
      },
    });
    expect(outcome.type).toBe("listing_unavailable");
    expect(pauses).toEqual([]);
  }
});

test("5xx back off with jitter then succeed or remain retryable", async () => {
  for (const status of [500, 503]) {
    for (const recovers of [true, false]) {
      let requests = 0;
      const pauses: number[] = [];
      const outcome = await fetchSkUsListing({
        ...identity,
        read: readWith(async () => {
          requests += 1;
          return recovers && requests === 3
            ? Response.json({ documents: [listing], numFound: 1 })
            : new Response(null, { status });
        }),
        pause: async (delay) => {
          pauses.push(delay);
        },
      });
      expect(requests).toBe(3);
      expect(pauses).toHaveLength(2);
      expect(pauses.at(0)).toBeGreaterThanOrEqual(1000);
      expect(pauses.at(0)).toBeLessThan(2000);
      expect(pauses.at(1)).toBeGreaterThanOrEqual(2000);
      expect(pauses.at(1)).toBeLessThan(3000);
      expect(outcome.type).toBe(recovers ? "listing" : "retry_later");
    }
  }
});

test("the first 429 halts the page with no further requests or checkpoint", async () => {
  for (const statuses of [[429], [503, 429]]) {
    let requests = 0;
    let writes = 0;
    let checkpoints = 0;
    const pauses: number[] = [];
    const result = await runSkUsRawPage({
      rows: [cursor, { ...cursor, id: createSafeId<"caseLawDecision">() }],
      mode: "apply",
      complete: async () =>
        await completeSkUsRawObservation({
          ...identity,
          raw: Result.ok(PDF),
          contentType: "application/pdf",
          mode: "apply",
          fetchListing: async () =>
            await fetchSkUsListing({
              ...identity,
              read: readWith(async () => {
                const status = statuses.at(requests);
                requests += 1;
                return status === undefined
                  ? Response.json({ documents: [listing], numFound: 1 })
                  : new Response(null, { status });
              }),
              pause: async (delay) => {
                pauses.push(delay);
              },
            }),
          writeCompletion: async () => {
            writes += 1;
            return "completed";
          },
        }),
      record: () => {},
      journal: async () => {},
      checkpoint: async () => {
        checkpoints += 1;
      },
    });
    expect(requests).toBe(statuses.length);
    expect(pauses).toHaveLength(statuses.length - 1);
    expect(writes).toBe(0);
    expect(checkpoints).toBe(0);
    expect(result.stopped).toBe(true);
    expect(result.cursor).toBeNull();
    expect(result.counts["publisher_rate_limited"]).toBe(1);
  }
});

test("a search 404 or undocumented empty body stops without checkpointing", async () => {
  for (const response of [
    new Response(null, { status: 404 }),
    new Response(""),
  ]) {
    let requests = 0;
    let checkpoints = 0;
    let writes = 0;
    const pauses: number[] = [];
    const result = await runSkUsRawPage({
      rows: [cursor, { ...cursor, id: createSafeId<"caseLawDecision">() }],
      mode: "apply",
      complete: async () =>
        await completeSkUsRawObservation({
          ...identity,
          raw: Result.ok(PDF),
          contentType: "application/pdf",
          mode: "apply",
          fetchListing: async () =>
            await fetchSkUsListing({
              ...identity,
              read: readWith(async () => {
                requests += 1;
                return response;
              }),
              pause: async (delay) => {
                pauses.push(delay);
              },
            }),
          writeCompletion: async () => {
            writes += 1;
            return "completed";
          },
        }),
      record: () => {},
      journal: async () => {},
      checkpoint: async () => {
        checkpoints += 1;
      },
    });
    expect(requests).toBe(1);
    expect(pauses).toEqual([]);
    expect(checkpoints).toBe(0);
    expect(writes).toBe(0);
    expect(result.stopped).toBe(true);
    expect(result.cursor).toBeNull();
    expect(result.counts["listing_unavailable"]).toBe(0);
    expect(result.counts["retry_later"]).toBe(1);
  }
});

test("permanent raw-read failures are journaled terminal rejections, transient failures hold the cursor", async () => {
  for (const permanent of [true, false]) {
    for (const mode of ["apply", "dry-run"] as const) {
      let fetches = 0;
      let writes = 0;
      let visits = 0;
      const audited: unknown[] = [];
      const next = { ...cursor, id: createSafeId<"caseLawDecision">() };
      const result = await runSkUsRawPage({
        rows: [cursor, next],
        mode,
        complete: async (row) => {
          visits += 1;
          if (row.id === next.id) {
            return "already_complete";
          }
          return await completeSkUsRawObservation({
            ...identity,
            contentType: "application/pdf",
            mode,
            raw: Result.err(
              new StoredRawReadError({
                key: "legacy/payload",
                message: "fixture raw read failed",
                permanent,
                cause: null,
              }),
            ),
            fetchListing: async () => {
              fetches += 1;
              return { type: "listing", listing: listingJson };
            },
            writeCompletion: async () => {
              writes += 1;
              return "completed";
            },
          });
        },
        record: () => {},
        journal: async () => {},
        checkpoint: async (row, outcome) => {
          audited.push({ row, outcome });
        },
      });
      expect(fetches).toBe(0);
      expect(writes).toBe(0);
      expect(visits).toBe(permanent ? 2 : 1);
      expect(result.stopped).toBe(!permanent);
      expect(result.cursor).toEqual(permanent ? next : null);
      expect(audited).toEqual(
        permanent && mode === "apply"
          ? [
              { row: cursor, outcome: "raw_read_rejected" },
              { row: next, outcome: "already_complete" },
            ]
          : [],
      );
      expect(
        result.counts[permanent ? "raw_read_rejected" : "retry_later"],
      ).toBe(1);
    }
  }
});

test("completion preserves every old text part and object reference and reaches replay", async () => {
  const parts = {
    document: "<html><body><span>Rozhodnutie.</span></body></html>\r\n",
    file: '{"documents":[]}',
    facets: '{"facetCount":{}}',
    unusual: "\u0000 café\r\n",
  };
  const objects = {
    "document-file": {
      location: "s3:case-law/raw/test/document",
      sha256: "a".repeat(64),
      byteLength: 11,
      contentType: "application/pdf",
    },
  };
  const original = encodeSourceRawEnvelope(parts, objects);
  const prepared = await prepareSkUsRawCompletion({
    raw: encoder.encode(original),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    ...identity,
    fetchListing: async () => ({ type: "listing", listing: listingJson }),
  });
  if (prepared.type !== "prepared") {
    expect.unreachable("fixture must reach completion");
  }
  const completed = completedSkUsRawEnvelope(prepared.completion);
  expect(decodeSourceRawEnvelope(completed)).toEqual({
    ...parts,
    listing: listingJson,
  });
  expect(decodeSourceRawEnvelopeObjects(completed)).toEqual(objects);
  expect(prepared.completion.file).toBeNull();
  const replay = await skUsAdapter.reparseStoredRaw?.({
    raw: encoder.encode(completed),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    caseNumber: identity.caseNumber,
    sourceDocumentId: identity.documentId,
    court: "Ústavný súd Slovenskej republiky",
    language: "sk",
    ecli: null,
    decisionDate: null,
    decisionType: null,
    sourceUrl: null,
    documentUrl: null,
    metadata: {},
  });
  expect(replay?.type).toBe("parsed");
  let refetches = 0;
  const rerun = await prepareSkUsRawCompletion({
    raw: encoder.encode(completed),
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    ...identity,
    fetchListing: async () => {
      refetches += 1;
      return { type: "listing", listing: listingJson };
    },
  });
  expect(rerun.type).toBe("already_complete");
  expect(refetches).toBe(0);
});

test("legacy binary bytes survive storage and the old raw object is never deleted", async () => {
  const fake = startFakeS3();
  try {
    const owner = {
      family: RAW_SOURCE_FAMILY.CASE_LAW,
      sourceId: createSafeId<"caseLawSource">(),
      documentId: cursor.id,
    } as const;
    const window = openRawSourceWriteWindow();
    const oldKey = (
      await writeCaseLawRawPayload({
        owner,
        window,
        data: PDF,
        contentType: "application/pdf",
        storedKey: null,
        storedContentType: null,
      })
    ).unwrap();
    const prepared = await prepareSkUsRawCompletion({
      raw: PDF,
      contentType: "application/pdf",
      ...identity,
      fetchListing: async () => ({ type: "listing", listing: listingJson }),
    });
    if (prepared.type !== "prepared" || prepared.completion.file === null) {
      expect.unreachable("legacy fixture must reach binary storage");
    }
    expect(prepared.completion.file).toEqual(PDF);
    const ref = (
      await writeSourceBinary({
        ...owner,
        bytes: prepared.completion.file,
        contentType: "application/pdf",
        window,
      })
    ).unwrap();
    const data = completedSkUsRawEnvelope({
      ...prepared.completion,
      objects: { "document-file": ref },
    });
    const input = {
      owner,
      window,
      data,
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      storedKey: oldKey,
      storedContentType: "application/pdf",
    };
    const newKey = (await writeCaseLawRawPayload(input)).unwrap();
    expect(newKey).not.toBe(oldKey);
    const stored = (await readStoredRawFromS3(newKey)).unwrap();
    if (stored === null) {
      expect.unreachable(
        "completed payload must be readable through the production raw reader",
      );
    }
    const replayed = await skUsAdapter.reparseStoredRaw?.({
      raw: stored,
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: identity.caseNumber,
      sourceDocumentId: identity.documentId,
      court: "Ústavný súd Slovenskej republiky",
      language: "sk",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    });
    expect(replayed?.type).toBe("parsed");
    expect(
      [...fake.objects.entries()].find(([key]) => key.endsWith(oldKey))?.at(1),
    ).toEqual({ bytes: PDF, contentType: "application/pdf" });
    await writeCaseLawRawPayload(input);
    expect(Math.max(...fake.versions.values())).toBe(1);
    expect(fake.requests.some(({ method }) => method === "DELETE")).toBe(false);
    expect([...fake.versions.keys()].some((key) => key.includes(oldKey))).toBe(
      true,
    );
  } finally {
    fake.stop();
  }
});

test("dry runs and transient failures never persist a checkpoint", async () => {
  for (const mode of ["dry-run", "apply"] as const) {
    const persisted: unknown[] = [];
    const result = await runSkUsRawPage({
      rows: [cursor],
      mode,
      complete: async () =>
        mode === "dry-run" ? "would_complete" : "retry_later",
      record: () => {},
      journal: async () => {},
      checkpoint: async (value) => {
        persisted.push(value);
      },
    });
    expect(persisted).toEqual([]);
    expect(result.stopped).toBe(mode === "apply");
  }
});

test("a dry run of a repairable legacy payload reaches no writer", async () => {
  let writes = 0;
  const outcome = await completeSkUsRawObservation({
    raw: Result.ok(PDF),
    contentType: "application/pdf",
    ...identity,
    mode: "dry-run",
    fetchListing: async () => ({ type: "listing", listing: listingJson }),
    writeCompletion: async () => {
      writes += 1;
      return "completed";
    },
  });
  expect(outcome).toBe("would_complete");
  expect(writes).toBe(0);
});

test("undecodable non-PDF bytes are a checkpointed terminal outcome, not a retry", async () => {
  for (const contentType of [null, SOURCE_RAW_ENVELOPE_CONTENT_TYPE]) {
    let fetches = 0;
    let writes = 0;
    const outcome = await completeSkUsRawObservation({
      raw: Result.ok(PDF),
      contentType,
      ...identity,
      mode: "apply",
      fetchListing: async () => {
        fetches += 1;
        return { type: "listing", listing: listingJson };
      },
      writeCompletion: async () => {
        writes += 1;
        return "completed";
      },
    });
    expect(outcome).toBe("raw_unavailable");
    expect(fetches).toBe(0);
    expect(writes).toBe(0);
  }
  const persisted: unknown[] = [];
  const next = { ...cursor, id: createSafeId<"caseLawDecision">() };
  const result = await runSkUsRawPage({
    rows: [cursor, next],
    mode: "apply",
    complete: async (row) => (row === cursor ? "raw_unavailable" : "completed"),
    record: () => {},
    journal: async () => {},
    checkpoint: async (row, outcome) => {
      persisted.push([row, outcome]);
    },
  });
  expect(result.stopped).toBe(false);
  expect(result.cursor).toBe(next);
  expect(persisted).toEqual([
    [cursor, "raw_unavailable"],
    [next, "completed"],
  ]);
});

test("a crash between fetch and write retries the item, while a crash after write never refetches it", async () => {
  for (const crashAt of ["before_write", "after_write"] as const) {
    let stored = encoder.encode(
      encodeSourceRawEnvelope({ document: "publisher text" }),
    );
    let fetches = 0;
    let writes = 0;
    let checkpointed = false;
    let crashing = true;
    const complete = async () => {
      const prepared = await prepareSkUsRawCompletion({
        raw: stored,
        contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
        ...identity,
        fetchListing: async () => {
          fetches += 1;
          return { type: "listing", listing: listingJson };
        },
      });
      if (prepared.type !== "prepared") {
        return prepared.type;
      }
      if (crashing && crashAt === "before_write") {
        throw new AdapterFetchError({
          message: "simulated crash before write",
          adapterKey: "sk-us",
          cursor: null,
        });
      }
      stored = encoder.encode(completedSkUsRawEnvelope(prepared.completion));
      writes += 1;
      return "completed" as const;
    };
    const run = async () =>
      await runSkUsRawPage({
        rows: [cursor],
        mode: "apply",
        complete,
        record: () => {},
        journal: async () => {},
        checkpoint: async () => {
          if (crashing) {
            throw new AdapterFetchError({
              message: "simulated crash before checkpoint",
              adapterKey: "sk-us",
              cursor: null,
            });
          }
          checkpointed = true;
        },
      });
    const crashed = await Result.tryPromise({
      try: run,
      catch: (error) => error,
    });
    expect(Result.isError(crashed)).toBe(true);
    expect(checkpointed).toBe(false);
    crashing = false;
    const resumed = await run();
    expect(resumed.stopped).toBe(false);
    expect(checkpointed).toBe(true);
    expect(writes).toBe(1);
    expect(fetches).toBe(crashAt === "before_write" ? 2 : 1);
  }
});

test("a concurrent pointer writer holds the checkpoint for a fresh read", async () => {
  let checkpoints = 0;
  const result = await runSkUsRawPage({
    rows: [cursor],
    mode: "apply",
    complete: async () => "concurrent_write",
    record: () => {},
    journal: async () => {},
    checkpoint: async () => {
      checkpoints += 1;
    },
  });
  expect(result.stopped).toBe(true);
  expect(result.cursor).toBeNull();
  expect(checkpoints).toBe(0);
});

test("deterministic invalid payloads advance past poison rows in both modes", async () => {
  const payloads = [
    new Uint8Array([0xff]),
    new Uint8Array([0xc0, 0xaf]),
    new Uint8Array([0xe2, 0x82]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    encoder.encode(""),
    encoder.encode("plain publisher text"),
    encoder.encode("{broken JSON"),
    encoder.encode(JSON.stringify({ unknown: "shape" })),
  ];
  for (const mode of ["apply", "dry-run"] as const) {
    for (const contentType of [
      null,
      "application/json",
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    ]) {
      const rows = payloads.map(() => ({
        ...cursor,
        id: createSafeId<"caseLawDecision">(),
      }));
      const next = { ...cursor, id: createSafeId<"caseLawDecision">() };
      const visited: string[] = [];
      const persisted: unknown[] = [];
      let fetches = 0;
      let writes = 0;
      const result = await runSkUsRawBatch({
        rows: [...rows, next],
        pageSize: 3,
        after: null,
        mode,
        complete: async (row) => {
          visited.push(row.id);
          const index = rows.findIndex(({ id }) => id === row.id);
          if (index === -1) {
            return "already_complete";
          }
          const raw = payloads.at(index);
          if (raw === undefined) {
            expect.unreachable("poison row must have bytes");
          }
          return await completeSkUsRawObservation({
            ...identity,
            raw: Result.ok(raw),
            contentType,
            mode,
            fetchListing: async () => {
              fetches += 1;
              return { type: "listing", listing: listingJson };
            },
            writeCompletion: async () => {
              writes += 1;
              return "completed";
            },
          });
        },
        record: () => {},
        journal: async () => {},
        checkpoint: async (row, outcome) => {
          persisted.push([row, outcome]);
        },
      });
      expect(result.stopped).toBe(false);
      expect(result.cursor).toEqual(next);
      expect(result.scanned).toBe(rows.length + 1);
      expect(result.counts["raw_unavailable"]).toBe(rows.length);
      expect(visited).toEqual([...rows, next].map(({ id }) => id));
      expect(persisted).toEqual(
        mode === "apply"
          ? [
              ...rows.map((row) => [row, "raw_unavailable"]),
              [next, "already_complete"],
            ]
          : [],
      );
      expect(fetches).toBe(0);
      expect(writes).toBe(0);
    }
  }
});

test("bounded batch results are invariant under page size and stop before later pages", async () => {
  await assertProperty(
    "bounded batch results are invariant under page size and stop before later pages",
    fc.asyncProperty(
      fc.record({
        rowCount: fc.integer({ min: 0, max: 30 }),
        limit: fc.integer({ min: 1, max: 200 }),
        pageSize: fc.integer({ min: 1, max: 200 }),
        failureIndex: fc.integer({ min: 0, max: 30 }),
        failure: fc.constantFrom(
          "retry_later",
          "concurrent_write",
          "publisher_rate_limited",
        ),
        mode: fc.constantFrom("apply", "dry-run"),
      }),
      async ({ rowCount, limit, pageSize, failureIndex, failure, mode }) => {
        const rows = Array.from({ length: rowCount }, () => ({
          ...cursor,
          id: createSafeId<"caseLawDecision">(),
        })).slice(0, limit);
        const previous = { ...cursor, id: createSafeId<"caseLawDecision">() };
        const visited: string[] = [];
        const persisted: string[] = [];
        const journaled: string[] = [];
        const recorded: [string, string][] = [];
        const evidence: string[] = [];
        const result = await runSkUsRawBatch({
          rows,
          pageSize,
          after: previous,
          mode,
          complete: async (row, operation) => {
            expect(operation).toBe(mode);
            visited.push(row.id);
            return row.id === rows.at(failureIndex)?.id
              ? failure
              : "already_complete";
          },
          record: (row, outcome) => {
            recorded.push([row.id, outcome]);
            evidence.push(`record:${row.id}`);
          },
          journal: async (row) => {
            journaled.push(row.id);
            evidence.push(`journal:${row.id}`);
          },
          checkpoint: async (row) => {
            persisted.push(row.id);
          },
        });
        const terminalCount = Math.min(failureIndex, rows.length);
        const stopped = failureIndex < rows.length;
        const terminalIds = rows.slice(0, terminalCount).map(({ id }) => id);
        expect(visited).toEqual(
          rows.slice(0, terminalCount + (stopped ? 1 : 0)).map(({ id }) => id),
        );
        expect(persisted).toEqual(mode === "apply" ? terminalIds : []);
        expect(journaled).toEqual(mode === "apply" ? visited : []);
        // Every attempted row leaves exactly one record, the stopping row
        // included, and in apply mode the record precedes its journal line.
        expect(recorded).toEqual(
          visited.map((id) => [
            id,
            id === rows.at(failureIndex)?.id ? failure : "already_complete",
          ]),
        );
        expect(evidence).toEqual(
          visited.flatMap((id) =>
            mode === "apply"
              ? [`record:${id}`, `journal:${id}`]
              : [`record:${id}`],
          ),
        );
        expect(result.stopped).toBe(stopped);
        expect(result.scanned).toBe(visited.length);
        expect(result.scanned).toBeLessThanOrEqual(limit);
        expect(
          Object.values(result.counts).reduce(
            (total, count) => total + count,
            0,
          ),
        ).toBe(visited.length);
        expect(result.counts["already_complete"] ?? 0).toBe(terminalCount);
        expect(result.counts[failure] ?? 0).toBe(stopped ? 1 : 0);
        expect(result.cursor).toEqual(
          terminalCount === 0 ? previous : rowAt(rows, terminalCount - 1),
        );
      },
    ),
    { numRuns: 60, seed: 4377 },
  );
});
