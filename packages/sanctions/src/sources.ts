import { Result, panic } from "better-result";

import { compareByLocale } from "@stll/collation";

import type {
  SanctionsIssuer,
  SanctionsListParseError,
  SanctionsSource,
} from "./entry";
import {
  invalidValue,
  missingField,
  parseIsoDate,
  stampInstant,
} from "./values";

const compareEnglish = compareByLocale("en");

type Licence = {
  url: string;
};

type Download =
  | { kind: "direct"; urls: readonly [string, ...string[]] }
  | { kind: "dated-file"; pageUrl: string; fileNamePattern: string };

type EditionMarker =
  | { kind: "http-last-modified"; url: string }
  | { kind: "http-content-disposition"; url: string }
  | { kind: "publisher-checksum"; url: string }
  | { kind: "publisher-page-date"; url: string }
  | { kind: "dated-file-name"; pageUrl: string; fileNamePattern: string };

type SourceMetadata = {
  issuer: SanctionsIssuer;
  download: Download;
  allowedRedirectHosts: readonly string[];
  licence?: Licence;
  editionMarker: EditionMarker;
  access?: { kind: "query-token"; parameter: "token" };
};

const EU_XML =
  "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content";
const EU_CHECKSUM =
  "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/checksum";
const UN_XML = "https://scsanctions.un.org/resources/xml/en/consolidated.xml";
const UN_PAGE =
  "https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list";
const CZ_PAGE =
  "https://mzv.gov.cz/jnp/cz/zahranicni_vztahy/sankcni_politika/sankcni_seznam_cr/vnitrostatni_sankcni_seznam.html";
const CZ_FILE = "Vnitrostatni_sankcni_seznam_YYYY_MM_DD.csv";
const OFAC_EXPORT =
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/";
const SDN_XML = `${OFAC_EXPORT}SDN.XML`;
const NON_SDN_XML = `${OFAC_EXPORT}CONSOLIDATED.XML`;
const UK_XML = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml";
const CH_XML =
  "https://www.sesam.search.admin.ch/sesam-search-web/pages/downloadXmlGesamtliste.xhtml?action=downloadXmlGesamtlisteAction&lang=de";

/** Publisher locations, reuse terms, and inexpensive checks for new editions. */
export const SANCTIONS_SOURCES = {
  eu: {
    id: "eu",
    allowedRedirectHosts: [],
    issuer: "EU",
    download: { kind: "direct", urls: [EU_XML] },
    licence: {
      url: "https://eur-lex.europa.eu/eli/dec/2011/833/oj/eng",
    },
    editionMarker: { kind: "publisher-checksum", url: EU_CHECKSUM },
    access: { kind: "query-token", parameter: "token" },
  },
  un: {
    id: "un",
    allowedRedirectHosts: ["unsolprodfiles.blob.core.windows.net"],
    issuer: "UN",
    download: { kind: "direct", urls: [UN_XML] },
    licence: {
      url: "https://www.un.org/Depts/los/LEGISLATIONANDTREATIES/terms_and_conditions.htm",
    },
    editionMarker: { kind: "publisher-page-date", url: UN_PAGE },
  },
  cz: {
    id: "cz",
    allowedRedirectHosts: [],
    issuer: "CZ",
    download: {
      kind: "dated-file",
      pageUrl: CZ_PAGE,
      fileNamePattern: CZ_FILE,
    },
    editionMarker: {
      kind: "dated-file-name",
      pageUrl: CZ_PAGE,
      fileNamePattern: CZ_FILE,
    },
  },
  "us-sdn": {
    id: "us-sdn",
    allowedRedirectHosts: [
      "wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com",
    ],
    issuer: "US",
    download: { kind: "direct", urls: [SDN_XML] },
    licence: {
      url: "https://www.govinfo.gov/content/pkg/USCODE-2024-title17/html/USCODE-2024-title17-chap1-sec105.htm",
    },
    editionMarker: { kind: "http-last-modified", url: SDN_XML },
  },
  "us-non-sdn": {
    id: "us-non-sdn",
    allowedRedirectHosts: [
      "wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com",
    ],
    issuer: "US",
    download: { kind: "direct", urls: [NON_SDN_XML] },
    licence: {
      url: "https://www.govinfo.gov/content/pkg/USCODE-2024-title17/html/USCODE-2024-title17-chap1-sec105.htm",
    },
    editionMarker: { kind: "http-last-modified", url: NON_SDN_XML },
  },
  uk: {
    id: "uk",
    allowedRedirectHosts: [],
    issuer: "GB",
    download: { kind: "direct", urls: [UK_XML] },
    licence: {
      url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    },
    editionMarker: { kind: "http-last-modified", url: UK_XML },
  },
  ch: {
    id: "ch",
    allowedRedirectHosts: [],
    issuer: "CH",
    download: { kind: "direct", urls: [CH_XML] },
    licence: {
      url: "https://www.admin.ch/en/terms-and-conditions",
    },
    editionMarker: { kind: "http-content-disposition", url: CH_XML },
  },
} as const satisfies {
  [Source in SanctionsSource]: SourceMetadata & { id: Source };
};

type MarkerResponse = {
  /** The value from an HTTP HEAD response, for sources that publish it. */
  lastModified?: string | null;
  /** The filename header from a SECO consolidated-list HEAD response. */
  contentDisposition?: string | null;
  /** A small checksum response or publisher page, for GET-based markers. */
  body?: string;
};

export type SourceEditionMarker = {
  source: SanctionsSource;
  /** Opaque change key. A changed value calls for downloading the list. */
  value: string;
  /** The current direct file URL when a publisher uses dated attachments. */
  downloadUrl: string | null;
};

const UN_MONTHS = new Map([
  ["January", 1],
  ["February", 2],
  ["March", 3],
  ["April", 4],
  ["May", 5],
  ["June", 6],
  ["July", 7],
  ["August", 8],
  ["September", 9],
  ["October", 10],
  ["November", 11],
  ["December", 12],
]);
const HTTP_MONTHS = new Map([
  ["Jan", 1],
  ["Feb", 2],
  ["Mar", 3],
  ["Apr", 4],
  ["May", 5],
  ["Jun", 6],
  ["Jul", 7],
  ["Aug", 8],
  ["Sep", 9],
  ["Oct", 10],
  ["Nov", 11],
  ["Dec", 12],
]);
const HTTP_DATE =
  /^[A-Z][a-z]{2}, (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/u;
const UN_DATE = /last updated on\s+(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})/iu;
const CZ_DOWNLOAD =
  /\/file\/\d+\/Vnitrostatni_sankcni_seznam_(\d{4})_(\d{2})_(\d{2})\.csv/gu;
const CHECKSUM = /^[a-f\d]{40,128}$/iu;
const CH_FILENAME =
  /^attachment;\s*filename="consolidated-list_(\d{4}-\d{2}-\d{2})\.xml"$/iu;

const httpLastModified = (
  source: SanctionsSource,
  stamp: string | null | undefined,
): Result<string, SanctionsListParseError> => {
  const match =
    stamp === undefined || stamp === null ? null : HTTP_DATE.exec(stamp);
  const day = match?.[1];
  const month = HTTP_MONTHS.get(match?.[2] ?? "");
  const year = match?.[3];
  const clock = match?.[4];
  const instant =
    day === undefined ||
    month === undefined ||
    year === undefined ||
    clock === undefined
      ? null
      : stampInstant(
          `${year}-${String(month).padStart(2, "0")}-${day}T${clock}Z`,
        );
  return instant === null
    ? Result.err(
        missingField(source, "HTTP Last-Modified is missing or invalid"),
      )
    : Result.ok(instant.toString());
};

const pageText = (html: string): string => {
  const text: string[] = [];
  let insideTag = false;
  for (const character of html) {
    if (character === "<") {
      insideTag = true;
      text.push(" ");
    } else if (character === ">" && insideTag) {
      insideTag = false;
    } else if (!insideTag) {
      text.push(character);
    }
  }
  return text.join("");
};

/** Parses the small response named by a source's editionMarker strategy. */
export const readSourceEditionMarker = (
  source: SanctionsSource,
  response: MarkerResponse,
): Result<SourceEditionMarker, SanctionsListParseError> => {
  const marker = SANCTIONS_SOURCES[source].editionMarker;
  let value: string;
  let downloadUrl: string | null = null;
  switch (marker.kind) {
    case "http-last-modified": {
      const stamp = httpLastModified(source, response.lastModified);
      if (stamp.isErr()) {
        return Result.err(stamp.error);
      }
      value = stamp.value;
      break;
    }
    case "http-content-disposition": {
      const header = response.contentDisposition;
      const date =
        header === undefined || header === null
          ? undefined
          : CH_FILENAME.exec(header)?.[1];
      if (date === undefined) {
        return Result.err(
          missingField(
            source,
            "HTTP Content-Disposition has no dated list filename",
          ),
        );
      }
      const checked = parseIsoDate(source, date);
      if (checked.isErr()) {
        return Result.err(checked.error);
      }
      value = date;
      break;
    }
    case "publisher-checksum": {
      const checksum = response.body?.trim();
      if (checksum === undefined || !CHECKSUM.test(checksum)) {
        return Result.err(
          invalidValue(source, "publisher checksum is missing or invalid"),
        );
      }
      value = checksum.toLowerCase();
      break;
    }
    case "publisher-page-date": {
      const text = response.body === undefined ? null : pageText(response.body);
      const match = text === null ? null : UN_DATE.exec(text);
      const day = match?.[1];
      const month = UN_MONTHS.get(match?.[2] ?? "");
      const year = match?.[3];
      if (day === undefined || month === undefined || year === undefined) {
        return Result.err(
          missingField(source, "publisher page has no list update date"),
        );
      }
      value = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
      const checked = parseIsoDate(source, value);
      if (checked.isErr()) {
        return Result.err(checked.error);
      }
      break;
    }
    case "dated-file-name": {
      const matches = [...(response.body ?? "").matchAll(CZ_DOWNLOAD)];
      const candidates = matches.flatMap((match) => {
        const path = match[0];
        const year = match[1];
        const month = match[2];
        const day = match[3];
        return year === undefined || month === undefined || day === undefined
          ? []
          : [{ path, publishedAt: `${year}-${month}-${day}` }];
      });
      candidates.sort((left, right) =>
        compareEnglish(right.publishedAt, left.publishedAt),
      );
      const latest = candidates.at(0);
      if (latest === undefined) {
        return Result.err(
          missingField(source, "publisher page has no dated CSV link"),
        );
      }
      const checked = parseIsoDate(source, latest.publishedAt);
      if (checked.isErr()) {
        return Result.err(checked.error);
      }
      downloadUrl = new URL(latest.path, marker.pageUrl).toString();
      value = downloadUrl;
      break;
    }
    default:
      marker satisfies never;
      return panic("unknown edition marker strategy");
  }
  return Result.ok({ source, value, downloadUrl });
};
