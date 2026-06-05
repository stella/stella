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
  // null when unknown — custom MCP connectors expose neither license nor
  // cost (the MCP spec carries no such metadata), so we omit rather than
  // fabricate. Curated entries always provide both.
  license: string | null;
  cost: CatalogueCost | null;
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
  /**
   * Whether the installed entry is currently enabled for use in chat.
   * Meaningful only when `installState === "installed"`. `null` when
   * the concept does not apply at the catalogue layer (today: MCP,
   * whose enabled state lives on the user connection row and is
   * surfaced via the MCP detail flow).
   */
  enabled: boolean | null;
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
  /** Version the server reports during `initialize`; null until connected. */
  serverVersion?: string | null | undefined;
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

/**
 * Binary "is this tool in use" check.
 *
 * Native tools stay catalogued even when the user removes them — the
 * "remove" path flips `enabled` to false instead of deleting a row.
 * From the user's standpoint they're not installed, so we surface
 * them as such (Přidat button instead of Odstranit).
 *
 * MCP and skill entries fully drop from `installState === "installed"`
 * on remove, so the simple state check is enough.
 */
export const isEffectivelyInstalled = (entry: CatalogueEntry): boolean => {
  if (entry.installState !== "installed") {
    return false;
  }
  if (entry.kind === "native-tool" && entry.enabled === false) {
    return false;
  }
  return true;
};
