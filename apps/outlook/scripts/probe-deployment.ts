import { panic } from "better-result";

import {
  assertOutlookReleaseVersion,
  getHtmlAssetPaths,
  getHtmlReleaseVersion,
  getOutlookDeploymentHeaderRules,
  isContentHashedCodeAsset,
  type OutlookReleaseOrigins,
} from "./release-artifact";

type ReleaseMetadata = {
  assets: Record<string, string>;
  origins: OutlookReleaseOrigins;
  schemaVersion: number;
  version: string;
};

const REQUIRED_HTML_FILES = ["taskpane.html", "commands.html", "dialog.html"];
const VERSION_BANNER_PATTERN =
  /(?:\/\/|\/\*) stella-outlook-version: (\d+\.\d+\.\d+\.\d+)/u;

const parseOrigin = (): URL => {
  const flag = process.argv.find((arg) => arg.startsWith("--origin="));
  if (!flag) {
    panic("Usage: bun scripts/probe-deployment.ts --origin=https://outlook.example");
  }
  const origin = new URL(flag.slice("--origin=".length));
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    panic("--origin must be an HTTPS origin without a path.");
  }
  return origin;
};

const urlAt = (origin: URL, pathname: string): URL => new URL(pathname, origin);

const assertHeader = ({
  headers,
  name,
  url,
  value,
}: {
  headers: Headers;
  name: string;
  url: URL;
  value: string;
}): void => {
  if (headers.get(name) !== value) {
    throw new Error(`${url.pathname} must return ${name}.`);
  }
};

const fetchText = async (url: URL): Promise<Response> => {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  }
  return response;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readReleaseMetadata = (value: unknown): ReleaseMetadata => {
  if (!isRecord(value)) {
    throw new Error("release.json must be an object.");
  }
  const metadata = value;
  const assets = metadata["assets"];
  const origins = metadata["origins"];
  const version = metadata["version"];
  if (
    metadata["schemaVersion"] !== 1 ||
    typeof version !== "string" ||
    !isRecord(assets) ||
    !isRecord(origins)
  ) {
    throw new Error("release.json has an unsupported shape.");
  }
  const parsedAssets: Record<string, string> = {};
  for (const [name, assetPath] of Object.entries(assets)) {
    if (typeof assetPath !== "string") {
      throw new Error("release.json has invalid assets or origins.");
    }
    parsedAssets[name] = assetPath;
  }
  const apiOrigin = origins["apiOrigin"];
  const frameAncestors = origins["frameAncestors"];
  const taskpaneOrigin = origins["taskpaneOrigin"];
  const uploadOrigin = origins["uploadOrigin"];
  const webOrigin = origins["webOrigin"];
  const parsedFrameAncestors: string[] = [];
  if (frameAncestors !== undefined) {
    if (!Array.isArray(frameAncestors)) {
      throw new Error("release.json has invalid assets or origins.");
    }
    for (const ancestor of frameAncestors) {
      if (typeof ancestor !== "string") {
        throw new Error("release.json has invalid assets or origins.");
      }
      parsedFrameAncestors.push(ancestor);
    }
    if (parsedFrameAncestors.length === 0) {
      throw new Error("release.json has invalid assets or origins.");
    }
  }
  if (
    Object.keys(parsedAssets).length === 0 ||
    typeof apiOrigin !== "string" ||
    typeof taskpaneOrigin !== "string" ||
    (uploadOrigin !== undefined && typeof uploadOrigin !== "string") ||
    typeof webOrigin !== "string"
  ) {
    throw new Error("release.json has invalid assets or origins.");
  }
  assertOutlookReleaseVersion(version);
  return {
    assets: parsedAssets,
    origins: {
      apiOrigin,
      ...(parsedFrameAncestors.length > 0
        ? { frameAncestors: parsedFrameAncestors }
        : {}),
      taskpaneOrigin,
      ...(uploadOrigin ? { uploadOrigin } : {}),
      webOrigin,
    },
    schemaVersion: 1,
    version,
  };
};

const readVersionBanner = async (
  url: URL,
): Promise<{ headers: Headers; version: string | null }> => {
  const response = await fetch(url, {
    headers: { Range: "bytes=0-127" },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  }
  const match = VERSION_BANNER_PATTERN.exec(await response.text());
  return { headers: response.headers, version: match?.[1] ?? null };
};

const run = async () => {
  const origin = parseOrigin();
  const releaseUrl = urlAt(origin, "/release.json");
  const releaseResponse = await fetchText(releaseUrl);
  const release = readReleaseMetadata(await releaseResponse.json());
  if (release.origins.taskpaneOrigin !== origin.origin) {
    throw new Error("release.json taskpane origin does not match --origin.");
  }

  const headerRules = getOutlookDeploymentHeaderRules(release.origins);
  const releaseCacheControl = headerRules.find(
    (rule) => rule.path === "/release.json",
  )?.headers["Cache-Control"];
  if (!releaseCacheControl) {
    throw new Error("release contract has no release metadata cache rule.");
  }
  assertHeader({
    headers: releaseResponse.headers,
    name: "Cache-Control",
    url: releaseUrl,
    value: releaseCacheControl,
  });
  const manifestResponse = await fetchText(urlAt(origin, "/manifest.xml"));
  const manifestRule = headerRules.find((rule) => rule.path === "/manifest.xml");
  const manifestCacheControl = manifestRule?.headers["Cache-Control"];
  if (!manifestCacheControl) {
    throw new Error("release contract has no manifest cache rule.");
  }
  assertHeader({
    headers: manifestResponse.headers,
    name: "Cache-Control",
    url: urlAt(origin, "/manifest.xml"),
    value: manifestCacheControl,
  });
  const manifest = await manifestResponse.text();
  if (!manifest.includes(`<Version>${release.version}</Version>`)) {
    throw new Error("manifest version does not match release.json.");
  }
  if (!manifest.includes(`${origin.origin}/taskpane.html`)) {
    throw new Error("manifest task pane location does not match --origin.");
  }

  const codeAssets = new Set<string>();
  for (const fileName of REQUIRED_HTML_FILES) {
    const url = urlAt(origin, `/${fileName}`);
    const response = await fetchText(url);
    const expectedHeaders = headerRules.find(
      (rule) => rule.path === `/${fileName}`,
    )?.headers;
    if (!expectedHeaders) {
      throw new Error(`release contract has no headers for ${fileName}.`);
    }
    for (const [name, value] of Object.entries(expectedHeaders)) {
      assertHeader({ headers: response.headers, name, url, value });
    }
    const html = await response.text();
    if (getHtmlReleaseVersion(html) !== release.version) {
      throw new Error(`${fileName} version does not match release.json.`);
    }
    for (const assetPath of getHtmlAssetPaths(html)) {
      if (!isContentHashedCodeAsset(assetPath)) {
        throw new Error(`${fileName} references a non-hashed code asset.`);
      }
      codeAssets.add(assetPath);
    }
  }

  for (const assetPath of Object.values(release.assets)) {
    if (!codeAssets.has(assetPath)) {
      throw new Error(`release.json asset ${assetPath} is not referenced by HTML.`);
    }
    const url = urlAt(origin, assetPath);
    const assetRule = headerRules.find(
      (rule) =>
        (assetPath.endsWith(".js") && rule.path === "/assets/*.js") ||
        (assetPath.endsWith(".css") && rule.path === "/assets/*.css"),
    );
    if (!assetRule) {
      throw new Error(`release contract has no headers for ${assetPath}.`);
    }
    const asset = await readVersionBanner(url);
    if (asset.version !== release.version) {
      throw new Error(`${assetPath} version banner does not match release.json.`);
    }
    for (const [name, value] of Object.entries(assetRule.headers)) {
      assertHeader({ headers: asset.headers, name, url, value });
    }
  }

  console.log(`Outlook deployment probe passed for ${origin.origin} (${release.version}).`);
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown probe failure.";
  console.error(`Outlook deployment probe failed: ${message}`);
  process.exit(1);
});
