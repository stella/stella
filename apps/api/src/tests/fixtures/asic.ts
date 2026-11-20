import { ASIC_E_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";
import { ZipArchive } from "@stll/docx-core/zip";

import type { AsicMimeType } from "@/api/lib/files/asic-container";

type AsicFixtureOptions = {
  mimeType?: AsicMimeType;
  mimeTypeEntry?: "include" | "omit";
  members?: readonly { fileName: string; bytes: string | Uint8Array }[];
  signature?: "xades" | "cades" | "timestamp";
};

// Structurally representative ZIP archives for reader tests. The marker
// contents are inert placeholders and contain no signatures or certificates.
export const makeAsicFixture = async ({
  mimeType = ASIC_E_FILE_FORMAT.mimeType,
  mimeTypeEntry = "include",
  members = [{ fileName: "document.txt", bytes: "ASiC fixture payload" }],
  signature = "xades",
}: AsicFixtureOptions = {}): Promise<Uint8Array> => {
  const zip = new ZipArchive();
  const isExtended = mimeType === ASIC_E_FILE_FORMAT.mimeType;
  if (mimeTypeEntry === "include") {
    zip.set("mimetype", mimeType, { compression: "store" });
  }
  for (const { fileName, bytes } of members) {
    zip.set(fileName, bytes);
  }
  switch (signature) {
    case "xades":
      zip.set(
        isExtended ? "META-INF/signatures0.xml" : "META-INF/signatures.xml",
        "<fixture/>",
      );
      break;
    case "cades":
      zip.set("META-INF/signature.p7s", "fixture");
      break;
    case "timestamp":
      zip.set("META-INF/timestamp.tst", "fixture");
      break;
    default:
      signature satisfies never;
  }
  if (isExtended && signature !== "xades") {
    zip.set("META-INF/ASiCManifest.xml", "<fixture/>");
  }
  return await zip.generate({ compression: "deflate" });
};
