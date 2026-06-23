import { createDetailNavStore } from "@/components/breadcrumbs/detail-nav-store";

// The templates list/detail is a view-state machine, not a $templateId route,
// so the open template is published here for the breadcrumb to read. See the
// shared store factory for how it bridges component state to the breadcrumb.
export const useTemplateNavStore = createDetailNavStore();
