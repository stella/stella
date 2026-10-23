import { t } from "elysia";

export const accountExportStatusSchema = t.Union([
  t.Object({
    status: t.UnionEnum(["requested", "processing", "failed", "expired"]),
    id: t.String(),
  }),
  t.Object({ status: t.Literal("ready"), id: t.String(), expiresAt: t.Date() }),
]);
