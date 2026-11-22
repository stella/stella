import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { readEAktaDossier } from "@/api/lib/files/e-akta-dossier";
import {
  makeEAktaFixture,
  xadesSignatureXml,
} from "@/api/tests/fixtures/signed-dossier";

const pdfBytes = async (text: string) => {
  const pdf = PDF.create();
  pdf.addPage({ width: 300, height: 200 }).drawText(text, {
    x: 20,
    y: 60,
    size: 14,
    font: StandardFonts.Helvetica,
  });
  return await pdf.save();
};

const read = async (bytes: Uint8Array) =>
  (await readEAktaDossier(bytes)).unwrap();

describe("e-akta dossiers", () => {
  test("lists every document in order with the bytes its transforms stored", async () => {
    const pdf = await pdfBytes("Határozat");
    const dossier = await read(
      await makeEAktaFixture({
        documents: [
          {
            title: "beadvány.txt",
            extension: "txt",
            bytes: "Tisztelt Bíróság!",
            transforms: ["zip", "base64"],
          },
          { title: "határozat", extension: "pdf", bytes: pdf },
          {
            title: "titkos.txt",
            extension: "txt",
            bytes: "ciphertext",
            transforms: ["zip", "encrypt", "base64"],
          },
        ],
      }),
    );
    expect(dossier.documents.map(({ fileName }) => fileName)).toEqual([
      "beadvány.txt",
      "határozat.pdf",
      "titkos.txt",
    ]);
    const [text, document, encrypted] = dossier.documents;
    expect(new TextDecoder().decode(text?.bytes)).toBe("Tisztelt Bíróság!");
    expect(text?.opaque).toBe(false);
    expect(document?.bytes).toEqual(pdf);
    // Recipients alone can read an encrypted document.
    expect(encrypted?.opaque).toBe(true);
  });

  test("keeps a nested dossier opaque", async () => {
    const inner = await makeEAktaFixture({
      documents: [{ title: "belső.txt", extension: "txt", bytes: "Belső" }],
    });
    const dossier = await read(
      await makeEAktaFixture({
        documents: [
          { title: "csatolt", extension: "es3", bytes: inner },
          // Saved under a generic name, recognized from its root element.
          { title: "mentett", extension: "xml", bytes: inner },
          { title: "adat", extension: "xml", bytes: "<adat>Adat</adat>" },
        ],
      }),
    );
    expect(dossier.documents).toMatchObject([
      { fileName: "csatolt.es3", opaque: true },
      { fileName: "mentett.xml", opaque: true },
      { fileName: "adat.xml", opaque: false },
    ]);
  });

  test("names signers from their signing certificate, frame signers first", async () => {
    const dossier = await read(
      await makeEAktaFixture({
        documents: [
          {
            title: "szerződés.txt",
            extension: "txt",
            bytes: "Szerződés",
            signers: ["Example document signer"],
          },
        ],
        frameSigners: [
          {
            id: "F0",
            signer: "Example frame signer",
            // A chain certificate listed first must not be taken for the signer.
            decoy: "Example certification authority",
          },
        ],
      }),
    );
    expect(dossier.signers.map(({ name }) => name)).toEqual([
      "Example frame signer",
      "Example document signer",
    ]);
    expect(new Set(dossier.signers.map(({ id }) => id)).size).toBe(2);
  });

  test("falls back to the dossier's stated signer name without a certificate", async () => {
    const dossier = await read(
      await makeEAktaFixture({
        documents: [{ title: "irat.txt", extension: "txt", bytes: "Irat" }],
        frameSigners: [
          {
            id: "F0",
            signer: "Example unused certificate",
            statedName: "Example\nstated   signer",
            withoutCertificate: true,
          },
        ],
      }),
    );
    expect(dossier.signers).toEqual([
      { id: "signature-0", name: "Example stated signer" },
    ]);
  });

  test("recognizes a dossier whose schema binds its own namespace", async () => {
    const dossier = await read(
      await makeEAktaFixture({
        namespace: "http://www.e-szigno.hu/2010/kozjegyzo20100101#",
        documents: [{ title: "okirat.txt", extension: "txt", bytes: "Okirat" }],
      }),
    );
    expect(dossier.documents).toHaveLength(1);
  });

  test("refuses XML that is not a dossier and a document that is not base64", async () => {
    const signature = await xadesSignatureXml({
      id: "S0",
      signer: "Example signer",
    });
    const notDossier = await readEAktaDossier(
      new TextEncoder().encode(signature),
    );
    expect(notDossier.isErr() && notDossier.error.reason).toBe("invalid");

    const valid = new TextDecoder().decode(
      await makeEAktaFixture({
        documents: [{ title: "irat.txt", extension: "txt", bytes: "Irat" }],
      }),
    );
    const corrupted = valid.replace(/(<ds:Object Id="O0">)[^<]+/u, "$1%%%");
    expect(corrupted).not.toBe(valid);
    const result = await readEAktaDossier(new TextEncoder().encode(corrupted));
    expect(result.isErr() && result.error.reason).toBe("invalid");
  });

  test("refuses document type declarations", async () => {
    const result = await readEAktaDossier(
      new TextEncoder().encode(
        '<!DOCTYPE es:Dossier [<!ENTITY x "y">]><es:Dossier xmlns:es="https://www.microsec.hu/ds/e-szigno30#"/>',
      ),
    );
    expect(result.isErr()).toBe(true);
  });
});
