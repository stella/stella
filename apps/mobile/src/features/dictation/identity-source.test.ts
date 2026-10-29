import { expect, test } from "bun:test";

import { dictationIdentity } from "./identity-source";

test("only a session with stable user identity can own a recording", () => {
  expect(dictationIdentity(null)).toEqual({ kind: "signed-out" });
  expect(
    dictationIdentity({
      serverUrl: "https://stella.example.com:443/path",
      userId: "user-žofie",
    }),
  ).toEqual({
    kind: "signed-in",
    scope: { serverOrigin: "https://stella.example.com", userId: "user-žofie" },
  });
});

test("an account and origin determine scope independently of a refreshed grant", () => {
  const first = {
    serverUrl: "https://stella.example.com",
    userId: "user-ľubica",
    refreshToken: "first",
  };
  const refreshed = { ...first, refreshToken: "rotated" };
  expect(dictationIdentity(first)).toEqual(dictationIdentity(refreshed));
  expect(dictationIdentity(first)).not.toEqual(
    dictationIdentity({ ...first, userId: "user-žofie" }),
  );
  expect(dictationIdentity(first)).not.toEqual(
    dictationIdentity({ ...first, serverUrl: "https://other.example.com" }),
  );
});
