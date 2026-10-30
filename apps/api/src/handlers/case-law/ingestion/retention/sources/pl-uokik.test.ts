/**
 * The pl-uokik projection against decisions the adapter builds from the
 * register's captured rows, pages and decision file. The register serves the
 * text only as a PDF stored beside the envelope, so no stored envelope holds
 * text the oracle could measure a document against.
 */
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
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
import { plUokikRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-uokik";
import { readGzipJson } from "@/api/lib/gzip-json";
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
  );
};

describe("pl-uokik retention projection", () => {
  test("a decision read from its PDF states that its text is a separate document", async () => {
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
    expect(await projectionOf(decision)).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
    });
  });

  test("a decision filed without a file answers the same", async () => {
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
    expect(await plUokikRetention.project("%PDF-1.4")).toEqual({
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    });
  });
});
