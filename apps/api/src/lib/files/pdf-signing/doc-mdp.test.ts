import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import {
  certificationForbidsChanges,
  readDocMdpPermission,
} from "@/api/lib/files/pdf-signing/doc-mdp";
import { createSignedPdf } from "@/api/tests/helpers/signed-pdf";

const read = async (source: Uint8Array) =>
  readDocMdpPermission({ pdf: await PDF.load(source), source });

describe("reading a certification's modification permission", () => {
  test("reports no certification on an ordinary PDF", async () => {
    const created = PDF.create();
    created.addPage({ width: 300, height: 400 });

    expect(await read(await created.save())).toBe(null);
  });

  test("reports no certification on a signed but uncertified PDF", async () => {
    expect(await read(await createSignedPdf())).toBe(null);
  });

  test.each([1, 2, 3] as const)(
    "reads P=%d off the catalog's certification",
    async (permission) => {
      expect(await read(await createSignedPdf({ certify: permission }))).toBe(
        permission,
      );
    },
  );

  test("treats an absent or out-of-range P as the default of 2", async () => {
    for (const permission of [null, 0, 7]) {
      expect(await read(await createSignedPdf({ certify: permission }))).toBe(
        2,
      );
    }
  });

  test("still finds a certification after a later revision drops its catalog entry", async () => {
    const certified = await createSignedPdf({ certify: 1 });
    // A later revision removes /Perms; the certification signature and the
    // bytes it covers are still in the file, and still forbid changes.
    const pdf = await PDF.load(certified);
    pdf.getCatalog().delete("Perms");
    const stripped = await pdf.save({ incremental: true });
    expect(
      (await PDF.load(stripped)).getCatalog().get("Perms"),
    ).toBeUndefined();

    expect(await read(stripped)).toBe(1);
    expect(await certificationForbidsChanges(stripped)).toBe(true);
  });

  test("refuses stored bytes only when the certification forbids changes", async () => {
    expect(
      await certificationForbidsChanges(await createSignedPdf({ certify: 1 })),
    ).toBe(true);
    for (const permission of [2, 3]) {
      expect(
        await certificationForbidsChanges(
          await createSignedPdf({ certify: permission }),
        ),
      ).toBe(false);
    }
    // Unparseable bytes are phase 1's to report, with their own reason.
    expect(
      await certificationForbidsChanges(new TextEncoder().encode("not a pdf")),
    ).toBe(false);
  });
});
