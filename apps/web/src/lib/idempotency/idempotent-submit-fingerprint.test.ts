import { expect, test } from "bun:test";

import { createSubmitFingerprint } from "./idempotent-submit-fingerprint";

test("submit fingerprints retain selected file identity and ignore object key order", () => {
  let sequence = 0;
  const fingerprint = createSubmitFingerprint(() => String(++sequence));
  const selected = new File(["first"], "contract.docx");
  const differentBytes = new File(["other"], "contract.docx");
  const reselected = new File(["first"], "contract.docx");
  expect(selected.size).toBe(differentBytes.size);
  const original = fingerprint({ name: "Matter", file: selected });
  expect(fingerprint({ file: selected, name: "Matter" })).toBe(original);
  expect(fingerprint({ name: "Matter", file: differentBytes })).not.toBe(
    original,
  );
  expect(fingerprint({ name: "Matter", file: reselected })).not.toBe(original);
});
