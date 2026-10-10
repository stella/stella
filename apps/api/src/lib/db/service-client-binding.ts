import { eq } from "drizzle-orm";

import { oauthClient } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { serviceOAuthClients } from "@/api/db/schema";

export const readOAuthClientBinding = async (
  db: Pick<Transaction, "select">,
  clientId: string,
) =>
  (
    await db
      .select({
        clientId: oauthClient.clientId,
        organizationId: serviceOAuthClients.organizationId,
        disabled: oauthClient.disabled,
        type: oauthClient.type,
        userId: oauthClient.userId,
        clientCredentialsScopes: oauthClient.clientCredentialsScopes,
        requestsPerMinute: serviceOAuthClients.requestsPerMinute,
        dailyBudget: serviceOAuthClients.dailyBudget,
        credentialVersion: serviceOAuthClients.credentialVersion,
        clientSecret: oauthClient.clientSecret,
      })
      .from(oauthClient)
      .leftJoin(
        serviceOAuthClients,
        eq(oauthClient.clientId, serviceOAuthClients.clientId),
      )
      .where(eq(oauthClient.clientId, clientId))
      .limit(1)
  ).at(0) ?? null;
