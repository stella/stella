#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { CLI_DEMO_TOOLS } from "../apps/landing/src/data/cli-demo";
import {
  productStoryEditorPortraitMedia,
  productStoryHeroMedia,
  productStoryMedia,
} from "../apps/landing/src/data/product-story";
import { products } from "../apps/landing/src/data/products/registry";
import { securityControls } from "../apps/landing/src/data/security-controls";
import { readProductMediaManifestSync } from "./product-media";

const CAPABILITY_CATALOG_PATH = "packages/cli/capability-catalog.json";
const POLICY_EVIDENCE_PATH = "docs/policies/evidence.json";
const CLI_REGISTRY_SNAPSHOT_PATH =
  "packages/cli/src/generated/registry-snapshot.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getCapabilityIds = (rootDir: string): Set<string> => {
  const catalogPath = nodePath.join(rootDir, CAPABILITY_CATALOG_PATH);
  const raw: unknown = JSON.parse(readFileSync(catalogPath, "utf-8"));
  if (!Array.isArray(raw)) {
    throw new TypeError(`${CAPABILITY_CATALOG_PATH} must contain an array`);
  }

  const ids = new Set<string>();
  for (const capability of raw) {
    if (!isRecord(capability) || typeof capability["id"] !== "string") {
      throw new TypeError(
        `${CAPABILITY_CATALOG_PATH} contains a capability without an id`,
      );
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

    const heroPath = nodePath.join(
      rootDir,
      "apps/landing/public",
      product.hero.src.replace(/^\//u, ""),
    );
    if (!existsSync(heroPath)) {
      errors.push(`${product.slug}: missing captured hero ${product.hero.src}`);
    }
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
