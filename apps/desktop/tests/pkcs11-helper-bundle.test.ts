import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The PKCS #11 helper is the one binary in the bundle that may load
// libraries another team signed (smart card vendors' modules). Its name is
// written in four places that must agree, and the exception must stay its
// own: the app's entitlements never carry it.

const DESKTOP_ROOT = path.join(import.meta.dir, "..");
const TAURI_DIR = path.join(DESKTOP_ROOT, "src-tauri");
const HELPER_NAME = "stella-pkcs11-helper";
const LIBRARY_VALIDATION_EXCEPTION =
  "com.apple.security.cs.disable-library-validation";

const read = (...segments: string[]) =>
  readFileSync(path.join(...segments), "utf-8");

const entitlementKeys = (plist: string) =>
  [...plist.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]);

// An entitlement is granted by its value, not its key: `<false/>` keeps
// library validation on.
const grantedEntitlements = (plist: string) =>
  [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/gu)].map(
    (match) => match[1],
  );

describe("PKCS #11 helper bundle", () => {
  test("only the helper may load libraries signed by another team", () => {
    const helper = read(TAURI_DIR, "Pkcs11HelperEntitlements.plist");
    expect(entitlementKeys(helper)).toEqual([LIBRARY_VALIDATION_EXCEPTION]);
    expect(grantedEntitlements(helper)).toEqual([LIBRARY_VALIDATION_EXCEPTION]);
    expect(
      entitlementKeys(read(TAURI_DIR, "Entitlements.plist")),
    ).not.toContain(LIBRARY_VALIDATION_EXCEPTION);
  });

  test("the bundle carries the helper the build script makes", () => {
    const config: unknown = JSON.parse(
      read(TAURI_DIR, "tauri.sidecar.conf.json"),
    );
    expect(config).toMatchObject({
      build: {
        beforeBuildCommand: expect.stringContaining(
          "bun run build:pkcs11-helper",
        ),
      },
      bundle: {
        macOS: {
          files: { [`MacOS/${HELPER_NAME}`]: `binaries/${HELPER_NAME}` },
        },
      },
    });
    const script = read(DESKTOP_ROOT, "scripts/build-pkcs11-helper.ts");
    expect(script).toContain(`const HELPER_NAME = "${HELPER_NAME}";`);
    expect(script).toContain('"Pkcs11HelperEntitlements.plist"');
    expect(script).toContain('path.join(TAURI_DIR, "binaries", HELPER_NAME)');
  });

  test("the app looks for the binary Cargo builds", () => {
    expect(read(TAURI_DIR, "crates/pkcs11-helper/Cargo.toml")).toContain(
      `[[bin]]\nname = "${HELPER_NAME}"`,
    );
    expect(read(TAURI_DIR, "src/pkcs11_signing.rs")).toContain(
      `const HELPER_NAME: &str = "${HELPER_NAME}";`,
    );
  });
});
