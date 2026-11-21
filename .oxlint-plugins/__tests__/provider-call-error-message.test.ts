import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lintHandler = async (lines: readonly string[]) =>
  await lintSingleRule(
    "provider-call-error-message",
    [...lines, ""].join("\n"),
    {
      sourcePath: "apps/api/src/lib/tanstack-ai-generate.ts",
    },
  );

const lintProviderError = async (lines: readonly string[]) =>
  await lintSingleRule(
    "provider-call-error-message",
    [...lines, ""].join("\n"),
  );

describe("provider-call-error-message", () => {
  test("allows a literal and an aliased imported owner constant, but rejects provider text", async () => {
    expect(
      await lintHandler([
        'import { PROVIDER_CALL_ERROR_MESSAGE as safeMessage } from "@/api/lib/errors/provider-call-error";',
        "declare const chunk: { message: string };",
        'new HandlerError({ message: "Provider request failed" });',
        "new HandlerError({ message: safeMessage });",
        "new HandlerError({ message: chunk.message });",
      ]),
    ).toEqual([5]);
  });

  test("rejects dynamic messages on aliased constructors directly and through references and spreads", async () => {
    expect(
      await lintProviderError([
        'import { ProviderCallError as ProviderFailure } from "@/api/lib/errors/provider-call-error";',
        "declare const providerText: string;",
        "const options = { message: providerText };",
        'new ProviderFailure({ provider: "openrouter", ...options });',
        'new ProviderFailure({ provider: "openrouter", message: providerText });',
      ]),
    ).toEqual([3, 5]);
  });

  test("rejects a message on a model run error, aliased or not", async () => {
    expect(
      await lintProviderError([
        'import { ModelRunError as RunFailure } from "@/api/lib/errors/provider-call-error";',
        "declare const modelText: string;",
        'new RunFailure({ model: "openrouter" });',
        'new RunFailure({ model: "openrouter", message: modelText });',
        'new ModelRunError({ model: "openrouter", message: "fixed" });',
      ]),
    ).toEqual([4, 5]);
  });

  test("does not constrain HandlerError messages outside the owning source", async () => {
    expect(
      await lintSingleRule(
        "provider-call-error-message",
        [
          "declare const providerText: string;",
          "new HandlerError({ message: providerText });",
          "",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
