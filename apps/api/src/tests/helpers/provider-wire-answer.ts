import { panic } from "better-result";

import {
  cassetteFor,
  type ProviderWireCassette,
  type ProviderWireProvider,
  type ProviderWireScenario,
} from "@/api/tests/helpers/provider-wire-cassette";
import { EXPECTED_TEXT } from "@/api/tests/helpers/provider-wire-contract";

/** A recorded provider stream's body and headers, ready for a `Response`. */
const recordedStreamBody = (
  cassette: ProviderWireCassette,
): { body: string; headers: Record<string, string> } => {
  const exchange = cassette.exchanges.at(0);
  if (exchange?.response.body.encoding !== "text") {
    return panic(
      `The ${cassette.provider} ${cassette.scenario} cassette has no text body`,
    );
  }
  return {
    body: exchange.response.body.text,
    headers: exchange.response.headers,
  };
};

/** The provider's recorded stream for `scenario` (variant `variant`). */
export const recordedScenarioBody = (
  cassettes: readonly ProviderWireCassette[],
  provider: ProviderWireProvider,
  scenario: ProviderWireScenario,
  variant?: string,
) =>
  recordedStreamBody(
    variant === undefined
      ? cassetteFor(cassettes, provider, scenario)
      : (cassettes.find(
          (cassette) =>
            cassette.provider === provider &&
            cassette.scenario === scenario &&
            cassette.variant === variant,
        ) ?? panic(`No ${provider}/${scenario}.${variant} cassette`)),
  );

/** The recorded sentence's pieces as each provider streamed them. */
const RECORDED_PIECES = new Set(["The", " cassette", " plays", "."]);

/**
 * The provider's recorded text stream with its sentence replaced by `answer`:
 * the whole sentence where the provider sent it whole, the first piece where
 * it streamed pieces, and the rest of the pieces emptied.
 */
export const streamCarrying = (sse: string, answer: string): string => {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value === EXPECTED_TEXT || value === "The") {
        return answer;
      }
      return RECORDED_PIECES.has(value) ? "" : value;
    }
    if (Array.isArray(value)) {
      return value.map(replace);
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, replace(entry)]),
      );
    }
    return value;
  };
  return sse.replace(/^data: (.+)$/gmu, (line, data: string) => {
    if (data.trim() === "[DONE]") {
      return line;
    }
    const event: unknown = JSON.parse(data);
    return `data: ${JSON.stringify(replace(event))}`;
  });
};
