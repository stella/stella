import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  admitCourtListenerRecord,
  COURTLISTENER_RECORD_LIMITS,
} from "./record";
import {
  citationRow,
  clusterRow,
  courtListenerRecord,
  docketRow,
  opinionRow,
  personRow,
} from "./test-records";

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
    expect(newColumn.diagnostics).toContainEqual({
      path: "opinions.0.ordering_key",
      detail: "unexpected column",
    });
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

  test("rejections never carry publisher text", () => {
    const marker = "PRIVILEGED-BODY-TEXT";
    const inputs = [
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
      const rejection = rejectionOf(input);
      expect(rejection.message).not.toContain(marker);
      expect(
        JSON.stringify(rejection.diagnostics.map(({ detail }) => detail)),
      ).not.toContain(marker);
    }
  });

  test("an input without a readable cluster ID is keyed by its digest", () => {
    const rejection = rejectionOf({ cluster: "not a row" });

    expect(rejection.clusterId).toBeNull();
    expect(rejection.sourceRecordKey).toMatch(/^input-sha256:[0-9a-f]{64}$/u);
  });
});
