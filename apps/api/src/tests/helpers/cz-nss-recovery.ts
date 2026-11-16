import { panic } from "better-result";
import { gunzipSync } from "node:zlib";

import { load } from "@stll/html";

import { buildCzNssDecision as uncheckedBuildCzNssDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import type { EnrolledAdapterFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";
import { withTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const buildCzNssDecision = guardParser(uncheckedBuildCzNssDecision);

const fixtures = new URL(
  "../../handlers/case-law/ingestion/adapters/__fixtures__/",
  import.meta.url,
);

export const nssRecoveryReference = "5 As 140/2014-76";

const DETAIL_FIXTURE = new URL(
  "cz-nss-extended-chamber-detail.html.gz",
  fixtures,
);

/**
 * What the recorded detail page states under each field, read straight off
 * the page: every value cell's text, in page order, a cell nested in another
 * of the same field counted once. The source-value oracle for the publisher
 * fields the decision keeps.
 */
const statedDetailValues = (html: string): Record<string, string[]> => {
  const $ = load(html);
  const stated: Record<string, string[]> = {};
  for (const element of $("[data-field-id]").toArray()) {
    const field = $(element).attr("data-field-id");
    if (field !== undefined) {
      stated[field] ??= [];
    }
  }
  for (const cell of $(".det-textval").toArray()) {
    const owner = $(cell).closest("[data-field-id]");
    const field = owner.attr("data-field-id");
    const nested = $(cell)
      .parents(".det-textval")
      .toArray()
      .some((parent) => $(parent).closest("[data-field-id]").is(owner));
    if (field === undefined || nested) {
      continue;
    }
    (stated[field] ??= []).push($(cell).text().replaceAll(/\s+/gu, " ").trim());
  }
  return stated;
};

const recordedDetailHtml = gunzipSync(
  await Bun.file(DETAIL_FIXTURE).bytes(),
).toString("utf-8");

export const nssRecoveryFixture = (
  pdfResponse?: () => Response,
): EnrolledAdapterFixture => ({
  rawFieldValues: statedDetailValues(recordedDetailHtml),
  buildDecision: async () => {
    const [detail, listing, placeholder, pdf] = await Promise.all([
      Bun.file(DETAIL_FIXTURE).bytes(),
      Bun.file(
        new URL("cz-nss-extended-chamber-registry.html.gz", fixtures),
      ).bytes(),
      Bun.file(
        new URL("cz-nss-extended-chamber-placeholder.html", fixtures),
      ).text(),
      Bun.file(
        new URL("cz-nss-extended-chamber-original.pdf", fixtures),
      ).bytes(),
    ]);
    return await withTestFetch(
      asFetchMock(async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.startsWith("/DokumentDetail/Index/")) {
          return new Response(gunzipSync(detail));
        }
        if (url.pathname.startsWith("/DokumentOriginal/")) {
          // Verbatim response encoding: UTF-16LE, no BOM and no charset header.
          return new Response(
            Buffer.from(placeholder.replaceAll("\n", "\r\n"), "utf16le"),
          );
        }
        if (url.pathname === "/rozhodovaci-cinnost/rozsireny-senat") {
          return new Response(gunzipSync(listing));
        }
        if (
          url.pathname ===
          "/modalni-obsah/rozhodovaci-cinnost/rozhodnuti-225964-anonymizovana-verze"
        ) {
          return (
            pdfResponse?.() ??
            new Response(pdf, {
              headers: { "Content-Type": "application/pdf" },
            })
          );
        }
        return panic(`Unexpected fixture URL: ${url.href}`);
      }),
      async () => {
        const built = await buildCzNssDecision({
          row: {
            caseNumber: "5 As 140/2014",
            publishedCaseNumber: nssRecoveryReference,
            decisionDate: "02.02.2017",
            decisionType: "Usnesení",
            outcome: "rozšířený senát: vrácení",
            documentUrl:
              "https://vyhledavac.nssoud.cz/DokumentDetail/Index/641220",
            documentId: "641220",
          },
          session: { cookies: "", token: "", formFields: new Map() },
          signal: new AbortController().signal,
        });
        return built.decision;
      },
    );
  },
});
