import { describe, expect, test } from "bun:test";

import {
  FILE_PART_KINDS_BY_FORMAT,
  filePartContainerFormat,
} from "./file-part-containers";
import { LEGAL_FILE_FORMATS } from "./legal-file-formats";

describe("a part that is itself a container", () => {
  test("every stored format and email is in the table, nothing else", () => {
    expect(Object.keys(FILE_PART_KINDS_BY_FORMAT).toSorted()).toEqual(
      [...LEGAL_FILE_FORMATS.map(({ kind }) => kind), "email"].toSorted(),
    );
  });

  test.each([
    ["application/zip", "spis.zip", "zip"],
    ["application/octet-stream", "DZ_5528193.zfo", "dataBox"],
    ["application/pkcs7-mime", "rozsudek.pdf.p7m", "cades"],
    ["message/rfc822", "podklady.eml", "email"],
    ["application/octet-stream", "odpoved.msg", "email"],
    ["application/vnd.etsi.asic-e+zip", "leping.bdoc", "asicE"],
    ["application/xml", "FV-2026-0042.isdoc", "isdoc"],
    ["application/mbox", "spis-23-C-118-2026.mbox", "mbox"],
    // Browsers declare a mailbox they hold no type for as bytes; its name
    // says what it is.
    ["application/octet-stream", "Doručená pošta.mbox", "mbox"],
    ["application/octet-stream", "korespondence.mbx", "mbox"],
    ["", "Archiv.mbox", "mbox"],
    ["application/vnd.ms-outlook-pst", "korespondence.pst", "pst"],
    ["application/octet-stream", "Archiv 2023.PST", "pst"],
    ["application/octet-stream", "mailbox.ost", "pst"],
  ] as const)("%s named %s is a %s container", (mediaType, name, format) => {
    expect(filePartContainerFormat(mediaType, name)).toBe(format);
  });

  test.each([
    ["application/pdf", "usneseni.pdf"],
    ["image/png", "plan.png"],
    ["text/plain", "poznamka.txt"],
    ["application/octet-stream", "spis.udf"],
    ["application/octet-stream", null],
  ] as const)("%s named %s has no parts", (mediaType, name) => {
    expect(filePartContainerFormat(mediaType, name)).toBeNull();
  });
});
