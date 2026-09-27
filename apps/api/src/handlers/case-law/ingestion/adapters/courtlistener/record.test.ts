import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  admitCourtListenerRecord,
  COURTLISTENER_RECORD_LIMITS,
} from "./record";
import type { CourtListenerRecordRejectedError } from "./rejection";
import {
  citationRow,
  clusterRow,
  courtListenerRecord,
  docketRow,
  opinionRow,
  personRow,
} from "./test-records";

/** Everything a rejection carries, as a log line or ledger row would. */
const serialized = (rejection: CourtListenerRecordRejectedError): string =>
  JSON.stringify({
    message: rejection.message,
    reason: rejection.reason,
    sourceRecordKey: rejection.sourceRecordKey,
    clusterId: rejection.clusterId,
    diagnostics: rejection.diagnostics,
    omittedDiagnostics: rejection.omittedDiagnostics,
    opinionIds: rejection.opinionIds,
  });

const rejectionOf = (input: unknown) => {
  const admitted = admitCourtListenerRecord(input);
  if (Result.isOk(admitted)) {
    throw new Error("expected the record to be rejected");
  }
  return admitted.error;
};

describe("admitting a CourtListener record", () => {
  test("admits a complete record and keeps its rows' original spelling", () => {
    const record = courtListenerRecord();
    const admitted = admitCourtListenerRecord(record);

    expect(Result.isOk(admitted)).toBe(true);
    const value = admitted.unwrap();
    expect(value.clusterId).toBe("9114912");
    expect(value.sourceRecordKey).toBe("cluster:9114912");
    expect(value.record.cluster).toEqual(record.cluster);
    expect(value.opinions.map(({ type }) => type)).toEqual(["020lead"]);
    expect(value.judgeRelations).toBeNull();
  });

  test("a missing or new publisher column is schema drift naming the column", () => {
    const { headmatter: _dropped, ...missing } = clusterRow();
    const extra = { ...opinionRow(), ordering_key: "1" };

    const missingColumn = rejectionOf({
      ...courtListenerRecord(),
      cluster: missing,
    });
    const newColumn = rejectionOf({
      ...courtListenerRecord(),
      opinions: [extra],
    });

    expect(missingColumn.reason).toBe("schema-drift");
    expect(missingColumn.diagnostics).toContainEqual({
      path: "cluster.headmatter",
      detail: "missing column",
    });
    expect(newColumn.reason).toBe("schema-drift");
    expect(newColumn.diagnostics).toEqual([
      {
        path: "opinions.0",
        detail: expect.stringMatching(
          /^1 unexpected key\(s\), sha256:[0-9a-f]{16}$/u,
        ),
      },
    ]);
  });

  test("an undeclared opinion or citation type is schema drift, not a default", () => {
    expect(
      rejectionOf(
        courtListenerRecord({ opinions: [opinionRow({ type: "110newtype" })] }),
      ).reason,
    ).toBe("schema-drift");
    expect(
      rejectionOf(
        courtListenerRecord({ citations: [citationRow({ type: "10" })] }),
      ).reason,
    ).toBe("schema-drift");
  });

  test.each([
    ["an ID with a leading zero", { cluster: clusterRow({ id: "09114912" }) }],
    [
      "a boolean spelled out",
      { opinions: [opinionRow({ per_curiam: "false" })] },
    ],
    [
      "a nullable number that is not decimal",
      { cluster: clusterRow({ scdb_votes_majority: "five" }) },
    ],
    ["a duplicate opinion row", { opinions: [opinionRow(), opinionRow()] }],
    ["a duplicate citation row", { citations: [citationRow(), citationRow()] }],
  ])("%s is an invalid record", (_name, parts) => {
    expect(rejectionOf(courtListenerRecord(parts)).reason).toBe(
      "invalid-record",
    );
  });

  test("an outer contract key the loader does not declare is an invalid record", () => {
    expect(
      rejectionOf({ ...courtListenerRecord(), fetchedAt: "2026-09-26" }).reason,
    ).toBe("invalid-record");
    expect(rejectionOf({ ...courtListenerRecord(), version: 2 }).reason).toBe(
      "invalid-record",
    );
  });

  test.each([
    ["a cluster naming another docket", { docket: docketRow({ id: "1" }) }],
    [
      "a docket naming another court",
      { docket: docketRow({ court_id: "ca9" }) },
    ],
    [
      "an opinion of another cluster",
      { opinions: [opinionRow({ cluster_id: "1" })] },
    ],
    [
      "a citation of another cluster",
      { citations: [citationRow({ cluster_id: "1" })] },
    ],
    ["no opinion rows", { opinions: [] }],
  ])("%s is an incomplete cluster", (_name, parts) => {
    expect(rejectionOf(courtListenerRecord(parts)).reason).toBe(
      "incomplete-cluster",
    );
  });

  test("the opinion rows must be exactly the membership the loader counted", () => {
    const record = courtListenerRecord();
    const missing = {
      ...record,
      provenance: {
        ...record.provenance,
        expectedOpinionIds: ["9109419", "9109420"],
      },
    };
    const unexpected = {
      ...record,
      provenance: { ...record.provenance, expectedOpinionIds: [] },
    };

    expect(rejectionOf(missing).reason).toBe("incomplete-cluster");
    expect(rejectionOf(unexpected).reason).toBe("incomplete-cluster");
  });

  test("a complete judge relation must name every author and joiner and only this cluster's opinions", () => {
    const people = [personRow()];
    const authorMissing = courtListenerRecord({
      opinions: [opinionRow({ author_id: "999" })],
      judgeRelations: { status: "complete", people, joinedBy: [] },
    });
    const joinerMissing = courtListenerRecord({
      judgeRelations: {
        status: "complete",
        people,
        joinedBy: [{ opinionId: "9109419", personId: "999" }],
      },
    });
    const foreignOpinion = courtListenerRecord({
      judgeRelations: {
        status: "complete",
        people,
        joinedBy: [{ opinionId: "1", personId: "3045" }],
      },
    });

    expect(rejectionOf(authorMissing).reason).toBe("incomplete-cluster");
    expect(rejectionOf(joinerMissing).reason).toBe("incomplete-cluster");
    expect(rejectionOf(foreignOpinion).reason).toBe("incomplete-cluster");
  });

  test("an unavailable relation is kept apart from a complete empty one", () => {
    const unavailable = admitCourtListenerRecord(
      courtListenerRecord(),
    ).unwrap();
    const empty = admitCourtListenerRecord(
      courtListenerRecord({
        judgeRelations: { status: "complete", people: [], joinedBy: [] },
      }),
    ).unwrap();

    expect(unavailable.judgeRelations).toBeNull();
    expect(empty.judgeRelations).toEqual({ people: new Map(), joinedBy: [] });
  });

  test("a record past a named limit is rejected whole, never truncated", () => {
    const opinions = Array.from(
      { length: COURTLISTENER_RECORD_LIMITS.OPINIONS + 1 },
      (_, index) => opinionRow({ id: String(1000 + index) }),
    );
    const citations = Array.from(
      { length: COURTLISTENER_RECORD_LIMITS.CITATIONS + 1 },
      (_, index) => citationRow({ id: String(1000 + index) }),
    );
    const oversized = courtListenerRecord({
      opinions: [
        opinionRow({
          plain_text: "x".repeat(COURTLISTENER_RECORD_LIMITS.RECORD_BYTES),
        }),
      ],
    });

    for (const input of [
      courtListenerRecord({ opinions }),
      courtListenerRecord({ citations }),
      oversized,
    ]) {
      const rejection = rejectionOf(input);
      expect(rejection.reason).toBe("over-limit");
      expect(rejection.clusterId).toBe("9114912");
    }
    const atLimit = courtListenerRecord({
      opinions: opinions.slice(0, COURTLISTENER_RECORD_LIMITS.OPINIONS),
    });
    expect(Result.isOk(admitCourtListenerRecord(atLimit))).toBe(true);
  });

  test("rejections never carry publisher text, not even an unexpected key's name", () => {
    const marker = "PRIVILEGED-BODY-TEXT";
    const record = courtListenerRecord();
    const inputs = [
      { ...record, [marker]: marker },
      { ...record, provenance: { ...record.provenance, [marker]: marker } },
      {
        ...record,
        provenance: {
          ...record.provenance,
          artifacts: [{ table: "t", url: "u", etag: "e", [marker]: marker }],
        },
      },
      {
        ...record,
        judgeRelations: { status: "unavailable", [marker]: marker },
      },
      {
        ...record,
        judgeRelations: {
          status: "complete",
          people: [],
          joinedBy: [{ opinionId: "1", personId: "2", [marker]: marker }],
        },
      },
      courtListenerRecord({ opinions: [opinionRow({ id: marker })] }),
      courtListenerRecord({
        opinions: [opinionRow({ per_curiam: marker, plain_text: marker })],
      }),
      courtListenerRecord({ opinions: [opinionRow({ type: marker })] }),
      {
        ...courtListenerRecord(),
        cluster: { ...clusterRow({ syllabus: marker }), [marker]: marker },
      },
      {
        ...courtListenerRecord(),
        provenance: {
          ...courtListenerRecord().provenance,
          citationCoverage: marker,
        },
      },
      { ...courtListenerRecord(), judgeRelations: { status: marker } },
    ];

    for (const input of inputs) {
      expect(serialized(rejectionOf(input))).not.toContain(marker);
    }
  });

  test("an ID past the publisher's key range is rejected before it is read, with a bounded rejection", () => {
    const oversized = "1".repeat(10_000);
    const everywhere = courtListenerRecord({
      cluster: clusterRow({ id: oversized }),
      opinions: [opinionRow({ cluster_id: oversized })],
      citations: [citationRow({ cluster_id: oversized })],
    });
    const joinder = courtListenerRecord({
      judgeRelations: {
        status: "complete",
        people: [],
        joinedBy: [{ opinionId: oversized, personId: "1" }],
      },
    });
    const membership = {
      ...courtListenerRecord(),
      provenance: {
        ...courtListenerRecord().provenance,
        expectedOpinionIds: Array.from({ length: 64 }, () => oversized),
      },
    };

    const rejection = rejectionOf(everywhere);
    expect(rejection.reason).toBe("invalid-record");
    expect(rejection.clusterId).toBeNull();
    expect(rejection.sourceRecordKey).toMatch(/^input-sha256:[0-9a-f]{64}$/u);
    for (const input of [everywhere, joinder, membership]) {
      const text = serialized(rejectionOf(input));
      expect(text).not.toContain("1".repeat(20));
      expect(text.length).toBeLessThan(16_384);
    }
    expect(
      Result.isOk(
        admitCourtListenerRecord(
          courtListenerRecord({
            cluster: clusterRow({ id: "9223372036854775807" }),
            opinions: [opinionRow({ cluster_id: "9223372036854775807" })],
            citations: [],
          }),
        ),
      ),
    ).toBe(true);
    expect(
      rejectionOf(
        courtListenerRecord({
          cluster: clusterRow({ id: "9223372036854775808" }),
          opinions: [opinionRow({ cluster_id: "9223372036854775808" })],
          citations: [],
        }),
      ).reason,
    ).toBe("invalid-record");
  });

  test("an input without a readable cluster ID is keyed by its digest", () => {
    const rejection = rejectionOf({ cluster: "not a row" });

    expect(rejection.clusterId).toBeNull();
    expect(rejection.sourceRecordKey).toMatch(/^input-sha256:[0-9a-f]{64}$/u);
  });
});
