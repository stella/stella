import type { PreviewBlock } from "../statute-list";

/**
 * § 72a odst. 1 of the Czech Code of Criminal Procedure (141/1961 Sb.) in the
 * consolidation in force from 1 January 2026, as a provision read returns it:
 * the paragraph's lead-in, then the four letters that complete its sentence.
 * Text verbatim from https://www.e-sbirka.cz/eli/cz/sb/1961/141/2026-01-01.
 */
export const section72aSubsection1Blocks = [
  {
    anchorId: "par_72a-odst_1",
    id: "par_72a-odst_1",
    text: "(1) Vazba může trvat v přípravném řízení a v řízení před soudem jen nezbytně nutnou dobu. Celková doba trvání vazby v trestním řízení nesmí přesáhnout",
  },
  {
    anchorId: "par_72a-odst_1-pism_a",
    id: "par_72a-odst_1-pism_a",
    text: "a) jeden rok, je-li vedeno trestní stíhání pro přečin,",
  },
  {
    anchorId: "par_72a-odst_1-pism_b",
    id: "par_72a-odst_1-pism_b",
    text: "b) dva roky, je-li vedeno trestní stíhání pro zločin,",
  },
  {
    anchorId: "par_72a-odst_1-pism_c",
    id: "par_72a-odst_1-pism_c",
    text: "c) tři roky, je-li vedeno trestní stíhání pro zvlášť závažný zločin,",
  },
  {
    anchorId: "par_72a-odst_1-pism_d",
    id: "par_72a-odst_1-pism_d",
    text: "d) čtyři roky, je-li vedeno trestní stíhání pro zvlášť závažný zločin, za který lze podle trestního zákona uložit výjimečný trest.",
  },
] as const satisfies readonly PreviewBlock[];
