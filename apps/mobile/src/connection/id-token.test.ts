import { describe, expect, test } from "bun:test";

import { readIdTokenSubject } from "./id-token";
import { unsignedIdToken } from "./test-support/id-token";

const ISSUER = "https://stella.example.com/api/auth";
const CLIENT_ID =
  "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json";

const read = (idToken: string) => {
  const result = readIdTokenSubject({
    clientId: CLIENT_ID,
    idToken,
    issuer: ISSUER,
  });
  return result.isOk() ? result.value : result.error._tag;
};

describe("readIdTokenSubject", () => {
  test("reads the subject of a token this server issued to this client", () => {
    expect(
      read(unsignedIdToken({ iss: ISSUER, aud: CLIENT_ID, sub: "user-1" })),
    ).toBe("user-1");
    expect(
      read(
        unsignedIdToken({
          iss: ISSUER,
          aud: ["another-client", CLIENT_ID],
          sub: "user-1",
        }),
      ),
    ).toBe("user-1");
  });

  test("decodes base64url payloads that carry non-ASCII text", () => {
    expect(
      read(
        unsignedIdToken({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: "user-1",
          name: "Jiří Ševčík ~?>",
        }),
      ),
    ).toBe("user-1");
  });

  test("refuses a token from another issuer or for another client", () => {
    expect(
      read(
        unsignedIdToken({
          iss: "https://elsewhere.example.com",
          aud: CLIENT_ID,
          sub: "user-1",
        }),
      ),
    ).toBe("TokenError");
    expect(
      read(
        unsignedIdToken({ iss: ISSUER, aud: "another-client", sub: "user-1" }),
      ),
    ).toBe("TokenError");
  });

  test("refuses a token without a subject or that is not a JWT", () => {
    expect(read(unsignedIdToken({ iss: ISSUER, aud: CLIENT_ID }))).toBe(
      "TokenError",
    );
    expect(
      read(unsignedIdToken({ iss: ISSUER, aud: CLIENT_ID, sub: "" })),
    ).toBe("TokenError");
    expect(read("not-a-jwt")).toBe("TokenError");
    expect(read("header.%%%.signature")).toBe("TokenError");
  });
});
