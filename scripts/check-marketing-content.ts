#!/usr/bin/env bun

import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import { CLI_DEMO_TOOLS } from "../apps/landing/src/data/cli-demo";
import { productCaptures } from "../apps/landing/src/data/product-captures";
import {
  productStoryEditorPortraitMedia,
  productStoryHeroMedia,
  productStoryMedia,
} from "../apps/landing/src/data/product-story";
import { products } from "../apps/landing/src/data/products/registry";
import { securityControls } from "../apps/landing/src/data/security-controls";
import { readCapabilityCatalog } from "../packages/cli/src/capability-catalog-data";
import { readProductMediaManifestSync } from "./product-media";

const CAPABILITY_CATALOG_PATH = "packages/cli/capabilities";
const POLICY_EVIDENCE_PATH = "docs/policies/evidence.json";
const CLI_REGISTRY_SNAPSHOT_PATH =
  "packages/cli/src/generated/registry-snapshot.json";

const ROOT_README_PATH = "README.md";

// Computed filesystem reads retain these repository Markdown inputs.
export const CI_MARKDOWN_READER_INPUTS = ["README.md"];
export const CI_MARKDOWN_READER_COMMAND =
  "bun scripts/check-marketing-content.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRemoteReference = (reference: string) =>
  reference.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(reference);

// GitHub reads `#gh-dark-mode-only` style fragments and query strings off an
// image URL; the file on disk is the path before them.
const imageFilePath = (reference: string) => {
  const suffix = reference.search(/[?#]/u);
  return suffix === -1 ? reference : reference.slice(0, suffix);
};

// One pass, in document order: `src`, each `srcset` candidate (without its
// width or density descriptor), inline `![alt](path "title")`, and
// reference-style `![alt][label]` / `![label]`, which resolve through a
// `[label]: path` definition (labels match case-insensitively).
const IMAGE_REFERENCE =
  /\bsrc="([^"]+)"|\bsrcset="([^"]+)"|!\[([^\]]*)\](?:\(\s*<?([^\s)>]+)|\[([^\]]*)\])?/gu;

const readmeImageReferences = (readme: string): string[] => {
  const definitions = new Map(
    [...readme.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)/gmu)].map(
      (match) => [(match[1] ?? "").toLowerCase(), match[2] ?? ""] as const,
    ),
  );
  return [...readme.matchAll(IMAGE_REFERENCE)].flatMap((match) => {
    const [, src, srcset, alt, inline, label] = match;
    if (src !== undefined) {
      return [src];
    }
    if (srcset !== undefined) {
      return srcset
        .split(",")
        .map((candidate) => candidate.trim().split(/\s+/u)[0] ?? "");
    }
    if (inline !== undefined) {
      return [inline];
    }
    const key = (label === undefined || label === "" ? alt : label) ?? "";
    const destination = definitions.get(key.toLowerCase());
    return destination === undefined ? [] : [destination];
  });
};

// The root README's tour embeds the captured product screenshots by
// repository-relative path; a renamed capture must fail here, not render as
// a broken image on GitHub.
export const findMissingReadmeImages = (
  readme: string,
  exists: (relativePath: string) => boolean,
): string[] => {
  const missing: string[] = [];
  for (const reference of readmeImageReferences(readme)) {
    if (reference === "" || isRemoteReference(reference)) {
      continue;
    }
    if (!exists(imageFilePath(reference)) && !missing.includes(reference)) {
      missing.push(reference);
    }
  }
  return missing;
};

const getCapabilityIds = (rootDir: string): Set<string> => {
  const catalogPath = nodePath.join(rootDir, CAPABILITY_CATALOG_PATH);
  const raw = readCapabilityCatalog(
    pathToFileURL(`${catalogPath}${nodePath.sep}`),
  );

  const ids = new Set<string>();
  for (const capability of raw) {
    if (!isRecord(capability) || typeof capability["id"] !== "string") {
      panic(`${CAPABILITY_CATALOG_PATH} contains a capability without an id`);
    }
    ids.add(capability["id"]);
  }
  return ids;
};

export const checkMarketingContent = (rootDir: string): string[] => {
  const errors: string[] = [];
  const capabilityIds = getCapabilityIds(rootDir);
  const productMediaPaths = new Set(
    readProductMediaManifestSync(rootDir).assets.map(({ path }) => `/${path}`),
  );

  const cliRegistry: unknown = JSON.parse(
    readFileSync(nodePath.join(rootDir, CLI_REGISTRY_SNAPSHOT_PATH), "utf-8"),
  );
  if (!Array.isArray(cliRegistry)) {
    errors.push(`${CLI_REGISTRY_SNAPSHOT_PATH} must contain an array`);
  } else {
    const toolNames = new Set(
      cliRegistry.flatMap((tool) => {
        if (!isRecord(tool) || typeof tool["name"] !== "string") {
          return [];
        }
        return [tool["name"]];
      }),
    );
    for (const toolName of Object.values(CLI_DEMO_TOOLS)) {
      if (!toolNames.has(toolName)) {
        errors.push(
          `cli-mcp: demo tool ${toolName} has drifted from the generated CLI registry`,
        );
      }
    }
  }

  const storyMediaEntries = [
    ...Object.entries(productStoryMedia),
    ...Object.entries(productStoryHeroMedia).map(
      ([sceneId, media]) => [`${sceneId} (hero)`, media] as const,
    ),
    ["editor (portrait)", productStoryEditorPortraitMedia] as const,
  ];
  for (const [sceneId, media] of storyMediaEntries) {
    for (const asset of [
      media.videoSrc,
      media.darkVideoSrc,
      media.posterSrc,
      media.darkPosterSrc,
    ]) {
      const assetPath = nodePath.join(
        rootDir,
        "apps/landing/public",
        asset.replace(/^\//u, ""),
      );
      if (!existsSync(assetPath) && !productMediaPaths.has(asset)) {
        errors.push(`${sceneId}: missing product story asset ${asset}`);
      }
    }
  }

  for (const product of products) {
    if (product.evidence.length === 0) {
      errors.push(
        `${product.slug}: product page has no implementation evidence`,
      );
      continue;
    }

    for (const evidence of product.evidence) {
      if (evidence.type === "capability") {
        if (!capabilityIds.has(evidence.id)) {
          errors.push(
            `${product.slug}: missing generated capability ${evidence.id}`,
          );
        }
        continue;
      }

      const evidencePath = nodePath.join(rootDir, evidence.path);
      if (!existsSync(evidencePath)) {
        errors.push(
          `${product.slug}: missing source evidence ${evidence.path}`,
        );
        continue;
      }

      const source = readFileSync(evidencePath, "utf-8");
      for (const expected of evidence.contains) {
        if (!source.includes(expected)) {
          errors.push(
            `${product.slug}: ${evidence.path} no longer contains ${JSON.stringify(expected)}`,
          );
        }
      }
    }

    const contentPath = nodePath.join(
      rootDir,
      `apps/landing/src/data/products/${product.slug}.ts`,
    );
    if (!existsSync(contentPath)) {
      errors.push(
        `${product.slug}: missing product content file ${contentPath}`,
      );
      continue;
    }

    const content = readFileSync(contentPath, "utf-8");
    if (content.includes('type: "placeholder"')) {
      errors.push(
        `${product.slug}: product page still contains placeholder media`,
      );
    }

    if (
      product.hero.type === "preview" ||
      product.hero.type === "story" ||
      // A live, in-browser run of the real engine (see AnonymizeLiveDemo,
      // EditorLiveDemo) is more substantiated than a static asset, not
      // less; nothing on disk to verify.
      product.hero.type === "live-anonymize" ||
      product.hero.type === "live-editor"
    ) {
      continue;
    }

    if (product.hero.type !== "image") {
      errors.push(
        `${product.slug}: product hero must be a captured image, recorded story, or registered preview`,
      );
      continue;
    }

    const capture = productCaptures[product.hero.captureId];
    for (const sources of Object.values(capture)) {
      for (const publicPath of new Set(Object.values(sources))) {
        const heroPath = nodePath.join(
          rootDir,
          "apps/landing/public",
          publicPath.replace(/^\//u, ""),
        );
        if (!existsSync(heroPath)) {
          errors.push(`${product.slug}: missing captured hero ${publicPath}`);
        }
      }
    }
  }

  const readme = readFileSync(
    nodePath.join(rootDir, ROOT_README_PATH),
    "utf-8",
  );
  for (const reference of findMissingReadmeImages(readme, (relativePath) =>
    existsSync(nodePath.join(rootDir, relativePath)),
  )) {
    errors.push(`${ROOT_README_PATH}: missing image ${reference}`);
  }

  const policyManifest: unknown = JSON.parse(
    readFileSync(nodePath.join(rootDir, POLICY_EVIDENCE_PATH), "utf-8"),
  );
  if (!isRecord(policyManifest) || !Array.isArray(policyManifest["controls"])) {
    errors.push(`${POLICY_EVIDENCE_PATH} must contain a controls array`);
    return errors;
  }

  const policiesByControlId = new Map<string, string>();
  for (const control of policyManifest["controls"]) {
    if (
      isRecord(control) &&
      typeof control["id"] === "string" &&
      typeof control["policy"] === "string"
    ) {
      policiesByControlId.set(control["id"], control["policy"]);
    }
  }

  for (const control of securityControls) {
    const policy = policiesByControlId.get(control.evidenceId);
    if (policy === undefined) {
      errors.push(`security: missing policy control ${control.evidenceId}`);
      continue;
    }
    if (policy !== control.policyPath) {
      errors.push(
        `security: ${control.evidenceId} points to ${policy}, not ${control.policyPath}`,
      );
    }
  }

  return errors;
};

if (import.meta.main) {
  const errors = checkMarketingContent(process.cwd());
  if (errors.length > 0) {
    process.stderr.write(
      `${errors.map((error) => `marketing-content: ${error}`).join("\n")}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `marketing-content: ${products.length} product pages and ${securityControls.length} security controls verified against source\n`,
  );
}
