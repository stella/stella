declare module "@/api/lib/api-handlers" {
  export const createSafePublicHandler: <T>(
    options: Record<string, never>,
    execute: () => T,
  ) => T;
  export const createSafeHandler: <T>(
    options: Record<string, never>,
    execute: (context: {
      workspaceId: string & { readonly __kind: "workspace" };
    }) => T,
  ) => T;
}

declare module "@/api/lib/case-law/language-alternates" {
  export const readPublicDecisionLanguageAlternatesByGroup: () => Promise<void>;
}

declare module "@/api/lib/limits" {
  export const LIMITS: { readonly contactsPageSizeDefault: number };
}
