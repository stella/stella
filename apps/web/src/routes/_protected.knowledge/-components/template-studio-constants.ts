import { getRouteApi } from "@tanstack/react-router";

export const protectedRouteApi = getRouteApi("/_protected");

export const TEMPLATE_STUDIO_VIEW = "template-studio";
export const TEMPLATES_ROUTE_ID = "/_protected/knowledge/templates";
export const templateStudioTabId = (templateId: string) =>
  `template-studio:${templateId}`;
