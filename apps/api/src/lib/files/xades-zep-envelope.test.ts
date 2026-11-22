import { describe, expect, test } from "bun:test";

import { readXadesZepEnvelope } from "@/api/lib/files/xades-zep-envelope";
import {
  makeXadesZepFixture,
  xadesSignatureXml,
  type XadesZepFixtureObject,
} from "@/api/tests/fixtures/signed-dossier";

const pdf = new TextEncoder().encode("%PDF-1.4\n%synthetic\n");
const objects: XadesZepFixtureObject[] = [
  {
    id: "Data1",
    description: "Rozhodnutie",
    mimeType: "application/pdf",
    content: pdf,
  },
  {
    id: "Data2",
    description: "Žiadosť",
    mimeType: "application/xml",
    content: {
      xml: '<ziadost xmlns="urn:example:form"><meno>Example applicant</meno><predmet>Vydanie rozhodnutia</predmet></ziadost>',
    },
  },
];

const read = (bytes: Uint8Array) => readXadesZepEnvelope(bytes).unwrap();

describe("XAdES_ZEP envelopes", () => {
  test.each(["detached", "enveloping", "manifest"] as const)(
    "names each %s data object from its stated format and reads its content",
    async (form) => {
      const envelope = read(await makeXadesZepFixture({ objects, form }));
      expect(envelope.receipt).toBe(false);
      expect(
        envelope.documents.map(({ fileName, bytes }) => [
          fileName,
          new TextDecoder().decode(bytes),
        ]),
      ).toEqual([
        ["Rozhodnutie.pdf", "%PDF-1.4\n%synthetic\n"],
        ["Žiadosť.xml", "Example applicant\nVydanie rozhodnutia"],
      ]);
      expect(envelope.signers.map(({ name }) => name)).toEqual([
        "Example envelope signer",
      ]);
    },
  );

  test("keeps inline markup in its place in an XML object's text", async () => {
    const envelope = read(
      await makeXadesZepFixture({
        objects: [
          {
            id: "Data1",
            description: "Výrok",
            mimeType: "application/xml",
            content: {
              xml: "<vyrok><p>Žalovaný je <b>povinný</b> zaplatiť trovy.</p><p>Odvolanie <i>nie je</i> prípustné.</p></vyrok>",
            },
          },
        ],
      }),
    );
    expect(
      envelope.documents.map(({ bytes }) => new TextDecoder().decode(bytes)),
    ).toEqual([
      "Žalovaný je povinný zaplatiť trovy.\nOdvolanie nie je prípustné.",
    ]);
  });

  test("leaves out an object only an unsigned manifest names", async () => {
    const signed = new TextDecoder().decode(
      await makeXadesZepFixture({ objects }),
    );
    const stray =
      '<ds:Object Id="Stray">Unsigned text</ds:Object><ds:Object><ds:Manifest Id="Unsigned"><ds:Reference URI="#Stray"><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>AAAA</ds:DigestValue></ds:Reference></ds:Manifest></ds:Object>';
    const withStray = signed.replace(
      "<ds:Signature ",
      () => `${stray}<ds:Signature `,
    );
    expect(withStray).not.toBe(signed);
    const envelope = read(new TextEncoder().encode(withStray));
    expect(envelope.documents.map(({ fileName }) => fileName)).toEqual([
      "Rozhodnutie.pdf",
      "Žiadosť.xml",
    ]);
  });

  test("lists every signer of the composite form", async () => {
    const envelope = read(
      await makeXadesZepFixture({
        objects,
        form: "composite",
        signers: ["Example first signer", "Example second signer"],
      }),
    );
    expect(envelope.documents).toHaveLength(2);
    expect(envelope.signers.map(({ name }) => name)).toEqual([
      "Example first signer",
      "Example second signer",
    ]);
  });

  test("names an undescribed object by its position and type", async () => {
    const [first] = objects;
    if (first === undefined) {
      throw new Error("Expected a fixture object");
    }
    const { description: _, ...undescribed } = first;
    const envelope = read(
      await makeXadesZepFixture({ objects: [undescribed] }),
    );
    expect(envelope.documents.map(({ fileName }) => fileName)).toEqual([
      "document-1.pdf",
    ]);
  });

  test("leaves out the signature's own properties, which are not signed data", async () => {
    const bytes = await makeXadesZepFixture({ objects });
    // The signing certificate's qualifying properties sit in an object too.
    expect(new TextDecoder().decode(bytes)).toContain(
      "<ds:Object><xades:QualifyingProperties",
    );
    const envelope = read(bytes);
    expect(envelope.documents).toHaveLength(objects.length);
  });

  test("refuses XML that is not an envelope and a binary object that is not base64", async () => {
    const signature = await xadesSignatureXml({
      id: "S0",
      signer: "Example signer",
    });
    const plain = readXadesZepEnvelope(new TextEncoder().encode(signature));
    expect(plain.isErr() && plain.error.reason).toBe("invalid");

    const valid = new TextDecoder().decode(
      await makeXadesZepFixture({ objects }),
    );
    const corrupted = valid.replace(/(Id="Data1">)[^<]+/u, "$1%%%");
    expect(corrupted).not.toBe(valid);
    const result = readXadesZepEnvelope(new TextEncoder().encode(corrupted));
    expect(result.isErr() && result.error.reason).toBe("invalid");
  });
});
