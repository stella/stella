import { existsSync, readFileSync } from "node:fs";

const API_CONFIG_PATH = "railway/api.railway.json";
const ROOT_RAILWAY_CONFIG_PATHS = ["railway.json", "railway.toml"];
const WEB_CONFIG_PATH = "railway/web.railway.json";
const RAILWAY_DOC_PATH = "docs/railway.md";
const TEMPLATE_README_PATH = "railway/template-readme.md";
const TEMPLATE_MANIFEST_PATH = "railway/template-manifest.json";
const DOCKERIGNORE_PATH = ".dockerignore";
const RAILWAY_SMOKE_WORKFLOW_PATH = ".github/workflows/railway-smoke.yml";
const RAILWAY_TEMPLATE_SOURCE_WORKFLOW_PATH =
  ".github/workflows/railway-template-source.yml";
const RAILWAY_SMOKE_SCRIPT_PATH = "scripts/check-railway-smoke.ts";
const RAILWAY_SYNC_SCRIPT_PATH = "scripts/sync-railway-template-source.ts";
const API_HEALTH_ROUTE_PATH = "apps/api/src/handlers/health/routes.ts";
const API_VERSION_MODULE_PATH = "apps/api/src/lib/version.ts";
const WEB_VITE_CONFIG_PATH = "apps/web/vite.config.ts";
const API_DOCKERFILE_PATH = "apps/api/Dockerfile";
const WEB_DOCKERFILE_PATH = "apps/web/Dockerfile";
const railwayTemplateReference = (value: string) => `\${{${value}}}`;
const railwaySecretReference = (length: number, alphabet: string) =>
  railwayTemplateReference(`secret(${String(length)}, "${alphabet}")`);
const railwayPublicUrlReference = (serviceName: string) =>
  `https://${railwayTemplateReference(`${serviceName}.RAILWAY_PUBLIC_DOMAIN`)}`;

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

const getBoolean = (
  value: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const next = value[key];
  if (typeof next !== "boolean") {
    failures.push(`Expected ${key} to be a boolean`);
    return undefined;
  }
  return next;
};

const getStringRecord = (
  value: Record<string, unknown>,
  key: string,
): Record<string, string> => {
  const next = value[key];
  if (!isRecord(next)) {
    failures.push(`Expected ${key} to be an object`);
    return {};
  }

  const result: Record<string, string> = {};
  for (const [recordKey, recordValue] of Object.entries(next)) {
    if (typeof recordValue !== "string") {
      failures.push(`Expected ${key}.${recordKey} to be a string`);
      continue;
    }
    result[recordKey] = recordValue;
  }
  return result;
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

expect(
  existsSync(API_CONFIG_PATH),
  "API config must live at /railway/api.railway.json",
);
for (const rootConfigPath of ROOT_RAILWAY_CONFIG_PATHS) {
  expect(
    !existsSync(rootConfigPath),
    `Root config file /${rootConfigPath} must not exist: Railway auto-discovers repo-root config files and applies them to every GitHub-sourced template service, hijacking per-service config`,
  );
}
expect(existsSync(WEB_CONFIG_PATH), "Web config must exist");
expect(existsSync(TEMPLATE_MANIFEST_PATH), "Template manifest must exist");

validateServiceConfig({
  path: API_CONFIG_PATH,
  dockerfilePath: "apps/api/Dockerfile",
  requiredWatchPatterns: [
    "/railway/api.railway.json",
    "/apps/api/**",
    "/packages/**",
    "/bun.lock",
  ],
});
validateServiceConfig({
  path: WEB_CONFIG_PATH,
  dockerfilePath: "apps/web/Dockerfile",
  requiredWatchPatterns: [
    "/railway/web.railway.json",
    "/apps/web/**",
    "/packages/**",
    "/VERSION",
  ],
});

const apiDeploy = getRecord(readJson(API_CONFIG_PATH), "deploy");
expect(
  JSON.stringify(apiDeploy["preDeployCommand"]) ===
    JSON.stringify(["bun src/db/migrate.ts"]),
  "API config must run migrations as a pre-deploy command",
);

const railwayDoc = readText(RAILWAY_DOC_PATH);
expect(
  railwayDoc.includes("`railway/api.railway.json`"),
  "Railway docs must reference the API config path",
);
expect(
  railwayDoc.includes("`railway/web.railway.json`"),
  "Railway docs must reference web config",
);
expect(
  railwayDoc.includes("repository root must not contain a `railway.json`"),
  "Railway docs must document the repo-root config invariant (no railway.json/railway.toml)",
);
expect(
  railwayDoc.includes("## Source-Backed Smoke Verification"),
  "Railway docs must describe the source-backed smoke workflow",
);
expect(
  railwayDoc.includes("This syncs service variables only."),
  "Railway docs must keep the template-source sync scoped to variables",
);
expect(
  railwayDoc.includes("It does not validate buckets, service") &&
    railwayDoc.includes("networking, or config files"),
  "Railway docs must require manual review of non-variable template shape",
);
expect(
  railwayDoc.includes("## Template Source Drift Guard"),
  "Railway docs must describe the template-source drift guard",
);

const railwaySyncScript = readText(RAILWAY_SYNC_SCRIPT_PATH);
expect(
  railwaySyncScript.includes("variable sync only; verify buckets"),
  "Railway sync script must identify itself as variable-only",
);
expect(
  railwaySyncScript.includes("Dry run found variable drift."),
  "Railway sync script must fail dry runs with variable drift",
);
expect(
  railwaySyncScript.includes("unrendered = true"),
  "Railway sync script must compare unrendered variables so same-project references cannot flatten to literals",
);
expect(
  railwaySyncScript.includes("skipDeploys: true"),
  "Railway sync script must not trigger deploys while syncing template-source variables",
);
for (const requiredText of [
  "check-rendered-credentials",
  "Project-Access-Token",
  "projectToken",
  "RAILWAY_PROJECT_TOKEN",
  "rendered credentials ok",
  "rendered credentials disagree",
  "Gotenberg password",
]) {
  expect(
    railwaySyncScript.includes(requiredText),
    `Railway sync script must include rendered credential guard text: ${requiredText}`,
  );
}

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
// A referral code inside a deploy URL is standard marketplace practice; the
// guard targets prose that discusses monetization, so URLs are stripped
// before matching.
const privateBusinessPattern = /kickback|referralCode|payout|earnings/iu;
const withoutUrls = (text: string) => text.replace(/https?:\/\/\S+/gu, "");
for (const [label, text] of publicRailwayCopy) {
  expect(
    !privateBusinessPattern.test(withoutUrls(text)),
    `${label} must not include referral or payout copy outside links`,
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

const railwayTemplateSourceWorkflow = readText(
  RAILWAY_TEMPLATE_SOURCE_WORKFLOW_PATH,
);
for (const requiredText of [
  "schedule:",
  "workflow_dispatch:",
  "RAILWAY_PROJECT_TOKEN",
  "RAILWAY_API_TOKEN",
  "RAILWAY_TEMPLATE_PROJECT_ID",
  "RAILWAY_TEMPLATE_ENVIRONMENT",
  "check:railway-template-source-runtime",
]) {
  expect(
    railwayTemplateSourceWorkflow.includes(requiredText),
    `Railway template-source workflow must include ${requiredText}`,
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

const apiVersionModule = readText(API_VERSION_MODULE_PATH);
expect(
  apiVersionModule.includes("RAILWAY_GIT_COMMIT_SHA"),
  "API version module must expose Railway source deploy commit SHAs",
);

const apiHealthRoute = readText(API_HEALTH_ROUTE_PATH);
expect(
  apiHealthRoute.includes("@/api/lib/version"),
  "API health route must report build stamps from the shared version module",
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

const templateManifest = getRecord(
  readJson(TEMPLATE_MANIFEST_PATH),
  "services",
);
const templateMetadata = getRecord(
  readJson(TEMPLATE_MANIFEST_PATH),
  "metadata",
);
expect(
  getString(templateMetadata, "name") === "stella",
  "Template manifest must publish the marketplace name as stella",
);
expect(
  getString(templateMetadata, "category") === "AI/ML",
  "Template manifest must publish in the AI/ML category",
);
expect(
  getString(templateMetadata, "readmeFile") === TEMPLATE_README_PATH,
  "Template manifest must use the checked-in template README",
);

const apiTemplate = getRecord(templateManifest, "api");
const webTemplate = getRecord(templateManifest, "web");
const gotenbergTemplate = getRecord(templateManifest, "gotenberg");
const postgresTemplate = getRecord(templateManifest, "Postgres");
const redisTemplate = getRecord(templateManifest, "Redis");
const apiTemplateVariables = getStringRecord(apiTemplate, "variables");
const webTemplateVariables = getStringRecord(webTemplate, "variables");
const gotenbergTemplateVariables = getStringRecord(
  gotenbergTemplate,
  "variables",
);
const postgresTemplateVariables = getStringRecord(
  postgresTemplate,
  "variables",
);
const redisTemplateVariables = getStringRecord(redisTemplate, "variables");
const apiRequiredUserInputs = getStringRecord(
  apiTemplate,
  "requiredUserInputs",
);

expect(
  getString(apiTemplate, "configFile") === "/railway/api.railway.json",
  "API template service must point at /railway/api.railway.json",
);
expect(
  getString(webTemplate, "configFile") === "/railway/web.railway.json",
  "web template service must point at /railway/web.railway.json",
);
expect(
  getBoolean(gotenbergTemplate, "publicNetworking") === false,
  "Gotenberg must stay private in the template",
);

expect(
  Object.keys(apiRequiredUserInputs).length === 0,
  "Railway template must not require user inputs for first deploy",
);

const expectedApiReferenceVariables: Record<string, string> = {
  DATABASE_URL: railwayTemplateReference("Postgres.DATABASE_URL"),
  REDIS_URL: railwayTemplateReference("Redis.REDIS_URL"),
  S3_ACCESS_KEY_ID: railwayTemplateReference("stella-files.ACCESS_KEY_ID"),
  S3_BUCKET: railwayTemplateReference("stella-files.BUCKET"),
  S3_ENDPOINT: railwayTemplateReference("stella-files.ENDPOINT"),
  S3_REGION: railwayTemplateReference("stella-files.REGION"),
  S3_SECRET_ACCESS_KEY: railwayTemplateReference(
    "stella-files.SECRET_ACCESS_KEY",
  ),
};
for (const [key, value] of Object.entries(expectedApiReferenceVariables)) {
  expect(
    apiTemplateVariables[key] === value,
    `API template variable ${key} must be ${value}`,
  );
}

const expectedPostgresVariables: Record<string, string> = {
  DATABASE_PUBLIC_URL: `postgresql://${railwayTemplateReference("PGUSER")}:${railwayTemplateReference("POSTGRES_PASSWORD")}@${railwayTemplateReference("RAILWAY_TCP_PROXY_DOMAIN")}:${railwayTemplateReference("RAILWAY_TCP_PROXY_PORT")}/${railwayTemplateReference("PGDATABASE")}`,
  DATABASE_URL: `postgresql://${railwayTemplateReference("PGUSER")}:${railwayTemplateReference("POSTGRES_PASSWORD")}@${railwayTemplateReference("RAILWAY_PRIVATE_DOMAIN")}:5432/${railwayTemplateReference("PGDATABASE")}`,
  PGDATA: "/var/lib/postgresql/data/pgdata",
  PGDATABASE: railwayTemplateReference("POSTGRES_DB"),
  PGHOST: railwayTemplateReference("RAILWAY_PRIVATE_DOMAIN"),
  PGPASSWORD: railwayTemplateReference("POSTGRES_PASSWORD"),
  PGPORT: "5432",
  PGUSER: railwayTemplateReference("POSTGRES_USER"),
  POSTGRES_DB: "railway",
  POSTGRES_PASSWORD: railwaySecretReference(
    32,
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ),
  POSTGRES_USER: "postgres",
  RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "60",
  SSL_CERT_DAYS: "820",
};
for (const [key, value] of Object.entries(expectedPostgresVariables)) {
  expect(
    postgresTemplateVariables[key] === value,
    `Postgres template variable ${key} must be ${value}`,
  );
}

const expectedRedisVariables: Record<string, string> = {
  REDISHOST: railwayTemplateReference("RAILWAY_PRIVATE_DOMAIN"),
  REDISPASSWORD: railwayTemplateReference("REDIS_PASSWORD"),
  REDISPORT: "6379",
  REDISUSER: "default",
  REDIS_PASSWORD: railwaySecretReference(
    32,
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ),
  REDIS_PUBLIC_URL: `redis://default:${railwayTemplateReference("REDIS_PASSWORD")}@${railwayTemplateReference("RAILWAY_TCP_PROXY_DOMAIN")}:${railwayTemplateReference("RAILWAY_TCP_PROXY_PORT")}`,
  REDIS_URL: `redis://${railwayTemplateReference("REDISUSER")}:${railwayTemplateReference("REDIS_PASSWORD")}@${railwayTemplateReference("REDISHOST")}:${railwayTemplateReference("REDISPORT")}`,
};
for (const [key, value] of Object.entries(expectedRedisVariables)) {
  expect(
    redisTemplateVariables[key] === value,
    `Redis template variable ${key} must be ${value}`,
  );
}

for (const key of [
  "BETTER_AUTH_SECRET",
  "CONTENT_ENCRYPTION_KEY",
  "SELFHOST_BOOTSTRAP_TOKEN",
]) {
  expect(
    apiTemplateVariables[key]?.includes("${{secret(") ?? false,
    `API template variable ${key} must be generated by Railway`,
  );
}

expect(
  apiTemplateVariables["SELFHOST_LOCAL_PASSWORD_AUTH"] === "true",
  "Railway template must enable self-host local password auth for zero-setup login",
);

for (const key of [
  "GOTENBERG_API_BASIC_AUTH_PASSWORD",
  "GOTENBERG_API_BASIC_AUTH_USERNAME",
]) {
  expect(
    gotenbergTemplateVariables[key]?.includes("${{secret(") ?? false,
    `Gotenberg template variable ${key} must be generated by Railway`,
  );
}

expect(
  gotenbergTemplateVariables["API_ENABLE_BASIC_AUTH"] === "true",
  "Gotenberg basic auth toggle must be prefilled instead of prompting users",
);
expect(
  apiTemplateVariables["PUBLIC_URL"] === railwayPublicUrlReference("api"),
  "API PUBLIC_URL must reference the Railway API domain",
);
expect(
  apiTemplateVariables["BETTER_AUTH_URL"] === railwayPublicUrlReference("api"),
  "API BETTER_AUTH_URL must reference the Railway API domain",
);
expect(
  apiTemplateVariables["FRONTEND_URL"] === railwayPublicUrlReference("web"),
  "API FRONTEND_URL must reference the Railway web domain",
);
expect(
  apiTemplateVariables["GOTENBERG_URL"] ===
    `http://${railwayTemplateReference("gotenberg.RAILWAY_PRIVATE_DOMAIN")}:3000`,
  "API GOTENBERG_URL must reference the private Gotenberg domain",
);
expect(
  apiTemplateVariables["GOTENBERG_USERNAME"] ===
    railwayTemplateReference("gotenberg.GOTENBERG_API_BASIC_AUTH_USERNAME"),
  "API GOTENBERG_USERNAME must reference the Gotenberg username",
);
expect(
  apiTemplateVariables["GOTENBERG_PASSWORD"] ===
    railwayTemplateReference("gotenberg.GOTENBERG_API_BASIC_AUTH_PASSWORD"),
  "API GOTENBERG_PASSWORD must reference the Gotenberg password",
);
expect(
  webTemplateVariables["PUBLIC_API_URL"] === railwayPublicUrlReference("api"),
  "web PUBLIC_API_URL must reference the Railway API domain",
);
expect(
  webTemplateVariables["PUBLIC_APP_URL"] === railwayPublicUrlReference("web"),
  "web PUBLIC_APP_URL must reference the Railway web domain",
);

const forbiddenTemplateVariablePattern =
  /^(?:VITE_)?FEATURE_|^VITE_SELFHOST$|^NODE_ENV$|^EMAIL_PROVIDER$|^S3_CREDENTIALS_PROVIDER$/u;
const templateVariableSets: [string, Record<string, string>][] = [
  ["api", apiTemplateVariables],
  ["web", webTemplateVariables],
  ["gotenberg", gotenbergTemplateVariables],
  ["Postgres", postgresTemplateVariables],
  ["Redis", redisTemplateVariables],
];
for (const [serviceName, variables] of templateVariableSets) {
  for (const key of Object.keys(variables)) {
    expect(
      !forbiddenTemplateVariablePattern.test(key),
      `${serviceName} template variable ${key} must be a repo default, not a template input`,
    );
  }
}

const apiDockerfile = readText(API_DOCKERFILE_PATH);
for (const requiredText of [
  "ENV NODE_ENV=production",
  "ENV FEATURE_CHAT=true",
  "ENV FEATURE_CONTACTS=true",
  "ENV FEATURE_DESKTOP_EDITING=true",
  "ENV FEATURE_KNOWLEDGE_TEMPLATES=true",
  "ENV FEATURE_TODOS=true",
  "ENV REQUIRE_PERSONAL_AI_KEY=true",
]) {
  expect(
    apiDockerfile.includes(requiredText),
    `API Dockerfile must define Railway self-host default ${requiredText}`,
  );
}

const webDockerfile = readText(WEB_DOCKERFILE_PATH);
for (const requiredText of [
  "ARG VITE_FEATURE_CHAT=true",
  "ARG VITE_FEATURE_CONTACTS=true",
  "ARG VITE_FEATURE_DESKTOP_EDITING=true",
  "ARG VITE_FEATURE_KNOWLEDGE_TEMPLATES=true",
  "ARG VITE_FEATURE_TODOS=true",
  "ARG VITE_SELFHOST=true",
]) {
  expect(
    webDockerfile.includes(requiredText),
    `web Dockerfile must define Railway self-host default ${requiredText}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`railway-template-shape: ${failure}`);
  }
  process.exit(1);
}

console.log("railway-template-shape: ok");
