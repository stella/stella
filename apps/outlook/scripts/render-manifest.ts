import { panic } from "better-result";
import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const APP_ROOT = resolve(import.meta.dirname, "..");
const TEMPLATE_PATH = resolve(APP_ROOT, "manifest.template.xml");

export type ManifestEnv = "dev" | "prod";

type ManifestPlaceholders = {
  API_ORIGIN: string;
  PROVIDER_NAME: string;
  SUPPORT_URL: string;
  TASKPANE_ORIGIN: string;
  VERSION: string;
  WEB_ORIGIN: string;
};

const PLACEHOLDER_DEFAULTS: Record<ManifestEnv, ManifestPlaceholders> = {
  dev: {
    API_ORIGIN: "http://localhost:3001",
    PROVIDER_NAME: "stella (dev)",
    SUPPORT_URL: "https://stll.app",
    TASKPANE_ORIGIN: "https://localhost:3002",
    VERSION: "0.1.0.0",
    WEB_ORIGIN: "http://localhost:3000",
  },
  prod: {
    API_ORIGIN: "https://api.stll.app",
    PROVIDER_NAME: "stella",
    SUPPORT_URL: "https://stll.app",
    TASKPANE_ORIGIN: "https://outlook.stll.app",
    VERSION: "0.1.0.0",
    WEB_ORIGIN: "https://my.stll.app",
  },
};

const PLACEHOLDER_ENV_VARS: Record<keyof ManifestPlaceholders, string> = {
  API_ORIGIN: "STELLA_API_ORIGIN",
  PROVIDER_NAME: "STELLA_PROVIDER_NAME",
  SUPPORT_URL: "STELLA_SUPPORT_URL",
  TASKPANE_ORIGIN: "STELLA_TASKPANE_ORIGIN",
  VERSION: "STELLA_OUTLOOK_VERSION",
  WEB_ORIGIN: "STELLA_WEB_ORIGIN",
};

const PLACEHOLDER_KEYS = [
  "API_ORIGIN",
  "PROVIDER_NAME",
  "SUPPORT_URL",
  "TASKPANE_ORIGIN",
  "VERSION",
  "WEB_ORIGIN",
] as const satisfies readonly (keyof ManifestPlaceholders)[];

const resolvePlaceholders = (env: ManifestEnv): ManifestPlaceholders => {
  const defaults = PLACEHOLDER_DEFAULTS[env];
  const result = { ...defaults };
  for (const key of PLACEHOLDER_KEYS) {
    const override = process.env[PLACEHOLDER_ENV_VARS[key]];
    if (override) {
      result[key] = override;
    }
  }
  return result;
};

const UNRESOLVED_PATTERN = /\{\{[A-Z_]+\}\}/u;

// The mail (mailappversionoverrides) DesktopFormFactor accepts only these
// child elements. GetStarted is a Taskpane-host element: Outlook rejects a
// mail manifest that nests it ("invalid child element 'GetStarted'"), so every
// render is validated structurally instead of trusting hand edits to the XML.
const MAIL_DESKTOP_FORM_FACTOR_CHILDREN = new Set([
  "FunctionFile",
  "ExtensionPoint",
]);

type XmlNode = Record<string, unknown>;

const isXmlNodeArray = (value: unknown): value is XmlNode[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );

const walkElements = function* (
  nodes: XmlNode[],
): Generator<{ children: XmlNode[]; tag: string }> {
  for (const node of nodes) {
    for (const [tag, value] of Object.entries(node)) {
      if (tag === ":@" || tag === "#text" || !isXmlNodeArray(value)) {
        continue;
      }
      yield { children: value, tag };
      yield* walkElements(value);
    }
  }
};

const childElementTags = (children: XmlNode[]): string[] =>
  children
    .flatMap((child) => Object.keys(child))
    .filter((tag) => tag !== ":@" && tag !== "#text");

/**
 * Reject manifests Outlook would refuse at sideload, guarding the one place
 * hand edits go wrong: the children allowed under the mail DesktopFormFactor.
 */
export const assertValidMailManifest = (xml: string): void => {
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
  }).parse(xml);
  if (!isXmlNodeArray(parsed)) {
    panic("Manifest did not parse into an element tree");
  }

  let desktopFormFactorCount = 0;
  for (const element of walkElements(parsed)) {
    if (element.tag !== "DesktopFormFactor") {
      continue;
    }
    desktopFormFactorCount += 1;
    for (const childTag of childElementTags(element.children)) {
      if (!MAIL_DESKTOP_FORM_FACTOR_CHILDREN.has(childTag)) {
        panic(
          `Invalid <${childTag}> under the mail DesktopFormFactor. Allowed: ${[
            ...MAIL_DESKTOP_FORM_FACTOR_CHILDREN,
          ].join(", ")}. GetStarted is Taskpane-only and Outlook rejects it.`,
        );
      }
    }
  }

  if (desktopFormFactorCount === 0) {
    panic("Manifest has no DesktopFormFactor; expected a Mailbox host.");
  }
};

export const renderManifest = (env: ManifestEnv): string => {
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const placeholders = resolvePlaceholders(env);
  let output = template;
  for (const [key, value] of Object.entries(placeholders)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  const unresolved = UNRESOLVED_PATTERN.exec(output);
  if (unresolved) {
    panic(`Unresolved manifest placeholder: ${unresolved[0]}`);
  }
  assertValidMailManifest(output);
  return output;
};
