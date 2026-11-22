import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { readZepContainer } from "@/api/lib/files/zep-container";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import {
  makeZepEnvelope,
  makeZepFixture,
} from "@/api/tests/fixtures/signed-dossier";

const text = (value: string) => new TextEncoder().encode(value);

describe("ZEPf containers", () => {
  test("lists the envelope's documents, attached files and every stated signer", async () => {
    const bytes = await makeZepFixture({
      envelope: makeZepEnvelope({
        body: "Žiadosť o vydanie rozhodnutia",
        attachments: [
          {
            fileName: "príloha.txt",
            mimeType: "text/plain",
            bytes: text("Príloha č. 1"),
          },
        ],
      }),
      xadesSigner: "Example XML signer",
      extra: { "D20260105090000Z/Other/poznámka.txt": "Poznámka" },
    });
    const { documents, signers } = (await readZepContainer(bytes)).unwrap();
    expect(
      documents.map(({ fileName, bytes: content }) => [
        fileName,
        new TextDecoder().decode(content),
      ]),
    ).toEqual([
      ["M20260105090000Z.txt", "Žiadosť o vydanie rozhodnutia"],
      ["príloha.txt", "Príloha č. 1"],
      ["D20260105090000Z/Other/poznámka.txt", "Poznámka"],
    ]);
    // Certificates and other validation data are not documents.
    // Signatures keep the container's entry order.
    expect(signers.map(({ name }) => name)).toEqual([
      "Example first signer",
      "Example XML signer",
    ]);
  });

  test("reads the signature an S/MIME envelope carries itself", async () => {
    const mixed = makeZepEnvelope({ body: "Podpísaná správa" });
    const boundary = "zep-fixture-signed";
    const signature = Buffer.from(
      await wrapP7m(mixed, { detached: true }),
    ).toString("base64");
    const envelope = text(
      [
        "MIME-Version: 1.0",
        `Content-Type: multipart/signed; protocol="application/x-pkcs7-signature"; micalg=sha-256; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        new TextDecoder().decode(mixed),
        `--${boundary}`,
        'Content-Type: application/x-pkcs7-signature; name="smime.p7s"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="smime.p7s"',
        "",
        signature,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const zip = new ZipArchive();
    zip.set("M20260105090000Z.eml", envelope);
    const { documents, signers } = (
      await readZepContainer(await zip.generate())
    ).unwrap();
    expect(documents.map(({ fileName }) => fileName)).toEqual([
      "M20260105090000Z.txt",
    ]);
    expect(signers.map(({ name }) => name)).toEqual(["Example first signer"]);
  });

  test("lists an unknown entry without dropping it", async () => {
    const bytes = await makeZepFixture({
      envelope: makeZepEnvelope({ body: "Text" }),
      mainDirectory: false,
      extra: { "readme.bin": Uint8Array.of(0, 1, 2) },
    });
    const { documents } = (await readZepContainer(bytes)).unwrap();
    expect(documents.map(({ fileName }) => fileName)).toEqual([
      "M20260105090000Z.txt",
      "readme.bin",
    ]);
  });

  test("refuses a ZIP without a document envelope", async () => {
    const zip = new ZipArchive();
    zip.set("S20260105090000Z.p7s", "signature");
    zip.set("document.txt", "Text");
    const result = await readZepContainer(await zip.generate());
    expect(result.isErr() && result.error.reason).toBe("invalid");
  });
});
