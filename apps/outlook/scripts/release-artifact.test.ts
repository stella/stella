import { describe, expect, test } from "bun:test";

import {
  assertOfficeRuntimeEntryIsIsolated,
  createContentHashedAssetName,
  getHtmlAssetPaths,
  getHtmlReleaseVersion,
  getManifestIconPaths,
  getOutlookDeploymentHeaderRules,
  isContentHashedCodeAsset,
  resolveOutlookFrameAncestors,
  versionAssetContent,
} from "./release-artifact";

const ORIGINS = {
  apiOrigin: "https://api.example.test",
  taskpaneOrigin: "https://outlook.example.test",
  webOrigin: "https://my.example.test",
};

describe("Outlook release artifact contract", () => {
  test("versions code bytes before deriving their immutable filename", () => {
    const first = versionAssetContent({
      content: new TextEncoder().encode("console.log('first');\n"),
      extension: ".js",
      version: "1.2.3.4",
    });
    const second = versionAssetContent({
      content: new TextEncoder().encode("console.log('second');\n"),
      extension: ".js",
      version: "1.2.3.4",
    });

    expect(new TextDecoder().decode(first)).toStartWith(
      "// stella-outlook-version: 1.2.3.4\n",
    );
    expect(
      createContentHashedAssetName({
        content: first,
        extension: ".js",
        name: "main",
      }),
    ).not.toBe(
      createContentHashedAssetName({
        content: second,
        extension: ".js",
        name: "main",
      }),
    );
  });

  test("extracts only content-hashed code assets from versioned HTML", () => {
    const html = `<meta name="stella-outlook-version" content="1.2.3.4" />
      <link rel="stylesheet" href="/assets/main.a1b2c3d4e5f60708.css" />
      <script src="/assets/main.0123456789abcdef.js"></script>`;

    expect(getHtmlReleaseVersion(html)).toBe("1.2.3.4");
    expect(getHtmlAssetPaths(html).every(isContentHashedCodeAsset)).toBe(true);
  });

  test("extracts each unique manifest icon path", () => {
    const manifest = `<IconUrl DefaultValue="https://outlook.example.test/assets/stella-icon-32.png" />
      <bt:Image DefaultValue="https://outlook.example.test/assets/stella-icon-80.png" />
      <bt:Image DefaultValue="https://outlook.example.test/assets/stella-icon-32.png" />`;

    expect(getManifestIconPaths(manifest)).toEqual([
      "/assets/stella-icon-32.png",
      "/assets/stella-icon-80.png",
    ]);
  });

  test("declares no-cache documents and a CSP limited to stella and Office", () => {
    const rules = getOutlookDeploymentHeaderRules(ORIGINS);
    const taskpane = rules.find((rule) => rule.path === "/taskpane.html");

    expect(taskpane?.headers["Cache-Control"]).toContain("no-cache");
    expect(taskpane?.headers["Content-Security-Policy"]).toContain(
      "https://appsforoffice.microsoft.com",
    );
    expect(taskpane?.headers["Content-Security-Policy"]).toContain(
      ORIGINS.apiOrigin,
    );
    expect(taskpane?.headers["Content-Security-Policy"]).toContain(
      ORIGINS.webOrigin,
    );
    expect(
      rules.find((rule) => rule.path === "/assets/stella-icon-*.png")?.headers[
        "Cache-Control"
      ],
    ).toContain("no-cache");
  });

  test("uses explicitly configured OWA frame ancestors without widening CSP", () => {
    const frameAncestors = resolveOutlookFrameAncestors(
      "https://mail.example.test,https://outlook.office365.us",
    );
    const rules = getOutlookDeploymentHeaderRules({
      ...ORIGINS,
      ...(frameAncestors ? { frameAncestors } : {}),
    });
    const csp = rules.find((rule) => rule.path === "/taskpane.html")?.headers[
      "Content-Security-Policy"
    ];

    expect(csp).toContain("frame-ancestors https://mail.example.test");
    expect(csp).toContain("https://outlook.office365.us");
    expect(csp).not.toContain("https://outlook.office.com");
  });

  test("rejects React in a command or later event runtime", () => {
    expect(() =>
      assertOfficeRuntimeEntryIsIsolated('import { useState } from "react";'),
    ).toThrow("must stay isolated");
  });
});
