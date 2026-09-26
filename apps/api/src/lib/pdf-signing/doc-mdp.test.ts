import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import {
  certificationForbidsChanges,
  readDocMdpPermission,
} from "@/api/lib/pdf-signing/doc-mdp";
import { buildCertifiedPdf } from "@/api/tests/helpers/certified-pdf";

describe("reading a certification's modification permission", () => {
  test("reports no certification on an ordinary PDF", async () => {
    const created = PDF.create();
    created.addPage({ width: 300, height: 400 });

    expect(readDocMdpPermission(await PDF.load(await created.save()))).toBe(
      null,
    );
  });

  test.each([1, 2, 3] as const)(
    "reads P=%d off the catalog's certification",
    async (permission) => {
      const pdf = await PDF.load(await buildCertifiedPdf({ permission }));

      expect(readDocMdpPermission(pdf)).toBe(permission);
    },
  );

  test("treats an absent or out-of-range P as the default of 2", async () => {
    for (const permission of [null, 0, 7]) {
      const pdf = await PDF.load(await buildCertifiedPdf({ permission }));

      expect(readDocMdpPermission(pdf)).toBe(2);
    }
  });

  test("refuses stored bytes only when the certification forbids changes", async () => {
    expect(
      await certificationForbidsChanges(
        await buildCertifiedPdf({ permission: 1 }),
      ),
    ).toBe(true);
    for (const permission of [2, 3]) {
      expect(
        await certificationForbidsChanges(
          await buildCertifiedPdf({ permission }),
        ),
      ).toBe(false);
    }
    // Unparseable bytes are phase 1's to report, with their own reason.
    expect(
      await certificationForbidsChanges(new TextEncoder().encode("not a pdf")),
    ).toBe(false);
  });
});
