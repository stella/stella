import { expect, test } from "bun:test";

import {
  refusedCredentialIssuerProbes,
  syntheticCredentialPrincipal,
} from "@/api/tests/helpers/session-credential-issuer-probes";

import { USER_SESSION_CREDENTIAL_ISSUERS } from "./credential-policy";

for (const [issuer, probe] of Object.entries(refusedCredentialIssuerProbes)) {
  test(`refuses the ${issuer} issuer for the synthetic principal`, async () => {
    await probe(syntheticCredentialPrincipal);
  });
}

test("classifies signed downloads as session-bound with a short lifetime", () => {
  expect(USER_SESSION_CREDENTIAL_ISSUERS.signedDownload).toEqual({
    disposition: "session-bound-ttl",
    maxTtlSeconds: 60,
    owner: "s3-presign",
  });
  expect(USER_SESSION_CREDENTIAL_ISSUERS.signedUpload.disposition).toBe(
    "refused",
  );
});
