import { UnhandledException } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { mintPartnerClientSecret } from "@/api/lib/db/partner-client-contract";
import { PartnerClientOperatorError } from "@/api/lib/db/partner-client-operator";
import {
  describeFailure,
  PARTNER_CLIENT_USAGE,
} from "@/api/scripts/partner-oauth-client.logic";

const failureOf = (cause: unknown) =>
  describeFailure(new UnhandledException({ cause }));

const validationFailureOf = (
  schema: v.GenericSchema,
  input: unknown,
): string => {
  const parsed = v.safeParse(schema, input);
  if (parsed.success) {
    throw new Error("expected the input to fail validation");
  }
  return failureOf(new v.ValiError(parsed.issues));
};

describe("partner client failure messages", () => {
  test("name the failing options and never echo a value", () => {
    const { clientSecret } = mintPartnerClientSecret();
    const message = validationFailureOf(
      v.strictObject({
        "client-id": v.string(),
        "secret-sha256": v.pipe(v.string(), v.regex(/^[\w-]{43}$/u)),
      }),
      { "secret-sha256": clientSecret },
    );

    expect(message).toContain("--client-id");
    expect(message).toContain("--secret-sha256");
    expect(message).toContain("clientSecretSha256");
    expect(message).toContain(PARTNER_CLIENT_USAGE);
    expect(message).not.toContain(clientSecret);
  });

  test("an unknown operation gets the usage, not the received word", () => {
    const message = validationFailureOf(
      v.picklist(["create", "rotate", "disable"]),
      "rotate-everything-now",
    );

    expect(message).toBe(`Invalid arguments. ${PARTNER_CLIENT_USAGE}`);
  });

  test("operator errors keep their fixed message", () => {
    expect(
      failureOf(
        new PartnerClientOperatorError({
          message: "Active partner client not found",
        }),
      ),
    ).toBe("Active partner client not found");
  });

  test("any other failure stays generic", () => {
    expect(
      failureOf(new Error("insert failed: params $1 = secret-digest-value")),
    ).toBe("Partner client operation failed.");
  });
});
