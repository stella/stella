import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";

export type TaskDeploymentFeatures = {
  governedWorkflow: boolean;
  legalLists: boolean;
};

export const deployedTaskFeatures = (): TaskDeploymentFeatures => ({
  governedWorkflow: isDeploymentFeatureEnabled("FEATURE_GOVERNED_WORKFLOW"),
  legalLists: isDeploymentFeatureEnabled("FEATURE_LEGAL_LISTS"),
});
