import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_KEY_SECONDS,
  desktopRegistryKeyConfig,
  parseDesktopRegistryMetadata,
} from "@/api/lib/business-registries/desktop/config";

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

const issuanceProperty = (object: ts.ObjectLiteralExpression, name: string) =>
  object.properties.find(
    (entry) =>
      ts.isPropertyAssignment(entry) &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
      entry.name.text === name,
  );

type IssuanceContext = {
  filename: string;
  ast: ts.SourceFile;
  isMachineOwner: boolean;
};
const assertIssuanceReference = (
  node: ts.Node,
  { filename, ast, isMachineOwner }: IssuanceContext,
) => {
  const isMemberReference =
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "createApiKey") ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "createApiKey");
  const isBareReference =
    ts.isIdentifier(node) &&
    node.text === "createApiKey" &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
  if (isMemberReference || isBareReference) {
    const directCall =
      ts.isCallExpression(node.parent) && node.parent.expression === node;
    const parameter = ts.isParameter(node.parent) ? node.parent : null;
    const defaultParameter =
      isMemberReference && ts.isParameter(node.parent) ? node.parent : null;
    const machineParameter = parameter ?? defaultParameter;
    const machineAlias =
      isMachineOwner &&
      machineParameter !== null &&
      ts.isIdentifier(machineParameter.name) &&
      machineParameter.name.text === "createApiKey" &&
      machineParameter.initializer?.getText(ast) ===
        "getAuth().api.createApiKey";
    if (!directCall && !machineAlias) {
      throw new TypeError(`${filename}: issuance function cannot be aliased`);
    }
  }
};
const assertIssuanceCall = (
  node: ts.CallExpression,
  { filename, isMachineOwner }: IssuanceContext,
) => {
  const request = node.arguments.at(0);
  if (!request || !ts.isObjectLiteralExpression(request)) {
    throw new TypeError(`${filename}: issuance must declare its body`);
  }
  const requestNames: string[] = [];
  for (const entry of request.properties) {
    if (
      !ts.isPropertyAssignment(entry) ||
      !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))
    ) {
      throw new TypeError(`${filename}: issuance request must be explicit`);
    }
    requestNames.push(entry.name.text);
  }
  if (new Set(requestNames).size !== requestNames.length) {
    throw new TypeError(
      `${filename}: issuance request cannot override its body`,
    );
  }
  const bodyProperty = issuanceProperty(request, "body");
  if (
    !bodyProperty ||
    !ts.isPropertyAssignment(bodyProperty) ||
    !ts.isObjectLiteralExpression(bodyProperty.initializer)
  ) {
    throw new TypeError(`${filename}: issuance must declare its body`);
  }
  const body = bodyProperty.initializer;
  const config = issuanceProperty(body, "configId");
  if (!config || !ts.isPropertyAssignment(config)) {
    throw new TypeError(`${filename}: issuance config must be explicit`);
  }
  let configName: string | null = null;
  if (
    ts.isIdentifier(config.initializer) ||
    ts.isStringLiteral(config.initializer)
  ) {
    configName = config.initializer.text;
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
      !ts.isPropertyAssignment(entry) ||
      !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))
    ) {
      throw new TypeError(
        `${filename}: issuance cannot hide expiry in dynamic fields`,
      );
    }
    names.push(entry.name.text);
  }
  if (new Set(names).size !== names.length) {
    throw new TypeError(
      `${filename}: issuance cannot override expiry with duplicate fields`,
    );
  }
  const expiry = issuanceProperty(body, "expiresIn");
  if (
    !expiry ||
    !ts.isPropertyAssignment(expiry) ||
    expiry.initializer.kind !== ts.SyntaxKind.NullKeyword
  ) {
    throw new TypeError(`${filename}: desktop provider expiry must be null`);
  }
  const metadata = issuanceProperty(body, "metadata");
  if (
    !metadata ||
    !ts.isPropertyAssignment(metadata) ||
    !ts.isObjectLiteralExpression(metadata.initializer) ||
    !issuanceProperty(metadata.initializer, "inactivityExpiresAt")
  ) {
    throw new TypeError(
      `${filename}: issuance must persist its inactivity deadline`,
    );
  }
  if (
    metadata.initializer.properties.some(
      (entry) => !ts.isPropertyAssignment(entry),
    )
  ) {
    throw new TypeError(`${filename}: inactivity metadata must be explicit`);
  }
  if (!issuanceProperty(metadata.initializer, "deviceJkt")) {
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
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const context = {
    filename,
    ast,
    isMachineOwner:
      filename.replace(/^\.\//u, "") === "handlers/api-keys/mint.ts",
  };
  let issuers = 0;
  const visit = (node: ts.Node) => {
    assertIssuanceReference(node, context);
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === "createApiKey") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "createApiKey") ||
        (ts.isElementAccessExpression(node.expression) &&
          ts.isStringLiteral(node.expression.argumentExpression) &&
          node.expression.argumentExpression.text === "createApiKey"))
    ) {
      issuers += assertIssuanceCall(node, context) ? 1 : 0;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
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

  test("every desktop issuance stores device binding and an inactivity deadline outside provider expiry cleanup", () => {
    const apiSourceUrl = new URL("../../", import.meta.url);
    const census = Bun.spawnSync(
      [
        "rg",
        "--files-with-matches",
        "--glob",
        "*.ts",
        "--glob",
        "!*.test.ts",
        "--glob",
        "!*.spec.ts",
        "createApiKey",
        ".",
      ],
      { cwd: fileURLToPath(apiSourceUrl), stdout: "pipe", stderr: "pipe" },
    );
    if (census.exitCode !== 0) {
      panic("Desktop issuance source census must complete");
    }
    const sources = census.stdout
      .toString()
      .trim()
      .split("\n")
      .map((filename) => ({
        filename,
        source: readFileSync(new URL(filename, apiSourceUrl), "utf-8"),
      }));
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
