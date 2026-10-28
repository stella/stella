/**
 * Every read of the citation graph that serves the public corpus anchors on
 * a decision's work, through `lib/case-law/decision-work.ts`. A module that
 * anchors on one decision row instead reads one language version's share of
 * a judgment's citations: counts that differ by language, and references
 * that appear on one version only. The owner module is the only place that
 * may name the anchor columns in an anchoring position; this census finds
 * every other.
 *
 * In scope is every API module that names the citation table and reads the
 * published corpus. Each entry in `LEGACY_SINGLE_ROW_ANCHORS` is a known
 * single-row read with its reason; the list only shrinks.
 */
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const apiSource = "apps/api/src";
const OWNER = "apps/api/src/lib/case-law/decision-work.ts";

/**
 * Known single-row reads, by file, with the reason each is still one. An
 * entry whose file no longer anchors on a row fails the census, so the list
 * cannot outlive its debt.
 */
const LEGACY_SINGLE_ROW_ANCHORS: Readonly<Record<string, string>> = {
  "apps/api/src/handlers/case-law/decisions/search.ts":
    "The Postgres search ranking scores every matched row with a live lateral over its own incoming edges before it picks a language representative; moving it to the work belongs with a change to the search ranking itself.",
};

/**
 * Modules that name both but read no decision's citations: they move rows by
 * id, and an anchor there selects storage, not a judgment's graph.
 */
const NOT_DECISION_CITATION_READS: Readonly<Record<string, string>> = {
  "apps/api/src/lib/case-law/corpus-slice-transfer-execution.ts":
    "Copies a corpus slice's citation rows by citing-id batch; no count or list is read from them.",
};

/** A module names the citation graph and reads the published corpus. */
const NAMES_CITATIONS = /\bcaseLawCitations\b|\bcase_law_citations\b/u;
const READS_PUBLIC_CORPUS =
  /\bpublishedCaseLawDecisions\b|\bcase_law_published_decisions\b|case-law-public-read-db/u;

/**
 * Ways a statement anchors the graph on one decision: a Drizzle comparison of
 * an endpoint column, an endpoint column interpolated before `=`, a direction
 * map naming an anchor column, and raw SQL comparing an endpoint column with
 * a value or another row's id.
 */
const SINGLE_ROW_ANCHORS: readonly RegExp[] = [
  /\b(?:eq|inArray|ne)\(\s*caseLawCitations\.(?:citedDecisionId|citingDecisionId)\b/u,
  /\$\{\s*caseLawCitations\.(?:citedDecisionId|citingDecisionId)\s*\}\s*(?:=|IN\b)/u,
  /\banchor:\s*caseLawCitations\.(?:citedDecisionId|citingDecisionId)\b/u,
  /\b(?:cited|citing)_decision_id\s*(?:=\s*(?:ANY\s*\(\s*)?(?:\$\{|[A-Za-z_]+\.id\b)|IN\s*\()/iu,
];

const anchorsOnOneRow = (source: string): string[] =>
  SINGLE_ROW_ANCHORS.flatMap((pattern) => {
    const match = pattern.exec(source);
    return match === null ? [] : [match[0]];
  });

const sourceFiles = async (): Promise<string[]> => {
  const glob = new Bun.Glob(`${apiSource}/**/*.ts`);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: repoRoot })) {
    if (!file.endsWith(".test.ts") && !file.includes("/tests/")) {
      files.push(file);
    }
  }
  return files.toSorted();
};

const publicCitationReaders = async () => {
  const readers: { file: string; anchors: string[] }[] = [];
  for (const file of await sourceFiles()) {
    if (file === OWNER || NOT_DECISION_CITATION_READS[file] !== undefined) {
      continue;
    }
    const source = await Bun.file(nodePath.resolve(repoRoot, file)).text();
    if (NAMES_CITATIONS.test(source) && READS_PUBLIC_CORPUS.test(source)) {
      readers.push({ file, anchors: anchorsOnOneRow(source) });
    }
  }
  return readers;
};

describe("citation reads anchor on the work", () => {
  test("the detector recognises each single-row anchoring form", () => {
    // Shapes these reads had before they anchored on the work.
    const anchored = [
      "eq(caseLawCitations.citedDecisionId, decisionId)",
      "eq(caseLawCitations.citingDecisionId, decisionId),",
      `sql\`\${caseLawCitations.citedDecisionId} = \${decisionId}\``,
      "anchor: caseLawCitations.citedDecisionId,",
      ") ON c.cited_decision_id = b.id",
      `WHERE citing_decision_id = \${decisionId} AND cited_decision_id IS NOT NULL`,
      "WHERE c.cited_decision_id = d.id",
    ];
    for (const snippet of anchored) {
      expect(anchorsOnOneRow(snippet)).not.toEqual([]);
    }
    // Joins and far-end lookups are not anchors.
    const notAnchored = [
      "ON citing_d.id = c.citing_decision_id",
      "eq(publishedCaseLawDecisions.id, caseLawCitations.citingDecisionId)",
      `WHERE \${reviews.citingDecisionId} = \${caseLawCitations.citingDecisionId}`,
      "related: caseLawCitations.citingDecisionId,",
    ];
    for (const snippet of notAnchored) {
      expect(anchorsOnOneRow(snippet)).toEqual([]);
    }
  });

  test("no module but the owner anchors a public citation read on one row", async () => {
    const readers = await publicCitationReaders();
    // The census reaches the reads it guards.
    expect(readers.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        "apps/api/src/handlers/case-law/citation-authority.ts",
        "apps/api/src/handlers/case-law/decisions/citation-graph.ts",
        "apps/api/src/handlers/case-law/analysis/significance.ts",
      ]),
    );
    const offenders = readers.filter(
      ({ file, anchors }) =>
        anchors.length > 0 && LEGACY_SINGLE_ROW_ANCHORS[file] === undefined,
    );
    expect(offenders).toEqual([]);
  });

  test("every legacy entry still anchors on a row", async () => {
    const readers = new Map(
      (await publicCitationReaders()).map(({ file, anchors }) => [
        file,
        anchors,
      ]),
    );
    for (const file of Object.keys(LEGACY_SINGLE_ROW_ANCHORS)) {
      expect(readers.get(file)?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
