export type CatalogueKind = "skill" | "mcp" | "native-tool";
export type CatalogueCost = "free" | "paid";
export type CatalogueSetup = "none" | "account" | "api-key";
export type CatalogueInstallState = "installed" | "available" | "unavailable";

type CommonFields = {
  slug: string;
  displayName: string;
  description: string;
  author: string;
  authorUrl?: string | undefined;
  license: string;
  cost: CatalogueCost;
  setup: CatalogueSetup;
  homepage?: string | undefined;
  iconUrl?: string | undefined;
  /** Bundled icon — data URL (PNG/ICO base64) or inline SVG text. */
  icon: string | null;
  tags: string[];
  jurisdictions: string[];
  isRecommendedForOrg: boolean;
  installState: CatalogueInstallState;
  isLocked: boolean;
  /**
   * Per-installation identifiers used by the uninstall path. Populated
   * only when `installState === "installed"` and the kind matches; null
   * otherwise. Native-tools uninstall via `backendSlug` so they don't
   * need a separate handle here.
   */
  installedSkillId: string | null;
  installedConnectorSlug: string | null;
};

export type CatalogueSkill = CommonFields & {
  kind: "skill";
  entryPath: string;
  resources: string[];
};

export type CatalogueMcp = CommonFields & {
  kind: "mcp";
  url: string;
  authType: "none" | "bearer" | "oauth";
  oauthRequestedScopes: string[];
  allowedTools: string[];
  documentationUrl?: string | undefined;
  tokenHelpUrl?: string | undefined;
};

export type CatalogueNativeTool = CommonFields & {
  kind: "native-tool";
  backendSlug: string;
  pinned: boolean;
  url?: string | undefined;
  documentationUrl?: string | undefined;
};

export type CatalogueEntry =
  | CatalogueSkill
  | CatalogueMcp
  | CatalogueNativeTool;
