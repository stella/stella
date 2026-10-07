import { expect, test } from "bun:test";

import { decisionTextVersion } from "./case-law-decision-read";
import { fingerprintTemplatePersistenceRequest } from "./template-persistence";

const TEXT = "Článek\u0000📄\ud800";

test("decision text versions retain Base64URL truncation", () => {
  expect(decisionTextVersion(TEXT)).toBe("U4EBVYrlGM8F");
  expect(decisionTextVersion("")).toBe("47DEQpj8HBSa");
});

test("template idempotency fingerprints preserve sorted keys and array order", () => {
  const fingerprint =
    "a129f8f6a8c95cbc97ca83d89d609fef6819b58fdf724d4a1d5ee42f10cbd2c7";
  expect(
    fingerprintTemplatePersistenceRequest({
      z: TEXT,
      a: { y: null, x: [1, false, "a\nb"] },
    }),
  ).toBe(fingerprint);
  expect(
    fingerprintTemplatePersistenceRequest({
      a: { x: [1, false, "a\nb"], y: null },
      z: TEXT,
    }),
  ).toBe(fingerprint);
});
