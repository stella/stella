import { defaultKeyHasher } from "@better-auth/api-key";
import { expect, test } from "bun:test";

import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";

import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "./desktop-device-proof";

test("a fixture claims a valid signed account request and retains its credential binding", async () => {
  const credential = `stella_dr_${"1".repeat(128)}`;
  const keyId = "fixture-key";
  const { deviceJkt, signRequest } = await createDesktopDeviceSigner();
  const request = await signRequest({
    request: new Request("https://api.example.test/v1/desktop-account/renew", {
      method: "POST",
    }),
    credential,
  });
  const receipt = await claimFixtureDeviceProof({
    request,
    deviceJkt,
    keyId,
    credential,
  });
  expect(receipt).toBeInstanceOf(ConsumedDesktopDeviceProof);
  const binding = {
    keyId,
    credentialHash: await defaultKeyHasher(credential),
    thumbprint: deviceJkt,
  };
  expect(receipt.authorizesCredential(binding)).toBe(true);
  expect(
    receipt.authorizesCredential({ ...binding, keyId: "another-key" }),
  ).toBe(false);
});
