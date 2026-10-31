import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { type Block, hasUsableAst } from "@stll/legal-ast/document-ast";

import { courtListenerConformanceFixture } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/conformance-fixture";
import { mapCourtListenerRecord } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/map";
import {
  citationRow,
  clusterRow,
  courtListenerRecord,
  courtRow,
  docketRow,
  opinionRow,
  recordedClusters,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";
import { sourceRetentionForAdapter } from "@/api/handlers/case-law/ingestion/retention/retention-sources";
import { usCourtlistenerRetention } from "@/api/handlers/case-law/ingestion/retention/sources/us-courtlistener";
import { IMPORT_SOURCE_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const project = async (sourceRaw: string) => {
  if (usCourtlistenerRetention.type !== "checked") {
    throw new Error("CourtListener decisions are checked");
  }
  return await usCourtlistenerRetention.project(sourceRaw);
};

const retention = async (decision: IngestionResult, blocks?: Block[]) => {
  const ast = decision.documentAst;
  expect(hasUsableAst(ast)).toBe(true);
  const projection = await project(decision.sourceRaw ?? "");
  if (projection.type !== "source") {
    throw new Error(
      `no publisher text projected: ${JSON.stringify(projection)}`,
    );
  }
  // The registry attaches the policy the oracle reads this source with.
  const { sourcePolicy } = sourceRetentionForAdapter(
    IMPORT_SOURCE_KEYS.COURTLISTENER,
  );
  return validateAst(projection.source, blocks ?? ast.blocks, {
    ...projection.options,
    ...(sourcePolicy === undefined ? {} : { sourcePolicy }),
  });
};

const expectRetained = async (decision: IngestionResult) => {
  const result = await retention(decision);
  expect(
    result.ok,
    `retained ${result.stats.retainedPct.toFixed(1)}%, missing ${result.stats.missingWords.join(", ")}`,
  ).toBe(true);
};

const mapped = (record: unknown): IngestionResult =>
  mapCourtListenerRecord(record).unwrap(
    "the fixture record maps to a decision",
  );

/** A row's values as the snapshot's CSV decoder states them: strings. */
const csvValues = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).map(([column, cell]) => [column, String(cell)]),
      )
    : {};

const rowsOf = (value: unknown): readonly unknown[] =>
  isUnknownArray(value) ? value : [];

/**
 * The recorded opinion rows the parser tests read, as whole records: the
 * capture keeps the cluster, docket and court rows without every column, so
 * the test builders fill the rest blank as the decoder would.
 */
const recordedOpinionRecords = () =>
  gunzipSync(
    readFileSync(
      new URL(
        "../../parsers/__fixtures__/courtlistener-opinions-2026-06-30.ndjson.gz",
        import.meta.url,
      ),
    ),
  )
    .toString("utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const captured: unknown = JSON.parse(line);
      const parts = isRecord(captured) ? captured : {};
      const cluster = clusterRow(csvValues(parts["cluster"]));
      return {
        clusterId: cluster.id,
        record: courtListenerRecord({
          cluster,
          docket: docketRow(csvValues(parts["docket"])),
          court: courtRow(csvValues(parts["court"])),
          opinions: rowsOf(parts["opinions"]).map((row) =>
            opinionRow({ xml_harvard: "", ...csvValues(row) }),
          ),
          citations: rowsOf(parts["citations"]).map((row) =>
            citationRow(csvValues(row)),
          ),
        }),
      };
    });

describe("CourtListener retention projection", () => {
  test("the conformance record keeps its publisher text", async () => {
    await expectRetained(
      await courtListenerConformanceFixture().buildDecision(),
    );
  });

  test("the synthetic certiorari denial keeps its publisher text", async () => {
    await expectRetained(mapped(courtListenerRecord()));
  });

  test.each(recordedClusters().map((record) => [record.cluster.id, record]))(
    "recorded cluster %s keeps its publisher text",
    async (_, record) => {
      await expectRetained(mapped(record));
    },
  );

  test.each(
    recordedOpinionRecords().map(({ clusterId, record }) => [
      clusterId,
      record,
    ]),
  )(
    "recorded opinion cluster %s keeps its publisher text",
    async (_, record) => {
      await expectRetained(mapped(record));
    },
  );

  test("reports a document that lost its longest paragraph", async () => {
    const record = recordedClusters().at(1);
    if (record === undefined) {
      throw new Error("the recorded clusters fixture is empty");
    }
    const decision = mapped(record);
    const longest = decision.documentAst.blocks
      .toSorted((left, right) => right.plainText.length - left.plainText.length)
      .at(0);
    const result = await retention(
      decision,
      decision.documentAst.blocks.filter((block) => block !== longest),
    );
    expect(result.ok).toBe(false);
  });

  test("leaves inline pagination out without splitting the word it broke", async () => {
    const projection = await project(
      encodeSourceRawEnvelope({
        "cl-cluster": JSON.stringify(clusterRow()),
        "cl-opinions": JSON.stringify([
          opinionRow({
            xml_harvard:
              '<opinion type="majority"><p>pretexts to investí-<page-number label="963">*963</page-number>gate other crimes</p></opinion>',
          }),
        ]),
      }),
    );
    expect(projection).toMatchObject({
      type: "source",
      source: "<body><p>pretexts to investí-gate other crimes</p></body>",
    });
  });

  test("reads the first text column that holds anything", async () => {
    const projection = await project(
      encodeSourceRawEnvelope({
        "cl-cluster": JSON.stringify(clusterRow()),
        "cl-opinions": JSON.stringify([
          opinionRow({
            xml_harvard: "  ",
            html_with_citations: "<div><p>Affirmed in full.</p></div>",
            plain_text: "Affirmed, in another words.",
          }),
        ]),
      }),
    );
    expect(projection).toMatchObject({
      type: "source",
      source: "<body><p>Affirmed in full.</p></body>",
    });
  });

  /** Every text column empty, so a test states the ones it fills. */
  const BLANK_COLUMNS = {
    xml_harvard: "",
    html_with_citations: "",
    html_lawbox: "",
    html_columbia: "",
    html_anon_2020: "",
    html: "",
    plain_text: "",
  };

  test("passes over a placeholder or undecodable column to the opinion's text", async () => {
    const usable = "The judgment of the district court is affirmed in full.";
    for (const unusable of [
      { xml_harvard: "Unable to extract document content" },
      {
        xml_harvard: "",
        html_with_citations: "<p>Opinion 12345 was never issued.</p>",
      },
      { html: `ÿþ${"�".repeat(40)}ab` },
    ]) {
      const projection = await project(
        encodeSourceRawEnvelope({
          "cl-cluster": JSON.stringify(clusterRow()),
          "cl-opinions": JSON.stringify([
            opinionRow({ ...BLANK_COLUMNS, ...unusable, plain_text: usable }),
          ]),
        }),
      );
      expect(projection).toMatchObject({
        type: "source",
        source: `<body><p>${usable}</p></body>`,
      });
    }
  });

  test("a placeholder-only parse does not pass against a placeholder column", async () => {
    // The parser skips the placeholder and parses plain_text; were the
    // projection to compare against the placeholder, any parse would pass.
    const record = courtListenerRecord({
      opinions: [
        opinionRow({
          ...BLANK_COLUMNS,
          xml_harvard: "Unable to extract document content",
          plain_text:
            "The judgment of the district court is affirmed. The appellant raised no issue the record supports, and the remaining arguments are waived.",
        }),
      ],
    });
    const decision = mapped(record);
    const result = await retention(decision, [
      {
        id: "p1",
        anchorId: "p1",
        type: "paragraph",
        plainText: "Unable to extract document content",
        inlines: [{ type: "text", text: "Unable to extract document content" }],
      },
    ]);
    expect(result.ok).toBe(false);
  });

  test("states why a raw holds no decision text", async () => {
    expect(await project("not an envelope")).toEqual({
      type: "unreadable",
      reason: "unreadable-envelope",
    });
    expect(
      await project(encodeSourceRawEnvelope({ "cl-cluster": "{}" })),
    ).toEqual({
      type: "unreadable",
      reason: "missing-text-part",
    });
    expect(
      await project(
        encodeSourceRawEnvelope({
          "cl-cluster": JSON.stringify(clusterRow()),
          "cl-opinions": JSON.stringify([opinionRow({ xml_harvard: "" })]),
        }),
      ),
    ).toEqual({ type: "no-text", reason: "not-published" });
  });
});
