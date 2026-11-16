import { encodeBase64Url } from "../pkce";

/** A JWT with these claims and a placeholder signature the app never checks. */
export const unsignedIdToken = (claims: Record<string, unknown>): string =>
  [{ alg: "RS256", typ: "JWT" }, claims, "signature"]
    .map((part) =>
      encodeBase64Url(
        new TextEncoder().encode(
          typeof part === "string" ? part : JSON.stringify(part),
        ),
      ),
    )
    .join(".");
