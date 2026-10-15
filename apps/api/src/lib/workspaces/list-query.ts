import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";

type WorkspaceListQueryOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  query?: string;
  limit: number;
};

export const readWorkspaceListRows = ({
  tx,
  organizationId,
  query,
  limit,
}: WorkspaceListQueryOptions) =>
  tx.query.workspaces.findMany({
    where: {
      organizationId: { eq: organizationId },
      ...(query
        ? {
            OR: [
              { name: { ilike: `%${escapeLike(query)}%` } },
              { reference: { ilike: `%${escapeLike(query)}%` } },
            ],
          }
        : {}),
      status: { eq: "active" },
    },
    columns: {
      id: true,
      name: true,
      reference: true,
      clientId: true,
      color: true,
      status: true,
      leadUserId: true,
      lastActivityAt: true,
      createdAt: true,
    },
    with: {
      client: {
        columns: {
          id: true,
          displayName: true,
        },
        with: {
          responsibleAttorney: {
            columns: { name: true },
          },
        },
      },
    },
    orderBy: {
      lastActivityAt: "desc",
    },
    limit,
  });
