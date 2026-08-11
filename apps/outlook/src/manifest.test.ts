import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  renderManifest,
  resolveManifestPlaceholders,
  resolveOutlookRuntimeConfig,
} from "../scripts/render-manifest";
import {
  ManifestValidationError,
  validateManifestFile,
} from "../scripts/validate-manifest";

const validateXml = (xml: string): void => {
  const dir = mkdtempSync(path.join(tmpdir(), "stella-manifest-"));
  const manifestPath = path.join(dir, "manifest.xml");
  writeFileSync(manifestPath, xml);
  try {
    validateManifestFile(manifestPath);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

describe("manifest XSD validation", () => {
  test("keeps the checked-in sideload manifest bound to the dev template", () => {
    const checkedInManifest = readFileSync(
      path.resolve(import.meta.dirname, "..", "manifest.xml"),
      "utf-8",
    );

    expect(checkedInManifest).toBe(renderManifest("dev", {}));
  });

  test("the rendered dev and prod manifests are schema-valid", () => {
    expect(() => validateXml(renderManifest("dev"))).not.toThrow();
    expect(() => validateXml(renderManifest("prod"))).not.toThrow();
  });

  test("rejects a Taskpane-only GetStarted under the mail DesktopFormFactor", () => {
    const broken = renderManifest("dev").replace(
      '<FunctionFile resid="Commands.Url" />',
      '<FunctionFile resid="Commands.Url" /><GetStarted><Title resid="x" /></GetStarted>',
    );
    expect(() => validateXml(broken)).toThrow(ManifestValidationError);
  });

  test("rejects a v1.1-only SupportsPinning inside a v1.0 Action", () => {
    const broken = renderManifest("dev").replace(
      '<SourceLocation resid="Taskpane.Url" />',
      '<SourceLocation resid="Taskpane.Url" /><SupportsPinning>true</SupportsPinning>',
    );
    expect(() => validateXml(broken)).toThrow(ManifestValidationError);
  });

  test("ships a mobile read command surface in the v1.1 manifest", () => {
    const manifest = renderManifest("prod");

    expect(manifest).toContain('xsi:type="MobileMessageReadCommandSurface"');
    expect(manifest).toContain('xsi:type="bt:MobileIconList"');
    expect(manifest).toContain('resid="Icon.25x25"');
    expect(manifest).toContain('resid="Icon.48x48"');
  });

  test("requires Mailbox 1.8 for attachment APIs", () => {
    for (const environment of ["dev", "prod"] as const) {
      const manifest = renderManifest(environment);

      expect(manifest).toContain('<Set Name="Mailbox" MinVersion="1.8" />');
      expect(manifest).not.toContain('<Set Name="Mailbox" MinVersion="1.5" />');
      expect(manifest.match(/DefaultMinVersion="1\.8"/gu)).toHaveLength(2);
      expect(manifest).not.toContain('DefaultMinVersion="1.5"');
    }
  });

  test("uses a Marketplace-compatible release version", () => {
    const manifest = renderManifest("prod");

    expect(manifest).toContain("<Version>1.0.0.0</Version>");
  });

  test("applies custom deployment origins to the shared build configuration", () => {
    const runtimeEnv = {
      STELLA_API_ORIGIN: "https://api.example.test",
      STELLA_TASKPANE_ORIGIN: "https://outlook.example.test",
      STELLA_WEB_ORIGIN: "https://app.example.test",
    };
    const placeholders = resolveManifestPlaceholders("prod", runtimeEnv);

    expect(placeholders).toMatchObject({
      API_ORIGIN: "https://api.example.test",
      TASKPANE_ORIGIN: "https://outlook.example.test",
      WEB_ORIGIN: "https://app.example.test",
    });
    expect(
      resolveOutlookRuntimeConfig({
        env: "prod",
        placeholders,
        runtimeEnv,
      }),
    ).toEqual({
      apiBaseUrl: "https://api.example.test",
      taskpaneOrigin: "https://outlook.example.test",
      webOrigin: "https://app.example.test",
    });
  });
});
