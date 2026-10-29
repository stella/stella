import { panic } from "better-result";
import { expect, test } from "bun:test";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { sourceRetentionForAdapter } from "@/api/handlers/case-law/ingestion/retention/retention-sources";
import { ukFclRetention } from "@/api/handlers/case-law/ingestion/retention/sources/uk-fcl";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { ukFclFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { buildCaseLawFixture } from "@/api/tests/helpers/case-law-parity";

const project = async (sourceRaw: string) => {
  if (ukFclRetention.type !== "checked") {
    return panic("LegalDocML must have a retention projection");
  }
  return await ukFclRetention.project(sourceRaw);
};

test("stored LegalDocML is measured independently, and missing judgment text fails", async () => {
  expect(sourceRetentionForAdapter(ADAPTER_KEYS.UK_FCL).policy).toBe(
    ukFclRetention,
  );
  const decision = await buildCaseLawFixture(ukFclFixture());
  if (!hasUsableAst(decision.documentAst) || decision.sourceRaw === undefined) {
    return panic("the fixture must have parsed blocks and stored raw");
  }
  const projection = await project(decision.sourceRaw);
  if (projection.type !== "source") {
    return panic("the fixture must have publisher text");
  }
  expect(validateAst(projection.source, decision.documentAst.blocks).ok).toBe(
    true,
  );
  const withoutBody = decision.documentAst.blocks.filter(
    (block) => block.type !== "image" && block.role === "front-matter",
  );
  expect(withoutBody.length).toBeLessThan(decision.documentAst.blocks.length);
  expect(validateAst(projection.source, withoutBody).ok).toBe(false);
});

test("projection keeps bare and unfamiliar units under namespace prefixes", async () => {
  const projection = await project(
    encodeSourceRawEnvelope({
      document:
        '<a:akomaNtoso xmlns:a="http://docs.oasis-open.org/legaldocml/ns/akn/3.0"><a:judgment><a:meta><a:p>metadata</a:p></a:meta><a:header><a:p>A<b>mber</b></a:p></a:header><a:judgmentBody><a:unknown>Bare <a:b>body</a:b></a:unknown><a:p>Closing</a:p></a:judgmentBody></a:judgment></a:akomaNtoso>',
    }),
  );
  expect(projection).toEqual({
    type: "source",
    source: {
      type: "paragraphs",
      paragraphs: ["Amber", "Bare body", "Closing"],
    },
  });
});

test("unreadable envelopes, missing documents, and invalid XML cannot pass unchecked", async () => {
  for (const raw of [
    "not an envelope",
    encodeSourceRawEnvelope({ listing: "listing" }),
    encodeSourceRawEnvelope({ document: "<broken>" }),
    encodeSourceRawEnvelope({ document: "<other/>" }),
  ]) {
    expect((await project(raw)).type).toBe("unreadable");
  }
});
