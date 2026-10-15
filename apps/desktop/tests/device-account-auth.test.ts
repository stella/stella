import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

type NativeSource = { filename: string; source: string };

// Account credentials have one HTTP owner. Edit-session SSE uses a separate
// token, so it is the one named exception and stays scoped to that stream.
const assertAccountRequestOwners = (sources: readonly NativeSource[]) => {
  const proofCallers: string[] = [];
  let ownerBearers = 0;
  for (const { filename, source } of sources) {
    const bearerReferences = [...source.matchAll(/\.\s*bearer_auth\b/gu)];
    for (const reference of bearerReferences) {
      const call = source.slice(reference.index);
      if (
        filename === "http_client.rs" &&
        call.startsWith(".bearer_auth(bearer)")
      ) {
        ownerBearers += 1;
        continue;
      }
      if (
        filename === "sse.rs" &&
        call.startsWith(".bearer_auth(&session_token)")
      ) {
        continue;
      }
      throw new TypeError(
        `${filename}: bearer requests must use the desktop device proof owner`,
      );
    }
    if (
      /\.(?:header|insert)\(\s*(?:"[Aa]uthorization"|(?:reqwest::header::)?AUTHORIZATION)/u.test(
        source,
      )
    ) {
      throw new TypeError(
        `${filename}: authorization headers must use the desktop device proof owner`,
      );
    }
    if (/crate::http_client::device_proof_request\s*\(/u.test(source)) {
      proofCallers.push(filename);
    }
  }
  if (ownerBearers !== 1) {
    throw new TypeError(
      "Desktop device proof owner must have exactly one bearer constructor",
    );
  }
  const expected = [
    "account.rs",
    "deep_link.rs",
    "feature_access.rs",
    "handoff.rs",
    "presence.rs",
    "registry.rs",
    "time_entry_submit.rs",
  ];
  if (JSON.stringify(proofCallers.toSorted()) !== JSON.stringify(expected)) {
    throw new TypeError("Desktop device proof caller census changed");
  }
};

const readNativeSources = () => {
  const root = path.join(import.meta.dirname, "../src-tauri/src");
  return [...new Bun.Glob("*.rs").scanSync({ cwd: root, onlyFiles: true })].map(
    (filename) => ({
      filename,
      source: readFileSync(path.join(root, filename), "utf-8"),
    }),
  );
};

describe("native desktop account request ownership", () => {
  test("all account bearer callers use the signing owner, including renewal and acknowledgment", () => {
    const sources = readNativeSources();
    assertAccountRequestOwners(sources);
    for (const filename of [
      "account.rs",
      "deep_link.rs",
      "feature_access.rs",
      "handoff.rs",
      "presence.rs",
      "registry.rs",
      "time_entry_submit.rs",
    ]) {
      const caller = sources.find((source) => source.filename === filename);
      expect(caller?.source).toContain(
        "crate::http_client::device_proof_request(",
      );
      const mutated = sources.map((source) =>
        source === caller
          ? {
              ...source,
              source: source.source.replace(
                "crate::http_client::device_proof_request(",
                "builder.bearer_auth(&account.credential.key); unsigned_request(",
              ),
            }
          : source,
      );
      expect(() => assertAccountRequestOwners(mutated)).toThrow(
        "bearer requests must use the desktop device proof owner",
      );
    }
    for (const source of [
      "builder.bearer_auth(&account.credential.key);",
      'builder.header("Authorization", credential);',
      "builder.header(reqwest::header::AUTHORIZATION, credential);",
      "let bearer = builder.bearer_auth;",
    ]) {
      expect(() =>
        assertAccountRequestOwners([
          ...sources,
          { filename: "unowned.rs", source },
        ]),
      ).toThrow(/must use the desktop device proof owner/u);
    }
    const sse = sources.find(({ filename }) => filename === "sse.rs");
    expect(sse?.source).toContain(".bearer_auth(&session_token)");
    expect(() =>
      assertAccountRequestOwners(
        sources.map((source) =>
          source === sse
            ? {
                ...source,
                source: source.source.replace(
                  ".bearer_auth(&session_token)",
                  ".bearer_auth(&account.credential.key)",
                ),
              }
            : source,
        ),
      ),
    ).toThrow("bearer requests must use the desktop device proof owner");
  });
});
