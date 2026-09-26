import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";

import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";

import {
  COURTLISTENER_RAW_PART,
  courtListenerRawHash,
  decodeCourtListenerRaw,
  encodeCourtListenerRaw,
} from "./raw";
import { admitCourtListenerRecord } from "./record";
import {
  citationRow,
  clusterRow,
  courtListenerRecord,
  opinionRow,
  personRow,
} from "./test-records";

const admitted = (input: unknown) =>
  admitCourtListenerRecord(input).unwrap().record;

const decode = (raw: string) =>
  decodeCourtListenerRaw({
    raw,
    contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });

/** Source text holding every character class the shared sanitizer removes or rewrites. */
const HOSTILE_TEXT = [
  "NUL\u0000",
  "zero​width‌‍⁠",
  "bom﻿",
  "nbsp ",
  "lone\uD800surrogate\uDC00",
  "astral 😀",
  "control\u0007\u001F",
  'quotes " \\ ',
].join("|");

const richRecord = () =>
  courtListenerRecord({
    opinions: [
      opinionRow({
        id: "11",
        plain_text: HOSTILE_TEXT,
        xml_harvard: HOSTILE_TEXT,
      }),
      opinionRow({ id: "12", type: "040dissent", html: "<p>dissent</p>" }),
    ],
    citations: [
      citationRow({ id: "21" }),
      citationRow({ id: "22", volume: "112", reporter: "S. Ct.", page: "422" }),
    ],
    judgeRelations: {
      status: "complete",
      people: [
        personRow({ id: "31" }),
        personRow({ id: "32", name_last: "Blackmun" }),
      ],
      joinedBy: [
        { opinionId: "12", personId: "31" },
        { opinionId: "12", personId: "32" },
      ],
    },
  });

describe("the stored CourtListener raw", () => {
  test("is printable ASCII, so the text sanitizer cannot change it", () => {
    const raw = encodeCourtListenerRaw(admitted(richRecord()));

    expect(HOSTILE_TEXT).not.toBe(stripDangerousChars(HOSTILE_TEXT));
    expect(raw).toMatch(/^[ -~]*$/u);
    expect(stripDangerousChars(raw)).toBe(raw);
  });

  test("decodes to the exact record, NUL, zero-width and unpaired surrogates included", () => {
    const record = admitted(richRecord());
    const decoded = decode(encodeCourtListenerRaw(record)).unwrap();
    const readmitted = admitCourtListenerRecord(decoded).unwrap();

    expect(readmitted.record).toEqual(record);
    expect(readmitted.record.opinions[0]?.plain_text).toBe(HOSTILE_TEXT);
    expect(courtListenerRawHash(readmitted.record)).toBe(
      courtListenerRawHash(record),
    );
  });

  test("its hash ignores row order, key order and provenance", () => {
    const record = richRecord();
    const relations = record.judgeRelations;
    if (relations.status !== "complete") {
      throw new Error("fixture has complete relations");
    }
    const reversedKeys = (row: object): Record<string, unknown> =>
      Object.fromEntries(Object.entries(row).toReversed());
    const permuted = {
      ...record,
      cluster: reversedKeys(record.cluster),
      opinions: record.opinions.toReversed().map(reversedKeys),
      citations: record.citations.toReversed(),
      judgeRelations: {
        ...relations,
        people: relations.people.toReversed(),
        joinedBy: relations.joinedBy.toReversed(),
      },
      provenance: {
        ...record.provenance,
        expectedOpinionIds: record.provenance.expectedOpinionIds.toReversed(),
        artifacts: [
          {
            table: "opinions",
            url: "https://mirror.example/opinions.csv.bz2",
            etag: '"other"',
          },
        ],
      },
    };

    expect(Object.keys(permuted.cluster)).not.toEqual(
      Object.keys(record.cluster),
    );
    expect(courtListenerRawHash(admitted(permuted))).toBe(
      courtListenerRawHash(admitted(record)),
    );
  });

  test.each([
    [
      "alternate text",
      { opinions: [opinionRow({ html_lawbox: "<p>other</p>" })] },
    ],
    [
      "publisher modification time",
      { cluster: clusterRow({ date_modified: "2026-07-01 00:00:00+00" }) },
    ],
    [
      "a citation",
      {
        citations: [
          citationRow(),
          citationRow({ id: "2", reporter: "S. Ct." }),
        ],
      },
    ],
    [
      "judge evidence",
      {
        judgeRelations: {
          status: "complete" as const,
          people: [],
          joinedBy: [],
        },
      },
    ],
  ])("its hash changes with %s", (_name, parts) => {
    expect(courtListenerRawHash(admitted(courtListenerRecord(parts)))).not.toBe(
      courtListenerRawHash(admitted(courtListenerRecord())),
    );
  });

  test.each([
    [
      "a payload under another media type",
      { contentType: "application/json" },
      "wrong-media-type",
    ],
    [
      "a payload that is not an envelope",
      { raw: "<html/>" },
      "not-an-envelope",
    ],
    [
      "an envelope missing a part",
      {
        raw: encodeSourceRawEnvelope({
          [COURTLISTENER_RAW_PART.CLUSTER]: "{}",
        }),
      },
      "missing-part",
    ],
    [
      "an envelope with a foreign part",
      { raw: encodeSourceRawEnvelope({ "PRIVILEGED-PART": "{}" }) },
      "unexpected-part",
    ],
  ])("rejects %s with a typed reason", (_name, override, reason) => {
    const decoded = decodeCourtListenerRaw({
      raw: encodeCourtListenerRaw(admitted(courtListenerRecord())),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      ...override,
    });

    expect(Result.isError(decoded) && decoded.error.reason).toBe(reason);
    expect(JSON.stringify(decoded)).not.toContain("PRIVILEGED");
  });

  test("rejects a contract part of another version", () => {
    const raw = encodeCourtListenerRaw(admitted(courtListenerRecord()));
    const tampered = raw.replace('\\"version\\":1', '\\"version\\":2');

    expect(tampered).not.toBe(raw);
    const decoded = decode(tampered);
    expect(Result.isError(decoded) && decoded.error.reason).toBe(
      "unsupported-version",
    );
  });
});
