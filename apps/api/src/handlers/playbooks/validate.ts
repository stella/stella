import type { Transaction } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Apply materializes each bundle column as a workspace property and
 * reuses an existing property when the trimmed name matches, so two
 * columns sharing a name would create duplicate properties. Reject the
 * bundle up front.
 */
export const hasDuplicateColumnNames = (
  bundle: readonly { name: string }[],
): boolean => {
  const seen = new Set<string>();
  for (const column of bundle) {
    const name = column.name.trim();
    if (seen.has(name)) {
      return true;
    }
    seen.add(name);
  }
  return false;
};

type TypePropertyValidation =
  | { ok: true }
  | { ok: false; status: 400 | 422; message: string };

/**
 * A playbook gates its bundle on a single-select Document Type
 * property. Confirm the referenced property exists in the workspace,
 * is a single-select, and that `typeValue` matches one of its
 * options so the stored gate `typePropertyId eq typeValue` can ever
 * be satisfied.
 */
export const validateTypeProperty = async ({
  tx,
  workspaceId,
  typePropertyId,
  typeValue,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  typePropertyId: SafeId<"property">;
  typeValue: string;
}): Promise<TypePropertyValidation> => {
  const property = await tx.query.properties.findFirst({
    where: {
      id: { eq: typePropertyId },
      workspaceId: { eq: workspaceId },
    },
    columns: { content: true },
  });

  if (!property) {
    return { ok: false, status: 422, message: "Type property not found" };
  }

  if (property.content.type !== "single-select") {
    return {
      ok: false,
      status: 400,
      message: "Type property must be a single-select property",
    };
  }

  const hasOption = property.content.options.some(
    (option) => option.value === typeValue,
  );
  if (!hasOption) {
    return {
      ok: false,
      status: 400,
      message: "Type value must match one of the type property options",
    };
  }

  return { ok: true };
};
