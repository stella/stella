import { panic } from "better-result";
import { createHash } from "node:crypto";

export type OutlookReleaseOrigins = {
  apiOrigin: string;
  frameAncestors?: string[];
  taskpaneOrigin: string;
  uploadOrigin?: string;
  webOrigin: string;
};

export type OutlookDeploymentHeaderRule = {
  headers: Record<string, string>;
  path: string;
};

export const OUTLOOK_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/u;
export const NO_CACHE_HEADER = "no-cache, max-age=0, must-revalidate";
export const IMMUTABLE_ASSET_CACHE_HEADER =
  "public, max-age=31536000, immutable";

const OFFICE_JS_ORIGIN = "https://appsforoffice.microsoft.com";
const DEFAULT_OFFICE_FRAME_ANCESTORS = [
  "https://outlook.office.com",
  "https://outlook.office365.com",
  "https://outlook.officeapps.live.com",
  "https://outlook.live.com",
  "https://outlook-sdf.office.com",
  "https://outlook-sdf.office365.com",
  "https://outlook.office365.cn",
  "https://outlook.office365.us",
  "https://outlook-dod.office365.us",
];

const normalizeHttpsOrigin = (value: string, label: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    panic(`${label} must be an HTTPS origin without a path.`);
  }
  return url.origin;
};

export const assertOutlookReleaseVersion = (version: string): void => {
  if (!OUTLOOK_RELEASE_VERSION_PATTERN.test(version)) {
    panic(
      `Outlook release version must have four numeric parts, received ${JSON.stringify(version)}.`,
    );
  }
};

const normalizeFrameAncestors = (
  frameAncestors: string[] | undefined,
): string[] | undefined => {
  if (!frameAncestors) {
    return undefined;
  }
  if (frameAncestors.length === 0) {
    panic("STELLA_OUTLOOK_FRAME_ANCESTORS cannot be empty.");
  }
  return [
    ...new Set(
      frameAncestors.map((origin) =>
        normalizeHttpsOrigin(origin, "STELLA_OUTLOOK_FRAME_ANCESTORS"),
      ),
    ),
  ];
};

export const resolveOutlookFrameAncestors = (
  value: string | undefined,
): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return normalizeFrameAncestors(
    value.split(",").map((origin) => origin.trim()),
  );
};

export const normalizeOutlookReleaseOrigins = (
  origins: OutlookReleaseOrigins,
): OutlookReleaseOrigins => {
  const frameAncestors = normalizeFrameAncestors(origins.frameAncestors);
  return {
    apiOrigin: normalizeHttpsOrigin(origins.apiOrigin, "STELLA_API_ORIGIN"),
    ...(frameAncestors ? { frameAncestors } : {}),
    taskpaneOrigin: normalizeHttpsOrigin(
      origins.taskpaneOrigin,
      "STELLA_TASKPANE_ORIGIN",
    ),
    ...(origins.uploadOrigin
      ? {
          uploadOrigin: normalizeHttpsOrigin(
            origins.uploadOrigin,
            "STELLA_UPLOAD_ORIGIN",
          ),
        }
      : {}),
    webOrigin: normalizeHttpsOrigin(origins.webOrigin, "STELLA_WEB_ORIGIN"),
  };
};

const buildContentSecurityPolicy = ({
  apiOrigin,
  frameAncestors,
  uploadOrigin,
  webOrigin,
}: OutlookReleaseOrigins): string =>
  [
    "default-src 'none'",
    "base-uri 'none'",
    `connect-src 'self' ${apiOrigin} ${webOrigin} ${OFFICE_JS_ORIGIN}${
      uploadOrigin ? ` ${uploadOrigin}` : ""
    }`,
    "font-src 'self'",
    "form-action 'self'",
    `frame-ancestors ${(frameAncestors ?? DEFAULT_OFFICE_FRAME_ANCESTORS).join(
      " ",
    )}`,
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src 'self' ${OFFICE_JS_ORIGIN}`,
    "style-src 'self'",
    "worker-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

export const getOutlookHtmlSecurityHeaders = (
  origins: OutlookReleaseOrigins,
): Record<string, string> => {
  const normalizedOrigins = normalizeOutlookReleaseOrigins(origins);
  return {
    "Content-Security-Policy": buildContentSecurityPolicy(normalizedOrigins),
    "Permissions-Policy":
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-DNS-Prefetch-Control": "off",
    "X-Permitted-Cross-Domain-Policies": "none",
  };
};

export const getOutlookDeploymentHeaderRules = (
  origins: OutlookReleaseOrigins,
): OutlookDeploymentHeaderRule[] => {
  const htmlHeaders = {
    ...getOutlookHtmlSecurityHeaders(origins),
    "Cache-Control": NO_CACHE_HEADER,
  };

  return [
    {
      headers: { "Cache-Control": NO_CACHE_HEADER },
      path: "/manifest.xml",
    },
    {
      headers: { "Cache-Control": NO_CACHE_HEADER },
      path: "/release.json",
    },
    {
      headers: { "Cache-Control": NO_CACHE_HEADER },
      path: "/deployment-headers.json",
    },
    { headers: htmlHeaders, path: "/taskpane.html" },
    { headers: htmlHeaders, path: "/commands.html" },
    { headers: htmlHeaders, path: "/dialog.html" },
    {
      headers: {
        "Cache-Control": IMMUTABLE_ASSET_CACHE_HEADER,
        "X-Content-Type-Options": "nosniff",
      },
      path: "/assets/*.js",
    },
    {
      headers: {
        "Cache-Control": IMMUTABLE_ASSET_CACHE_HEADER,
        "X-Content-Type-Options": "nosniff",
      },
      path: "/assets/*.css",
    },
    {
      headers: { "Cache-Control": NO_CACHE_HEADER },
      path: "/assets/stella-icon-*.png",
    },
  ];
};

const versionComment = (extension: string, version: string): string =>
  extension === ".css"
    ? `/* stella-outlook-version: ${version} */\n`
    : `// stella-outlook-version: ${version}\n`;

export const versionAssetContent = ({
  content,
  extension,
  version,
}: {
  content: Uint8Array;
  extension: string;
  version: string;
}): Uint8Array => {
  assertOutlookReleaseVersion(version);
  return Buffer.concat([
    Buffer.from(versionComment(extension, version)),
    content,
  ]);
};

export const createContentHashedAssetName = ({
  content,
  extension,
  name,
}: {
  content: Uint8Array;
  extension: string;
  name: string;
}): string => {
  const digest = createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 16);
  return `${name}.${digest}${extension}`;
};

const HTML_RELEASE_VERSION_PATTERN =
  /<meta name="stella-outlook-version" content="([^"]+)"\s*\/>/u;

export const getHtmlReleaseVersion = (html: string): string | null =>
  HTML_RELEASE_VERSION_PATTERN.exec(html)?.at(1) ?? null;

export const getHtmlAssetPaths = (html: string): string[] =>
  [...html.matchAll(/(?:href|src)="(\/assets\/[^"?#]+)"/gu)].map(
    (match) => match[1] ?? "",
  );

export const getManifestIconPaths = (manifest: string): string[] => [
  ...new Set(
    [
      ...manifest.matchAll(
        /DefaultValue="[^"]+(\/assets\/stella-icon-[^"]+\.png)"/gu,
      ),
    ].map((match) => match[1] ?? ""),
  ),
];

export const isContentHashedCodeAsset = (assetPath: string): boolean =>
  /^\/assets\/[a-z-]+\.[a-f0-9]{16}\.(?:css|js)$/u.test(assetPath);

/**
 * V1 has no event-based activation or Smart Alerts. If one is added later it
 * must keep its own tiny Office-only entry point; React belongs only to main.
 */
export const assertOfficeRuntimeEntryIsIsolated = (source: string): void => {
  const forbiddenImports = [
    'from "react"',
    'from "react-dom"',
    'from "@/app"',
    'from "@/components/',
    'from "@/hooks/',
  ];
  const forbiddenImport = forbiddenImports.find((value) =>
    source.includes(value),
  );
  if (forbiddenImport) {
    panic(
      `Office command/event runtime must stay isolated from the React task pane (${forbiddenImport}).`,
    );
  }
};
