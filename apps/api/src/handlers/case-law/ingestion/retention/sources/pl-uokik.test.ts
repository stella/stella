/**
 * The pl-uokik projection against decisions the adapter builds from the
 * register's captured rows, pages and decision file. The register serves the
 * text as PDFs stored beside the envelope. The projection reads those original
 * bytes independently of the parsed document.
 */
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  assemblePlUokikDecision,
  parsePlUokikDetail,
  PL_UOKIK_FILE_STATUS,
  plUokikRawPartsOf,
} from "@/api/handlers/case-law/ingestion/adapters/pl-uokik";
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { PDF_PROJECTION_MAX_BYTES } from "@/api/handlers/case-law/ingestion/retention/sources/pdf-text";
import { plUokikRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-uokik";
import { readGzipJson } from "@/api/lib/gzip-json";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

const FIXTURES = new URL("../../adapters/__fixtures__/", import.meta.url);
const PDF_FIXTURE = new URL(
  "../../parsers/__fixtures__/pl-uokik-dok-9-2011.pdf",
  import.meta.url,
);

/** DOK-9/2011: a decision PDF and two court rulings on its appeal. */
const WITH_RULINGS = "2520D55B0F17A317C1257EC6007B9773";
/** DIH-4/2009: filed with no attachment. */
const FILELESS = "9C652284E9A4958DC1257EC6007B8BE1";

const entryOf = async (unid: string): Promise<Record<string, unknown>> => {
  const year2011 = await readGzipJson(
    new URL("pl-uokik-view-2011.json.gz", FIXTURES),
  );
  const window2009: unknown = await Bun.file(
    new URL("pl-uokik-view-2009-window.json", FIXTURES),
  ).json();
  const entries = [year2011, window2009].flatMap((listed) => {
    const rows = isRecord(listed) ? listed["viewentry"] : undefined;
    return Array.isArray(rows) ? rows.filter(isRecord) : [];
  });
  return (
    entries.find((entry) => entry["@unid"] === unid) ??
    panic(`the view fixtures lost ${unid}`)
  );
};

const pageOf = async (unid: string): Promise<string> =>
  await Bun.file(
    new URL(`pl-uokik-detail-${unid.toLowerCase()}.html`, FIXTURES),
  ).text();

const projectionOf = async (decision: IngestionResult) => {
  if (plUokikRetention.type !== "checked") {
    return panic("pl-uokik is declared checked");
  }
  return await plUokikRetention.project(
    decision.sourceRaw ?? panic("the decision stored no source raw"),
    { sourceRawObjects: decision.sourceRawObjects ?? {} },
  );
};

describe("pl-uokik retention projection", () => {
  test("a decision read from its PDF is checked against the original file", async () => {
    const page = await pageOf(WITH_RULINGS);
    const name =
      parsePlUokikDetail(page)?.fields.find(({ label }) => label === "Decyzja")
        ?.files[0]?.name ?? panic("the page links no decision file");
    const entry = await entryOf(WITH_RULINGS);
    const built = await assemblePlUokikDecision({
      entry,
      rawParts: plUokikRawPartsOf(entry, page),
      files: [
        {
          name,
          status: PL_UOKIK_FILE_STATUS.READ,
          bytes: new Uint8Array(await Bun.file(PDF_FIXTURE).arrayBuffer()),
        },
      ],
    });
    const decision =
      built.type === "unkeyable" ? panic("unkeyable row") : built.decision;
    // The document the pipeline would check exists, so the answer below is
    // what the check reports for it.
    expect(hasUsableAst(decision.documentAst)).toBe(true);
    const projection = await projectionOf(decision);
    expect(projection.type).toBe("source");
    if (projection.type !== "source" || typeof projection.source === "string") {
      expect.unreachable("The stored PDF has readable text");
    }
    expect(projection.source.paragraphs.join(" ")).toContain("nałożenia");
  });

  test("a decision filed without a file has no sidecar to project", async () => {
    const entry = await entryOf(FILELESS);
    const built = await assemblePlUokikDecision({
      entry,
      rawParts: plUokikRawPartsOf(entry, await pageOf(FILELESS)),
    });
    const decision =
      built.type === "unkeyable" ? panic("unkeyable row") : built.decision;
    expect(await projectionOf(decision)).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
    });
  });

  test("a raw that is not the adapter's envelope is unreadable", async () => {
    if (plUokikRetention.type !== "checked") {
      panic("pl-uokik is declared checked");
    }
    expect(
      await plUokikRetention.project("%PDF-1.4", { sourceRawObjects: {} }),
    ).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    });
  });
});

test("an attachment that is not a readable PDF is unverifiable", async () => {
  if (plUokikRetention.type !== "checked") {
    expect.unreachable();
  }
  expect(
    await plUokikRetention.project(encodeSourceRawEnvelope({ listing: "{}" }), {
      sourceRawObjects: {
        document: {
          bytes: new TextEncoder().encode("not a PDF"),
          contentType: "application/pdf",
        },
      },
    }),
  ).toEqual({
    type: "unreadable",
    reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT,
  });
});

test("all attachments share the PDF projection byte budget", async () => {
  if (plUokikRetention.type !== "checked") {
    expect.unreachable();
  }
  const bytes = new Uint8Array(Math.floor(PDF_PROJECTION_MAX_BYTES / 2) + 1);
  expect(
    await plUokikRetention.project(encodeSourceRawEnvelope({ listing: "{}" }), {
      sourceRawObjects: {
        first: { bytes, contentType: "application/pdf" },
        second: { bytes, contentType: "application/pdf" },
      },
    }),
  ).toEqual({
    type: "no-text",
    reason: RETENTION_TEXT_ABSENCE.OVER_CHECK_BUDGET,
  });
});
