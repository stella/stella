import { describe, expect, test } from "bun:test";

import {
  createAuthorizationResponseBinding,
  evaluateAuthorizationResponseBinding,
  observeAuthorizationResponseBinding,
} from "@/api/lib/mcp-upstream/oauth";
import type { AuthorizationResponseRegistrationMode } from "@/api/lib/mcp-upstream/oauth";

const issuer = "https://authorization.example.com";
const registrationModes = [
  "cimd",
  "dcr",
  "pre_registered",
] satisfies AuthorizationResponseRegistrationMode[];
const booleans: boolean[] = [false, true];

const responseIssuer = ({
  issMatches,
  issPresent,
}: {
  issMatches: boolean;
  issPresent: boolean;
}) => {
  if (!issPresent) {
    return undefined;
  }
  return issMatches ? issuer : "https://different.example.com";
};

describe("authorization response binding census", () => {
  test("classifies every observed response and preserves the exchange", async () => {
    for (const registrationMode of registrationModes) {
      for (const issSupportedAdvertised of booleans) {
        for (const issPresent of booleans) {
          for (const issMatches of booleans) {
            const binding = createAuthorizationResponseBinding({
              authorizationServer: {
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                authorization_response_iss_parameter_supported:
                  issSupportedAdvertised,
              },
              registrationMode,
            });
            const response = {
              issuer: responseIssuer({ issMatches, issPresent }),
            };
            const verdict = evaluateAuthorizationResponseBinding(
              binding,
              response,
            );
            expect(verdict.type).toBe(
              issSupportedAdvertised && issPresent && issMatches
                ? "accepted"
                : "would_refuse",
            );

            const exchangeArguments = {
              code: "authorization-code",
              redirectUri: "https://app.example.com/v1/mcp/oauth/callback",
              responseIssuer: response.issuer,
            };
            const calls: (typeof exchangeArguments)[] = [];
            const result = await observeAuthorizationResponseBinding({
              binding,
              response,
              observe: () => undefined,
              exchange: async () => {
                calls.push(exchangeArguments);
                return "exchanged";
              },
            });

            expect(result).toBe("exchanged");
            expect(calls).toEqual([exchangeArguments]);
          }
        }
      }
    }
  });

  test("keeps registration mode in each persisted binding", () => {
    for (const registrationMode of registrationModes) {
      const observed: AuthorizationResponseRegistrationMode =
        createAuthorizationResponseBinding({
          authorizationServer: {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
          },
          registrationMode,
        }).registrationMode;
      expect(observed).toBe(registrationMode);
    }
  });

  test("continues the exchange when observation does not complete", async () => {
    const binding = createAuthorizationResponseBinding({
      authorizationServer: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      },
      registrationMode: "dcr",
    });
    const exchangeArguments = {
      code: "authorization-code",
      redirectUri: "https://app.example.com/v1/mcp/oauth/callback",
      responseIssuer: issuer,
    };
    const calls: (typeof exchangeArguments)[] = [];

    const result = await observeAuthorizationResponseBinding({
      binding,
      response: { issuer },
      observe: () => {
        throw new Error("observation did not complete");
      },
      exchange: async () => {
        calls.push(exchangeArguments);
        return "exchanged";
      },
    });

    expect(result).toBe("exchanged");
    expect(calls).toEqual([exchangeArguments]);
  });

  test("compares response issuers for unbound observations", () => {
    const binding = createAuthorizationResponseBinding({
      authorizationServer: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      },
      registrationMode: "dcr",
    });

    expect(
      evaluateAuthorizationResponseBinding(binding, { issuer }).issMatches,
    ).toBe(true);
    expect(
      evaluateAuthorizationResponseBinding(binding, {
        issuer: "https://different.example.com",
      }).issMatches,
    ).toBe(false);
  });
});
