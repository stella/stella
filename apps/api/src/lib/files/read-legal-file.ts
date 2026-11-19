import type { Result } from "better-result";

import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";

import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readDataBoxFile } from "@/api/lib/files/read-data-box-file";

type LegalContentReader = (
  options: Parameters<typeof readDataBoxFile>[0],
) => Promise<
  Result<
    {
      text: string;
      attachments: { entityId: SafeId<"entity">; position: number }[];
    },
    HandlerError
  >
>;

export const LEGAL_FILE_READERS = {
  dataBox: async (options) =>
    (await readDataBoxFile(options)).map((file) => ({
      text: file.text,
      attachments:
        file.kind === "message"
          ? file.files.flatMap(({ entityId }, index) =>
              entityId === null ? [] : [{ position: index + 1, entityId }],
            )
          : [],
    })),
} satisfies Record<LegalFileFormatKind, LegalContentReader>;
