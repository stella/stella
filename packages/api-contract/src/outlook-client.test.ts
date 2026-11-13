import { describe, expect, test } from "bun:test";

import {
  buildOutlookClientMetadataDocument,
  normalizeOutlookTaskPaneOrigin,
  outlookClientMetadataUrl,
} from "./outlook-client";

describe("Outlook add-in OAuth client", () => {
  test("a task-pane origin is exactly an https origin", () => {
    for (const [value, origin] of [
      ["https://outlook.example.com", "https://outlook.example.com"],
      ["https://outlook.example.com/", "https://outlook.example.com"],
      ["https://outlook.example.com:8443", "https://outlook.example.com:8443"],
      ["http://outlook.example.com", undefined],
      ["https://outlook.example.com/pane", undefined],
      ["https://outlook.example.com/?x=1", undefined],
      ["https://outlook.example.com/#x", undefined],
      ["https://user@outlook.example.com", undefined],
      ["outlook.example.com", undefined],
    ] as const) {
      expect(normalizeOutlookTaskPaneOrigin(value), value).toBe(origin);
    }
  });

  test("the client id is the document URL on an https issuer only", () => {
    expect(outlookClientMetadataUrl("https://api.example.com/some/path")).toBe(
      "https://api.example.com/v1/mcp/oauth/outlook-client-metadata.json",
    );
    expect(outlookClientMetadataUrl("http://localhost:3001")).toBeUndefined();
  });

  test("the document lists the one callback on the task-pane origin", () => {
    const document = buildOutlookClientMetadataDocument({
      clientId:
        "https://api.example.com/v1/mcp/oauth/outlook-client-metadata.json",
      taskPaneOrigin: "https://outlook.example.com",
    });
    expect(document.redirect_uris).toEqual([
      "https://outlook.example.com/auth/callback.html",
    ]);
    expect(document.token_endpoint_auth_method).toBe("none");
    expect(document.scope.split(" ")).toEqual([
      "openid",
      "offline_access",
      "stella:read",
      "stella:matters_write",
      "stella:documents_write",
      "stella:chat",
    ]);
  });
});
