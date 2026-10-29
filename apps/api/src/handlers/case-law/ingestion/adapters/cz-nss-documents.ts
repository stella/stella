import { Result } from "better-result";
import * as cheerio from "cheerio";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { PublisherTargetError } from "@/api/handlers/case-law/ingestion/adapters/publisher-target";
import { parseNssDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import type { ParseNssDecisionInput } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import {
  assemblePlSnParagraphs,
  extractPlSnLines,
  plSnParagraphsToHtml,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import {
  ownTableRows,
  visibleHtmlText,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

const NSS_REGISTRY_ORIGIN = "https://www.nssoud.cz";
const ANONYMISED_DECISION_PATH =
  /^\/modalni-obsah\/rozhodovaci-cinnost\/rozhodnuti-\d+-anonymizovana-verze$/u;

/** NSS serves both UTF-8 HTML and BOM-less UTF-16 HTML without a charset. */
export const decodeNssDocument = (
  bytes: Uint8Array,
  encoding: "utf-8" | "utf-16le" = "utf-8",
): string => {
  const first = bytes.at(0);
  const second = bytes.at(1);
  if ((first === 0xff && second === 0xfe) || (first === 0x3c && second === 0)) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if ((first === 0xfe && second === 0xff) || (first === 0 && second === 0x3c)) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  return new TextDecoder(encoding).decode(bytes);
};

export const isNssDocumentPlaceholder = (html: string): boolean => {
  const $ = cheerio.load(html);
  const body = visibleHtmlText($("body")).trim();
  return body === "N/A" || body.length === 0;
};

/** The registry's default searches RS numbers; referral searches court dockets. */
export const nssRegistryUrl = (reference: string): string => {
  const url = new URL(
    "/rozhodovaci-cinnost/rozsireny-senat",
    NSS_REGISTRY_ORIGIN,
  );
  url.searchParams.set("filter[fileNumber_type]", "referral");
  url.searchParams.set(
    "filter[fileNumber]",
    splitCaseReference(reference).caseNumber,
  );
  url.searchParams.set("showResults", "1");
  return url.href;
};

const normalizedReference = (reference: string): string =>
  reference.replace(/\s/gu, "");

type NssRegistryDocumentOptions = { html: string; reference: string };

/** Match the complete reference, including the sheet; a referral is another decision. */
export const nssRegistryDocumentUrl = ({
  html,
  reference,
}: NssRegistryDocumentOptions): Result<string | null, PublisherTargetError> => {
  const $ = cheerio.load(html);
  for (const anchor of $("tbody a[href]").toArray()) {
    const link = $(anchor);
    if (
      normalizedReference(visibleHtmlText(link)) !==
      normalizedReference(reference)
    ) {
      continue;
    }
    const href = link.attr("href");
    const parsed =
      href === undefined ? null : URL.parse(href, NSS_REGISTRY_ORIGIN);
    if (
      parsed === null ||
      parsed.origin !== NSS_REGISTRY_ORIGIN ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      !ANONYMISED_DECISION_PATH.test(parsed.pathname)
    ) {
      return Result.err(
        new PublisherTargetError({
          adapterKey: ADAPTER_KEYS.CZ_NSS,
          url: NSS_REGISTRY_ORIGIN,
          message:
            "Registry link is not an anonymized NSS original on the declared origin",
        }),
      );
    }
    // Only the publisher's path and cache key cross the outbound boundary.
    const target = new URL(parsed.pathname, NSS_REGISTRY_ORIGIN);
    const cacheKey = parsed.searchParams.get("cHash");
    if (cacheKey !== null) {
      target.searchParams.set("cHash", cacheKey);
    }
    return Result.ok(target.href);
  }
  return Result.ok(null);
};

type ParseNssPdfOptions = {
  input: Omit<ParseNssDecisionInput, "html">;
  bytes: Uint8Array;
};

/** Reuse the positioned PDF reader and the NSS classifier, including on raw replay. */
export const parseNssPdf = async ({ input, bytes }: ParseNssPdfOptions) =>
  parseNssDecisionHtml({
    ...input,
    html: plSnParagraphsToHtml(
      assemblePlSnParagraphs(await extractPlSnLines(bytes)),
    ),
  });

export const NSS_REGISTRY_FIELDS = [
  "registry:Spisová značka",
  "registry:Předkládací usnesení",
  "registry:Datum předložení",
  "registry:Proti věci",
  "registry:Stav",
  "registry:Datum rozhodnutí RS",
  "registry:Rozhodnutí RS",
  "registry:Anotace",
] as const;

/** Read publisher labels, so a new registry column cannot disappear silently. */
export const listNssRegistryFields = (html: string): string[] => {
  const $ = cheerio.load(html);
  return [
    ...$("table")
      .toArray()
      .flatMap((table) =>
        ownTableRows($(table))
          .children("th")
          .toArray()
          .map((node) => `registry:${visibleHtmlText($(node)).trim()}`),
      ),
    ...$("tbody strong")
      .toArray()
      .map(
        (node) =>
          `registry:${visibleHtmlText($(node)).trim().replace(/:$/u, "")}`,
      ),
  ];
};
