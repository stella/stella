import type { FeatureAccessProof } from "@/api/lib/feature-access/policy";

export type ListVerificationAccessProof = FeatureAccessProof;

export type ListVerificationAccessResult =
  | { status: "available"; proof: FeatureAccessProof }
  | { status: "unavailable" };
