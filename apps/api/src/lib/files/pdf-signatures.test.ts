import { PDF, PdfDict } from "@libpdf/core";
import type { PdfRef } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  appendSigningRevision,
  isSignedPdf,
  PdfRevisionAppendError,
  savePdfRewrite,
} from "@/api/lib/files/pdf-signatures";
import {
  createEncryptedPdf,
  createSignedPdf,
  readSignatureIntegrity,
} from "@/api/tests/helpers/signed-pdf";
import type { SignatureHidingRevision } from "@/api/tests/helpers/signed-pdf";

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

type SignedShape = {
  name: string;
  certify?: 1 | 2 | 3;
  hidingRevision?: SignatureHidingRevision;
  signatures?: number;
  xrefStream?: boolean;
};

const SIGNED_SHAPES: readonly SignedShape[] = [
  { name: "one approval signature" },
  { name: "certified, no changes allowed", certify: 1 },
  { name: "certified, form filling allowed", certify: 2 },
  { name: "certified, annotations allowed", certify: 3 },
  { name: "two signatures over xref streams", signatures: 2, xrefStream: true },
  { name: "SigFlags dropped later", hidingRevision: "drop-sig-flags" },
  {
    name: "signature value inherited from a parent field",
    hidingRevision: "inherit-signature-value",
  },
  {
    name: "signature field removed in a later xref-stream revision",
    hidingRevision: "remove-signature-field",
    xrefStream: true,
  },
];

const formShowsSignature = (pdf: PDF): boolean => {
  const form = pdf.getForm();
  return (
    form?.properties.hasSignatures === true ||
    form?.getSignatureFields().some((field) => field.isSigned()) === true
  );
};

const certificationLevel = (pdf: PDF): number | undefined => {
  const resolve = (ref: PdfRef) => pdf.getObject(ref);
  const signature = pdf
    .getCatalog()
    .getDict("Perms", resolve)
    ?.getDict("DocMDP", resolve);
  const reference = signature?.getArray("Reference", resolve)?.at(0, resolve);
  return reference instanceof PdfDict
    ? reference.getDict("TransformParams", resolve)?.getNumber("P")?.value
    : undefined;
};

describe("signed PDF detection", () => {
  test.each([...SIGNED_SHAPES])("detects $name", async (shape) => {
    const source = await createSignedPdf(shape);
    const integrity = await readSignatureIntegrity(source);
    expect(integrity).toHaveLength(shape.signatures ?? 1);
    expect(integrity.every(({ digestMatches }) => digestMatches)).toBe(true);
    const pdf = await PDF.load(source);
    // The fixture must be the shape it names: certified at its level, and a
    // hiding revision really hides the signature from the current form.
    expect(certificationLevel(pdf)).toBe(shape.certify);
    expect(formShowsSignature(pdf)).toBe(
      shape.hidingRevision === undefined ||
        shape.hidingRevision === "drop-sig-flags",
    );

    expect(isSignedPdf({ pdf, source })).toBe(true);
  });

  test("detects a signature whose names are spelled with #xx escapes", async () => {
    const hidden = latin1(
      await createSignedPdf({ hidingRevision: "remove-signature-field" }),
    );
    const source = Uint8Array.from(
      hidden.replaceAll("/ByteRange", "/Byte#52ange"),
      (character) => character.codePointAt(0) ?? 0,
    );
    expect(latin1(source)).not.toContain("/ByteRange");
    expect(latin1(source)).toContain("/Byte#52ange");
    const pdf = await PDF.load(source);
    expect(formShowsSignature(pdf)).toBe(false);

    expect(isSignedPdf({ pdf, source })).toBe(true);
  });

  test("leaves an unsigned PDF unflagged", async () => {
    const created = PDF.create();
    created.addPage().drawText("Kupní smlouva", { x: 40, y: 700 });
    const source = await created.save();
    const pdf = await PDF.load(source);

    expect(isSignedPdf({ pdf, source })).toBe(false);
  });

  // libpdf itself writes SignaturesExist when it creates any AcroForm, so the
  // flag alone over-reports; honouring it only keeps such a file unchanged.
  test("treats a SignaturesExist flag as signed even without a signature", async () => {
    const created = PDF.create();
    created.addPage();
    created.getOrCreateForm().createTextField("Name");
    const source = await created.save();
    const pdf = await PDF.load(source);
    expect(latin1(source)).not.toContain("/ByteRange");
    expect(pdf.getForm()?.properties.hasSignatures).toBe(true);

    expect(isSignedPdf({ pdf, source })).toBe(true);
  });
});

describe("PDF rewrites", () => {
  test("fully rewrites an unsigned PDF so replaced values leave the file", async () => {
    const created = PDF.create();
    created.addPage();
    created.setMetadata({ author: "Jana Autorka" });
    const source = await created.save();
    expect(latin1(source)).toContain("Jana Autorka");
    const pdf = await PDF.load(source);
    pdf.setMetadata({ author: "" });

    const result = await savePdfRewrite({ pdf, source });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") {
      return;
    }
    expect(latin1(result.bytes)).not.toContain("Jana Autorka");
    expect((await PDF.load(result.bytes)).getAuthor()).toBeFalsy();
  });

  test("refuses to rewrite a signed PDF the form no longer shows", async () => {
    const source = await createSignedPdf({
      hidingRevision: "inherit-signature-value",
    });
    const pdf = await PDF.load(source);
    pdf.setMetadata({ author: "" });

    expect(await savePdfRewrite({ pdf, source })).toEqual({ status: "signed" });
  });

  test("refuses to rewrite an encrypted PDF", async () => {
    const source = await createEncryptedPdf();
    const pdf = await PDF.load(source);
    expect(pdf.isEncrypted).toBe(true);
    pdf.setMetadata({ author: "" });

    expect(await savePdfRewrite({ pdf, source })).toEqual({
      status: "encrypted",
    });
  });

  test("an appended signing revision never falls back to a rewrite", async () => {
    const signed = await createSignedPdf();
    const pdf = await PDF.load(signed);
    // A pending encryption change is one of the states LibPDF can only
    // save by rewriting the whole file.
    pdf.setProtection({ ownerPassword: "owner" });

    const refused = await appendSigningRevision(pdf);
    expect(Result.isError(refused) && refused.error).toBeInstanceOf(
      PdfRevisionAppendError,
    );

    const untouched = await PDF.load(signed);
    const appended = (await appendSigningRevision(untouched)).unwrap();
    expect(
      Buffer.from(appended.subarray(0, signed.byteLength)).equals(
        Buffer.from(signed),
      ),
    ).toBe(true);
  });
});
