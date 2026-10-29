import { Result } from "better-result";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseSync } from "oxc-parser";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  decryptAIConfig,
  type OrgAIConfigReadFailure,
  unreadableOrgAIConfig,
} from "@/api/lib/ai-config-crypto";
import {
  loadOrgAIConfig,
  loadOrgAISettings,
  loadOrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import {
  decryptOrgAIConfigRow,
  resolvePromptCachingPreference,
} from "@/api/lib/ai-config-loader-core";
import * as aiConfigLoaderCore from "@/api/lib/ai-config-loader-core";
import * as captureModule from "@/api/lib/analytics/capture";
import { toSafeId } from "@/api/lib/branded-types";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import {
  assertClassifiedSettingsFailure,
  assertSettingsAnalyticsFrame,
  assertSettingsFailureConfidential,
} from "@/api/tests/helpers/settings-failure-confidentiality";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

beforeEach(() => {
  decryptAIConfigMock.mockClear();
});

const decryptedAIConfig: OrgAIConfig = {
  providers: [
    {
      apiKey: "org-google-secret",
      provider: "google",
    },
  ],
  overrideModels: {
    chat: { provider: "google", modelId: "gemini-3.5-flash" },
    fast: { provider: "google", modelId: "gemini-3.5-flash" },
    pdf: { provider: "google", modelId: "gemini-3.5-flash" },
    reasoning: { provider: "google", modelId: "gemini-3.1-pro-preview" },
  },
  decision: null,
};

const decryptAIConfigMock = mock(async () => Result.ok(decryptedAIConfig));

beforeEach(() => {
  decryptAIConfigMock.mockClear();
});

const organizationId = toSafeId<"organization">("org_loader_test");
const userId = toSafeId<"user">("user_loader_test");

type SettingsRow = {
  aiConfigEncrypted: Buffer | null;
  aiConfigIv: Buffer | null;
  promptCachingEnabled: boolean;
  managedAIResidency: "eu";
};

const settingsReader = (row: SettingsRow) => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [row] }),
      }),
    }),
    transaction: async <T>(run: (tx: unknown) => Promise<T>) => await run(db),
  };
  return asTestRaw<Parameters<typeof loadOrgAIConfig>[0]>(db);
};

describe("loadOrgAIConfig", () => {
  test("every runtime loader exposes only the shared confidentiality allowlist", async () => {
    const key = envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY;
    const fixtures = {
      "incomplete-envelope": {
        aiConfigEncrypted: Buffer.from("stored-incomplete"),
        aiConfigIv: null,
      },
      "missing-key": {
        aiConfigEncrypted: Buffer.from("stored-missing-key"),
        aiConfigIv: Buffer.alloc(12, 21),
      },
      "decryption-failed": {
        aiConfigEncrypted: Buffer.from("stored-decryption"),
        aiConfigIv: Buffer.alloc(12, 22),
      },
      "invalid-json": {
        aiConfigEncrypted: Buffer.from('{"secret":'),
        aiConfigIv: Buffer.alloc(12),
      },
      "invalid-schema": {
        aiConfigEncrypted: Buffer.from(
          JSON.stringify({ providers: [{ apiKey: "stored-secret" }] }),
        ),
        aiConfigIv: Buffer.alloc(12),
      },
    } as const satisfies Record<
      OrgAIConfigReadFailure,
      { aiConfigEncrypted: Buffer; aiConfigIv: Buffer | null }
    >;
    const loaders = {
      loadOrgAIConfig,
      loadOrgAISettings,
      loadOrgSettingsForAuth,
    } as const;
    const isReason = (value: string): value is keyof typeof fixtures =>
      Object.hasOwn(fixtures, value);

    try {
      for (const reason of Object.keys(fixtures)) {
        if (!isReason(reason)) {
          continue;
        }
        envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY =
          reason === "missing-key" ? undefined : key;
        for (const [name, load] of Object.entries(loaders)) {
          const classified: unknown[] = [];
          const decryptRow = aiConfigLoaderCore.decryptOrgAIConfigRow;
          const decrypt = spyOn(
            aiConfigLoaderCore,
            "decryptOrgAIConfigRow",
          ).mockImplementation(
            async (...args: Parameters<typeof decryptRow>) => {
              const result = await decryptRow(...args);
              if (result.status === "corrupt") {
                classified.push(result.error);
              }
              return result;
            },
          );
          const analytics = installRecordingAnalytics();
          const logs = installRecordingLogger();
          const capture = spyOn(captureModule, "captureObservedError");
          const devErrors = spyOn(console, "error").mockImplementation(
            () => undefined,
          );
          try {
            const row = {
              ...fixtures[reason],
              promptCachingEnabled: false,
              managedAIResidency: "eu" as const,
            };
            const result = await load(settingsReader(row), {
              organizationId,
              userId,
            });
            let returned: unknown = result;
            if (name !== "loadOrgSettingsForAuth" && "error" in result) {
              returned = result.error;
            }
            assertSettingsFailureConfidential({
              reason,
              organizationId,
              outputs: {
                analyticsEvents: analytics.events,
                captureEntries: capture.mock.calls,
                developmentEntries: devErrors.mock.calls,
                groupIdentifies: analytics.groupIdentifies,
                logRecords: logs.records,
                returned,
              },
            });
            expect(classified).toHaveLength(1);
            assertClassifiedSettingsFailure(classified.at(0), reason);
          } finally {
            decrypt.mockRestore();
            devErrors.mockRestore();
            capture.mockRestore();
            logs.restore();
            analytics.restore();
          }
        }
      }
    } finally {
      envDocumentProcessingWorker.CONTENT_ENCRYPTION_KEY = key;
    }
  });

  test("returns ok/null for nullish encrypted settings", async () => {
    const result = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfigMock,
      organizationId,
      row: { aiConfigEncrypted: null, aiConfigIv: undefined },
    });

    expect(result).toEqual({ status: "ok", config: null });
    expect(decryptAIConfigMock).not.toHaveBeenCalled();
  });

  test("decodes bytea text before decrypting", async () => {
    const result = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfigMock,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: "\\x0102" },
    });

    expect(result).toEqual({ status: "ok", config: decryptedAIConfig });
    expect(decryptAIConfigMock).toHaveBeenCalledWith(
      organizationId,
      Buffer.from([10, 11]),
      Buffer.from([1, 2]),
    );
  });

  test("treats a row with ciphertext but no IV (or vice versa) as corrupt", async () => {
    const missingIv = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfig,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: null },
    });
    const missingCiphertext = await decryptOrgAIConfigRow({
      decrypt: decryptAIConfig,
      organizationId,
      row: { aiConfigEncrypted: null, aiConfigIv: "\\x0102" },
    });

    expect(missingIv.status).toBe("corrupt");
    expect(missingCiphertext.status).toBe("corrupt");
    if (
      missingIv.status !== "corrupt" ||
      missingCiphertext.status !== "corrupt"
    ) {
      throw new Error("Expected incomplete envelopes to be corrupt");
    }
    expect(missingIv.error.reason).toBe("incomplete-envelope");
    expect(missingCiphertext.error.reason).toBe("incomplete-envelope");
    expect(decryptAIConfigMock).not.toHaveBeenCalled();
  });

  test("preserves the classified result without throwing", async () => {
    const classified = unreadableOrgAIConfig(
      organizationId,
      "decryption-failed",
    );
    const decrypt = mock(async () => Result.err(classified));

    const result = await decryptOrgAIConfigRow({
      decrypt,
      organizationId,
      row: { aiConfigEncrypted: "\\x0a0b", aiConfigIv: "\\x0102" },
    });

    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") {
      throw new Error("Expected decryption failure to be corrupt");
    }
    expect(result.error).toMatchObject({
      _tag: "OrgAIConfigReadError",
      message: "Decrypted organization AI configuration is unreadable",
      name: "OrgAIConfigReadError",
      reason: "decryption-failed",
    });
    expect(result.error).toBe(classified);
    expect(Object.hasOwn(result.error, "cause")).toBe(false);
    expect(Object.hasOwn(result.error, "metadata")).toBe(false);
  });

  test("emits only the allowlisted output for every classified failure", () => {
    const reasons = {
      "missing-key": true,
      "decryption-failed": true,
      "incomplete-envelope": true,
      "invalid-json": true,
      "invalid-schema": true,
    } as const satisfies Record<OrgAIConfigReadFailure, true>;
    const isReason = (value: string): value is keyof typeof reasons =>
      Object.hasOwn(reasons, value);

    for (const reason of Object.keys(reasons)) {
      if (!isReason(reason)) {
        continue;
      }
      const classifiedReason: OrgAIConfigReadFailure = reason;
      const logger = installRecordingLogger();
      const analytics = installRecordingAnalytics();
      const capture = spyOn(captureModule, "captureObservedError");
      const devErrors = spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      try {
        const error = unreadableOrgAIConfig(organizationId, classifiedReason);
        assertSettingsFailureConfidential({
          reason: classifiedReason,
          organizationId,
          outputs: {
            analyticsEvents: analytics.events,
            captureEntries: capture.mock.calls,
            developmentEntries: devErrors.mock.calls,
            groupIdentifies: analytics.groupIdentifies,
            logRecords: logger.records,
            returned: error,
          },
        });
      } finally {
        devErrors.mockRestore();
        capture.mockRestore();
        analytics.restore();
        logger.restore();
      }
    }
  });

  test("the covered reader inventory owns every encrypted settings read", async () => {
    const programs = new Map<string, ReturnType<typeof parseSync>["program"]>();
    for await (const file of new Bun.Glob("src/**/*.ts").scan(".")) {
      if (file.endsWith(".test.ts") || file.includes("/tests/")) {
        continue;
      }
      programs.set(file, parseSync(file, await Bun.file(file).text()).program);
    }

    const inventory = (modules: typeof programs): string[] => {
      const resolveModule = (from: string, source: string): string => {
        let unresolved = source;
        if (source.startsWith("@/api/")) {
          unresolved = `src/${source.slice("@/api/".length)}`;
        } else if (source.startsWith("./") || source.startsWith("../")) {
          unresolved = `${from.slice(0, from.lastIndexOf("/") + 1)}${source}`;
        }
        const parts: string[] = [];
        for (const part of unresolved.split("/")) {
          if (part === "..") {
            parts.pop();
          } else if (part !== ".") {
            parts.push(part);
          }
        }
        const path = parts.join("/");
        return path.endsWith(".ts") ? path : `${path}.ts`;
      };
      const boundaryExports = new Map<string, Set<string>>([
        ["src/lib/ai-config-crypto.ts", new Set(["decryptAIConfig"])],
        [
          "src/lib/ai-config-loader-core.ts",
          new Set(["decryptOrgAIConfigRow"]),
        ],
      ]);
      for (let pass = 0; pass < modules.size; pass += 1) {
        for (const [file, program] of modules) {
          const exported = boundaryExports.get(file) ?? new Set<string>();
          const before = exported.size;
          for (const statement of program.body) {
            if (
              statement.type !== "ExportNamedDeclaration" ||
              !statement.source
            ) {
              continue;
            }
            const sourceExports = boundaryExports.get(
              resolveModule(file, statement.source.value),
            );
            if (!sourceExports) {
              continue;
            }
            for (const specifier of statement.specifiers) {
              const local =
                specifier.local.type === "Identifier"
                  ? specifier.local.name
                  : specifier.local.value;
              if (!sourceExports.has(local)) {
                continue;
              }
              exported.add(
                specifier.exported.type === "Identifier"
                  ? specifier.exported.name
                  : specifier.exported.value,
              );
            }
          }
          if (exported.size > before) {
            boundaryExports.set(file, exported);
          }
        }
      }

      const boundaryCallers: string[] = [];
      for (const [file, program] of modules) {
        const boundaryBindings = new Set<string>();
        const boundaryNamespaces = new Map<string, Set<string>>();
        for (const statement of program.body) {
          if (statement.type !== "ImportDeclaration") {
            continue;
          }
          const sourceExports = boundaryExports.get(
            resolveModule(file, statement.source.value),
          );
          if (!sourceExports) {
            continue;
          }
          for (const specifier of statement.specifiers) {
            if (specifier.type === "ImportSpecifier") {
              const importedName =
                specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : specifier.imported.value;
              if (sourceExports.has(importedName)) {
                boundaryBindings.add(specifier.local.name);
              }
            } else if (specifier.type === "ImportNamespaceSpecifier") {
              boundaryNamespaces.set(specifier.local.name, sourceExports);
            }
          }
        }
        const visit = (node: unknown): void => {
          if (typeof node !== "object" || node === null) {
            return;
          }
          const isIdentifierCall =
            "type" in node &&
            node.type === "CallExpression" &&
            "callee" in node &&
            typeof node.callee === "object" &&
            node.callee !== null &&
            "type" in node.callee &&
            node.callee.type === "Identifier" &&
            "name" in node.callee &&
            typeof node.callee.name === "string" &&
            boundaryBindings.has(node.callee.name);
          const isNamespaceCall =
            "type" in node &&
            node.type === "CallExpression" &&
            "callee" in node &&
            typeof node.callee === "object" &&
            node.callee !== null &&
            "type" in node.callee &&
            node.callee.type === "MemberExpression" &&
            "object" in node.callee &&
            typeof node.callee.object === "object" &&
            node.callee.object !== null &&
            "type" in node.callee.object &&
            node.callee.object.type === "Identifier" &&
            "name" in node.callee.object &&
            typeof node.callee.object.name === "string" &&
            "property" in node.callee &&
            typeof node.callee.property === "object" &&
            node.callee.property !== null &&
            "type" in node.callee.property &&
            node.callee.property.type === "Identifier" &&
            "name" in node.callee.property &&
            typeof node.callee.property.name === "string" &&
            boundaryNamespaces
              .get(node.callee.object.name)
              ?.has(node.callee.property.name) === true;
          if (isIdentifierCall || isNamespaceCall) {
            boundaryCallers.push(file);
          }
          for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
              for (const child of value) {
                visit(child);
              }
            } else {
              visit(value);
            }
          }
        };
        visit(program);
      }
      return boundaryCallers;
    };

    const boundaryCallers = inventory(programs);
    if (new Set(boundaryCallers).size !== boundaryCallers.length) {
      throw new Error(
        "Each settings reader must have one exercised decryption boundary",
      );
    }
    expect(boundaryCallers.toSorted()).toEqual([
      "src/handlers/organization-settings/read-ai-config.ts",
      "src/handlers/organization-settings/update-ai-config.ts",
      "src/lib/ai-config-loader.ts",
    ]);

    const uncoveredReaders = new Map(programs);
    uncoveredReaders.set(
      "src/uncovered-namespace.ts",
      parseSync(
        "src/uncovered-namespace.ts",
        'import * as crypto from "@/api/lib/ai-config-crypto"; crypto.decryptAIConfig();',
      ).program,
    );
    uncoveredReaders.set(
      "src/re-export.ts",
      parseSync(
        "src/re-export.ts",
        'export { decryptAIConfig as decryptSettings } from "@/api/lib/ai-config-crypto";',
      ).program,
    );
    uncoveredReaders.set(
      "src/uncovered-re-export.ts",
      parseSync(
        "src/uncovered-re-export.ts",
        'import { decryptSettings } from "./re-export"; decryptSettings();',
      ).program,
    );
    expect(inventory(uncoveredReaders).toSorted()).toEqual(
      [
        ...boundaryCallers,
        "src/uncovered-namespace.ts",
        "src/uncovered-re-export.ts",
      ].toSorted(),
    );
  });

  test("rejects an analytics frame from another repository source", () => {
    expect(() =>
      assertSettingsAnalyticsFrame("apps/api/src/lib/ai-config.ts:12:3"),
    ).toThrow("apps/api/src/lib/ai-config-response.ts:[line]:[column]");
  });
});

describe("resolvePromptCachingPreference", () => {
  test("defaults to enabled when settings are absent", async () => {
    expect(resolvePromptCachingPreference(undefined)).toBe(true);
  });

  test("returns the stored preference", async () => {
    expect(
      resolvePromptCachingPreference({ promptCachingEnabled: false }),
    ).toBe(false);
  });
});
