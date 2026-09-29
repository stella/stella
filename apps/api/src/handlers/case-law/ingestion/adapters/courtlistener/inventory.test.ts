import { describe, expect, test } from "bun:test";

import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/ingestion-types";

import {
  COURTLISTENER_SOURCE_FIELD_INVENTORY,
  COURTLISTENER_SOURCE_SURFACES,
} from "./inventory";
import { encodeCourtListenerRaw } from "./raw";
import { admitCourtListenerRecord } from "./record";
import {
  CITATION_COLUMNS,
  CLUSTER_COLUMNS,
  COURT_COLUMNS,
  DOCKET_COLUMNS,
  OPINION_COLUMNS,
} from "./snapshot-columns";
import {
  courtListenerRecord,
  personRow,
  recordedClusters,
} from "./test-records";

const storedParts = (input: unknown) =>
  decodeSourceRawEnvelope(
    encodeCourtListenerRaw(admitCourtListenerRecord(input).unwrap().record),
  ) ?? {};

describe("the CourtListener field and surface declarations", () => {
  test("the stored raw states exactly the declared fields", () => {
    const parts = storedParts(
      courtListenerRecord({
        judgeRelations: {
          status: "complete",
          people: [personRow()],
          joinedBy: [{ opinionId: "9109419", personId: "3045" }],
        },
      }),
    );
    const stated = COURTLISTENER_SOURCE_FIELD_INVENTORY.listSourceFields(parts);

    expect(stated.toSorted()).toEqual(
      Object.keys(COURTLISTENER_SOURCE_FIELD_INVENTORY.fields).toSorted(),
    );
  });

  test("every stored surface is a part of the envelope", () => {
    const parts = storedParts(courtListenerRecord());
    const declared = Object.values(COURTLISTENER_SOURCE_SURFACES.surfaces)
      .flatMap((surface) =>
        surface.disposition === "stored" ? [surface.part] : [],
      )
      .toSorted();

    expect(declared).toEqual(
      Object.keys(parts)
        .filter((part) => part !== "cl-contract")
        .toSorted(),
    );
  });

  test("the declared columns are the recorded snapshot rows' own, in header order", () => {
    const clusters = recordedClusters();

    expect(clusters.length).toBeGreaterThan(0);
    for (const record of clusters) {
      expect(Object.keys(record.cluster)).toEqual(CLUSTER_COLUMNS);
      expect(Object.keys(record.docket)).toEqual(DOCKET_COLUMNS);
      expect(Object.keys(record.court)).toEqual(COURT_COLUMNS);
      for (const opinion of record.opinions) {
        expect(Object.keys(opinion)).toEqual(OPINION_COLUMNS);
      }
      for (const citation of record.citations) {
        expect(Object.keys(citation)).toEqual(CITATION_COLUMNS);
      }
    }
  });
});
