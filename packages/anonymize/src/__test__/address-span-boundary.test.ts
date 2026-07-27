/**
 * An address span ends at the city that completes its
 * destination. Right-expansion used to run on to the next
 * unrelated boundary, so a return address absorbed the
 * conjunction and the prose that followed it.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { detectNative } from "./native-detect";
import { loadTestDictionaries } from "./load-dictionaries";

const dictionaries = await loadTestDictionaries();

const config: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "address-span-boundary-test",
  dictionaries,
};

const addresses = async (fullText: string): Promise<NativePipelineEntity[]> => {
  const entities = await detectNative(config, fullText);
  return entities.filter((entity) => entity.label === "address");
};

describe("address span boundary", () => {
  test("span ends at the city, not the conjunction that follows", async () => {
    const found = await addresses(
      "Notices shall be sent to the offices of 14 Rue de la Paix, Paris, and Meridian Capital shall countersign.",
    );
    const address = found.find((entity) => entity.text.includes("Rue de la"));
    expect(address?.text).toBe("14 Rue de la Paix, Paris");
  });

  test("span ends at the city, not the prose that follows", async () => {
    const found = await addresses(
      "Notices were sent to 14 Rue de la Paix, Paris last year.",
    );
    const address = found.find((entity) => entity.text.includes("Rue de la"));
    expect(address?.text).toBe("14 Rue de la Paix, Paris");
  });

  test("a unit component after the city stays inside the span", async () => {
    // "Apt. 5" is not an address seed, so the city is the span's rightmost
    // evidence; the unit component still belongs to the address.
    const found = await addresses(
      "Notices go to 10 Main Street, Springfield Apt. 5.",
    );
    const address = found.find((entity) => entity.text.includes("Main Street"));
    expect(address?.text).toBe("10 Main Street, Springfield Apt. 5");
  });

  test("a city-anchored address with no trailing prose is unchanged", async () => {
    const found = await addresses("14 Rue de la Paix, Paris");
    expect(
      found.some((entity) => entity.text === "14 Rue de la Paix, Paris"),
    ).toBe(true);
  });
});
