/**
 * What court a decision this publisher serves is stored under.
 *
 * The Supreme Court's database is not a single court's corpus: it publishes
 * selected decisions of the high, regional, city and district courts beside
 * its own, naming the deciding court in each detail page's `Soud` row and in
 * the ECLI's court code. A row labelled with the publisher instead names a
 * court that did not decide it and ranks with that court's authority.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { buildCzNsDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A labelled row of a detail page, in the publisher's own markup. */
const detailRow = (label: string, value: string): string =>
  `<tr valign="top"><td class="left-part" width="17%"><b><font face="Times New Roman">${label}:</font></b></td>` +
  `<td class="right-part" width="83%"><b><font face="Times New Roman">${value}</font></b></td></tr>`;

const DECISION_BODY =
  "Krajský soud v Ostravě rozhodl v senátě složeném z předsedkyně JUDr. Evy " +
  "Novákové takto: Rozsudek soudu prvního stupně se potvrzuje. Odůvodnění: " +
  "Soud prvního stupně rozsudkem zamítl žalobu.";

type PageOptions = {
  court?: string | undefined;
  ecli?: string | undefined;
};

const detailPage = ({ court, ecli }: PageOptions): string =>
  `<!DOCTYPE HTML><html><body><table>${[
    ...(court === undefined ? [] : [detailRow("Soud", court)]),
    detailRow("Datum rozhodnutí", "6. 5. 2011"),
    detailRow("Spisová značka", "75 Co 19/2011"),
    ...(ecli === undefined ? [] : [detailRow("ECLI", ecli)]),
    detailRow("Typ rozhodnutí", "ROZSUDEK"),
    detailRow("Zveřejněno na webu", "1. 6. 2011"),
  ].join(
    "",
  )}</table><font face="Times New Roman">${DECISION_BODY}</font></body></html>`;

/** The court the adapter stores for a decision served with these pages. */
const builtCourt = async (page: PageOptions): Promise<string> => {
  globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    // Only the detail page: the print page is the document's source and the
    // court is not read off it, so a decision stored without one still has
    // to be attributed correctly.
    return await Promise.resolve(
      url.includes("/WebPrint/")
        ? new Response("", { status: 404 })
        : new Response(detailPage(page), {
            headers: { "Content-Type": "text/html" },
          }),
    );
  });
  const built = await buildCzNsDecision({
    unid: "0000000000000000000000000000000A",
    caseNumber: "75 Co 19/2011",
  });
  if (built.type !== "built") {
    throw new Error(`cz-ns decision did not build: ${built.type}`);
  }
  expect(built.decision.metadata["court"]).toBe(built.decision.court);
  return built.decision.court;
};

describe("cz-ns court attribution", () => {
  test("stores a regional court's decision under that court", async () => {
    expect(
      await builtCourt({
        court: "Krajský soud v Ostravě",
        ecli: "ECLI:CZ:KSOS:2011:75.CO.19.2011.1",
      }),
    ).toBe("Krajský soud v Ostravě");
  });

  test("reads the court off the page when the decision carries no ECLI", async () => {
    expect(await builtCourt({ court: "Vrchní soud v Praze" })).toBe(
      "Vrchní soud v Praze",
    );
  });

  test("stores the publisher's own decision under the publisher", async () => {
    expect(
      await builtCourt({
        court: "Nejvyšší soud",
        ecli: "ECLI:CZ:NS:2011:30.CDO.3000.2011.1",
      }),
    ).toBe("Nejvyšší soud");
  });

  test("labels nothing the Supreme Court on a page that states no court", async () => {
    expect(
      await builtCourt({ ecli: "ECLI:CZ:KSOS:2011:75.CO.19.2011.1" }),
    ).toBe("Krajský soud v Ostravě");
  });
});
