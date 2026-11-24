import { describe, expect, test } from "bun:test";

import { parseXadesFile } from "@/api/lib/files/xades";
import {
  certificateBase64,
  detachedXades,
  digestOf,
  envelopedXades,
  envelopingXades,
  FIXTURE_SIGNING_TIME,
  SIGNATURE_FIXTURE_SIGNERS,
} from "@/api/tests/fixtures/signature-files";

const encode = (text: string) => new TextEncoder().encode(text);
const pdfLike = encode("%PDF-1.7\nsigned petition body\n%%EOF\n");

describe("XAdES signature files", () => {
  test("an enveloping signature carries its document's exact bytes", async () => {
    const parsed = parseXadesFile(await envelopingXades(pdfLike)).unwrap();
    expect(parsed).toMatchObject({
      standard: "xades",
      packaging: "enveloping",
      references: [],
      documentText: null,
      embedded: { mimeType: "application/pdf" },
      signers: [
        {
          id: "signature-0.signer-0",
          name: SIGNATURE_FIXTURE_SIGNERS[0],
          signedAt: FIXTURE_SIGNING_TIME.toISOString(),
        },
      ],
    });
    expect(parsed.embedded?.bytes).toEqual(pdfLike);
  });

  test("a detached signature names the file beside it and its digest", async () => {
    const name = "návrh smlouvy.pdf";
    const parsed = parseXadesFile(await detachedXades(name, pdfLike)).unwrap();
    expect(parsed.packaging).toBe("detached");
    expect(parsed.references).toEqual([
      {
        fileName: name,
        digest: {
          algorithm: "SHA-256",
          hex: Buffer.from(await digestOf("SHA-256", pdfLike)).toString("hex"),
        },
      },
    ]);
  });

  test("a transformed reference states no comparable digest", async () => {
    const parsed = parseXadesFile(
      await detachedXades("form.xml", pdfLike, { transformed: true }),
    ).unwrap();
    expect(parsed.references).toEqual([{ fileName: "form.xml", digest: null }]);
  });

  test("an enveloped signature reads its document without the signature", async () => {
    const parsed = parseXadesFile(
      await envelopedXades(
        "<wniosek><tytul>Wniosek o wydanie zaświadczenia</tytul><tresc>Proszę o wydanie zaświadczenia.</tresc></wniosek>",
      ),
    ).unwrap();
    expect(parsed.packaging).toBe("enveloped");
    expect(parsed.signers.at(0)?.name).toBe(SIGNATURE_FIXTURE_SIGNERS[1]);
    expect(parsed.documentText).toBe(
      "Wniosek o wydanie zaświadczenia\nProszę o wydanie zaświadczenia.",
    );
    expect(parsed.documentText).not.toContain("AAAA");
  });

  test("keeps mixed text in document order", async () => {
    const parsed = parseXadesFile(
      await envelopedXades(
        "<podani><odstavec>Zaplaťte <b>100</b> EUR do <i>15. 3.</i></odstavec><podpis>Jan</podpis></podani>",
      ),
    ).unwrap();
    expect(parsed.documentText).toBe("Zaplaťte 100 EUR do 15. 3.\nJan");
  });

  test.each([
    ["a plain XML document", "<invoice><total>100</total></invoice>"],
    [
      "an XML signature without XAdES properties",
      '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:Reference URI="a.pdf"/></ds:SignedInfo></ds:Signature>',
    ],
    [
      "a document that only mentions both namespaces",
      "<note>http://www.w3.org/2000/09/xmldsig# and http://uri.etsi.org/01903/</note>",
    ],
    ["text that is not XML", "Signed by hand"],
  ])("does not claim %s", (_label, xml) => {
    const parsed = parseXadesFile(encode(xml));
    expect(parsed.isErr() && parsed.error.reason).toBe("not_signature");
  });

  test("refuses a document type declaration before reading entities", async () => {
    const signature = new TextDecoder().decode(await envelopingXades(pdfLike));
    const withDoctype = signature.replace(
      "<ds:Signature",
      '<!DOCTYPE x [<!ENTITY e "y">]><ds:Signature',
    );
    expect(withDoctype).not.toBe(signature);
    const parsed = parseXadesFile(encode(withDoctype));
    expect(parsed.isErr() && parsed.error.reason).toBe("not_signature");
  });

  test("a signed-properties reference without its type stays metadata", async () => {
    const typed = new TextDecoder().decode(
      await detachedXades("smlouva.pdf", pdfLike),
    );
    const untyped = typed.replace(
      ' Type="http://uri.etsi.org/01903#SignedProperties"',
      "",
    );
    expect(untyped).not.toBe(typed);
    const container = `<asic:XAdESSignatures xmlns:asic="http://uri.etsi.org/02918/v1.2.1#">${untyped.replace(/^<\?xml[^>]*>\n/u, "")}</asic:XAdESSignatures>`;
    const parsed = parseXadesFile(encode(container)).unwrap();
    expect(parsed.packaging).toBe("detached");
    expect(parsed.references.map(({ fileName }) => fileName)).toEqual([
      "smlouva.pdf",
    ]);
  });

  test("counts a countersignature as part of its signature", async () => {
    const outer = new TextDecoder().decode(await envelopingXades(pdfLike));
    const counter = new TextDecoder()
      .decode(
        await envelopingXades(pdfLike, { signer: "Example countersigner" }),
      )
      .replace(/^<\?xml[^>]*>\n/u, "");
    const nested = outer.replace(
      "</xades:QualifyingProperties>",
      () =>
        `<xades:UnsignedProperties><xades:UnsignedSignatureProperties><xades:CounterSignature>${counter}</xades:CounterSignature></xades:UnsignedSignatureProperties></xades:UnsignedProperties></xades:QualifyingProperties>`,
    );
    expect(nested).not.toBe(outer);
    const parsed = parseXadesFile(encode(nested)).unwrap();
    expect(parsed.signers.map(({ name }) => name)).toEqual([
      SIGNATURE_FIXTURE_SIGNERS[0],
    ]);
  });

  test("reads a signature declared in a Central European encoding", async () => {
    const utf8 = new TextDecoder().decode(
      await envelopedXades("<podanie><text>Žiadosť o vydanie</text></podanie>"),
    );
    const latin2 = utf8.replace('encoding="UTF-8"', 'encoding="ISO-8859-2"');
    expect(latin2).not.toBe(utf8);
    // Re-encode the two non-ASCII letters as ISO-8859-2 bytes.
    const encoded = Buffer.concat(
      latin2
        .split(/(Žiadosť)/u)
        .map((part) =>
          part === "Žiadosť"
            ? Buffer.from([0xae, 0x69, 0x61, 0x64, 0x6f, 0x73, 0xbb])
            : Buffer.from(part, "utf-8"),
        ),
    );
    expect(encoded.includes(Buffer.from("Žiadosť"))).toBe(false);
    const parsed = parseXadesFile(new Uint8Array(encoded)).unwrap();
    expect(parsed.documentText).toBe("Žiadosť o vydanie");
  });

  const text = async (bytes: Promise<Uint8Array>) =>
    new TextDecoder().decode(await bytes);

  test("a countersigner's time is not the outer signer's", async () => {
    const outer = (await text(envelopingXades(pdfLike))).replace(
      /<xades:SigningTime>[^<]*<\/xades:SigningTime>/u,
      "",
    );
    const counter = (
      await text(envelopingXades(pdfLike, { signer: "Example countersigner" }))
    ).replace(/^<\?xml[^>]*>\n/u, "");
    const nested = outer.replace(
      "</xades:QualifyingProperties>",
      () =>
        `<xades:UnsignedProperties><xades:UnsignedSignatureProperties><xades:CounterSignature>${counter}</xades:CounterSignature></xades:UnsignedSignatureProperties></xades:UnsignedProperties></xades:QualifyingProperties>`,
    );
    const parsed = parseXadesFile(encode(nested)).unwrap();
    expect(parsed.signers).toEqual([
      {
        id: "signature-0.signer-0",
        name: SIGNATURE_FIXTURE_SIGNERS[0],
        signedAt: null,
      },
    ]);
  });

  test("qualifying properties without referenced signed properties are not XAdES", async () => {
    const detached = await text(detachedXades("smlouva.pdf", pdfLike));
    const unreferenced = detached.replace(
      'URI="#signature-1-props"',
      'URI="#elsewhere"',
    );
    expect(unreferenced).not.toBe(detached);
    const parsed = parseXadesFile(encode(unreferenced));
    expect(parsed.isErr() && parsed.error.reason).toBe("not_signature");
  });

  test("names the signer the signed properties identify among several certificates", async () => {
    const signed = await text(detachedXades("smlouva.pdf", pdfLike));
    const signerCertificate = await certificateBase64(
      SIGNATURE_FIXTURE_SIGNERS[0],
    );
    const issuerCertificate = await certificateBase64(
      SIGNATURE_FIXTURE_SIGNERS[1],
    );
    const issuerFirst = signed.replace(
      "<ds:X509Data>",
      () =>
        `<ds:X509Data><ds:X509Certificate>${issuerCertificate}</ds:X509Certificate>`,
    );
    expect(
      parseXadesFile(encode(issuerFirst)).unwrap().signers.at(0)?.name,
    ).toBeNull();
    const certDigest = Buffer.from(
      await digestOf("SHA-256", Buffer.from(signerCertificate, "base64")),
    ).toString("base64");
    const identified = issuerFirst.replace(
      "<xades:SignedSignatureProperties>",
      () =>
        `<xades:SignedSignatureProperties><xades:SigningCertificateV2><xades:Cert><xades:CertDigest><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${certDigest}</ds:DigestValue></xades:CertDigest></xades:Cert></xades:SigningCertificateV2>`,
    );
    expect(
      parseXadesFile(encode(identified)).unwrap().signers.at(0)?.name,
    ).toBe(SIGNATURE_FIXTURE_SIGNERS[0]);
  });

  test("an unencoded text object is read as text, not as base64", async () => {
    const enveloping = await text(envelopingXades(pdfLike));
    const plain = enveloping.replace(
      /<ds:Object Id="document"[^>]*>[^<]*<\/ds:Object>/u,
      '<ds:Object Id="document" MimeType="text/plain">Paid</ds:Object>',
    );
    expect(plain).not.toBe(enveloping);
    expect(parseXadesFile(encode(plain)).unwrap()).toMatchObject({
      packaging: "enveloping",
      embedded: null,
      documentText: "Paid",
    });
  });

  test("a reference may name an element inside an object", async () => {
    const enveloping = await text(envelopingXades(pdfLike));
    const nested = enveloping
      .replace(
        /<ds:Object Id="document"[^>]*>[^<]*<\/ds:Object>/u,
        '<ds:Object><Terms Id="terms">Payment within 30 days</Terms></ds:Object>',
      )
      .replace('URI="#document"', 'URI="#terms"');
    expect(parseXadesFile(encode(nested)).unwrap()).toMatchObject({
      packaging: "enveloping",
      documentText: "Payment within 30 days",
    });
  });

  test("an enveloped signature of one element reads only that element", async () => {
    const signed = (
      await text(
        envelopedXades(
          '<doc><Terms Id="terms">Signed terms</Terms><Notes>Unsigned note</Notes></doc>',
        ),
      )
    ).replace('URI=""', 'URI="#terms"');
    const parsed = parseXadesFile(encode(signed)).unwrap();
    expect(parsed.packaging).toBe("enveloped");
    expect(parsed.documentText).toBe("Signed terms");
  });

  test("a wrapper whose signature signs only another file is detached", async () => {
    const detached = (
      await text(detachedXades("contract.pdf", pdfLike))
    ).replace(/^<\?xml[^>]*>\n/u, "");
    const parsed = parseXadesFile(
      encode(`<envelope><meta>Filed 2026</meta>${detached}</envelope>`),
    ).unwrap();
    expect(parsed.packaging).toBe("detached");
    expect(parsed.documentText).toBeNull();
    expect(parsed.references.map(({ fileName }) => fileName)).toEqual([
      "contract.pdf",
    ]);
  });

  test("a fragment reference names its file but states no file digest", async () => {
    const detached = (await text(detachedXades("form.xml", pdfLike))).replace(
      'URI="form.xml"',
      'URI="form.xml#section"',
    );
    expect(parseXadesFile(encode(detached)).unwrap().references).toEqual([
      { fileName: "form.xml", digest: null },
    ]);
  });

  test("a digest of the wrong length is not a stated digest", async () => {
    const detached = await text(detachedXades("smlouva.pdf", pdfLike));
    const short = detached.replace(
      /(<ds:Reference URI="smlouva\.pdf">[\s\S]*?<ds:DigestValue>)[^<]*/u,
      "$1AAAA",
    );
    expect(short).not.toBe(detached);
    expect(parseXadesFile(encode(short)).unwrap().references).toEqual([
      { fileName: "smlouva.pdf", digest: null },
    ]);
  });
});
