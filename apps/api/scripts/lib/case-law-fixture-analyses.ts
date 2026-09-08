/**
 * Reading the seeded case-law fixtures' analyses, and the input each one
 * claims to describe.
 *
 * Shared by the refresh script and the test that guards it, so "what a stale
 * fixture is" has one definition. Both answer the same question: does the
 * stored `inputFingerprint` still equal the digest of this decision's
 * anchored text and the prompt its language resolves to today?
 */

import { panic } from "better-result";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { parseUsableDocumentAst } from "@stll/legal-ast/document-ast";

import { getSystemPrompt } from "@/api/handlers/case-law/analysis/prompts/prompt-registry";
import { analysisInputOf } from "@/api/lib/case-law/analysis-prompt";

export const CASE_LAW_FIXTURES_DIR = path.join(
  import.meta.dir,
  "..",
  "__fixtures__",
  "case-law",
);

/** The fixture fields this reader depends on; the rest passes through. */
type FixtureDecision = {
  case_number: string;
  court: string;
  country: string;
  decision_type?: string | null;
  language: string;
  document_ast?: unknown;
  analysis?: { inputFingerprint: string } | null;
};

type Fixture = { decisions: FixtureDecision[] };

export type CaseLawFixtureAnalysis = {
  fixtureName: string;
  caseNumber: string;
  /** The stored analysis object, mutable so the refresh can re-stamp it. */
  analysis: { inputFingerprint: string };
  storedFingerprint: string;
  currentFingerprint: string;
  matches: boolean;
};

export type CaseLawFixtureFile = {
  path: string;
  fixtureName: string;
  fixture: Fixture;
  entries: CaseLawFixtureAnalysis[];
};

const isFixture = (value: unknown): value is Fixture =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { decisions?: unknown }).decisions);

export const readCaseLawFixtureFile = async (
  fixturePath: string,
): Promise<Fixture> => {
  const buffer = Buffer.from(await Bun.file(fixturePath).arrayBuffer());
  const parsed: unknown = JSON.parse(gunzipSync(buffer).toString());
  if (!isFixture(parsed)) {
    // A checked-in archive that is not a fixture is a broken repository,
    // not a runtime failure a caller could recover from.
    return panic(`Not a case-law fixture: ${fixturePath}`);
  }
  return parsed;
};

/**
 * Every fixture that carries at least one stored analysis, with the current
 * fingerprint computed beside each stored one. A decision whose document has
 * no usable parse carries no comparison and is skipped: it could not have
 * been analysed either.
 */
export const readCaseLawFixtureAnalyses = async (): Promise<
  CaseLawFixtureFile[]
> => {
  const names = (await readdir(CASE_LAW_FIXTURES_DIR)).filter((entry) =>
    entry.endsWith(".json.gz"),
  );
  const files: CaseLawFixtureFile[] = [];
  for (const fixtureName of names.toSorted()) {
    const fixturePath = path.join(CASE_LAW_FIXTURES_DIR, fixtureName);
    const fixture = await readCaseLawFixtureFile(fixturePath);
    const entries: CaseLawFixtureAnalysis[] = [];
    for (const decision of fixture.decisions) {
      const analysis = decision.analysis;
      if (!analysis) {
        continue;
      }
      const ast = parseUsableDocumentAst(decision.document_ast);
      if (ast === null) {
        continue;
      }
      const currentFingerprint = analysisInputOf({
        blocks: ast.blocks,
        decision: {
          court: decision.court,
          country: decision.country,
          decisionType: decision.decision_type ?? null,
          language: decision.language,
        },
        systemPrompt: getSystemPrompt(decision.language),
      }).fingerprint;
      entries.push({
        fixtureName,
        caseNumber: decision.case_number,
        analysis,
        storedFingerprint: analysis.inputFingerprint,
        currentFingerprint,
        matches: analysis.inputFingerprint === currentFingerprint,
      });
    }
    if (entries.length > 0) {
      files.push({ path: fixturePath, fixtureName, fixture, entries });
    }
  }
  return files;
};
