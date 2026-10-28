import { panic } from "better-result";

import { gunzipSync } from "node:zlib";

import { buildCzNssDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import type { EnrolledAdapterFixture } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const fixtures = new URL("./", import.meta.url);

export const nssRecoveryReference = "5 As 140/2014-76";

export const nssRecoveryFixture = (pdfResponse?: () => Response): EnrolledAdapterFixture => ({
  buildDecision: async () => {
    const [detail, listing, placeholder, pdf] = await Promise.all([
      Bun.file(new URL("cz-nss-extended-chamber-detail.html.gz", fixtures)).bytes(),
      Bun.file(new URL("cz-nss-extended-chamber-registry.html.gz", fixtures)).bytes(),
      Bun.file(new URL("cz-nss-extended-chamber-placeholder.html", fixtures)).text(),
      Bun.file(new URL("cz-nss-extended-chamber-original.pdf", fixtures)).bytes(),
    ]);
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith("/DokumentDetail/Index/")) {
        return new Response(gunzipSync(detail));
      }
      if (url.pathname.startsWith("/DokumentOriginal/")) {
        // Verbatim response encoding: UTF-16LE, no BOM and no charset header.
        return new Response(Buffer.from(placeholder.replaceAll("\n", "\r\n"), "utf16le"));
      }
      if (url.pathname === "/rozhodovaci-cinnost/rozsireny-senat") {
        return new Response(gunzipSync(listing));
      }
      if (url.pathname === "/modalni-obsah/rozhodovaci-cinnost/rozhodnuti-225964-anonymizovana-verze") {
        return pdfResponse?.() ?? new Response(pdf, { headers: { "Content-Type": "application/pdf" } });
      }
      return panic(`Unexpected fixture URL: ${url.href}`);
    });
    const built = await buildCzNssDecision({
      row: {
        caseNumber: "5 As 140/2014",
        publishedCaseNumber: nssRecoveryReference,
        decisionDate: "02.02.2017",
        decisionType: "Usnesení",
        outcome: "rozšířený senát: vrácení",
        documentUrl: "https://vyhledavac.nssoud.cz/DokumentDetail/Index/641220",
        documentId: "641220",
      },
      session: { cookies: "", token: "", formFields: new Map() },
      signal: AbortSignal.timeout(30_000),
    });
    return built.decision;
  },
});
