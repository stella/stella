import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { expect, test } from "bun:test";

// The embedded file's Subtype is a PDF name: "/" must be written once as
// "#2F". Escaping it before the name encoder escapes "#" again produced
// "application#232Fxml", which PDF/A-3 validators reject (rule 6.8-1).
test("an attached file keeps a valid MIME subtype", async () => {
  const pdf = PDF.create();
  pdf.addPage({ width: 595, height: 842 });
  pdf.attachments.add("invoice.xml", new TextEncoder().encode("<Invoice/>"), {
    mimeType: "application/xml",
  });
  const bytes = await pdf.save();

  const raw = new TextDecoder("latin1").decode(bytes);
  expect(raw).toContain("/Subtype /application#2Fxml");
  expect(raw).not.toContain("#232F");

  const reloaded = await PDF.load(bytes);
  expect(reloaded.attachments.list().get("invoice.xml")).toMatchObject({
    mimeType: "application/xml",
  });
});

// The fix is a dependency patch keyed by version: upgrading @libpdf/core
// without moving the patch would silently bring the double escape back.
test("the attachment patch follows the pinned @libpdf/core version", async () => {
  const manifest: {
    catalog: Record<string, string>;
    patchedDependencies: Record<string, string>;
  } = await Bun.file(
    new URL("../../../../../package.json", import.meta.url),
  ).json();
  const version =
    manifest.catalog["@libpdf/core"] ??
    panic("@libpdf/core is not pinned in the root catalog");

  expect(manifest.patchedDependencies).toHaveProperty([
    `@libpdf/core@${version}`,
  ]);
});
