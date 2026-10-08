import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { LOCAL_ONLY_FEATURES } from "./local-only-features";

const NATIVE_ROOT = path.join(import.meta.dir, "../src-tauri");
const WINDOW_OWNER = "src/app_window.rs";
const CALLER_OWNER = "src/local_window.rs";

const featureCases = LOCAL_ONLY_FEATURES.map(
  (feature) => [feature.id, feature] as const,
);

const permissionPrefix = (commandPrefix: string) =>
  `allow-${commandPrefix.replaceAll("_", "-")}`;

const readNative = async (relativePath: string) =>
  readFile(path.join(NATIVE_ROOT, relativePath), "utf-8");

const parseJson = (source: string): unknown => JSON.parse(source);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown, label: string) => {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(`${label} must be a string array`);
  }
  return value;
};

const capabilities = async () => {
  const directory = path.join(NATIVE_ROOT, "capabilities");
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".json"),
  );
  return Promise.all(
    files.map(async (file) => {
      const capability = parseJson(
        await readFile(path.join(directory, file), "utf-8"),
      );
      if (!isRecord(capability)) {
        throw new TypeError(`Invalid capability: ${file}`);
      }
      return { capability, file };
    }),
  );
};

const tauriConfig = async () => {
  const config = parseJson(await readNative("tauri.conf.json"));
  const app = isRecord(config) ? config["app"] : undefined;
  if (!isRecord(config) || !isRecord(app)) {
    throw new TypeError("Invalid tauri.conf.json");
  }
  return { app, plugins: config["plugins"] };
};

const cspDirectives = (csp: string) =>
  new Map(
    csp
      .split(";")
      .map((directive) => directive.trim().split(/\s+/u))
      .filter((tokens) => tokens.length > 0 && tokens[0] !== "")
      .map(([name = "", ...sources]) => [name, sources]),
  );

/** CSP fetch directives that fall back to `default-src` when absent. */
const effectiveSources = (
  directives: Map<string, string[]>,
  directive: string,
) => directives.get(directive) ?? directives.get("default-src") ?? [];

const commandFunctions = (source: string) =>
  [
    ...source.matchAll(
      /#\[tauri::command\]\s*pub (?:async )?fn (\w+)\(([\s\S]*?)\)\s*(?:->|\{)/gu,
    ),
  ].map((match) => ({ name: match[1] ?? "", parameters: match[2] ?? "" }));

describe("local-only data stays in the feature's own windows", () => {
  test("activity has no system clipboard publication", async () => {
    const files = (await readdir(path.join(NATIVE_ROOT, "src"))).filter(
      (file) =>
        file === "activity.rs" ||
        (file.startsWith("activity_") && file.endsWith(".rs")),
    );
    expect(files).toContain("activity_commands.rs");
    for (const file of files) {
      const source = await readNative(`src/${file}`);
      expect(source, file).not.toMatch(
        /\bclipboard::|\bwrite_plain_text\b|\buse[^;]*\bclipboard\b/u,
      );
    }
  });

  test("no capability is granted to a remote origin", async () => {
    for (const { capability, file } of await capabilities()) {
      expect(capability, file).not.toHaveProperty("remote");
      expect(stringArray(capability["windows"], file).length).toBeGreaterThan(
        0,
      );
      expect(capability, file).not.toHaveProperty("webviews");
    }
  });

  test.each(featureCases)(
    "%s commands are granted only to its windows",
    async (_id, feature) => {
      const prefixes = feature.commandOwners.map(({ prefix }) =>
        permissionPrefix(prefix),
      );
      const windows = new Set<string>(feature.windows);
      let grants = 0;
      for (const { capability, file } of await capabilities()) {
        const permissions = stringArray(capability["permissions"], file);
        const granted = permissions.filter((permission) =>
          prefixes.some((prefix) => permission.startsWith(prefix)),
        );
        if (granted.length === 0) {
          continue;
        }
        grants += granted.length;
        for (const window of stringArray(capability["windows"], file)) {
          expect(windows, file).toContain(window);
        }
      }
      expect(grants).toBeGreaterThan(0);
    },
  );

  test.each(featureCases)(
    "every %s command requires a verified caller",
    async (_id, feature) => {
      const manifest = await readNative("src/command_manifest.rs");
      const caller = new RegExp(`\\b_?caller: ${feature.callerType}\\b`, "u");
      for (const owner of feature.commandOwners) {
        const module = path.basename(owner.module, ".rs");
        const manifestCommands = [
          ...manifest.matchAll(new RegExp(`${module}::(\\w+) =>`, "gu")),
        ].flatMap((match) => (match[1] ? [match[1]] : []));
        const commands = commandFunctions(await readNative(owner.module));

        expect(commands.length).toBeGreaterThan(0);
        expect(commands.map(({ name }) => name).toSorted()).toEqual(
          manifestCommands.toSorted(),
        );
        for (const { name, parameters } of commands) {
          expect(name.startsWith(owner.prefix), name).toBe(true);
          expect(parameters, name).toMatch(caller);
        }
      }
    },
  );

  test("every local caller type is a listed local-only feature", async () => {
    const source = await readNative(CALLER_OWNER);
    const callers = [
      ...source.matchAll(/pub type (\w+Caller) = LocalCaller<\w+>;/gu),
    ].flatMap((match) => (match[1] ? [match[1]] : []));
    expect(callers.toSorted()).toEqual(
      LOCAL_ONLY_FEATURES.map((feature) => feature.callerType).toSorted(),
    );
  });

  test("the command scan sees a command without a caller", () => {
    const commands = commandFunctions(
      [
        "#[tauri::command]",
        "pub fn clipboard_a(caller: ClipboardCaller, id: String) -> Result<(), String> {}",
        "#[tauri::command]",
        "pub async fn clipboard_b(",
        "  id: String,",
        "  state: State<'_, ClipboardAppState>,",
        ") {}",
      ].join("\n"),
    );
    expect(commands.map(({ name }) => name)).toEqual([
      "clipboard_a",
      "clipboard_b",
    ]);
    expect(commands[1]?.parameters).not.toMatch(
      /\b_?caller: ClipboardCaller\b/u,
    );
  });

  test("windows load bundled pages through the one origin-locked builder", async () => {
    const sources = (await readdir(path.join(NATIVE_ROOT, "src"))).filter(
      (file) => file.endsWith(".rs"),
    );
    expect(sources).toContain(path.basename(WINDOW_OWNER));
    for (const file of sources) {
      const source = await readNative(`src/${file}`);
      expect(source, file).not.toMatch(
        /WebviewUrl::(?:External|CustomProtocol)/u,
      );
      if (`src/${file}` === WINDOW_OWNER) {
        expect(source).toContain(".on_navigation(");
        expect(source).toContain("NewWindowResponse::Deny");
        continue;
      }
      expect(source, file).not.toMatch(
        /\bWebview(?:Window)?Builder::(?:new|from_config)\b/u,
      );
    }
    const clippy = await readNative("clippy.toml");
    for (const constructor of [
      "tauri::webview::WebviewWindowBuilder::new",
      "tauri::webview::WebviewWindowBuilder::from_config",
      "tauri::webview::WebviewBuilder::new",
      "tauri::webview::WebviewBuilder::from_config",
    ]) {
      expect(clippy).toContain(`path = "${constructor}"`);
    }
  });

  test("the app config declares no window, global API or CSP relaxation", async () => {
    const { app } = await tauriConfig();
    expect(app["windows"]).toEqual([]);
    expect(app["withGlobalTauri"]).toBe(false);
    const security = app["security"];
    if (!isRecord(security)) {
      throw new TypeError("app.security is required");
    }
    expect(Object.keys(security).toSorted()).toEqual(["csp"]);
    const csp = security["csp"];
    if (typeof csp !== "string") {
      throw new TypeError("app.security.csp must be a string");
    }

    const directives = cspDirectives(csp);
    expect(effectiveSources(directives, "script-src")).toEqual(["'self'"]);
    for (const directive of [
      "connect-src",
      "font-src",
      "media-src",
      "worker-src",
      "manifest-src",
      "child-src",
    ]) {
      expect(effectiveSources(directives, directive), directive).toEqual([
        "'self'",
      ]);
    }
    expect(effectiveSources(directives, "img-src").toSorted()).toEqual(
      ["'self'", "data:"].toSorted(),
    );
    for (const directive of [
      "object-src",
      "base-uri",
      "form-action",
      "frame-src",
      "frame-ancestors",
    ]) {
      expect(directives.get(directive), directive).toEqual(["'none'"]);
    }
  });

  test("updates install only when signed by the pinned key over https", async () => {
    const { plugins } = await tauriConfig();
    const updater = isRecord(plugins) ? plugins["updater"] : undefined;
    if (!isRecord(updater)) {
      throw new TypeError("plugins.updater is required");
    }
    expect(Object.keys(updater).toSorted()).toEqual(["endpoints", "pubkey"]);
    expect(typeof updater["pubkey"]).toBe("string");
    expect(String(updater["pubkey"]).length).toBeGreaterThan(0);
    const endpoints = stringArray(updater["endpoints"], "endpoints");
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(new URL(endpoint).protocol).toBe("https:");
    }
  });
});
