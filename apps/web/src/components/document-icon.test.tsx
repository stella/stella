import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { documentFormat } from "@stll/api-contract/document-format";
import {
  LEGAL_FILE_FORMATS,
  legalFileFormatProfiles,
} from "@stll/api-contract/legal-file-formats";
import { DocumentMark, isDocumentMarkKind } from "@stll/ui/document-mark";

import { DocumentIcon } from "@/components/document-icon";

/**
 * Every legal format, and every profile of one, as Files names it: its own
 * extensions, under its format's media type and under none.
 */
const legalIdentities = LEGAL_FILE_FORMATS.flatMap((format) => {
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
});

const iconOf = (mimeType: string, fileName: string) =>
  renderToStaticMarkup(
    <DocumentIcon fileName={fileName} mimeType={mimeType} />,
  );

describe("legal format marks", () => {
  test("draw every legal format with a registered mark of its own", () => {
    const markupByIdentity = new Map<string, string>();
    for (const { name, mimeType, extensions } of legalIdentities) {
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
    expect(markupByIdentity.size).toBe(legalIdentities.length);
    expect(new Set(drawings).size).toBe(drawings.length);
    expect(drawings).not.toContain(generic);
  });
});
