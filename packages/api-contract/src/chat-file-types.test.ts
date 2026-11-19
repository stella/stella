import { expect, test } from "bun:test";

import {
  CHAT_FILE_TYPE_CONFIG,
  chatFileMimeType,
  chatFileSource,
  runOutputMimeTypeOf,
} from "./chat-file-types";
import { legalFileFormat } from "./document-format";
import { LEGAL_FILE_FORMATS } from "./legal-file-formats";

test("every chat format resolves from its picker MIME and from each extension on a generic upload", () => {
  for (const { extensions, mimeType } of CHAT_FILE_TYPE_CONFIG) {
    expect(chatFileMimeType("attachment", mimeType)).toBe(mimeType);
    for (const extension of extensions) {
      expect(
        chatFileMimeType(
          `attachment${extension.toUpperCase()}`,
          "application/octet-stream",
        ),
      ).toBe(mimeType);
    }
  }
});

test.each(LEGAL_FILE_FORMATS)(
  "Files and chat recognize every registered legal container by media type and name",
  (format) => {
    expect(runOutputMimeTypeOf(`export${format.extension}`)).toBeNull();
    expect(chatFileMimeType(`export${format.extension}`, "image/png")).toBe(
      "image/png",
    );
    for (const [name, mime] of [
      ["export", format.mimeType],
      [`export${format.extension.toUpperCase()}`, "application/octet-stream"],
      [`export${format.extension}`, "text/plain"],
    ] as const) {
      expect(legalFileFormat(mime, name)).toBe(format);
      expect(chatFileMimeType(name, mime)).toBe(format.mimeType);
      expect(chatFileSource(format.mimeType)).toBe("extracted-text");
    }
  },
);
