import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import {
  CADES_DETACHED_FILE_FORMAT,
  XADES_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";

import {
  readSignaturePdf,
  readSignatureWorkerReply,
} from "@/api/lib/files/signature-preview";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import {
  detachedCms,
  detachedXades,
  envelopedXades,
  envelopingXades,
  SIGNATURE_FIXTURE_SIGNERS,
} from "@/api/tests/fixtures/signature-files";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const stored = (bytes: Uint8Array, fileName: string, mimeType: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    mimeType,
    path: fileName,
  });

const signedPdf = async () => {
  const pdf = PDF.create();
  pdf.addPage({ width: 300, height: 200 }).drawText("Petition to the court", {
    x: 20,
    y: 60,
    size: 14,
    font: StandardFonts.Helvetica,
  });
  return await pdf.save();
};

describe("signature file reading", () => {
  test("an enveloping XAdES file previews its PDF with the exact signed bytes", async () => {
    const pdf = await signedPdf();
    const file = stored(await envelopingXades(pdf), "podanie.xml", "text/xml");
    const reply = (await readSignatureWorkerReply(file, "xades")).unwrap();
    expect(reply).toMatchObject({
      standard: "xades",
      packaging: "enveloping",
      document: {
        fileName: "podanie.pdf",
        mimeType: PDF_MIME_TYPE,
        text: expect.stringContaining("Petition to the court"),
      },
    });
    expect((await readSignaturePdf(file, "xades")).unwrap()).toEqual(pdf);
  });

  test("a detached CMS signature reports its signers and stated digest", async () => {
    const file = stored(
      await detachedCms(new TextEncoder().encode("signed bytes")),
      "contract.pdf.p7s",
      CADES_DETACHED_FILE_FORMAT.mimeType,
    );
    const reply = (
      await readSignatureWorkerReply(file, "cadesDetached")
    ).unwrap();
    expect(reply?.packaging).toBe("detached");
    expect(reply?.document).toBeNull();
    expect(reply?.signers.map(({ name }) => name)).toEqual([
      SIGNATURE_FIXTURE_SIGNERS[0],
    ]);
    const pdf = await readSignaturePdf(file, "cadesDetached");
    expect(pdf.isErr() && pdf.error.status).toBe(422);
  });

  test("bytes that hold no signature read as none, not as a failure", async () => {
    const plain = stored(
      new TextEncoder().encode("<invoice><total>100</total></invoice>"),
      "invoice.xml",
      "application/xml",
    );
    expect(
      (await readSignatureWorkerReply(plain, "xades")).unwrap(),
    ).toBeNull();
  });
});

describe("signature text for search, chat and agents", () => {
  test("an XAdES .xml file is read as a signature and its document", async () => {
    const text = await extractFileTextResult(
      stored(
        await envelopedXades(
          "<wniosek><tresc>Wniosek o wpis do rejestru</tresc></wniosek>",
        ),
        "wniosek.xml",
        "text/xml",
      ),
    );
    const value = text.unwrap() ?? "";
    expect(value).toContain(
      "XAdES signature, enveloped. Signatures are unverified.",
    );
    expect(value).toContain(`Signer 1: ${SIGNATURE_FIXTURE_SIGNERS[1]}`);
    expect(value).toContain("Wniosek o wpis do rejestru");
  });

  test("a plain .xml file still has no extracted text", async () => {
    const text = await extractFileTextResult(
      stored(
        new TextEncoder().encode("<invoice><total>100</total></invoice>"),
        "invoice.xml",
        "text/xml",
      ),
    );
    expect(text.unwrap()).toBeNull();
  });

  test.each([
    ["contract.pdf.sig", "application/octet-stream"],
    ["contract.pdf.p7s", CADES_DETACHED_FILE_FORMAT.mimeType],
  ])("%s is read as the signature it holds", async (fileName, mimeType) => {
    const text = await extractFileTextResult(
      stored(
        await detachedCms(new TextEncoder().encode("signed bytes")),
        fileName,
        mimeType,
      ),
    );
    expect(text.unwrap()).toContain(
      `CAdES signature, detached. Signatures are unverified.\nSigner 1: ${SIGNATURE_FIXTURE_SIGNERS[0]}`,
    );
  });

  test("a detached XAdES file names the file it signs", async () => {
    const text = await extractFileTextResult(
      stored(
        await detachedXades("smlouva.pdf", new TextEncoder().encode("x")),
        "smlouva.pdf.xades",
        XADES_FILE_FORMAT.mimeType,
      ),
    );
    expect(text.unwrap()).toContain("Signs: smlouva.pdf");
  });

  test("a .sig file that is not CMS has no text", async () => {
    const text = await extractFileTextResult(
      stored(
        new TextEncoder().encode(
          "-----BEGIN PGP SIGNATURE-----\niQEz\n-----END PGP SIGNATURE-----\n",
        ),
        "release.sig",
        "application/pgp-signature",
      ),
    );
    expect(text.unwrap()).toBeNull();
  });
});
