import { describe, expect, test } from "bun:test";

import type { GazetteerEntry, PipelineConfig } from "@stll/anonymize";
import { buildChatAnonPipelineConfig } from "@stll/anonymize-chat";

import { toSafeId } from "@/api/lib/branded-types";
import {
  anonymizeTextFields,
  anonymizeTextFieldsDependencies,
} from "@/api/mcp/anonymization";
import type { AnonymizeTextFieldsDependencies } from "@/api/mcp/anonymization-core";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";

/**
 * Stella's wiring around the anonymization engine, on the real native
 * pipeline. Name-matching behaviour (inflection, diacritics, typos, legal
 * forms, identifier false positives) is gated by the labeled corpus in the
 * `stella/anonymize` repository; this file pins only what Stella adds: the
 * request path's config, the chat detectors together, the field join and
 * strict split, forced values, and deny-list entry order.
 */

const WORKSPACE_ID = "anonymization-wiring";
const ORGANIZATION_ID = toSafeId<"organization">("org_anonymization_wiring");

const entry = (
  canonical: string,
  label: "organization" | "person",
): GazetteerEntry => ({
  id: `wiring-${canonical}`,
  canonical,
  label,
  variants: [],
  workspaceId: WORKSPACE_ID,
  createdAt: 0,
  source: "manual",
});

/** Synthetic deny-list: CZ/SK/EN people and firms, short and long. */
const DENY_LIST = [
  entry("Zeta", "organization"),
  entry("Orbis", "organization"),
  entry("Beta Trading s.r.o.", "organization"),
  entry("Marie Dvořáková", "person"),
  entry("Novák", "person"),
  entry("Ľubomír Šťastný", "person"),
  entry("Harriet Wellbourne", "person"),
  entry("Will", "person"),
];

const FORCED_ORGANIZATION_ID = "5f0c2a9e-7b1d-4c3a-9e8f-1a2b3c4d5e6f";
const FORCED_SCOPE_ID = "c3a91f04-6d2e-4b8a-a1f7-0e9d8c7b6a51";

type AnonymizeOptions = {
  denyList?: readonly GazetteerEntry[];
  fields: string[];
  forcedSensitiveValues?: readonly string[];
};

const anonymize = async ({
  denyList = DENY_LIST,
  fields,
  forcedSensitiveValues = [],
}: AnonymizeOptions) =>
  (
    await anonymizeTextFields({
      catalogs: {
        type: "preloaded",
        excludedCanonicals: [],
        gazetteerEntries: [...denyList],
      },
      fields,
      forcedSensitiveValues,
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    })
  ).unwrap();

const anonymizeOne = async (text: string, denyList = DENY_LIST) =>
  (await anonymize({ denyList, fields: [text] })).fields.at(0);

/** Hits no other chat detector redacts, so each is the deny-list's own. */
const DENY_LIST_HITS = [
  {
    kind: "exact",
    text: "Dodavatelem zůstává Zeta.",
    expected: "Dodavatelem zůstává [ORGANIZATION_1].",
  },
  {
    kind: "inflected",
    text: "Plnou moc udělila Marii Dvořákové.",
    expected: "Plnou moc udělila [PERSON_1].",
  },
  {
    kind: "one-typo",
    text: "Klient Orbys zaplatil.",
    expected: "Klient [ORGANIZATION_1] zaplatil.",
  },
] as const;

const [KEEP_CONTEXT] = DENY_LIST_HITS;

const KEEP_CASES = [
  {
    kind: "UUID",
    text: "request 9b1d0c3e-acfe-4ca1-8b2e-5c7a0a1b2c3d failed",
  },
  {
    kind: "hex hash",
    text: "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ok",
  },
  { kind: "id code", text: "Faktura INV-2024-0042 je splatná." },
  {
    kind: "word extending a single-word entry",
    text: "Both parties are willing to settle.",
  },
  {
    kind: "common word equal to a first name",
    text: "The grant of rights is exclusive.",
  },
  { kind: "marker", text: "before ⟦field-acfe-01⟧ after" },
  { kind: "marker around an entry", text: "before ⟦Zeta⟧ after" },
] as const;

const MULTI_FIELD_INPUT = [
  "Za kupujícího jednala Marie Dvořáková.",
  "Prodávající: Beta Trading s.r.o.",
  "Odvolanie podal Ľubomír Šťastný.",
];

const SPLIT_NAME_INPUT = [
  "Za kupujícího jednala Marie",
  "Dvořáková podepsala.",
];

describe("the chat and MCP request path", () => {
  test("runs the chat pipeline config with the workspace deny-list as gazetteer", async () => {
    const configs: PipelineConfig[] = [];
    const gazetteers: GazetteerEntry[][] = [];
    const dependencies = {
      ...anonymizeTextFieldsDependencies,
      createNativePipelineFromConfig: async (input) => {
        configs.push(input.config);
        gazetteers.push([...(input.gazetteerEntries ?? [])]);
        return await anonymizeTextFieldsDependencies.createNativePipelineFromConfig(
          input,
        );
      },
    } satisfies AnonymizeTextFieldsDependencies;

    const result = await anonymizeTextFieldsWithDependencies({
      catalogs: {
        type: "preloaded",
        excludedCanonicals: [],
        gazetteerEntries: [...DENY_LIST],
      },
      dependencies,
      fields: [KEEP_CONTEXT.text],
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(configs).toEqual([
      {
        ...buildChatAnonPipelineConfig({
          hasGazetteer: true,
          workspaceId: WORKSPACE_ID,
        }),
        dictionaries:
          await anonymizeTextFieldsDependencies.loadNameDictionaries(),
      },
    ]);
    expect(configs.at(0)).toMatchObject({
      threshold: 0.4,
      enableGazetteer: true,
      enableDenyList: false,
    });
    expect(gazetteers).toEqual([DENY_LIST]);
    expect(result.unwrap().fields).toEqual([KEEP_CONTEXT.expected]);
  });

  test.each(DENY_LIST_HITS)(
    "redacts a deny-list $kind hit that stays visible without the deny-list",
    async ({ expected, text }) => {
      expect(await anonymizeOne(text, [])).toBe(text);
      expect(await anonymizeOne(text)).toBe(expected);
    },
  );
});

describe("all chat detectors together", () => {
  test.each(KEEP_CASES)(
    "keep a $kind intact beside a deny-list hit",
    async ({ text }) => {
      expect(await anonymizeOne(`${KEEP_CONTEXT.text} ${text}`)).toBe(
        `${KEEP_CONTEXT.expected} ${text}`,
      );
    },
  );
});

describe("the field join and strict split", () => {
  test("return one field per input field, each redacted on its own", async () => {
    const result = await anonymize({ fields: MULTI_FIELD_INPUT });

    expect(result.fields).toEqual([
      "Za kupujícího jednala [PERSON_1].",
      "Prodávající: [ORGANIZATION_1]",
      "Odvolanie podal [PERSON_2].",
    ]);
  });

  test("never merge a name split across a field boundary into one redaction", async () => {
    const result = await anonymize({ fields: SPLIT_NAME_INPUT });

    expect(result.fields).toHaveLength(2);
    expect(result.fields.at(0)).toStartWith("Za kupujícího jednala ");
    expect(result.fields.at(1)).toEndWith(" podepsala.");
    expect(
      [...result.redactionMap.values()].filter(
        (original) =>
          original.includes("Marie") && original.includes("Dvořáková"),
      ),
    ).toEqual([]);
  });
});

describe("chat forced values", () => {
  test("redact identifiers from a sibling field in the next field, case variants included", async () => {
    const fields = [
      `Organization ${FORCED_ORGANIZATION_ID}, scope ${FORCED_SCOPE_ID}.`,
      `ORG ${FORCED_ORGANIZATION_ID.toUpperCase()} ARCHIVED, GET /orgs/${FORCED_ORGANIZATION_ID}/files, {"scope":"${FORCED_SCOPE_ID}"}`,
    ];

    const control = await anonymize({ denyList: [], fields });
    const result = await anonymize({
      denyList: [],
      fields,
      forcedSensitiveValues: [FORCED_ORGANIZATION_ID, FORCED_SCOPE_ID],
    });

    expect(control.fields).toEqual(fields);
    expect(result.fields).toEqual([
      "Organization [MISC_1], scope [MISC_2].",
      'ORG [MISC_1] ARCHIVED, GET /orgs/[MISC_1]/files, {"scope":"[MISC_2]"}',
    ]);
  });
});

describe("deny-list entry order", () => {
  test("does not change any output", async () => {
    const inputs = [
      ...DENY_LIST_HITS.map(({ text }) => [text]),
      ...KEEP_CASES.map(({ text }) => [`${KEEP_CONTEXT.text} ${text}`]),
      MULTI_FIELD_INPUT,
      SPLIT_NAME_INPUT,
    ];
    const reversed = DENY_LIST.toReversed();

    const outputsFor = async (denyList: readonly GazetteerEntry[]) => {
      const outputs: string[][] = [];
      for (const fields of inputs) {
        outputs.push((await anonymize({ denyList, fields })).fields);
      }
      return outputs;
    };

    expect(reversed.at(0)).toEqual(DENY_LIST.at(-1));
    expect(await outputsFor(reversed)).toEqual(await outputsFor(DENY_LIST));
  });
});
