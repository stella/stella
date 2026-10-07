import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_ONLY_FEATURES,
  LOCAL_ONLY_GATE_MODULES,
  LOCAL_ONLY_SHARED_MODULES,
  isFeatureModule,
} from "./local-only-features";

const NATIVE_SOURCE = path.join(import.meta.dir, "../src-tauri/src");
const NETWORK_PATTERN =
  /\b(?:hyper|ureq|surf)::|\b(?:tokio|std)::net::|\b(?:TcpStream|UdpSocket|ToSocketAddrs)\b/u;

const readNative = async (file: string) =>
  readFile(path.join(NATIVE_SOURCE, file), "utf-8");

const nativeFiles = async () =>
  (await readdir(NATIVE_SOURCE)).filter((file) => file.endsWith(".rs"));

const expectNoNetwork = (file: string, source: string) => {
  // URL parsing is local; the rest of reqwest is outside this boundary.
  const withoutUrlImport = source.replaceAll("use reqwest::Url;", "");
  expect(withoutUrlImport, file).not.toMatch(/\breqwest\b/u);
  expect(source, file).not.toMatch(NETWORK_PATTERN);
};

describe("local-only network boundary", () => {
  test.each(LOCAL_ONLY_FEATURES.map((feature) => [feature.id, feature]))(
    "%s modules do not construct network clients or reach the gate fetch",
    async (_id, feature) => {
      const files = (await nativeFiles()).filter((file) =>
        isFeatureModule(feature, file),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const source = await readNative(file);
        expectNoNetwork(file, source);
        for (const gate of LOCAL_ONLY_GATE_MODULES) {
          expect(source, file).not.toContain(path.basename(gate, ".rs"));
        }
      }
    },
  );

  test("the shared local-only machinery has no network code", async () => {
    const files = await nativeFiles();
    for (const file of LOCAL_ONLY_SHARED_MODULES) {
      expect(files).toContain(file);
      expectNoNetwork(file, await readNative(file));
    }
  });

  test("the gate fetch never touches a local-only feature's data", async () => {
    for (const file of LOCAL_ONLY_GATE_MODULES) {
      const source = await readNative(file);
      for (const feature of LOCAL_ONLY_FEATURES) {
        expect(source, file).not.toMatch(
          new RegExp(`\\b${feature.id}(?:_\\w+)?::`, "u"),
        );
      }
      expect(source, file).not.toMatch(/\b(?:local_store|LocalCaller)\b/u);
    }
  });

  test.each(
    LOCAL_ONLY_FEATURES.filter(
      (feature) => feature.telemetry === "fixedCodes",
    ).map((feature) => [feature.id, feature]),
  )(
    "%s reports fixed error codes only, never what it recorded",
    async (_id, feature) => {
      const featureFiles = (await nativeFiles()).filter((name) =>
        isFeatureModule(feature, name),
      );
      expect(featureFiles.length).toBeGreaterThan(0);
      for (const file of featureFiles) {
        expect(await readNative(file), file).not.toMatch(
          /\b(?:desktop_telemetry|DesktopTelemetry)\b/u,
        );
      }
      const frontendModules = Object.values(feature.windowModules).flat();
      expect(frontendModules.length).toBeGreaterThan(0);
      for (const module of frontendModules) {
        const source = await readFile(
          path.join(import.meta.dir, "..", module),
          "utf-8",
        );
        expect(source, module).not.toMatch(/\bdescribeError\b|\bdetail\s*:/u);
      }
    },
  );
});
