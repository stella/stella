import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const NATIVE_ROOT = path.join(import.meta.dir, "../src-tauri");
const HISTORY_WINDOWS = new Set(["clipboard", "clipboard-editor"]);
const HISTORY_COMMAND_PREFIX = "allow-clipboard-";
const WINDOW_OWNER = "src/app_window.rs";

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

describe("clipboard history stays in the app's own windows", () => {
  test("no capability is granted to a remote origin", async () => {
    for (const { capability, file } of await capabilities()) {
      expect(capability, file).not.toHaveProperty("remote");
      expect(stringArray(capability["windows"], file).length).toBeGreaterThan(
        0,
      );
      expect(capability, file).not.toHaveProperty("webviews");
    }
  });

  test("clipboard commands are granted only to the clipboard windows", async () => {
    let grants = 0;
    for (const { capability, file } of await capabilities()) {
      const permissions = stringArray(capability["permissions"], file);
      const history = permissions.filter((permission) =>
        permission.startsWith(HISTORY_COMMAND_PREFIX),
      );
      if (history.length === 0) {
        continue;
      }
      grants += history.length;
      for (const window of stringArray(capability["windows"], file)) {
        expect(HISTORY_WINDOWS, file).toContain(window);
      }
    }
    expect(grants).toBeGreaterThan(0);
  });

  test("every clipboard command requires a verified clipboard caller", async () => {
    const manifest = await readNative("src/command_manifest.rs");
    const manifestCommands = [
      ...manifest.matchAll(/clipboard_commands::(\w+) =>/gu),
    ].flatMap((match) => (match[1] ? [match[1]] : []));
    const commands = commandFunctions(
      await readNative("src/clipboard_commands.rs"),
    );

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map(({ name }) => name).toSorted()).toEqual(
      manifestCommands.toSorted(),
    );
    for (const { name, parameters } of commands) {
      expect(parameters, name).toMatch(/\b_?caller: ClipboardCaller\b/u);
    }
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
