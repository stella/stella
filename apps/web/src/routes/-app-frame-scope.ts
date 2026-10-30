export const APP_FRAME_SCOPE = {
  none: "none",
  member: "member",
  knowledge: "knowledge",
} as const;

export type AppFrameScope =
  (typeof APP_FRAME_SCOPE)[keyof typeof APP_FRAME_SCOPE];

export const PROVIDER_SCOPE = {
  auth: "auth",
  ai: "ai",
  composer: "composer",
} as const;
export type ProviderScope =
  (typeof PROVIDER_SCOPE)[keyof typeof PROVIDER_SCOPE];
export const MEMBER_PROVIDER_SCOPES = Object.values(PROVIDER_SCOPE);

export const matchedAppFrameScope = (
  matches: readonly { staticData: { appFrame?: AppFrameScope } }[],
): AppFrameScope => {
  for (const {
    staticData: { appFrame },
  } of matches.toReversed()) {
    if (appFrame !== undefined) {
      return appFrame;
    }
  }
  return APP_FRAME_SCOPE.none;
};
