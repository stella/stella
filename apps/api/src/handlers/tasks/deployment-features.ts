import { env } from "@/api/env";

export type TaskDeploymentFeatures = {
  governedWorkflow: boolean;
  legalLists: boolean;
};

export const deployedTaskFeatures = (): TaskDeploymentFeatures => ({
  governedWorkflow: env.FEATURE_GOVERNED_WORKFLOW,
  legalLists: env.FEATURE_LEGAL_LISTS,
});
