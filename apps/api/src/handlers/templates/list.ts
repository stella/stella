import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ListTemplatesProps = {
  organizationId: SafeId<"organization">;
};

export const listTemplatesHandler = async ({
  organizationId,
}: ListTemplatesProps) => {
  const result = await db.query.templates.findMany({
    where: { organizationId },
    columns: {
      id: true,
      name: true,
      fileName: true,
      fieldCount: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    limit: LIMITS.templatesCount,
  });

  return {
    templates: result,
    templatesCountLimit: LIMITS.templatesCount,
  };
};
