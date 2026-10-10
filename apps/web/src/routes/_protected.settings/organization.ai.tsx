import { createFileRoute } from "@tanstack/react-router";

import { AIConfigCard } from "@/routes/_protected.settings/-components/organization/ai-config-card";

export const Route = createFileRoute("/_protected/settings/organization/ai")({
  component: AIConfigPage,
});

function AIConfigPage() {
  return <AIConfigCard />;
}
