import { expect, test } from "bun:test";

const pipeline = await Bun.file(new URL("pipeline.ts", import.meta.url)).text();

test("a refresh locks the citation graph before replacing citation rows", () => {
  const documentRefresh = pipeline.indexOf("if (!incomingCarriesDocument)");
  const graphLock = pipeline.indexOf(
    "await lockCitationGraph(tx);",
    documentRefresh,
  );
  const citationDelete = pipeline.indexOf(
    ".delete(caseLawCitations)",
    documentRefresh,
  );
  const inlineResolution = pipeline.indexOf(
    "await resolveCitationsForDecision(tx, existing.id);",
    citationDelete,
  );

  expect(documentRefresh).toBeGreaterThan(-1);
  expect(graphLock).toBeGreaterThan(documentRefresh);
  expect(citationDelete).toBeGreaterThan(graphLock);
  expect(inlineResolution).toBeGreaterThan(citationDelete);
});
