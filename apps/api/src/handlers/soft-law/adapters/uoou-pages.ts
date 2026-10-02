import { panic, Result } from "better-result";
import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import type { SourceRawParts } from "@/api/lib/legal-search/ingestion-types";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawMetadata,
  SoftLawStated,
} from "@/api/lib/legal-search/soft-law-types";

export const UOOU_ORIGIN = "https://uoou.gov.cz";
const isRealCalendarDate = (value: string) =>
  !Result.isError(
    Result.try(() => Temporal.PlainDate.from(value.slice(0, 10))),
  );
export const UOOU_DATE_SCHEMA = v.pipe(
  v.string(),
  v.isoDate(),
  v.check(isRealCalendarDate),
);
export const UOOU_TIMESTAMP_SCHEMA = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u,
  ),
  v.check(isRealCalendarDate),
  v.check(
    (value) =>
      !Result.isError(
        Result.try(() =>
          Temporal.Instant.from(value.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2")),
        ),
      ),
  ),
);
const METHODOLOGY_PREFIX = "/profesional/metodiky-a-doporuceni-pro-spravce/";
const FAQ_PREFIXES = [
  "/profesional/qa-otazky-a-odpovedi/",
  "/verejnost/qa-otazky-a-odpovedi/",
] as const;
const THEMATIC_ROOTS = [
  "/profesional/poverenec-pro-ochranu-osobnich-udaju",
  "/profesional/posouzeni-vlivu-na-ochranu-osobnich-udaju-dpia",
  "/profesional/predavani-osobnich-udaju-do-tretich-zemi-1",
  "/profesional/hodnoceni-shody-s-gdpr",
  "/profesional/poruseni-zabezpeceni-osobnich-udaju",
] as const;

export const classifyUoouUrl = (url: string) => {
  const parsedUrl = Result.try(() => new URL(url));
  if (parsedUrl.status === "error") {
    return { type: "excluded", reason: "outside_guidance_slice" } as const;
  }
  const parsed = parsedUrl.value;
  if (
    parsed.origin !== UOOU_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return { type: "excluded", reason: "outside_guidance_slice" } as const;
  }
  const path = parsed.pathname.replace(/\/$/u, "");
  if (
    path.includes("/pokyny-sboru-") ||
    path.includes("/pokyny-doporuceni-a-stanoviska-sboru-")
  ) {
    return { type: "excluded", reason: "edpb_translation" } as const;
  }
  if (FAQ_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return { type: "guidance", kind: "faq" } as const;
  }
  if (path.startsWith(METHODOLOGY_PREFIX)) {
    return {
      type: "guidance",
      kind: path.slice(METHODOLOGY_PREFIX.length).startsWith("doporuceni-")
        ? "recommendation"
        : "methodology",
    } as const;
  }
  if (
    THEMATIC_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
  ) {
    return { type: "guidance", kind: "guideline" } as const;
  }
  return { type: "excluded", reason: "outside_guidance_slice" } as const;
};

const jsonObject = v.record(v.string(), v.unknown());
const UOOU_ATTACHMENT_SELECTOR =
  "._cms-content a[href], .u-l-documents a[href]";
type ReadUoouJsonLdResult = Result<
  Record<string, unknown>[],
  SoftLawIngestionError
>;
export const readUoouJsonLd = (html: string): ReadUoouJsonLdResult => {
  const $ = load(html);
  const nodes: Record<string, unknown>[] = [];
  const visit = (
    value: unknown,
    depth: number,
  ): Result<void, SoftLawIngestionError> => {
    if (depth > 10) {
      return Result.err(
        new SoftLawIngestionError({
          message: "JSON-LD nesting exceeds the limit",
        }),
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const visited = visit(item, depth + 1);
        if (visited.status === "error") {
          return visited;
        }
      }
      return Result.ok();
    }
    const object = v.safeParse(jsonObject, value);
    if (!object.success) {
      return Result.err(
        new SoftLawIngestionError({ message: "Invalid JSON-LD object" }),
      );
    }
    nodes.push(object.output);
    if (object.output["@graph"] !== undefined) {
      return visit(object.output["@graph"], depth + 1);
    }
    return Result.ok();
  };
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    const parsed = Result.try({
      try: (): unknown => JSON.parse($(script).text()),
      catch: (cause) =>
        new SoftLawIngestionError({
          message: "Invalid publisher JSON-LD",
          cause,
        }),
    });
    if (parsed.status === "error") {
      return parsed;
    }
    const visited = visit(parsed.value, 0);
    if (visited.status === "error") {
      return visited;
    }
  }
  return Result.ok(nodes);
};

export const listUoouSourceFields = (parts: SourceRawParts) => {
  const html = parts["page"];
  if (!html) {
    return panic("Stored page is missing");
  }
  const $ = load(html);
  if (
    !$("h1").first().text().trim() ||
    !$("._cms-content, .u-accordion--faq").length
  ) {
    return panic("Stored guidance title or body is missing");
  }
  const fields = new Set<string>();
  fields.add("title");
  if ($("._cms-content").length) {
    fields.add("body");
  }
  if ($(".u-accordion--faq .u-accordion__title").length) {
    fields.add("questions");
  }
  const nodes = readUoouJsonLd(html);
  if (nodes.status === "error") {
    return panic(`Stored publisher JSON-LD is invalid: ${nodes.error.message}`);
  }
  for (const node of nodes.value) {
    for (const key of Object.keys(node)) {
      fields.add(`jsonld.${key}`);
    }
  }
  for (const anchor of $(UOOU_ATTACHMENT_SELECTOR).toArray()) {
    const href = $(anchor).attr("href");
    if (href && /\/media\/.*\.(?:pdf|docx)(?:[?#]|$)/iu.test(href)) {
      fields.add("attachments");
    }
  }
  return [...fields];
};

const CZECH_MONTHS = {
  ledna: "01",
  února: "02",
  března: "03",
  dubna: "04",
  května: "05",
  června: "06",
  července: "07",
  srpna: "08",
  září: "09",
  října: "10",
  listopadu: "11",
  prosince: "12",
} as const;
type StatedIssueDateResult = Result<
  SoftLawStated<string>,
  SoftLawIngestionError
>;
const statedIssueDate = (text: string): StatedIssueDateResult => {
  const match =
    /(?:ze dne|vyd[aá]no(?: dne)?)\s+(\d{1,2})\.\s*(\d{1,2}|[\p{L}]+)\.?\s*(\d{4})/iu.exec(
      text,
    );
  if (!match) {
    return Result.ok({ state: "not_stated" });
  }
  const day = match.at(1);
  const monthText = match.at(2)?.toLowerCase();
  const month =
    Object.entries(CZECH_MONTHS)
      .find(([name]) => name === monthText)
      ?.at(1) ?? monthText;
  const year = match.at(3);
  if (!day || !month || !year) {
    return panic("Issue date capture is incomplete");
  }
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== iso
  ) {
    return Result.err(
      new SoftLawIngestionError({ message: "Invalid stated issue date" }),
    );
  }
  return Result.ok({ state: "stated", value: iso });
};

const readUoouAttachments = (
  $: CheerioAPI,
  url: string,
): Result<string[], SoftLawIngestionError> => {
  const attachments: string[] = [];
  for (const anchor of $(UOOU_ATTACHMENT_SELECTOR).toArray()) {
    const href = $(anchor).attr("href");
    if (!href) {
      continue;
    }
    const parsedAttachment = Result.try({
      try: () => new URL(href, url),
      catch: (cause) =>
        new SoftLawIngestionError({
          message: "Invalid guidance attachment URL",
          cause,
        }),
    });
    if (parsedAttachment.status === "error") {
      return parsedAttachment;
    }
    const attachment = parsedAttachment.value;
    if (
      attachment.origin !== UOOU_ORIGIN ||
      attachment.username ||
      attachment.password ||
      !attachment.pathname.startsWith("/media/") ||
      !/\.(?:pdf|docx)$/iu.test(attachment.pathname)
    ) {
      continue;
    }
    attachment.hash = "";
    if (!attachments.includes(attachment.href)) {
      attachments.push(attachment.href);
    }
  }
  if (attachments.length > 19) {
    return Result.err(
      new SoftLawIngestionError({
        message: "Too many guidance attachments",
      }),
    );
  }
  return Result.ok(attachments);
};

type ParsedUoouPage = {
  metadata: SoftLawMetadata;
  text: string;
  attachments: string[];
  sourceDates: Record<string, string>;
  excluded: "edpb_translation" | null;
};
type ParseUoouPageResult = Result<ParsedUoouPage, SoftLawIngestionError>;
export const parseUoouPage = (
  html: string,
  url: string,
): ParseUoouPageResult => {
  const classification = classifyUoouUrl(url);
  if (classification.type === "excluded") {
    return Result.err(
      new SoftLawIngestionError({
        message: "Page is outside the guidance slice",
      }),
    );
  }
  const $ = load(html);
  const title = $("h1").first().text().replace(/\s+/gu, " ").trim();
  const accordion = $(".u-accordion--faq");
  const body = (accordion.length ? accordion : $("._cms-content")).clone();
  if (!title || !body.length) {
    return Result.err(
      new SoftLawIngestionError({
        message: "Publisher title or guidance body is missing",
      }),
    );
  }
  body.find("script, style, nav, noscript, .u-accordion__show-text").remove();
  body.find("p, div, li, h2, h3, h4, tr, br").append("\n");
  const text = body
    .text()
    .replace(/[^\S\n]+/gu, " ")
    .replace(/\n\s*\n+/gu, "\n\n")
    .trim();
  if (!text) {
    return Result.err(
      new SoftLawIngestionError({ message: "Guidance body is empty" }),
    );
  }
  const attachments = readUoouAttachments($, url);
  if (attachments.status === "error") {
    return attachments;
  }
  const sourceDates: Record<string, string> = {};
  const nodes = readUoouJsonLd(html);
  if (nodes.status === "error") {
    return nodes;
  }
  for (const node of nodes.value) {
    for (const field of [
      "dateCreated",
      "datePublished",
      "dateModified",
    ] as const) {
      const value = node[field];
      if (value === undefined) {
        continue;
      }
      if (
        typeof value !== "string" ||
        !v.safeParse(UOOU_TIMESTAMP_SCHEMA, value).success
      ) {
        return Result.err(
          new SoftLawIngestionError({ message: "Invalid CMS date" }),
        );
      }
      const key = `cms.${field}`;
      if (sourceDates[key] && sourceDates[key] !== value) {
        return Result.err(
          new SoftLawIngestionError({ message: "Conflicting CMS dates" }),
        );
      }
      sourceDates[key] = value;
    }
  }
  const issuingStatement =
    [title, ...text.slice(0, 500).split("\n")].find((line) =>
      /^Doporučení\s+(?:(?:ÚOOÚ|Úřadu(?:\s+pro\s+ochranu\s+osobních\s+údajů)?)\s+)?(?:č\.|\(?ze dne)/iu.test(
        line.trim(),
      ),
    ) ?? title;
  const reference =
    classification.kind === "recommendation"
      ? /(?:^|\s)č\.\s*(\d+\s*\/\s*\d{4})/iu.exec(issuingStatement)?.at(1)
      : undefined;
  const issuedOn =
    classification.kind === "recommendation"
      ? statedIssueDate(
          issuingStatement.split(/\s+k\s+/iu).at(0) ?? issuingStatement,
        )
      : Result.ok({ state: "not_stated" } as const);
  if (issuedOn.status === "error") {
    return issuedOn;
  }
  const metadata = {
    title,
    kind: classification.kind,
    statedReference: reference
      ? { state: "stated", value: reference.replace(/\s/gu, "") }
      : { state: "not_stated" },
    issuedOn: issuedOn.value,
    validity: { state: "not_stated", basis: "source_stated" },
  } as const satisfies SoftLawMetadata;
  // Exclude publisher-labelled translations, not pages merely citing EDPB material.
  const excluded =
    /(?:překlad|české znění).{0,120}(?:EDPB|evropského sboru)|(?:EDPB|evropského sboru).{0,120}(?:překlad|české znění)/iu.test(
      title,
    )
      ? "edpb_translation"
      : null;
  return Result.ok({
    metadata,
    text,
    attachments: attachments.value,
    sourceDates,
    excluded,
  });
};
