import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { DEFAULT_ENTITY_LABELS } from "../constants";
import type { NativePipelineEntity } from "../native";
import type { PipelineConfig } from "../types";
import { loadTestDictionaries } from "./load-dictionaries";
import { detectNative } from "./native-detect";

setDefaultTimeout(60_000);

const CONFIG: Omit<PipelineConfig, "dictionaries"> = {
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
  workspaceId: "legal-party-fields-test",
  languages: ["en"],
  nameCorpusLanguages: ["en"],
};

const detect = async (text: string): Promise<NativePipelineEntity[]> =>
  detectNative({ ...CONFIG, dictionaries: await loadTestDictionaries() }, text);

const people = async (text: string): Promise<string[]> =>
  (await detect(text))
    .filter(({ label }) => label === "person")
    .map(({ text: entityText }) => entityText);

describe("structured English contract-party fields", () => {
  test("detects party names on the same line", async () => {
    const text = [
      "Buyer: Q. Z. Mercer",
      "Seller: Imani Nwosu",
      "Lender: Ayo Balogun",
      "Guarantor: B. T. Okafor",
    ].join("\n");

    expect(await people(text)).toEqual([
      "Q. Z. Mercer",
      "Imani Nwosu",
      "Ayo Balogun",
      "B. T. Okafor",
    ]);
  });

  test("detects a party name on the following line", async () => {
    expect(await people("Borrower:\nZofia Wrona")).toContain("Zofia Wrona");
  });

  test("rejects prose, blank templates, titles, and organizations", async () => {
    const text = [
      "Buyer: the party named above",
      "Seller: ____________________",
      "Seller: Acme Trading",
      "Lender: General Lender",
      "Customer: Harbor Legal Inc.",
    ].join("\n");

    expect(await people(text)).toEqual([]);
  });
});
