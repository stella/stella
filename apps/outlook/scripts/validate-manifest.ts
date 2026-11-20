import { panic } from "better-result";
import { XmlDocument, XmlValidateError, XsdValidator } from "libxml2-wasm";
import { xmlRegisterFsInputProviders } from "libxml2-wasm/lib/nodejs.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const SCHEMA_DIR = path.resolve(APP_ROOT, "schemas");
const ROOT_SCHEMA = path.resolve(SCHEMA_DIR, "OfficeAppManifestV1_1.xsd");

export class ManifestValidationError extends Error {
  override readonly name = "ManifestValidationError";
  readonly manifestPath: string;
  readonly details: string;

  constructor(manifestPath: string, details: string) {
    super(`Manifest ${manifestPath} failed XSD validation:\n${details}`);
    this.manifestPath = manifestPath;
    this.details = details;
  }
}

let registeredFsProviders = false;

const buildValidator = (): XsdValidator => {
  if (!existsSync(ROOT_SCHEMA)) {
    panic(
      `Missing vendored manifest schema at ${ROOT_SCHEMA}. ` +
        `The XSD set in apps/outlook/schemas/ is required for offline validation.`,
    );
  }
  if (!registeredFsProviders) {
    // Lets libxml2 resolve the sibling xs:import schemaLocation references
    // (OfficeAppBasicTypesV1_0.xsd, MailAppVersionOverridesV1_0/1_1.xsd, ...)
    // against the real filesystem instead of the network.
    xmlRegisterFsInputProviders();
    registeredFsProviders = true;
  }
  const schemaDoc = XmlDocument.fromString(readFileSync(ROOT_SCHEMA, "utf-8"), {
    url: pathToFileURL(ROOT_SCHEMA).href,
  });
  try {
    return XsdValidator.fromDoc(schemaDoc);
  } finally {
    schemaDoc.dispose();
  }
};

export const validateManifestFile = (manifest: string): void => {
  const manifestPath = path.resolve(manifest);
  if (!existsSync(manifestPath)) {
    panic(`Manifest not found: ${manifestPath}`);
  }

  const validator = buildValidator();
  const manifestDoc = XmlDocument.fromString(
    readFileSync(manifestPath, "utf-8"),
  );
  try {
    validator.validate(manifestDoc);
  } catch (error) {
    if (error instanceof XmlValidateError) {
      throw new ManifestValidationError(manifestPath, error.message);
    }
    throw error;
  } finally {
    manifestDoc.dispose();
    validator.dispose();
  }
};

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    panic("Usage: bun scripts/validate-manifest.ts <manifest.xml>");
  }
  try {
    validateManifestFile(target);
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  process.stdout.write(
    `OK: ${path.resolve(target)} is a valid Outlook add-in manifest\n`,
  );
}
