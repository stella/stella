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

const read = async (bytes: Uint8Array) =>
  (await readXadesZepEnvelope(bytes)).unwrap();

describe("XAdES_ZEP envelopes", () => {
  test.each(["detached", "enveloping", "manifest"] as const)(
    "names each %s data object from its stated format and reads its content",
    async (form) => {
      const envelope = await read(await makeXadesZepFixture({ objects, form }));
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

  test("lists every signer of the composite form", async () => {
    const envelope = await read(
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
    const envelope = await read(
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
    const envelope = await read(bytes);
    expect(envelope.documents).toHaveLength(objects.length);
  });

  test("refuses XML that is not an envelope and a binary object that is not base64", async () => {
    const signature = await xadesSignatureXml({
      id: "S0",
      signer: "Example signer",
    });
    const plain = await readXadesZepEnvelope(
      new TextEncoder().encode(signature),
    );
    expect(plain.isErr() && plain.error.reason).toBe("invalid");

    const valid = new TextDecoder().decode(
      await makeXadesZepFixture({ objects }),
    );
    const corrupted = valid.replace(/(Id="Data1">)[^<]+/u, "$1%%%");
    expect(corrupted).not.toBe(valid);
    const result = await readXadesZepEnvelope(
      new TextEncoder().encode(corrupted),
    );
    expect(result.isErr() && result.error.reason).toBe("invalid");
  });
});
