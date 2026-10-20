import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const NATIVE_ROOT = path.join(import.meta.dir, "../src-tauri");
const FEATURE = "webdriver";
const PLUGIN_CRATE = "tauri-plugin-wdio-webdriver";
const PLUGIN_PERMISSION_PREFIX = "wdio-webdriver:";

const readNative = (file: string) =>
  readFileSync(path.join(NATIVE_ROOT, file), "utf-8");

/** The body of a top-level TOML table, up to the next table header. */
const tomlTable = (source: string, name: string) => {
  const start = source.indexOf(`\n[${name}]\n`);
  if (start === -1) {
    return null;
  }
  const body = source.slice(start + name.length + 4);
  const end = body.search(/^\[/mu);
  return end === -1 ? body : body.slice(0, end);
};

const MANIFEST = readNative("Cargo.toml");

describe("the webdriver feature stays out of release builds", () => {
  test("release builds refuse to compile it", () => {
    expect(readNative("src/lib.rs")).toContain(
      `#[cfg(all(feature = "${FEATURE}", not(debug_assertions)))]\ncompile_error!(`,
    );
  });

  test("the release profile keeps debug assertions off", () => {
    expect(tomlTable(MANIFEST, "profile.release")).not.toMatch(
      /^debug-assertions\s*=\s*true/mu,
    );
  });

  test("only the feature pulls in the plugin, and no default enables it", () => {
    expect(MANIFEST).toMatch(
      new RegExp(
        `^${PLUGIN_CRATE} = \\{[^}\\n]*optional = true[^}\\n]*\\}$`,
        "mu",
      ),
    );
    const features = tomlTable(MANIFEST, "features") ?? "";
    expect(features).toMatch(
      new RegExp(`^${FEATURE} = \\["dep:${PLUGIN_CRATE}"\\]$`, "mu"),
    );
    expect(features).not.toMatch(/^default\s*=/mu);
  });

  test("no compiled capability file grants the plugin", () => {
    const capabilities = readdirSync(path.join(NATIVE_ROOT, "capabilities"));
    expect(capabilities.length).toBeGreaterThan(0);
    for (const file of capabilities) {
      expect(readNative(`capabilities/${file}`)).not.toContain(
        PLUGIN_PERMISSION_PREFIX,
      );
    }
  });
});
