import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

type ParserParitySpec = {
  readonly adapterKey: AdapterKey;
  readonly fixture: string;
  readonly identity?: ParserParityIdentity;
};

export type ParserParityIdentity = {
  caseNumber: string;
  documentId: string;
  decisionDate: string;
  ecli: string;
};

/** Stored, full-decision captures whose adapter path can be replayed offline. */
export const PARSER_PARITY_MANIFEST = [
  {
    adapterKey: ADAPTER_KEYS.UK_FCL,
    fixture: "parsers/__fixtures__/uk-fcl.xml",
  },
  {
    adapterKey: ADAPTER_KEYS.EU_ECJ,
    fixture: "parsers/__fixtures__/eu-ecj/62022CJ0128.en.html.gz",
  },
  {
    adapterKey: ADAPTER_KEYS.HU_BHGY,
    fixture: "parsers/__fixtures__/hu-bhgy-decision.docx",
  },
  {
    adapterKey: ADAPTER_KEYS.PL_NSA,
    fixture: "adapters/__fixtures__/pl-nsa-rows.json",
  },
  {
    adapterKey: ADAPTER_KEYS.PL_UODO,
    fixture: "parsers/__fixtures__/pl-uodo-dkn-5131-45-2022.xml",
  },
  {
    adapterKey: ADAPTER_KEYS.SK_US,
    fixture: "parsers/__fixtures__/sk-us-iii-us-265-2026.content.json.gz",
  },
  {
    adapterKey: ADAPTER_KEYS.SK_US,
    fixture: "parsers/__fixtures__/sk-us-i-us-618-2026.content.json.gz",
    identity: {
      caseNumber: "I. ÚS 618/2026",
      documentId: "4acade4e-851e-4fc1-93e7-06ede3447a07",
      decisionDate: "2026-10-22",
      ecli: "ECLI:SK:USSR:2026:1.US.618.2026.1",
    },
  },
] as const satisfies readonly ParserParitySpec[];

export type ParserParityEntry = {
  readonly adapterKey: (typeof PARSER_PARITY_MANIFEST)[number]["adapterKey"];
  readonly fixture: string;
  readonly identity?: ParserParityIdentity;
};
