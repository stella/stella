import type { InferOutput } from "valibot";

import type { cadesPreviewSchema } from "@stll/api-contract/cades";

type CadesText = Pick<
  InferOutput<typeof cadesPreviewSchema>,
  "layers" | "text"
>;

export const cadesDocumentText = ({ layers, text }: CadesText): string =>
  [
    "CAdES signed file. Signatures are unverified.",
    ...layers.map(
      ({ signers }, index) =>
        `Layer ${index + 1}: ${signers.map(({ name }) => name ?? "Unknown signer").join(", ")}`,
    ),
    "",
    text || "Embedded file text unavailable.",
  ].join("\n");
