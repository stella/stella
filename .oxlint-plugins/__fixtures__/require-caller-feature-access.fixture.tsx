import { createFileRoute } from "@tanstack/react-router";

// oxlint-disable-next-line require-caller-feature-access/require-caller-feature-access -- fixture: a gated route requires its loader owner
import { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";

declare const env: { VITE_FEATURE_LEGAL_LISTS: boolean; MODE: string };
declare const dev: { avtPreview: boolean };

// expect-clean: require-caller-feature-access/require-caller-feature-access
export const buildMode = env.MODE;

// oxlint-disable-next-line require-caller-feature-access/require-caller-feature-access -- fixture: browser flags cannot authorize a caller
export const buildFlag = env.VITE_FEATURE_LEGAL_LISTS;
// oxlint-disable-next-line require-caller-feature-access/require-caller-feature-access -- fixture: browser preview state cannot authorize a caller
export const preview = dev.avtPreview;

export const Route = createFileRoute("/__fixture/feature")({
  loader: () => legalListsOptions("matter"),
});
