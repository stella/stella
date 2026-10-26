import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { assemblePlKioDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import { RETENTION_TEXT_ABSENCE } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { plKioRetention } from "@/api/handlers/case-law/ingestion/retention/sources/pl-kio";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

const FIXTURES_DIR = new URL("../../adapters/__fixtures__/", import.meta.url);

const fixtureText = async (name: string): Promise<string> =>
  await Bun.file(new URL(name, FIXTURES_DIR)).text();

const gzFixtureText = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(await Bun.file(new URL(name, FIXTURES_DIR)).arrayBuffer()),
    ),
  );

const project = async (sourceRaw: string) =>
  plKioRetention.type === "checked"
    ? await plKioRetention.project(sourceRaw)
    : panic("pl-kio is a checked source");

/** The recorded rulings the adapter's tests build from all three pages. */
const RECORDED = [
  {
    id: "30308",
    item: {
      id: "30308",
      signature: "KIO 2845/25|KIO 2846/25",
      issueDate: "01-09-2025",
    },
  },
  { id: "8247", item: { id: "8247" } },
  { id: "13694", item: { id: "13694", signature: "KIO 1090/20" } },
] as const;

describe("pl-kio retention projection", () => {
  test.each(RECORDED.map((recorded) => [recorded.id, recorded] as const))(
    "content %s keeps the ruling's text",
    async (_id, recorded) => {
      const { decision } = assemblePlKioDecision({
        item: recorded.item,
        detailHtml: await fixtureText(`pl-kio-detail-${recorded.id}.html`),
        document: {
          type: "read",
          html: await gzFixtureText(`pl-kio-content-${recorded.id}.html.gz`),
        },
      });
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
        `pl-kio content ${recorded.id}: retainedPct=${result.stats.retainedPct.toFixed(1)} missingWords=${String(result.stats.missingWords.length)}`,
      );
      expect(result.ok).toBe(true);
    },
  );

  test("the projection reads the document's body, not its head", async () => {
    expect(
      await project(
        encodeSourceRawEnvelope({
          listing: "{}",
          document:
            "<html><head><title>untitled</title></head><body><p>Wyrok.</p></body></html>",
        }),
      ),
    ).toEqual({
      type: "source",
      source: { type: "paragraphs", paragraphs: ["Wyrok."] },
    });
  });

  test("a ruling stored without its document states no publisher text", async () => {
    expect(
      await project(
        encodeSourceRawEnvelope({
          listing: "{}",
          "document-rejection": "oversized",
        }),
      ),
    ).toEqual({
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED,
    });
  });

  test("a raw that is not the adapter's envelope is unreadable", async () => {
    expect((await project("<html></html>")).type).toBe("unreadable");
  });
});
