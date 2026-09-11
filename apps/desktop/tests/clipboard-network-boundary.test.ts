import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const NATIVE_SOURCE = path.join(import.meta.dir, "../src-tauri/src");

describe("clipboard capture network boundary", () => {
  test("clipboard modules do not construct network clients or resolve hosts", async () => {
    const files = (await readdir(NATIVE_SOURCE)).filter(
      (file) => file.startsWith("clipboard") && file.endsWith(".rs"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(path.join(NATIVE_SOURCE, file), "utf-8");
      // URL parsing is local; the rest of reqwest is outside this slice.
      const withoutUrlImport = source.replaceAll("use reqwest::Url;", "");
      expect(withoutUrlImport, file).not.toMatch(/\breqwest\b/u);
      expect(source, file).not.toMatch(
        /\b(?:hyper|ureq|surf)::|\b(?:tokio|std)::net::|\b(?:TcpStream|UdpSocket|ToSocketAddrs)\b/u,
      );
    }
  });
});
