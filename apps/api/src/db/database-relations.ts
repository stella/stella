import { agentAuthRelationsPart } from "@/api/db/agent-auth-schema";
import { authRelationsPart } from "@/api/db/auth-schema";
import { relations } from "@/api/db/schema";

export const databaseRelations = {
  ...relations,
  ...authRelationsPart,
  ...agentAuthRelationsPart,
};
