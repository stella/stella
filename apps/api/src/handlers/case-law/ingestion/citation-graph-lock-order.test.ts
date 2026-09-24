import { expect, test } from "bun:test";

const decisionWrite = await Bun.file(
  new URL("pipeline/decision-row-update.ts", import.meta.url),
).text();
const citationWrite = await Bun.file(
  new URL("pipeline/citations.ts", import.meta.url),
).text();

test("a refresh locks the citation graph before writing citation rows", () => {
  // Source-shape guard only: PGlite does not model PostgreSQL advisory and FK
  // lock concurrency. The database suites separately exercise both paths.
  const documentRefresh = decisionWrite.indexOf(
    "if (!incomingCarriesDocument)",
  );
  const graphLock = decisionWrite.indexOf(
    "await lockCitationGraph(tx);",
    documentRefresh,
  );
  const citationWriteCall = decisionWrite.indexOf(
    "await writeDecisionCitations(tx, {",
    documentRefresh,
  );

  expect(documentRefresh).toBeGreaterThan(-1);
  expect(graphLock).toBeGreaterThan(documentRefresh);
  expect(citationWriteCall).toBeGreaterThan(graphLock);

  // And the writer deletes before it resolves what it kept.
  const writer = citationWrite.indexOf(
    "export const writeDecisionCitations = async",
  );
  const citationDelete = citationWrite.indexOf(
    ".delete(caseLawCitations)",
    writer,
  );
  const inlineResolution = citationWrite.indexOf(
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
