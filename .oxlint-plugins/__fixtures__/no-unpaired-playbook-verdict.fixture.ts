// Passive regression fixture for
// `no-unpaired-playbook-verdict/no-unpaired-playbook-verdict`.
//
// The rule bans discriminating on a property's `tool.type` outside the module
// that owns the pairing, so a surface cannot rediscover the rule and render a
// verdict apart from the value it grades. If the rule regresses, the disable
// directive below goes unused and
// `--report-unused-disable-directives-severity=error` fails CI.
//
// The variants underneath must NOT report. They matter: a first draft of this
// rule matched the bare string and fired on all of them, which would have
// pushed people to suppress it rather than use the helper.

declare const property: { tool: { type: string } };
declare const block: { kind: string };

// oxlint-disable-next-line no-unpaired-playbook-verdict/no-unpaired-playbook-verdict
export const handRolled = property.tool.type === "playbook-verdict";

/** A justification block kind: an unrelated concept sharing the name. */
export const blockKind = block.kind === "playbook-verdict";

/** Type-level narrowing is how the variant is meant to be excluded. */
export type Gradable = Exclude<
  { type: "playbook-verdict" } | { type: "ai-model" },
  { type: "playbook-verdict" }
>;

/** Constructing the variant is not discriminating on it. */
export const constructed = { type: "playbook-verdict" } as const;

/** A different tool on the same discriminant must not report. */
export const otherTool = property.tool.type === "ai-model";
