import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

type ParserParitySpec = {
  readonly adapterKey: AdapterKey;
  readonly fixture: string;
};

/** Stored, full-decision captures whose adapter path can be replayed offline. */
export const PARSER_PARITY_MANIFEST = [
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
] as const satisfies readonly ParserParitySpec[];

export type ParserParityEntry = {
  readonly adapterKey: (typeof PARSER_PARITY_MANIFEST)[number]["adapterKey"];
  readonly fixture: string;
};
