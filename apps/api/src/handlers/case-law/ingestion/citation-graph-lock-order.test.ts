import { expect, test } from "bun:test";

const pipeline = await Bun.file(new URL("pipeline.ts", import.meta.url)).text();

test("a refresh locks the citation graph before writing citation rows", () => {
  // Source-shape guard only: PGlite does not model PostgreSQL advisory and FK
  // lock concurrency. The database suites separately exercise both paths.
  const documentRefresh = pipeline.indexOf("if (!incomingCarriesDocument)");
  const graphLock = pipeline.indexOf(
    "await lockCitationGraph(tx);",
    documentRefresh,
  );
  const citationWrite = pipeline.indexOf(
    "await writeDecisionCitations(tx, {",
    documentRefresh,
  );

  expect(documentRefresh).toBeGreaterThan(-1);
  expect(graphLock).toBeGreaterThan(documentRefresh);
  expect(citationWrite).toBeGreaterThan(graphLock);

  // And the writer deletes before it resolves what it kept.
  const writer = pipeline.indexOf("const writeDecisionCitations = async");
  const citationDelete = pipeline.indexOf(".delete(caseLawCitations)", writer);
  const inlineResolution = pipeline.indexOf(
    "await resolveCitationsForDecision(tx, decisionId);",
    writer,
  );
  expect(writer).toBeGreaterThan(-1);
  expect(citationDelete).toBeGreaterThan(writer);
  expect(inlineResolution).toBeGreaterThan(citationDelete);
});

test("the backfill decision lock permits resolver foreign-key checks", async () => {
  const source = await Bun.file(
    new URL("decision-identifier-backfill.ts", import.meta.url),
  ).text();

  expect(source).toContain("FOR NO KEY UPDATE OF decision");
  expect(source).not.toContain("FOR UPDATE OF decision");
});
