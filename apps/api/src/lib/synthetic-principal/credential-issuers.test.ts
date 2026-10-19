import { test } from "bun:test";

import {
  refusedCredentialIssuerProbes,
  syntheticCredentialPrincipal,
} from "@/api/tests/helpers/session-credential-issuer-probes";

for (const [issuer, probe] of Object.entries(refusedCredentialIssuerProbes)) {
  test(`refuses the ${issuer} issuer for the synthetic principal`, async () => {
    await probe(syntheticCredentialPrincipal);
  });
}
