import { describe, expect, test } from "bun:test";

import { documentFormat } from "./document-format";
import {
  EML_MIME_TYPE,
  isTnefFileName,
  MSG_MIME_TYPE,
  resolveEmailMimeType,
  TNEF_MIME_TYPE,
} from "./email-mime-types";

describe("an email's media type", () => {
  test.each([
    [EML_MIME_TYPE, "zprava", EML_MIME_TYPE],
    [MSG_MIME_TYPE, "zprava", MSG_MIME_TYPE],
    [TNEF_MIME_TYPE, "zprava", TNEF_MIME_TYPE],
    ["application/ms-tnef", "priloha", TNEF_MIME_TYPE],
    ["Application/MS-TNEF; name=winmail.dat", null, TNEF_MIME_TYPE],
    ["Application/VND.MS-TNEF; name=zprava.dat", "zprava.dat", TNEF_MIME_TYPE],
    ["application/octet-stream", "winmail.dat", TNEF_MIME_TYPE],
    ["application/octet-stream", "WINMAIL.DAT", TNEF_MIME_TYPE],
    ["application/octet-stream", "prilohy/winmail.dat", TNEF_MIME_TYPE],
    ["application/octet-stream", "odpoved.eml", EML_MIME_TYPE],
    ["application/octet-stream", "odpoved.msg", MSG_MIME_TYPE],
    ["application/octet-stream", "export.dat", null],
    ["application/octet-stream", "mywinmail.dat", null],
    [null, null, null],
  ] as const)("%s named %s is %s", (mimeType, fileName, expected) => {
    expect(resolveEmailMimeType({ mimeType, fileName })).toBe(expected);
  });

  test("a TNEF stream is an email, known by its type or by Outlook's name for it", () => {
    for (const [mimeType, fileName] of [
      [TNEF_MIME_TYPE, null],
      ["application/ms-tnef", null],
      ["application/octet-stream", "winmail.dat"],
      [null, "Winmail.dat"],
    ] as const) {
      expect(documentFormat(mimeType, fileName)).toEqual({
        kind: "email",
        mark: "email",
        label: "TNEF",
      });
    }
    // `.dat` alone names no format.
    expect(documentFormat("application/octet-stream", "zaloha.dat").kind).toBe(
      "file",
    );
    expect(isTnefFileName(" winmail.dat ")).toBe(true);
    expect(isTnefFileName("winmail.dat.pdf")).toBe(false);
  });
});
