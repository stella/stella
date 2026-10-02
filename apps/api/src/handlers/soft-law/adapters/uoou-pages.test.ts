import { panic } from "better-result";
import { expect, test } from "bun:test";

import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";

import {
  classifyUoouUrl,
  listUoouSourceFields,
  parseUoouPage,
  readUoouJsonLd,
  UOOU_ORIGIN,
} from "./uoou-pages";

const METHODOLOGY_URL = `${UOOU_ORIGIN}/profesional/metodiky-a-doporuceni-pro-spravce/metodika-test`;

type GeneratedPageOptions = {
  jsonLd?: unknown;
  attachmentHrefs?: readonly string[];
};
const generatedPage = ({
  jsonLd,
  attachmentHrefs = [],
}: GeneratedPageOptions = {}) => `
  <!doctype html>
  <html><head>${jsonLd === undefined ? "" : `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`}</head>
  <body><h1>Metodika pro správce</h1>
    <div class="_cms-content"><p>Úřad doporučuje tento postup pro správce.</p></div>
    <div class="u-l-documents">${attachmentHrefs.map((href) => `<a href="${href}">Příloha</a>`).join("")}</div>
  </body></html>
`;

const expectIngestionFailure = (
  result: ReturnType<typeof parseUoouPage>,
  message: string,
) => {
  if (result.status !== "error") {
    panic(`Invalid publisher page accepted: ${message}`);
  }
  expect(result.error).toBeInstanceOf(SoftLawIngestionError);
  expect(result.error.message).toBe(message);
};

test("JSON-LD graph nodes retain their exact CMS dates through nested graphs and arrays", () => {
  const dates = {
    dateCreated: "2024-01-01T10:00:00+0100",
    datePublished: "2024-01-02T11:00:00+0100",
    dateModified: "2024-01-03T12:00:00+0100",
  };
  const parsed = parseUoouPage(
    generatedPage({
      jsonLd: {
        "@context": "https://schema.org",
        "@graph": [
          { dateCreated: dates.dateCreated },
          {
            "@graph": [
              { datePublished: dates.datePublished },
              { dateModified: dates.dateModified },
            ],
          },
          { dateModified: dates.dateModified },
        ],
      },
    }),
    METHODOLOGY_URL,
  ).unwrap();
  expect(parsed.sourceDates).toEqual({
    "cms.dateCreated": dates.dateCreated,
    "cms.datePublished": dates.datePublished,
    "cms.dateModified": dates.dateModified,
  });
  expect(parsed.metadata.issuedOn).toEqual({ state: "not_stated" });
});

test("conflicting dates across JSON-LD graph nodes fail with the classified conflict error", () => {
  const first = "2024-01-01T12:00:00+0100";
  const second = "2024-02-01T12:00:00+0100";
  expect(first).not.toBe(second);
  expectIngestionFailure(
    parseUoouPage(
      generatedPage({
        jsonLd: {
          "@graph": [
            { dateModified: first },
            { "@graph": [{ dateModified: second }] },
          ],
        },
      }),
      METHODOLOGY_URL,
    ),
    "Conflicting CMS dates",
  );
});

test("every thematic guidance root admits descendants only across a path segment boundary", () => {
  // Independent publisher path contract: removing a root from classification must fail this matrix.
  const roots = [
    "/profesional/poverenec-pro-ochranu-osobnich-udaju",
    "/profesional/posouzeni-vlivu-na-ochranu-osobnich-udaju-dpia",
    "/profesional/predavani-osobnich-udaju-do-tretich-zemi-1",
    "/profesional/hodnoceni-shody-s-gdpr",
    "/profesional/poruseni-zabezpeceni-osobnich-udaju",
  ];
  for (const root of roots) {
    for (const suffix of ["", "/", "/guidance", "/guidance/detail"]) {
      expect(classifyUoouUrl(`${UOOU_ORIGIN}${root}${suffix}`)).toEqual({
        type: "guidance",
        kind: "guideline",
      });
    }
    for (const suffix of ["-unrelated", "ish", ".html"]) {
      expect(classifyUoouUrl(`${UOOU_ORIGIN}${root}${suffix}`)).toEqual({
        type: "excluded",
        reason: "outside_guidance_slice",
      });
    }
  }
});

test("the attachment cap counts distinct owned downloads after fragment deduplication", () => {
  const links = Array.from(
    { length: 19 },
    (_, index) => `/media/item-${index}.${index % 2 === 0 ? "pdf" : "docx"}`,
  );
  const redundant = [
    ...links,
    ...links.map((href) => `${href}#page=1`),
    ...links,
  ];
  expect(redundant.length).toBeGreaterThan(19);
  const allowed = parseUoouPage(
    generatedPage({ attachmentHrefs: redundant }),
    METHODOLOGY_URL,
  ).unwrap();
  expect(allowed.attachments).toEqual(
    links.map((href) => `${UOOU_ORIGIN}${href}`),
  );
  expectIngestionFailure(
    parseUoouPage(
      generatedPage({ attachmentHrefs: [...redundant, "/media/item-19.docx"] }),
      METHODOLOGY_URL,
    ),
    "Too many guidance attachments",
  );
});

test("malformed URLs fail closed and malformed attachment locators are classified parser errors", () => {
  for (const url of ["", "not a URL", "https://["]) {
    expect(classifyUoouUrl(url)).toEqual({
      type: "excluded",
      reason: "outside_guidance_slice",
    });
    expectIngestionFailure(
      parseUoouPage(generatedPage(), url),
      "Page is outside the guidance slice",
    );
  }
  expectIngestionFailure(
    parseUoouPage(
      generatedPage({ attachmentHrefs: ["https://["] }),
      METHODOLOGY_URL,
    ),
    "Invalid guidance attachment URL",
  );
});

test("the JSON-LD reader returns classified errors while invalid retained source parts panic", () => {
  const malformed = generatedPage({ jsonLd: "not an object" });
  const result = readUoouJsonLd(malformed);
  if (result.status !== "error") {
    panic("JSON-LD reader accepted a scalar publisher object");
  }
  expect(result.error).toBeInstanceOf(SoftLawIngestionError);
  expect(result.error.message).toBe("Invalid JSON-LD object");
  expect(() => listUoouSourceFields({})).toThrow("Stored page is missing");
  expect(() => listUoouSourceFields({ page: "<h1>Guidance</h1>" })).toThrow(
    "Stored guidance title or body is missing",
  );
  expect(() => listUoouSourceFields({ page: malformed })).toThrow(
    "Stored publisher JSON-LD is invalid: Invalid JSON-LD object",
  );
});
