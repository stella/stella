import { existsSync, readFileSync } from "node:fs";

const API_CONFIG_PATH = "railway.json";
const LEGACY_API_CONFIG_PATH = "railway/api.railway.json";
const WEB_CONFIG_PATH = "railway/web.railway.json";
const RAILWAY_DOC_PATH = "docs/railway.md";
const TEMPLATE_README_PATH = "railway/template-readme.md";
const DOCKERIGNORE_PATH = ".dockerignore";
const RAILWAY_SMOKE_WORKFLOW_PATH = ".github/workflows/railway-smoke.yml";
const RAILWAY_SMOKE_SCRIPT_PATH = "scripts/check-railway-smoke.ts";
const API_HEALTH_ROUTE_PATH = "apps/api/src/handlers/health/routes.ts";
const WEB_VITE_CONFIG_PATH = "apps/web/vite.config.ts";
const API_DOCKERFILE_PATH = "apps/api/Dockerfile";
const WEB_DOCKERFILE_PATH = "apps/web/Dockerfile";

const failures: string[] = [];

const readText = (path: string) => readFileSync(path, "utf-8");

const readJson = (path: string): unknown => JSON.parse(readText(path));

const expect = (condition: boolean, message: string) => {
  if (!condition) {
    failures.push(message);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasPath = (
  value: unknown,
  key: string,
): value is Record<string, unknown> => isRecord(value) && key in value;

const getRecord = (value: unknown, key: string): Record<string, unknown> => {
  if (!hasPath(value, key)) {
    failures.push(`Missing object key ${key}`);
    return {};
  }
  const next = value[key];
  if (!isRecord(next)) {
    failures.push(`Expected ${key} to be an object`);
    return {};
  }
  return next;
};

const getString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const next = value[key];
  if (typeof next !== "string") {
    failures.push(`Expected ${key} to be a string`);
    return undefined;
  }
  return next;
};

const getStringArray = (
  value: Record<string, unknown>,
  key: string,
): string[] => {
  const next = value[key];
  if (!Array.isArray(next) || next.some((item) => typeof item !== "string")) {
    failures.push(`Expected ${key} to be a string array`);
    return [];
  }
  return next;
};

const validateServiceConfig = ({
  path,
  dockerfilePath,
  requiredWatchPatterns,
}: {
  path: string;
  dockerfilePath: string;
  requiredWatchPatterns: string[];
}) => {
  const config = readJson(path);
  const build = getRecord(config, "build");
  const deploy = getRecord(config, "deploy");
  const watchPatterns = getStringArray(build, "watchPatterns");

  expect(
    getString(build, "builder") === "DOCKERFILE",
    `${path} must use Dockerfile builds`,
  );
  expect(
    getString(build, "dockerfilePath") === dockerfilePath,
    `${path} must point at ${dockerfilePath}`,
  );
  for (const pattern of requiredWatchPatterns) {
    expect(watchPatterns.includes(pattern), `${path} must watch ${pattern}`);
  }
  expect(
    getString(deploy, "healthcheckPath") === "/health",
    `${path} must healthcheck /health`,
  );
  expect(
    deploy["restartPolicyType"] === "ON_FAILURE",
    `${path} must restart on failure`,
  );
};

expect(existsSync(API_CONFIG_PATH), "API config must live at /railway.json");
expect(
  !existsSync(LEGACY_API_CONFIG_PATH),
  "Do not keep duplicate API config at /railway/api.railway.json",
);
expect(existsSync(WEB_CONFIG_PATH), "Web config must exist");

validateServiceConfig({
  path: API_CONFIG_PATH,
  dockerfilePath: "apps/api/Dockerfile",
  requiredWatchPatterns: ["/apps/api/**", "/packages/**", "/bun.lock"],
});
validateServiceConfig({
  path: WEB_CONFIG_PATH,
  dockerfilePath: "apps/web/Dockerfile",
  requiredWatchPatterns: ["/apps/web/**", "/packages/**", "/VERSION"],
});

const apiDeploy = getRecord(readJson(API_CONFIG_PATH), "deploy");
expect(
  JSON.stringify(apiDeploy["preDeployCommand"]) ===
    JSON.stringify(["bun src/db/migrate.ts"]),
  "API config must run migrations as a pre-deploy command",
);

const railwayDoc = readText(RAILWAY_DOC_PATH);
expect(
  railwayDoc.includes("`railway.json`"),
  "Railway docs must reference root API config",
);
expect(
  railwayDoc.includes("`railway/web.railway.json`"),
  "Railway docs must reference web config",
);
expect(
  !railwayDoc.includes("railway/api.railway.json"),
  "Railway docs must not reference the removed API config path",
);
expect(
  railwayDoc.includes("## Source-Backed Smoke Verification"),
  "Railway docs must describe the source-backed smoke workflow",
);

const templateReadme = readText(TEMPLATE_README_PATH);
for (const heading of [
  "# Deploy and Host stella on Railway",
  "## About Hosting stella",
  "## Common Use Cases",
  "## Dependencies for stella Hosting",
  "### Deployment Dependencies",
  "### Implementation Details",
  "## Why Deploy stella on Railway?",
  "## Updating",
]) {
  expect(
    templateReadme.includes(heading),
    `Template README missing heading: ${heading}`,
  );
}

const publicRailwayCopy = [
  ["Railway docs", railwayDoc],
  ["template README", templateReadme],
  ["README", readText("README.md")],
];
const privateBusinessPattern = /kickback|referralCode|payout|earnings/iu;
for (const [label, text] of publicRailwayCopy) {
  expect(
    !privateBusinessPattern.test(text),
    `${label} must not include referral or payout copy`,
  );
}

const dockerignore = readText(DOCKERIGNORE_PATH);
expect(
  dockerignore.includes("**/.env*"),
  ".dockerignore must exclude env files from Railway/Docker uploads",
);

const railwaySmokeWorkflow = readText(RAILWAY_SMOKE_WORKFLOW_PATH);
for (const requiredText of [
  "deployment_status:",
  "workflow_dispatch:",
  "RAILWAY_SMOKE_DEPLOYMENT_ENVIRONMENT",
  "RAILWAY_SMOKE_API_URL",
  "RAILWAY_SMOKE_WEB_URL",
  "scripts/check-railway-smoke.ts",
]) {
  expect(
    railwaySmokeWorkflow.includes(requiredText),
    `Railway smoke workflow must include ${requiredText}`,
  );
}

const railwaySmokeScript = readText(RAILWAY_SMOKE_SCRIPT_PATH);
for (const requiredText of [
  "RAILWAY_SMOKE_API_URL",
  "RAILWAY_SMOKE_WEB_URL",
  "RAILWAY_SMOKE_EXPECTED_COMMIT",
  "/health",
  "/version.json",
]) {
  expect(
    railwaySmokeScript.includes(requiredText),
    `Railway smoke checker must include ${requiredText}`,
  );
}

const apiHealthRoute = readText(API_HEALTH_ROUTE_PATH);
expect(
  apiHealthRoute.includes("RAILWAY_GIT_COMMIT_SHA"),
  "API health route must expose Railway source deploy commit SHAs",
);

const webViteConfig = readText(WEB_VITE_CONFIG_PATH);
expect(
  webViteConfig.includes("RAILWAY_GIT_COMMIT_SHA"),
  "web version manifest must expose Railway source deploy commit SHAs",
);

for (const path of [API_DOCKERFILE_PATH, WEB_DOCKERFILE_PATH]) {
  expect(
    readText(path).includes("RAILWAY_GIT_COMMIT_SHA"),
    `${path} must preserve Railway source deploy commit SHAs`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`railway-template-shape: ${failure}`);
  }
  process.exit(1);
}

console.log("railway-template-shape: ok");
