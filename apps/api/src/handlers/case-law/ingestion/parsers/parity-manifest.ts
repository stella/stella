import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

export type ParserParityEntry = {
  readonly adapterKey: AdapterKey;
  readonly fixture: string;
  readonly golden: string;
};

/** Stored, full-decision captures whose adapter path can be replayed offline. */
export const PARSER_PARITY_MANIFEST = [
  {
    adapterKey: ADAPTER_KEYS.EU_ECJ,
    fixture: "parsers/__fixtures__/eu-ecj/62022CJ0128.en.html.gz",
    golden: "parsers/__fixtures__/eu-ecj/62022CJ0128.en.html.gz.golden.json",
  },
  {
    adapterKey: ADAPTER_KEYS.HU_BHGY,
    fixture: "parsers/__fixtures__/hu-bhgy-decision.docx",
    golden: "parsers/__fixtures__/hu-bhgy-decision.docx.golden.json",
  },
  {
    adapterKey: ADAPTER_KEYS.PL_NSA,
    fixture: "adapters/__fixtures__/pl-nsa-rows.json",
    golden: "adapters/__fixtures__/pl-nsa-rows.json.golden.json",
  },
  {
    adapterKey: ADAPTER_KEYS.PL_UODO,
    fixture: "parsers/__fixtures__/pl-uodo-dkn-5131-45-2022.xml",
    golden: "parsers/__fixtures__/pl-uodo-dkn-5131-45-2022.xml.golden.json",
  },
  {
    adapterKey: ADAPTER_KEYS.SK_US,
    fixture: "parsers/__fixtures__/sk-us-iii-us-265-2026.content.json.gz",
    golden:
      "parsers/__fixtures__/sk-us-iii-us-265-2026.content.json.gz.golden.json",
  },
] as const satisfies readonly ParserParityEntry[];
