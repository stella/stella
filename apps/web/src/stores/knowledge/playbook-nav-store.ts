import { createDetailNavStore } from "@/components/breadcrumbs/detail-nav-store";

// The playbooks list/editor is a view-state machine, not a $playbookId route,
// so the open playbook is published here for the breadcrumb to read. See the
// shared store factory for how it bridges component state to the breadcrumb.
export const usePlaybookNavStore = createDetailNavStore();
