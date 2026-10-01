import { expect, test } from "bun:test";

import {
  createTestCertificate,
  createTestRsaKeyPool,
} from "@/api/tests/helpers/test-pki";

test("a file key pool keeps signer keys distinct and reuses only immutable keys after reset", async () => {
  const keyPool = createTestRsaKeyPool();
  const [first, second] = await Promise.all([keyPool.take(), keyPool.take()]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(first.privateKey).not.toBe(second.privateKey);
  expect(first.publicKey).not.toBe(second.publicKey);

  const message = new TextEncoder().encode("test signer identity");
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    first.privateKey,
    message,
  );
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      first.publicKey,
      signature,
      message,
    ),
  ).toBe(true);
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      second.publicKey,
      signature,
      message,
    ),
  ).toBe(false);

  keyPool.reset();
  const beforeReset = await createTestCertificate({
    commonName: "Signer",
    keyPool,
  });
  keyPool.reset();
  const afterReset = await createTestCertificate({
    commonName: "Signer",
    keyPool,
  });
  expect(beforeReset.privateKey).toBe(afterReset.privateKey);
  expect(beforeReset.certificate).not.toBe(afterReset.certificate);
  expect(beforeReset.der).not.toEqual(afterReset.der);
  expect(await beforeReset.certificate.verify()).toBe(true);
  expect(await afterReset.certificate.verify()).toBe(true);
});
