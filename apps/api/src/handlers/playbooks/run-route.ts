import autoRunPlaybooks from "@/api/handlers/playbooks/applicable/run";
import runPlaybook from "@/api/handlers/playbooks/run";
import { routes } from "@/api/http/route";

// Running a playbook is workspace-scoped (it materializes columns where the
// documents live) even though the definition it reads is org-scoped. Mounted
// under `/workspaces/:workspaceId/playbooks` so workspace access is validated
// from the path, separate from the org-scoped definition CRUD in `routes.ts`.
export const playbookRunsRoute = routes(
  {
    "/:playbookId/run": { POST: runPlaybook },
    "/auto-run": { POST: autoRunPlaybooks },
  },
  { prefix: "/workspaces/:workspaceId/playbooks" },
);
