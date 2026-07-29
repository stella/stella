import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderManifest } from "../scripts/render-manifest";
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
});
