import { panic } from "better-result";
import { expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { buildCzNsSbirkaDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-ns-sbirka";
import { sourceRetentionForAdapter } from "@/api/handlers/case-law/ingestion/retention/retention-sources";
import { czNsSbirkaRetention } from "@/api/handlers/case-law/ingestion/retention/sources/cz-ns-sbirka";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import {
  CZ_NS_SBIRKA_RECORDINGS,
  czNsSbirkaRecordedPage,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

const project = async (sourceRaw: string) =>
  await czNsSbirkaRetention.project(sourceRaw);

const built = (postId: (typeof CZ_NS_SBIRKA_RECORDINGS)[number]) => {
  const decision = buildCzNsSbirkaDecision({
    postId,
    detailHtml: czNsSbirkaRecordedPage(postId),
  });
  if (
    decision === null ||
    !hasUsableAst(decision.documentAst) ||
    decision.sourceRaw === undefined
  ) {
    return panic(`${postId}: the entry must parse and store its raw`);
  }
  return { decision, sourceRaw: decision.sourceRaw };
};

test("every recorded entry is measured against its stored page", async () => {
  expect(sourceRetentionForAdapter(ADAPTER_KEYS.CZ_NS_SBIRKA).policy).toBe(
    czNsSbirkaRetention,
  );
  for (const postId of CZ_NS_SBIRKA_RECORDINGS) {
    const { decision, sourceRaw } = built(postId);
    const projection = await project(sourceRaw);
    if (projection.type !== "source" || !hasUsableAst(decision.documentAst)) {
      return panic(`${postId}: a parsed entry must have publisher text`);
    }
    expect({
      postId,
      ok: validateAst(projection.source, decision.documentAst.blocks).ok,
    }).toEqual({ postId, ok: true });
  }
});

test("an entry that loses its reasons fails the check", async () => {
  const { decision, sourceRaw } = built("9586");
  const projection = await project(sourceRaw);
  if (projection.type !== "source" || !hasUsableAst(decision.documentAst)) {
    return panic("the Slovak entry must have publisher text");
  }
  expect(
    validateAst(projection.source, decision.documentAst.blocks.slice(0, 2)).ok,
  ).toBe(false);
});

test("the text is the cell, its heading included, and nothing else", async () => {
  const page = (cell: string) =>
    encodeSourceRawEnvelope({
      listing: '{"postId":"1"}',
      detail:
        `<table class="content-table"><tbody>` +
        `<tr><td>Právní věta:</td><td><p>Věta.</p></td></tr>` +
        `<tr><td></td><td><div class="detail-section__table-heading"><span>Sbírkový text rozhodnutí</span></div>${cell}</td></tr>` +
        `</tbody></table>`,
    });
  expect(await project(page("<p>První.</p><p>Druhý.</p>"))).toEqual({
    type: "source",
    source: {
      type: "paragraphs",
      paragraphs: ["Sbírkový text rozhodnutí", "První.", "Druhý."],
    },
  });
  expect(await project(page("<p><em></p>"))).toEqual({
    type: "no-text",
    reason: "not-published",
  });
});

test("a page without a text row, or an unreadable raw, cannot pass unchecked", async () => {
  expect(
    await project(
      encodeSourceRawEnvelope({ listing: "{}", detail: "<html></html>" }),
    ),
  ).toEqual({ type: "no-text", reason: "not-published" });
  for (const raw of [
    "not an envelope",
    encodeSourceRawEnvelope({ listing: "{}" }),
  ]) {
    expect((await project(raw)).type).toBe("unreadable");
  }
});
