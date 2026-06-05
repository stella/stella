import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

const dbLimitMock = mock(async () => [] as Record<string, unknown>[]);
const dbWhereMock = mock(() => ({ limit: dbLimitMock }));
const dbFromMock = mock(() => ({ where: dbWhereMock }));
const dbSelectMock = mock(() => ({ from: dbFromMock }));
const decryptAIConfigMock = mock(async () => ({
  overrideModels: {},
  providers: [],
}));

void mock.module("@/api/db/root", () => ({
  rootDb: {
    select: dbSelectMock,
  },
}));

void mock.module("@/api/lib/ai-config-crypto", () => ({
  decryptAIConfig: decryptAIConfigMock,
}));

beforeEach(() => {
  dbSelectMock.mockClear();
  dbFromMock.mockClear();
  dbWhereMock.mockClear();
  dbLimitMock.mockReset();
  dbLimitMock.mockResolvedValue([]);
  decryptAIConfigMock.mockClear();
});

const organizationId = toSafeId<"organization">("org_loader_test");

describe("loadOrgAIConfig", () => {
  test("returns null for nullish encrypted settings", async () => {
    dbLimitMock.mockResolvedValueOnce([
      { aiConfigEncrypted: null, aiConfigIv: undefined },
    ]);

    const { loadOrgAIConfig } = await import("@/api/lib/ai-config-loader");

    const result = await loadOrgAIConfig(organizationId);

    expect(result).toBeNull();
    expect(decryptAIConfigMock).not.toHaveBeenCalled();
  });

  test("decodes bytea text before decrypting", async () => {
    dbLimitMock.mockResolvedValueOnce([
      { aiConfigEncrypted: "\\x0a0b", aiConfigIv: "\\x0102" },
    ]);

    const { loadOrgAIConfig } = await import("@/api/lib/ai-config-loader");

    const result = await loadOrgAIConfig(organizationId);

    expect(result).toEqual({
      overrideModels: {},
      providers: [],
    });
    expect(decryptAIConfigMock).toHaveBeenCalledWith(
      organizationId,
      Buffer.from([10, 11]),
      Buffer.from([1, 2]),
    );
  });
});

describe("loadPromptCachingPreference", () => {
  test("defaults to enabled when settings are absent", async () => {
    const { loadPromptCachingPreference } =
      await import("@/api/lib/ai-config-loader");

    const result = await loadPromptCachingPreference(organizationId);

    expect(result).toBe(true);
  });

  test("returns the stored preference", async () => {
    dbLimitMock.mockResolvedValueOnce([{ promptCachingEnabled: false }]);
    const { loadPromptCachingPreference } =
      await import("@/api/lib/ai-config-loader");

    const result = await loadPromptCachingPreference(organizationId);

    expect(result).toBe(false);
  });
});
