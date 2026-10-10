import { expect, test } from "bun:test";

import { createSha256 as createLegacyNodeHash } from "@stll/sha256/node";

import { hashUploadFile } from "./file-content-hash";

test.each(["", "ordinary", "Žluťoučký kůň Łódź 📄", "e\u0301"])(
  "browser upload and comparison identities preserve exact file bytes: %j",
  async (text) => {
    const bytes = new TextEncoder().encode(text);
    const file = new File([bytes], "příloha.txt", { type: "text/plain" });
    expect(await hashUploadFile(file)).toBe(
      createLegacyNodeHash().update(bytes).digest("hex"),
    );
  },
);

test("browser upload identities preserve real DOCX and binary file bytes", async () => {
  const fixture = await Bun.file(
    new URL(
      "../../handlers/case-law/ingestion/parsers/__fixtures__/hu-bhgy-decision.docx",
      import.meta.url,
    ),
  ).bytes();
  for (const bytes of [fixture, new Uint8Array([0, 255, 128, 13, 10])]) {
    const file = new File([bytes], "příloha.docx");
    expect(await hashUploadFile(file)).toBe(
      createLegacyNodeHash().update(bytes).digest("hex"),
    );
  }
});
