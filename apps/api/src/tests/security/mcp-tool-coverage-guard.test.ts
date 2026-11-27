import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

// Registry-derived adversarial coverage guard for the static MCP tool surface.
// Iterates `ALL_MCP_TOOL_DEFINITIONS` directly so any new workspace/org-scoped
// MCP tool added without adversarial isolation coverage in
// `mcp-adversarial-isolation.db.test.ts` (or a typed, reviewed exemption with
// a closed reason enum) fails CI immediately.

const adversarialIsolationTestPath = path.resolve(
  import.meta.dir,
  "mcp-adversarial-isolation.db.test.ts",
);

/**
 * Closed set of reasons a non-public-law MCP tool is not yet directly
 * exercised by `mcp-adversarial-isolation.db.test.ts`.
 */
const MCP_TOOL_EXEMPTION_REASON = {
  /**
   * Account- or session-level tool with no cross-workspace/cross-org resource
   * target (e.g. onboarding preferences, feedback submission, web handoff, or
   * creating a brand-new organization).
   */
  accountLevel: "account-level",
  /**
   * Queries an external public register rather than tenant-owned database rows.
   */
  publicRegister: "public-register",
  /**
   * Delegated capability meta-tool that dispatches through the capability
   * executor registry rather than owning its own direct resource query.
   */
  capabilityGateway: "capability-gateway",
  /**
   * Tenant-scoped MCP tool whose isolation is covered by a dedicated security
   * suite outside `mcp-adversarial-isolation.db.test.ts`.
   */
  coveredInDedicatedSuite: "covered-in-dedicated-suite",
  /**
   * Pre-existing tenant-scoped tool not yet added to
   * `mcp-adversarial-isolation.db.test.ts`. Adding a case there forces removal
   * of this entry via the anti-staleness test below.
   */
  trackedPreExistingGap: "tracked-pre-existing-gap",
} as const;

type McpToolExemptionReason =
  (typeof MCP_TOOL_EXEMPTION_REASON)[keyof typeof MCP_TOOL_EXEMPTION_REASON];

const MCP_TOOL_COVERAGE_EXEMPTIONS: Record<string, McpToolExemptionReason> = {
  // Account- / session-level tools
  set_practice_jurisdictions: MCP_TOOL_EXEMPTION_REASON.accountLevel,
  create_organization: MCP_TOOL_EXEMPTION_REASON.accountLevel,
  prepare_feedback: MCP_TOOL_EXEMPTION_REASON.accountLevel,
  submit_feedback: MCP_TOOL_EXEMPTION_REASON.accountLevel,
  mint_web_handoff: MCP_TOOL_EXEMPTION_REASON.accountLevel,

  // External public register tools
  lookup_business_registry: MCP_TOOL_EXEMPTION_REASON.publicRegister,
  check_counterparty: MCP_TOOL_EXEMPTION_REASON.publicRegister,

  // Capability gateway meta-tools
  list_capabilities: MCP_TOOL_EXEMPTION_REASON.capabilityGateway,
  describe_capability: MCP_TOOL_EXEMPTION_REASON.capabilityGateway,
  read_capability: MCP_TOOL_EXEMPTION_REASON.capabilityGateway,
  write_capability: MCP_TOOL_EXEMPTION_REASON.capabilityGateway,

  // Covered by `billing-visibility.test.ts` and `billing-visibility.postgres.test.ts`
  resolve_rate: MCP_TOOL_EXEMPTION_REASON.coveredInDedicatedSuite,

  // Pre-existing tenant-scoped gaps awaiting cases in `mcp-adversarial-isolation.db.test.ts`
  search: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  fetch: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  search_across_matters: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  read_content_across_matters: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  read_contact: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  delete_matter: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  list_templates: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  fill_template: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  save_filled_template: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  create_template: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  configure_template_fields: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  preview_template_conditions: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  reformat_into_template: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  upload_document_version: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  open_document_version_upload: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  compare_documents: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  prepare_file_comparison: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  prepare_file_comparison_from_links:
    MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  open_file_comparison: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  run_playbook: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  list_reader_annotations: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  create_reader_annotation: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  update_reader_annotation: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  delete_reader_annotation: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  get_usage: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
  list_audit_log: MCP_TOOL_EXEMPTION_REASON.trackedPreExistingGap,
};

/**
 * A tool is public-law-only when every registered copy of its name carries the
 * public-law deployment gate and passthrough egress policy (so dual-audience
 * wire names such as `search` / `fetch`, which also have a tenant-scoped
 * default-audience definition, stay in scope for adversarial isolation).
 */
const uniqueToolNames = [
  ...new Set(ALL_MCP_TOOL_DEFINITIONS.map(({ name }) => name)),
].toSorted();

const isPublicLawOnlyTool = (toolName: string): boolean => {
  const definitions = ALL_MCP_TOOL_DEFINITIONS.filter(
    ({ name }) => name === toolName,
  );
  return (
    definitions.length > 0 &&
    definitions.every(
      (definition) =>
        definition.anonymized.exposure === "passthrough" &&
        "feature" in definition &&
        definition.feature === "FEATURE_PUBLIC_LAW",
    )
  );
};

const publicLawOnlyTools = new Set<string>(
  uniqueToolNames.filter((name) => isPublicLawOnlyTool(name)),
);

const tenantScopedTools = uniqueToolNames.filter(
  (name) => !publicLawOnlyTools.has(name),
);

const adversarialSuiteSource = readFileSync(
  adversarialIsolationTestPath,
  "utf-8",
);

const coveredTools = new Set<string>(
  uniqueToolNames.filter((name) =>
    adversarialSuiteSource.includes(JSON.stringify(name)),
  ),
);

const exemptedTools = Object.keys(MCP_TOOL_COVERAGE_EXEMPTIONS);

describe("MCP tool adversarial coverage guard", () => {
  test("every non-public-law MCP tool is exercised by the adversarial isolation suite or explicitly exempted", () => {
    const uncovered = tenantScopedTools.filter(
      (name) =>
        !coveredTools.has(name) && !(name in MCP_TOOL_COVERAGE_EXEMPTIONS),
    );
    expect(uncovered).toEqual([]);
  });

  test("no tool exercised by the adversarial isolation suite retains an exemption", () => {
    const stale = exemptedTools.filter((name) => coveredTools.has(name));
    expect(stale).toEqual([]);
  });

  test("every exemption names a registered non-public-law MCP tool", () => {
    const registeredSet = new Set<string>(uniqueToolNames);
    const invalid = exemptedTools.filter(
      (name) => !registeredSet.has(name) || publicLawOnlyTools.has(name),
    );
    expect(invalid).toEqual([]);
  });
});
