import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  authorizeUploadConsent,
  type UploadPurpose,
} from "@/api/handlers/uploads/permissions";

const statusOf = (
  grantedScopes: readonly string[] | undefined,
  purpose: UploadPurpose,
): "ok" | number => {
  const consent = authorizeUploadConsent({ grantedScopes, purpose });
  return Result.isError(consent) ? consent.error.status : "ok";
};

describe("the consent an upload spends", () => {
  test("a browser session is the person's own consent for every purpose", () => {
    expect(statusOf(undefined, "entity_create")).toBe("ok");
    expect(statusOf(undefined, "entity_version")).toBe("ok");
    expect(statusOf(undefined, "agent_skill")).toBe("ok");
  });

  test("an app's token writes a document only with the documents write scope", () => {
    const appScopes = [
      "stella:read",
      "stella:chat",
      "stella:matters_write",
      "stella:documents_write",
    ];
    expect(statusOf(appScopes, "entity_create")).toBe("ok");
    expect(statusOf(appScopes, "entity_version")).toBe("ok");

    const withoutDocuments = ["stella:read", "stella:matters_write"];
    expect(statusOf(withoutDocuments, "entity_create")).toBe(403);
    expect(statusOf(withoutDocuments, "entity_version")).toBe(403);
  });

  test("an app's token never installs a skill", () => {
    expect(
      statusOf(
        [
          "stella:read",
          "stella:chat",
          "stella:matters_write",
          "stella:documents_write",
        ],
        "agent_skill",
      ),
    ).toBe(403);
  });
});
