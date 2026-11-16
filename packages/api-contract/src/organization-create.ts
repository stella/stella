import * as v from "valibot";

export const ORGANIZATION_EVALUATION_LIMIT = 3;
export const ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE =
  "organization_evaluation_limit_reached";
export const ORGANIZATION_NAME_MAX_LENGTH = 50;
export const ORGANIZATION_CREATE_SCOPE = "stella:organization_create";

export const organizationCreateOutputSchema = v.strictObject({
  organizationId: v.string(),
  name: v.string(),
  slug: v.string(),
  role: v.literal("owner"),
  nextCall: v.strictObject({
    command: v.literal("stella auth login"),
    instruction: v.string(),
  }),
});
