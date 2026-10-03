import { panic } from "better-result";

import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { createTanStackTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { loadProviderWireCassettes } from "@/api/tests/helpers/provider-wire-cassette";

export const providerCallErrorCassettes = () =>
  loadProviderWireCassettes().filter(
    ({ provider, scenario, variant }) =>
      provider === "openrouter" &&
      (scenario === "server-error" || scenario === "rate-limit") &&
      (variant === "request-id" || variant === "body-only"),
  );

export const providerCallErrorSentinel = ({
  exchanges,
}: ReturnType<typeof providerCallErrorCassettes>[number]) => {
  const response = exchanges.at(0)?.response;
  if (response === undefined) {
    panic("The error fixture has a response");
  }
  if (response.body.encoding !== "text") {
    panic("The error fixture has a text body");
  }
  const sentinel = /SENTINEL_OPENROUTER_[A-Z0-9_]+/u
    .exec(response.body.text)
    ?.at(0);
  if (sentinel === undefined) {
    panic("The error fixture has a sentinel");
  }
  return sentinel;
};

export const instanceWireErrorModel = (modelId: string) =>
  ({
    adapter: createTanStackTextAdapterFactory({
      apiKey: "cassette-replay-no-credentials",
      dataClass: "public_corpus",
      provider: "openrouter",
    })(modelId),
    keySource: "instance",
    modelId,
    modelOptions: {},
    provider: "openrouter",
  }) satisfies ResolvedTanStackTextModel;
