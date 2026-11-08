/**
 * Roles of recorded Polish decisions, read through the one Polish role
 * grammar: the bench signs under its ruling, a signing label leaves a blank
 * for the signature, and the reasons open under their heading however the
 * court spaced it.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";
import { isDocumentAst } from "@stll/legal-ast/document-ast";
import { isPlReasonsHeading } from "@stll/legal-ast/polish-document-roles";

import {
  buildPlDecision,
  normalizeSaosDumpItem,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { assemblePlKioDecision as uncheckedAssemblePlKioDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import { structureFidelityIn } from "@/api/lib/legal-search/parsers/structure-fidelity";
import { isRecord } from "@/api/lib/type-guards";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const assemblePlKioDecision = guardParser(uncheckedAssemblePlKioDecision);

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const fixtureText = async (name: string): Promise<string> => {
  const bytes = await Bun.file(new URL(name, FIXTURES)).bytes();
  return new TextDecoder().decode(
    name.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
  );
};

const blocksOf = (documentAst: unknown): Block[] =>
  isDocumentAst(documentAst)
    ? documentAst.blocks
    : panic("The recorded decision has no document");

/** A SAOS detail response, read as ingestion reads it. */
const saosBlocks = async (id: string): Promise<Block[]> => {
  const payload: unknown = JSON.parse(
    await fixtureText(`pl-courts-detail-${id}.json.gz`),
  );
  const detail =
    isRecord(payload) && isRecord(payload["data"])
      ? payload["data"]
      : panic(`pl-courts-detail-${id} is not a SAOS detail`);
  const decision =
    buildPlDecision({
      listingItem: normalizeSaosDumpItem({ id: detail["id"] }),
      detail: normalizeSaosDumpItem(detail),
      rawParts: {
        "listing-dump": JSON.stringify({ id: detail["id"] }),
        detail: JSON.stringify(payload),
      },
    }) ?? panic(`pl-courts-detail-${id} builds no decision`);
  return blocksOf(decision.documentAst);
};

const kioBlocks = async (id: string): Promise<Block[]> => {
  const built = assemblePlKioDecision({
    item: { id },
    detailHtml: await fixtureText(`pl-kio-detail-${id}.html`),
    document: {
      type: "read",
      html: await fixtureText(`pl-kio-content-${id}.html.gz`),
    },
  });
  return built.type === "built"
    ? blocksOf(built.decision.documentAst)
    : panic(`KIO ${id} did not build: ${built.type}`);
};

const paragraphs = (blocks: readonly Block[]): ParagraphBlock[] =>
  blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");

const withRole = (
  blocks: readonly Block[],
  role: ParagraphBlock["role"],
): string[] =>
  paragraphs(blocks)
    .filter((block) => block.role === role)
    .map((block) => block.plainText);

/** The decision read by the role rules every source is held to. */
const roleFindings = (blocks: readonly Block[]): string[] =>
  structureFidelityIn(blocks, "pl")
    .filter(
      ({ rule }) =>
        rule === "signature-as-holding" ||
        rule === "holding-after-reasons" ||
        rule === "holding-after-signature",
    )
    .map(({ rule, anchorId }) => `${rule} ${anchorId}`);

describe("Polish decisions sign under their ruling", () => {
  test("I C 707/23: the judge's line under the ruling points signs it", async () => {
    const blocks = await saosBlocks("554032");

    expect(withRole(blocks, "holding")).toHaveLength(3);
    expect(withRole(blocks, "holding").at(-1)).toStartWith(
      "3. nakazuje pobrać od pozwanego",
    );
    expect(withRole(blocks, "signature")).toEqual([
      "SSO Katarzyna Banko",
      "SSO Katarzyna Banko",
    ]);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("KIO 1675/10: the chamber's label and its blank sign, and the spaced reasons heading opens the reasons", async () => {
    const blocks = await saosBlocks("116508");
    // The court prints the heading spaced out (`U z a s a d n i e n i e`).
    const reasons = blocks.findIndex(
      (block) =>
        block.type === "heading" && isPlReasonsHeading(block.plainText),
    );

    expect(blocks[reasons]).toMatchObject({
      type: "heading",
      role: "section-heading",
      plainText: "Uzasadnienie",
    });
    expect(withRole(blocks, "signature")).toEqual([
      "Skład orzekający Izby:",
      "………………………………",
      "Skład orzekający Izby:",
      "……………………………",
    ]);
    const afterReasons = paragraphs(blocks.slice(reasons + 1));
    expect(afterReasons.filter((block) => block.role === "holding")).toEqual(
      [],
    );
    expect(
      afterReasons.filter((block) => block.role === "argumentation"),
    ).toHaveLength(afterReasons.length - 2);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("KIO 1090/20: the reasons under a spaced heading are argued, and the presiding member signs", async () => {
    const blocks = await kioBlocks("13694");
    const reasons = blocks.findIndex(
      (block) =>
        block.type === "heading" && isPlReasonsHeading(block.plainText),
    );

    // The court prints the heading spaced out (`U z a s a d n i e n i e`).
    expect(blocks[reasons]?.plainText).toBe("Uzasadnienie");
    expect(withRole(blocks.slice(0, reasons), "signature")).toEqual([
      "Przewodniczący:    .............................",
    ]);
    expect(withRole(blocks.slice(reasons + 1), "holding")).toEqual([]);
    expect(
      withRole(blocks.slice(reasons + 1), "argumentation").length,
    ).toBeGreaterThan(80);
    expect(roleFindings(blocks)).toEqual([]);
  });
});
