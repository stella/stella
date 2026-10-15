import * as v from "valibot";

import type { AgentInputNormalizationAnnotation } from "@stll/agent-input";

import { LIMITS } from "@/api/lib/limits";
import {
  cursorInput,
  ELI_NORMALIZATION,
  nullAsAbsent,
} from "@/api/mcp/input-schemas";
import { isProvisionTextCursor } from "@/api/mcp/provision-text-window";

export const eliInputSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.description(
    "European Legislation Identifier of the work, as search_legislation " +
      "returns it (for example https://www.e-sbirka.cz/eli/cz/sb/2012/89). " +
      "It addresses the act, not one consolidation of it.",
  ),
);

export const anchorInputSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
  v.description(
    "Publisher provision anchor; confirm it in read_statute's outline for " +
      "the chosen consolidation. Czech e-Sbírka commonly uses par_<section>, " +
      "-odst_<paragraph>, and -pism_<letter> (par_1729, par_1729-odst_1, " +
      "par_1729-odst_2-pism_a). Subdivision anchors narrow the answer to " +
      "that subdivision. Other publishers may use different schemes.",
  ),
);

export const languageInputSchema = v.pipe(
  v.string(),
  v.minLength(2),
  v.maxLength(8),
  v.description(
    "Language of the consolidation to read. Language is part of the work " +
      "key, so an act published in two languages has one consolidation in " +
      "each.",
  ),
);

export const readProvisionHistoryArgsSchema = nullAsAbsent(
  v.strictObject({
    eli: eliInputSchema,
    anchor: anchorInputSchema,
    language: v.optional(languageInputSchema),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.legislationProvisionHistoryPageSizeMax),
        v.description(
          `Versions per page; defaults to ${LIMITS.legislationProvisionHistoryPageSizeDefault}, at most ${LIMITS.legislationProvisionHistoryPageSizeMax}.`,
        ),
      ),
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous read_provision_history call to read the next page",
    }),
    text_cursor: cursorInput({
      description:
        "Opaque nextTextCursor from one item in the requested history page",
      issuedBy: isProvisionTextCursor,
    }),
  }),
);

export const READ_PROVISION_HISTORY_INPUT_NORMALIZATION = {
  eli: ELI_NORMALIZATION,
} as const satisfies Readonly<
  Record<string, AgentInputNormalizationAnnotation>
>;
