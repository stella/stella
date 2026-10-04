import { describe, expect, test } from "bun:test";

import {
  buildCliClientMetadataDocument,
  CLI_CLIENT_METADATA_PATH,
  cliClientMetadataUrl,
} from "./client-metadata-document.js";
import { LOOPBACK_REDIRECT_URI } from "./constants.js";

describe("CLI client metadata document", () => {
  test("lives on the issuer's origin", () => {
    expect(cliClientMetadataUrl("https://api.stella.example/api/auth")).toBe(
      `https://api.stella.example${CLI_CLIENT_METADATA_PATH}`,
    );
    expect(cliClientMetadataUrl("https://api.stella.example")).toBe(
      `https://api.stella.example${CLI_CLIENT_METADATA_PATH}`,
    );
  });

  test("needs an https issuer", () => {
    for (const issuer of ["http://localhost:3001/api/auth", "not a url"]) {
      expect(cliClientMetadataUrl(issuer)).toBeUndefined();
    }
  });

  test("names itself and the loopback redirects the CLI listens on", () => {
    const clientId = `https://api.stella.example${CLI_CLIENT_METADATA_PATH}`;
    const document = buildCliClientMetadataDocument(clientId);
    expect(document.client_id).toBe(clientId);
    expect(document.redirect_uris).toContain(LOOPBACK_REDIRECT_URI);
    expect(document.token_endpoint_auth_method).toBe("none");
    expect(document.scope.split(" ")).toContain("stella:admin_read");
  });
});
