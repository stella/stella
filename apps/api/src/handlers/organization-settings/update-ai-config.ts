import { generateText } from "ai";
import { Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { invalidateOrgAIConfig } from "@/api/lib/ai-config-cache";
import {
  decryptAIConfig,
  encryptAIConfig,
  maskApiKey,
} from "@/api/lib/ai-config-crypto";
import { getModelForRole, supportsRegion } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const updateAIConfigBody = t.Object({
  provider: t.UnionEnum([
    "google",
    "openrouter",
    "openai",
    "anthropic",
    "openai_compatible",
  ]),
  apiKey: t.Optional(t.String({ minLength: 1 })),
  baseURL: t.Optional(t.String({ format: "uri" })),
  overrideRoles: t.Optional(
    t.Array(t.UnionEnum(["fast", "chat", "reasoning", "pdf"])),
  ),
  region: t.Optional(t.UnionEnum(["eu", "global", "ch"])),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: updateAIConfigBody,
} satisfies HandlerConfig;

/**
 * Update the org's AI config (BYOK).
 *
 * Validates the API key with a lightweight test call,
 * encrypts the config, and stores it.
 */
const updateAIConfig = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body }) {
    // Resolve the API key and existing config: use the new
    // key if provided, otherwise read from storage.
    let resolvedKey: string | undefined = body.apiKey;
    let existingConfig: OrgAIConfig | undefined;

    if (!resolvedKey) {
      const row = yield* Result.await(
        safeDb((tx) =>
          tx.query.organizationSettings.findFirst({
            where: {
              organizationId: {
                eq: session.activeOrganizationId,
              },
            },
            columns: {
              aiConfigEncrypted: true,
              aiConfigIv: true,
            },
          }),
        ),
      );

      const ciphertext = row?.aiConfigEncrypted;
      const iv = row?.aiConfigIv;

      if (ciphertext && iv) {
        const decryptResult = await Result.tryPromise({
          try: async () =>
            await decryptAIConfig(session.activeOrganizationId, ciphertext, iv),
          catch: (error: unknown) => error,
        });

        if (decryptResult.isErr()) {
          captureError(decryptResult.error);
          return Result.err(
            new HandlerError({
              status: 400,
              message:
                "Stored AI config could not be decrypted. " +
                "Please re-enter your API key.",
            }),
          );
        }

        existingConfig = decryptResult.value;
        resolvedKey = existingConfig.apiKey;
      }
    }

    if (!resolvedKey) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "API key is required for initial setup",
        }),
      );
    }

    // Require a new key when switching providers; the old
    // provider's key won't authenticate with the new one.
    if (
      !body.apiKey &&
      existingConfig &&
      existingConfig.provider !== body.provider
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "API key is required when changing provider",
        }),
      );
    }

    // Resolve baseURL: body > existing > reject for
    // openai_compatible.
    const resolvedBaseURL = body.baseURL ?? existingConfig?.baseURL;
    if (body.provider === "openai_compatible" && !resolvedBaseURL) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Base URL is required for OpenAI-compatible provider",
        }),
      );
    }

    // Reject region + non-regional provider at the boundary.
    if (
      body.region &&
      body.region !== "global" &&
      !supportsRegion(body.provider)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            `Regional routing is not supported for ${body.provider}. ` +
            "Only Google AI supports EU/CH regional endpoints via Vertex AI.",
        }),
      );
    }

    // Only validate when a new key is provided.
    if (body.apiKey) {
      const validationResult = await validateProviderKey(
        body.provider,
        resolvedKey,
        resolvedBaseURL,
        body.region ?? existingConfig?.region,
      );

      if (!validationResult.valid) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: validationResult.error,
          }),
        );
      }
    }

    const orgConfig: OrgAIConfig = {
      provider: body.provider,
      apiKey: resolvedKey,
      baseURL: resolvedBaseURL,
      overrideRoles: body.overrideRoles ?? existingConfig?.overrideRoles,
      region: body.region ?? existingConfig?.region,
    };

    const { ciphertext: newCiphertext, iv: newIv } = await encryptAIConfig(
      session.activeOrganizationId,
      orgConfig,
    );

    yield* Result.await(
      safeDb((tx) =>
        tx
          .insert(organizationSettings)
          .values({
            id: crypto.randomUUID(),
            organizationId: session.activeOrganizationId,
            aiConfigEncrypted: newCiphertext,
            aiConfigIv: newIv,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              aiConfigEncrypted: newCiphertext,
              aiConfigIv: newIv,
              updatedAt: new Date(),
            },
          }),
      ),
    );

    invalidateOrgAIConfig(session.activeOrganizationId);

    return Result.ok({
      provider: body.provider,
      apiKeyMasked: maskApiKey(resolvedKey),
      region: orgConfig.region ?? "global",
    });
  },
);

type ValidationResult = { valid: true } | { valid: false; error: string };

/**
 * Validate a provider API key by making a minimal API call.
 * Uses a tiny prompt to minimize cost.
 */
const validateProviderKey = async (
  provider: OrgAIConfig["provider"],
  apiKey: string,
  baseURL?: string,
  region?: OrgAIConfig["region"],
): Promise<ValidationResult> => {
  const tempConfig: OrgAIConfig = {
    provider,
    apiKey,
    baseURL,
    region,
  };

  const result = await Result.tryPromise({
    try: async () => {
      const model = getModelForRole("fast", tempConfig);
      return await generateText({
        model,
        prompt: "Say OK",
        maxOutputTokens: 3,
        abortSignal: AbortSignal.timeout(10_000),
      });
    },
    catch: (error: unknown) =>
      `API key validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  });

  if (result.isErr()) {
    return { valid: false, error: result.error };
  }
  return { valid: true };
};

export default updateAIConfig;
