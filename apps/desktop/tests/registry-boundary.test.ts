import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const DESKTOP_ROOT = path.join(import.meta.dir, "..");
const NATIVE_ROOT = path.join(DESKTOP_ROOT, "src-tauri");

type Capability = {
  identifier: string;
  permissions: string[];
  windows: string[];
};

const registryCommands = async () => {
  const manifest = await readFile(
    path.join(NATIVE_ROOT, "src/command_manifest.rs"),
    "utf-8",
  );
  return [...manifest.matchAll(/registry::(registry_\w+) =>/gu)].flatMap(
    (match) => {
      const command = match.at(1);
      return command ? [command] : [];
    },
  );
};

describe("unified registry search boundary", () => {
  test("only the clipboard window receives the exact native registry allowlist", async () => {
    const permissions = (await registryCommands()).map(
      (command) => `allow-${command.replaceAll("_", "-")}`,
    );
    expect(permissions.length).toBeGreaterThan(0);
    const directory = path.join(NATIVE_ROOT, "capabilities");
    const files = (await readdir(directory)).filter((file) =>
      file.endsWith(".json"),
    );
    const owners: string[] = [];
    for (const file of files) {
      const capability: Capability = JSON.parse(
        await readFile(path.join(directory, file), "utf-8"),
      );
      const granted = capability.permissions.filter((permission) =>
        permission.startsWith("allow-registry-"),
      );
      if (granted.length === 0) {
        continue;
      }
      owners.push(capability.identifier);
      expect(capability.windows).toEqual(["clipboard"]);
      expect(granted.toSorted()).toEqual(permissions.toSorted());
      expect(capability.permissions).not.toContain("core:default");
      expect(capability.permissions.join(" ")).not.toMatch(
        /http:|opener:|shell:|fs:|clipboard-manager:/u,
      );
    }
    expect(owners).toEqual(["clipboard"]);
  });

  test("every exposed registry command checks its calling window before side effects", async () => {
    const source = await readFile(
      path.join(NATIVE_ROOT, "src/registry.rs"),
      "utf-8",
    );
    expect(source).toContain(
      "window.label() != crate::clipboard_window::CLIPBOARD_WINDOW_LABEL",
    );
    for (const command of await registryCommands()) {
      expect(source).toMatch(
        new RegExp(
          `pub (?:async )?fn ${command}\\([\\s\\S]*?\\) -> [^{]+\\{\\s*require_registry\\(&window\\)\\?;`,
          "u",
        ),
      );
    }
  });

  test("registry UI receives typed queries without clipboard reads or direct network access", async () => {
    const source = await readFile(
      path.join(DESKTOP_ROOT, "src/registry/RegistrySearch.tsx"),
      "utf-8",
    );
    expect(source).not.toMatch(
      /from\s+["'][^"']*\/clipboard\/|clipboard_get|clipboard-history|\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|open_stella|opener/iu,
    );
  });
});

// Account requests retain their lease in the transport signature. Session SSE
// carries document-session tokens; issuance and rotation stay in account.rs.
const accountBearerOwners = {
  "account.rs": "_lease: tokio::sync::MutexGuard<'static, ()>",
  "registry.rs": "saved: &account::AccountRequest",
  "presence.rs": "account: &crate::account::AccountRequest",
  "handoff.rs": "account: Option<&'a crate::account::AccountRequest>",
  "deep_link.rs": "crate::account::request_account(&state).await?",
  "sse.rs": ".bearer_auth(&session_token)",
  "http_client.rs": "key: &crate::device_proof::DeviceKey",
} as const;

const assertBearerOwner = (file: string, source: string) => {
  const compactSource = source.replace(/\s+/gu, "");
  if (
    !compactSource.includes(".bearer_auth(") &&
    !compactSource.includes("crate::http_client::device_proof_request(")
  ) {
    return;
  }
  if (!(file in accountBearerOwners)) {
    throw new TypeError(`Unowned bearer transport: ${file}`);
  }
  const obligation = Object.entries(accountBearerOwners)
    .find(([owner]) => owner === file)
    ?.at(1)
    ?.replace(/\s+/gu, "");
  if (!obligation || !compactSource.includes(obligation)) {
    throw new TypeError(`Account lease absent: ${file}`);
  }
};

describe("native account transport ownership", () => {
  test("every bearer transport retains its account lease or session-token owner", async () => {
    const sourceRoot = path.join(NATIVE_ROOT, "src");
    // Nested modules can open bearer transports too, so scan the whole crate.
    const files = (await readdir(sourceRoot, { recursive: true })).filter(
      (file) => file.endsWith(".rs"),
    );
    const exercised = new Set<string>();
    for (const file of files) {
      const source = (
        (await readFile(path.join(sourceRoot, file), "utf-8"))
          .split(/#\[cfg\(test\)\]\s*mod tests/u)
          .at(0) ?? ""
      ).replace(/\s+/gu, "");
      assertBearerOwner(file, source);
      if (
        !source.includes(".bearer_auth(") &&
        !source.includes("crate::http_client::device_proof_request(")
      ) {
        continue;
      }
      exercised.add(file);
      const obligation = Object.entries(accountBearerOwners)
        .find(([owner]) => owner === file)
        ?.at(1)
        ?.replace(/\s+/gu, "");
      if (!obligation) {
        throw new TypeError(`Missing owner ${file}`);
      }
      expect(() =>
        assertBearerOwner(
          file,
          source.replaceAll(obligation, () =>
            obligation.startsWith(".bearer_auth(")
              ? ".bearer_auth(&unowned)"
              : "invalid lease",
          ),
        ),
      ).toThrow(`Account lease absent: ${file}`);
    }
    expect([...exercised].toSorted()).toEqual(
      Object.keys(accountBearerOwners).toSorted(),
    );
    expect(() =>
      assertBearerOwner("unowned.rs", ".bearer_auth(&credential)"),
    ).toThrow("Unowned bearer transport");
  });
});
