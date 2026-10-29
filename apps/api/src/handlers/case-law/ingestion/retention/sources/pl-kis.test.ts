import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  assemblePlKisDecision,
  PL_KIS_INCLUDED_CATEGORIES,
  plKisRawPartsOf,
  readPlKisListing,
} from "@/api/handlers/case-law/ingestion/adapters/pl-kis";
import { RETENTION_TEXT_ABSENCE } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { plKisRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-kis";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

const FIXTURES_DIR = new URL("../../adapters/__fixtures__/", import.meta.url);

const listingRow = async (tag: string): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(
    await Bun.file(new URL(`pl-kis-listing-${tag}.json`, FIXTURES_DIR)).text(),
  );
  return readPlKisListing(parsed)?.rows[0] ?? panic(`${tag}: no captured row`);
};

const detailText = async (tag: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(
        await Bun.file(
          new URL(`pl-kis-detail-${tag}.json.gz`, FIXTURES_DIR),
        ).arrayBuffer(),
      ),
    ),
  );

const built = async (
  row: Record<string, unknown>,
  detail: string,
  pdfBytes?: Uint8Array,
): Promise<IngestionResult> => {
  const result = await assemblePlKisDecision({
    row,
    rawParts: plKisRawPartsOf(row, detail),
    ...(pdfBytes === undefined ? {} : { pdfBytes }),
  });
  return result.type === "built"
    ? result.decision
    : panic("the captured payloads did not build");
};

const project = async (sourceRaw: string) =>
  plKisRetention.type === "checked"
    ? await plKisRetention.project(sourceRaw)
    : panic("pl-kis is a checked source");

// The adapter's tests capture one document per included category, except the
// jurisdiction-dispute category the service lists nothing under.
const CAPTURED = PL_KIS_INCLUDED_CATEGORIES.filter(
  ({ slug }) => slug !== "19-spor",
).map(({ slug }) => slug);

describe("pl-kis retention projection", () => {
  test.each(CAPTURED)("%s keeps the document's HTML text", async (slug) => {
    const decision = await built(
      await listingRow(slug),
      await detailText(slug),
    );
    const ast = decision.documentAst;
    const projection = await project(
      decision.sourceRaw ?? panic("no sourceRaw"),
    );
    if (projection.type !== "source" || !("blocks" in ast)) {
      panic(`unexpected projection ${projection.type}`);
    }
    const result = validateAst(
      projection.source,
      ast.blocks,
      projection.options,
    );
    console.info(
      `pl-kis ${slug}: retainedPct=${result.stats.retainedPct.toFixed(1)} missingWords=${String(result.stats.missingWords.length)}`,
    );
    expect(result.ok).toBe(true);
  });

  test("a document read from its PDF names the separate document", async () => {
    const slug = "05-objas";
    const parsed: unknown = JSON.parse(await detailText(slug));
    const document = isRecord(parsed) ? parsed["dokument"] : undefined;
    const fields = isRecord(document) ? document["fields"] : [];
    const withoutHtml = {
      ...(isRecord(parsed) ? parsed : {}),
      dokument: {
        fields: Array.isArray(fields)
          ? fields.filter(
              (field: unknown) =>
                !isRecord(field) || field["key"] !== "TRESC_INTERESARIUSZ",
            )
          : [],
      },
    };
    const pdfBytes = new Uint8Array(
      await Bun.file(
        new URL("pl-kis-document-05-objas.pdf", FIXTURES_DIR),
      ).arrayBuffer(),
    );
    const decision = await built(
      await listingRow(slug),
      JSON.stringify(withoutHtml),
      pdfBytes,
    );
    expect("blocks" in decision.documentAst).toBe(true);
    expect(await project(decision.sourceRaw ?? panic("no sourceRaw"))).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.SEPARATE_DOCUMENT,
    });
  });

  test("a plain-text field is read as its blank-line paragraphs", async () => {
    const projection = await project(
      encodeSourceRawEnvelope({
        listing: "{}",
        detail: JSON.stringify({
          dokument: {
            fields: [
              { key: "TRESC_INTERESARIUSZ", value: "Pierwszy.\n\nDrugi." },
            ],
          },
        }),
      }),
    );
    expect(projection).toEqual({
      type: "source",
      source: { type: "paragraphs", paragraphs: ["Pierwszy.", "Drugi."] },
    });
  });

  test("an envelope without a detail states no publisher text", async () => {
    expect(await project(encodeSourceRawEnvelope({ listing: "{}" }))).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a raw that is not the adapter's envelope is unreadable", async () => {
    expect((await project("<html></html>")).type).toBe("unreadable");
    expect(
      (await project(encodeSourceRawEnvelope({ listing: "{}", detail: "{" })))
        .type,
    ).toBe("unreadable");
  });
});
