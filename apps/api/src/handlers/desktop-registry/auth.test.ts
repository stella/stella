import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import {
  type CallExpression,
  type Node,
  type ObjectExpression,
  type ParsedSource,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

import { env } from "@/api/env";
import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_KEY_SECONDS,
  desktopRegistryKeyConfig,
  parseDesktopRegistryMetadata,
} from "@/api/lib/business-registries/desktop/config";
import { rateLimitBudgetEnvSchema } from "@/api/lib/rate-limit/budget-config-schema";

const DEFAULT_BUDGETS = v.parse(v.object(rateLimitBudgetEnvSchema), {});

const createTestAuth = (sessionForKeys = false) =>
  betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      apikey: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      bearer(),
      apiKey([
        {
          ...desktopRegistryKeyConfig,
          // The harness pins the schema default so an ambient budget cannot
          // rate-limit its repeated verifications.
          rateLimit: {
            enabled: true,
            maxRequests: DEFAULT_BUDGETS.RATE_LIMIT_API_KEY_DESKTOP_MAX,
            timeWindow: DEFAULT_BUDGETS.RATE_LIMIT_API_KEY_DESKTOP_WINDOW_MS,
          },
          enableSessionForAPIKeys: sessionForKeys,
        },
        {
          configId: "machine",
          references: "user",
          defaultPrefix: "stella_mk_",
          enableSessionForAPIKeys: false,
        },
      ]),
    ],
  });

const issuanceProperty = (object: ObjectExpression, name: string) =>
  object.properties.find(
    (entry) =>
      entry.type === "Property" &&
      entry.kind === "init" &&
      !entry.method &&
      !entry.shorthand &&
      !entry.computed &&
      ((entry.key.type === "Identifier" && entry.key.name === name) ||
        (entry.key.type === "Literal" && entry.key.value === name)),
  );

type IssuanceContext = {
  filename: string;
  ast: ParsedSource;
  isMachineOwner: boolean;
};
const assertIssuanceReference = (
  node: Node,
  { filename, ast, isMachineOwner }: IssuanceContext,
  ancestors: readonly Node[],
) => {
  const parent = ancestors.at(-1);
  // An operation-name constant holds a label, not the provider issuance function.
  const isConstantLabel =
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    /^[A-Z][A-Z0-9_]*$/u.test(node.object.name);
  const isMemberReference =
    !isConstantLabel &&
    node.type === "MemberExpression" &&
    ((!node.computed &&
      node.property.type === "Identifier" &&
      node.property.name === "createApiKey") ||
      (node.computed &&
        node.property.type === "Literal" &&
        node.property.value === "createApiKey"));
  const isBareReference =
    node.type === "Identifier" &&
    node.name === "createApiKey" &&
    !(
      parent?.type === "MemberExpression" &&
      !parent.computed &&
      parent.property === node
    ) &&
    !(parent?.type === "Property" && !parent.shorthand && parent.key === node);
  if (isMemberReference || isBareReference) {
    const directCall =
      parent?.type === "CallExpression" && parent.callee === node;
    const machineAlias =
      isMachineOwner &&
      parent?.type === "AssignmentPattern" &&
      parent.left.type === "Identifier" &&
      parent.left.name === "createApiKey" &&
      ast.sourceText.slice(parent.right.start, parent.right.end) ===
        "getAuth().api.createApiKey" &&
      ancestors.some(
        (ancestor) =>
          (ancestor.type === "FunctionDeclaration" ||
            ancestor.type === "FunctionExpression" ||
            ancestor.type === "ArrowFunctionExpression") &&
          ancestor.params.includes(parent),
      );
    if (!directCall && !machineAlias) {
      throw new TypeError(`${filename}: issuance function cannot be aliased`);
    }
  }
};
const assertIssuanceCall = (
  node: CallExpression,
  { filename, isMachineOwner }: IssuanceContext,
) => {
  const request = node.arguments.at(0);
  if (!request || request.type !== "ObjectExpression") {
    throw new TypeError(`${filename}: issuance must declare its body`);
  }
  const requestNames: string[] = [];
  for (const entry of request.properties) {
    if (
      entry.type !== "Property" ||
      entry.kind !== "init" ||
      entry.method ||
      entry.shorthand ||
      entry.computed ||
      !(
        entry.key.type === "Identifier" ||
        (entry.key.type === "Literal" && typeof entry.key.value === "string")
      )
    ) {
      throw new TypeError(`${filename}: issuance request must be explicit`);
    }
    requestNames.push(
      entry.key.type === "Identifier" ? entry.key.name : entry.key.value,
    );
  }
  if (new Set(requestNames).size !== requestNames.length) {
    throw new TypeError(
      `${filename}: issuance request cannot override its body`,
    );
  }
  const bodyProperty = issuanceProperty(request, "body");
  if (
    !bodyProperty ||
    bodyProperty.type !== "Property" ||
    bodyProperty.value.type !== "ObjectExpression"
  ) {
    throw new TypeError(`${filename}: issuance must declare its body`);
  }
  const body = bodyProperty.value;
  const config = issuanceProperty(body, "configId");
  if (!config || config.type !== "Property") {
    throw new TypeError(`${filename}: issuance config must be explicit`);
  }
  let configName: string | null = null;
  if (
    config.value.type === "Identifier" ||
    (config.value.type === "Literal" && typeof config.value.value === "string")
  ) {
    configName =
      config.value.type === "Identifier"
        ? config.value.name
        : config.value.value;
  }
  if (configName === "MACHINE_API_KEY_CONFIG_ID" || configName === "machine") {
    return false;
  }
  if (isMachineOwner) {
    throw new TypeError(
      `${filename}: machine issuance cannot mint desktop credentials`,
    );
  }
  if (
    configName !== "DESKTOP_REGISTRY_KEY_CONFIG" &&
    configName !== "desktop-registry"
  ) {
    throw new TypeError(`${filename}: issuance config must have a known owner`);
  }

  const names: string[] = [];
  for (const entry of body.properties) {
    if (
      entry.type !== "Property" ||
      entry.kind !== "init" ||
      entry.method ||
      entry.shorthand ||
      entry.computed ||
      !(
        entry.key.type === "Identifier" ||
        (entry.key.type === "Literal" && typeof entry.key.value === "string")
      )
    ) {
      throw new TypeError(
        `${filename}: issuance cannot hide expiry in dynamic fields`,
      );
    }
    names.push(
      entry.key.type === "Identifier" ? entry.key.name : entry.key.value,
    );
  }
  if (new Set(names).size !== names.length) {
    throw new TypeError(
      `${filename}: issuance cannot override expiry with duplicate fields`,
    );
  }
  const expiry = issuanceProperty(body, "expiresIn");
  if (
    !expiry ||
    expiry.type !== "Property" ||
    expiry.value.type !== "Literal" ||
    expiry.value.value !== null
  ) {
    throw new TypeError(`${filename}: desktop provider expiry must be null`);
  }
  const metadata = issuanceProperty(body, "metadata");
  if (
    !metadata ||
    metadata.type !== "Property" ||
    metadata.value.type !== "ObjectExpression" ||
    !issuanceProperty(metadata.value, "inactivityExpiresAt")
  ) {
    throw new TypeError(
      `${filename}: issuance must persist its inactivity deadline`,
    );
  }
  if (
    metadata.value.properties.some(
      (entry) =>
        entry.type !== "Property" ||
        entry.kind !== "init" ||
        entry.method ||
        entry.shorthand,
    )
  ) {
    throw new TypeError(`${filename}: inactivity metadata must be explicit`);
  }
  if (!issuanceProperty(metadata.value, "deviceJkt")) {
    throw new TypeError(
      `${filename}: issuance must persist its device key binding`,
    );
  }
  return true;
};
const censusIssuanceSource = ({
  filename,
  source,
}: {
  filename: string;
  source: string;
}) => {
  const ast = parseSource(filename, source);
  const context = {
    filename,
    ast,
    isMachineOwner:
      filename.replace(/^\.\//u, "") === "handlers/api-keys/mint.ts",
  };
  let issuers = 0;
  walk(ast.program, (node, ancestors) => {
    assertIssuanceReference(node, context, ancestors);
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node.callee;
    if (
      (callee.type === "Identifier" && callee.name === "createApiKey") ||
      (callee.type === "MemberExpression" &&
        ((!callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "createApiKey") ||
          (callee.computed &&
            callee.property.type === "Literal" &&
            callee.property.value === "createApiKey")))
    ) {
      issuers += assertIssuanceCall(node, context) ? 1 : 0;
    }
  });
  return issuers;
};
const assertDesktopIssuance = (
  sources: readonly { filename: string; source: string }[],
) => {
  const issuers = sources.reduce(
    (total, source) => total + censusIssuanceSource(source),
    0,
  );
  if (issuers === 0) {
    throw new TypeError("Desktop issuance census must find its producer");
  }
};

describe("desktop registry API-key configuration", () => {
  test("keeps the registry credential separate and sessionless", async () => {
    expect(desktopRegistryKeyConfig.rateLimit).toEqual({
      enabled: true,
      maxRequests: env.RATE_LIMIT_API_KEY_DESKTOP_MAX,
      timeWindow: env.RATE_LIMIT_API_KEY_DESKTOP_WINDOW_MS,
    });
    const auth = createTestAuth();
    const signedUp = await auth.api.signUpEmail({
      body: {
        email: "desktop-registry@example.test",
        name: "Desktop Registry",
        password: "A secure password 123!",
      },
    });
    const created = await auth.api.createApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        name: "Desktop registry search",
        userId: signedUp.user.id,
        expiresIn: null,
        metadata: {
          purpose: DESKTOP_REGISTRY_KEY_CONFIG,
          organizationId: "00000000-0000-4000-8000-000000000001",
          deviceJkt: "A".repeat(43),
          inactivityExpiresAt: new Date(
            Date.now() + DESKTOP_REGISTRY_KEY_SECONDS * 1000,
          ).toISOString(),
        },
      },
    });

    expect(created.key.startsWith(DESKTOP_REGISTRY_KEY_PREFIX)).toBe(true);
    expect(created.expiresAt).toBeNull();
    expect(desktopRegistryKeyConfig.keyExpiration.defaultExpiresIn).toBeNull();
    const desktopVerification = await auth.api.verifyApiKey({
      body: { configId: DESKTOP_REGISTRY_KEY_CONFIG, key: created.key },
    });
    expect(desktopVerification).toMatchObject({ valid: true });
    const machineVerification = await auth.api.verifyApiKey({
      body: { configId: "machine", key: created.key },
    });
    expect(machineVerification).toMatchObject({ valid: false });
    const sessionResult = await auth.api
      .getSession({
        headers: { authorization: `Bearer ${created.key}` },
      })
      .catch((error: unknown) => error);
    if (
      sessionResult !== null &&
      typeof sessionResult === "object" &&
      "body" in sessionResult
    ) {
      expect(sessionResult).toMatchObject({
        body: { code: "UNAUTHORIZED_SESSION" },
      });
    } else {
      expect(sessionResult).toBeNull();
    }

    const sessionToken =
      signedUp.token ?? panic("sign-up issued no session token");
    await auth.api.updateApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        keyId: created.id,
        enabled: false,
      },
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const disabledVerification = await auth.api
      .verifyApiKey({
        body: { configId: DESKTOP_REGISTRY_KEY_CONFIG, key: created.key },
      })
      .catch((error: unknown) => error);
    if (
      disabledVerification !== null &&
      typeof disabledVerification === "object" &&
      "body" in disabledVerification
    ) {
      expect(disabledVerification).toMatchObject({
        body: { code: "INVALID_API_KEY" },
      });
    } else {
      expect(disabledVerification).toMatchObject({ valid: false });
    }
  });

  test("every desktop issuance stores its inactivity deadline outside provider expiry cleanup", () => {
    const apiSourceUrl = new URL("../../", import.meta.url);
    // Scan in-process so the census does not depend on a host search binary.
    const sources = [
      ...new Bun.Glob("**/*.ts").scanSync({
        cwd: fileURLToPath(apiSourceUrl),
      }),
    ]
      .filter(
        (filename) =>
          !filename.endsWith(".test.ts") &&
          !filename.endsWith(".spec.ts") &&
          // Test fixtures mint keys for the isolation matrix; the census
          // covers production issuance only.
          !filename.startsWith("tests/"),
      )
      .map((filename) => ({
        filename,
        source: readFileSync(new URL(filename, apiSourceUrl), "utf-8"),
      }))
      .filter(({ source }) => source.includes("createApiKey"));
    if (sources.length === 0) {
      panic("Desktop issuance source census must complete");
    }
    assertDesktopIssuance(sources);
    const issuer = sources.find(
      ({ source }) =>
        source.includes(".createApiKey(") &&
        source.includes("configId: DESKTOP_REGISTRY_KEY_CONFIG"),
    );
    if (!issuer) {
      panic("Desktop credential issuer must exist");
    }
    expect(issuer.source).toContain("expiresIn: null");
    expect(issuer.source).toContain("deviceJkt: identity.deviceJkt,");
    expect(() =>
      assertDesktopIssuance(
        sources.map((entry) =>
          entry === issuer
            ? {
                ...entry,
                source: entry.source.replace(
                  "expiresIn: null",
                  "expiresIn: DESKTOP_REGISTRY_KEY_SECONDS",
                ),
              }
            : entry,
        ),
      ),
    ).toThrow("desktop provider expiry must be null");
    expect(() =>
      assertDesktopIssuance(
        sources.map((entry) =>
          entry === issuer
            ? {
                ...entry,
                source: entry.source.replace(
                  "inactivityExpiresAt: expiresAt.toISOString(),",
                  "",
                ),
              }
            : entry,
        ),
      ),
    ).toThrow("issuance must persist its inactivity deadline");
    expect(() =>
      assertDesktopIssuance(
        sources.map((entry) =>
          entry === issuer
            ? {
                ...entry,
                source: entry.source.replace(
                  "deviceJkt: identity.deviceJkt,",
                  "",
                ),
              }
            : entry,
        ),
      ),
    ).toThrow("issuance must persist its device key binding");
    expect(() =>
      assertDesktopIssuance([
        ...sources,
        {
          filename: "unowned-issuer.ts",
          source:
            "auth.api.createApiKey({ body: { configId: DESKTOP_REGISTRY_KEY_CONFIG, expiresIn: 2592000, metadata: {} } });",
        },
      ]),
    ).toThrow("desktop provider expiry must be null");
    expect(() =>
      assertDesktopIssuance(
        sources.map((entry) =>
          entry.filename.replace(/^\.\//u, "") === "handlers/api-keys/mint.ts"
            ? {
                ...entry,
                source: entry.source.replace(
                  "configId: MACHINE_API_KEY_CONFIG_ID",
                  "configId: DESKTOP_REGISTRY_KEY_CONFIG",
                ),
              }
            : entry,
        ),
      ),
    ).toThrow("machine issuance cannot mint desktop credentials");
    for (const reference of [
      "auth.api.createApiKey",
      'auth.api["createApiKey"]',
      "createApiKey",
    ]) {
      expect(() =>
        assertDesktopIssuance([
          ...sources,
          {
            filename: "unowned-alias.ts",
            source: `const mint = ${reference}; mint({ body: { configId: DESKTOP_REGISTRY_KEY_CONFIG, expiresIn: 2592000 } });`,
          },
        ]),
      ).toThrow("issuance function cannot be aliased");
    }
  });

  test("inactivity metadata rejects missing or malformed deadlines without a provider expiry fallback", () => {
    const metadata = {
      purpose: DESKTOP_REGISTRY_KEY_CONFIG,
      organizationId: "00000000-0000-4000-8000-000000000001",
      deviceJkt: "A".repeat(43),
      inactivityExpiresAt: "2026-11-05T12:00:00.000Z",
    };
    expect(parseDesktopRegistryMetadata(metadata).success).toBe(true);
    expect(parseDesktopRegistryMetadata(JSON.stringify(metadata)).success).toBe(
      true,
    );
    // verifyApiKey revives the stored timestamp as a Date.
    const revived = parseDesktopRegistryMetadata({
      ...metadata,
      inactivityExpiresAt: new Date(metadata.inactivityExpiresAt),
    });
    expect(revived.success).toBe(true);
    expect(revived.output).toEqual(metadata);
    for (const invalid of [
      null,
      "not-json",
      {},
      { purpose: metadata.purpose, organizationId: metadata.organizationId },
      { ...metadata, inactivityExpiresAt: "not-a-date" },
      { ...metadata, inactivityExpiresAt: 123 },
      { ...metadata, purpose: "machine" },
      ...[
        undefined,
        "",
        "A".repeat(42),
        "A".repeat(44),
        `${"A".repeat(42)}=`,
        `${"A".repeat(42)}+`,
        `${"A".repeat(42)}/`,
      ].map((deviceJkt) => ({ ...metadata, deviceJkt })),
      { ...metadata, inactivityExpiresAt: new Date(Number.NaN) },
      { ...metadata, providerExpiresAt: metadata.inactivityExpiresAt },
    ]) {
      expect(parseDesktopRegistryMetadata(invalid).success).toBe(false);
    }
  });

  test("detects accidental API-key session enablement", async () => {
    const auth = createTestAuth(true);
    const signedUp = await auth.api.signUpEmail({
      body: {
        email: "desktop-registry-session@example.test",
        name: "Desktop Registry",
        password: "A secure password 123!",
      },
    });
    const created = await auth.api.createApiKey({
      body: {
        configId: DESKTOP_REGISTRY_KEY_CONFIG,
        name: "Session must stay disabled",
        userId: signedUp.user.id,
        expiresIn: null,
        metadata: {
          purpose: DESKTOP_REGISTRY_KEY_CONFIG,
          organizationId: "00000000-0000-4000-8000-000000000001",
          deviceJkt: "A".repeat(43),
          inactivityExpiresAt: new Date(
            Date.now() + DESKTOP_REGISTRY_KEY_SECONDS * 1000,
          ).toISOString(),
        },
      },
    });
    expect(
      await auth.api.getSession({
        headers: { "x-api-key": created.key },
      }),
    ).not.toBeNull();
  });
});
