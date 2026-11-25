import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  CONVERTED_DOCUMENT_FORMATS,
  HTML_RENDERED_DOCUMENT_FORMATS,
} from "@stll/api-contract/converted-document-formats";
import {
  documentFormat,
  RECOGNISED_DOCUMENT_FORMATS,
} from "@stll/api-contract/document-format";
import {
  LEGAL_FILE_FORMATS,
  legalFileFormatProfiles,
} from "@stll/api-contract/legal-file-formats";
import {
  DOCUMENT_MARK_KINDS,
  DocumentMark,
  isDocumentMarkKind,
} from "@stll/ui/document-mark";

import { DocumentIcon } from "@/components/document-icon";

/**
 * Every format a registry declares (the legal formats with their profiles,
 * and the formats previewed by conversion), as Files names it: its own
 * extensions, under its format's media type and under none.
 */
const registeredIdentities = [
  ...LEGAL_FILE_FORMATS.flatMap((format) => {
    const profiles = legalFileFormatProfiles(format);
    const profiled = new Set(profiles.flatMap(({ extensions }) => extensions));
    return [
      {
        name: format.label,
        mimeType: format.mimeType,
        extensions: format.extensions.filter(
          (extension) => !profiled.has(extension),
        ),
      },
      ...profiles.map((profile) => ({
        name: profile.label,
        mimeType: format.mimeType,
        extensions: profile.extensions,
      })),
    ];
  }),
  ...[...CONVERTED_DOCUMENT_FORMATS, ...HTML_RENDERED_DOCUMENT_FORMATS].map(
    (format) => ({
      name: format.label,
      mimeType: format.mimeType,
      extensions: format.extensions,
    }),
  ),
];

/** Formats that keep their family's glyph: an image may show its thumbnail. */
const GLYPH_FAMILIES: ReadonlySet<string> = new Set([
  "image",
  "audio",
  "email",
  "text",
]);

/**
 * Marks of what a file holds rather than what it is: a FatturaPA invoice is
 * an XML file, and only its invoice preview draws the FatturaPA mark.
 */
const CONTENT_MARKS: ReadonlySet<string> = new Set(["fatturaPA"]);

const iconOf = (mimeType: string, fileName: string) =>
  renderToStaticMarkup(
    <DocumentIcon fileName={fileName} mimeType={mimeType} />,
  );

describe("format marks", () => {
  test("draw every registered format with a registered mark of its own", () => {
    const markupByIdentity = new Map<string, string>();
    for (const { name, mimeType, extensions } of registeredIdentities) {
      expect(extensions.length).toBeGreaterThan(0);
      for (const extension of extensions) {
        const fileName = `submission${extension}`;
        const { mark } = documentFormat(mimeType, fileName);
        if (!isDocumentMarkKind(mark)) {
          throw new Error(`${name} (${extension}) has no mark: ${mark}`);
        }
        const drawn = renderToStaticMarkup(<DocumentMark kind={mark} />);
        expect(iconOf(mimeType, fileName)).toBe(drawn);
        expect(iconOf("application/octet-stream", fileName)).toBe(drawn);
        const known = markupByIdentity.get(name);
        expect(known === undefined || known === drawn).toBeTrue();
        markupByIdentity.set(name, drawn);
      }
    }

    // Compared as drawn, so two formats cannot share artwork under two keys.
    const generic = iconOf("application/octet-stream", "submission.bin");
    const drawings = [...markupByIdentity.values()];
    expect(markupByIdentity.size).toBe(registeredIdentities.length);
    expect(new Set(drawings).size).toBe(drawings.length);
    expect(drawings).not.toContain(generic);
  });

  test("every recognised format outside the glyph families draws a mark, and every mark is drawn", () => {
    const drawnMarks = new Set<string>();
    for (const format of RECOGNISED_DOCUMENT_FORMATS) {
      const named = [
        ...format.mimeTypes.map((mimeType) => ({
          mimeType,
          fileName: null,
        })),
        ...format.extensions.map((extension) => ({
          mimeType: null,
          fileName: `submission${extension}`,
        })),
      ];
      expect(named.length).toBeGreaterThan(0);
      for (const { mimeType, fileName } of named) {
        const { kind, mark } = documentFormat(mimeType, fileName);
        if (GLYPH_FAMILIES.has(kind)) {
          expect(isDocumentMarkKind(mark)).toBeFalse();
          continue;
        }
        if (!isDocumentMarkKind(mark)) {
          throw new Error(`${format.label} has no mark: ${mark}`);
        }
        expect(
          renderToStaticMarkup(
            <DocumentIcon fileName={fileName} mimeType={mimeType} />,
          ),
        ).toBe(renderToStaticMarkup(<DocumentMark kind={mark} />));
        drawnMarks.add(mark);
      }
    }
    expect([...drawnMarks].toSorted()).toEqual(
      DOCUMENT_MARK_KINDS.filter((mark) => !CONTENT_MARKS.has(mark)).toSorted(),
    );
  });
});
