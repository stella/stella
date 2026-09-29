/** Entries of the catalogue's "Add custom" menu, in display order. */
const ADD_CUSTOM_ACTIONS = ["mcp", "skill-blueprint", "skill-import"] as const;

type AddCustomAction = (typeof ADD_CUSTOM_ACTIONS)[number];

type AddCustomPermissions = {
  /** Admin or owner: may add organization-wide connectors. */
  canManageCustomTools: boolean;
  /** Holds `agentSkill:create`: may create private skills. */
  canCreateSkills: boolean;
};

// Which permission unlocks each action. Team scope for a new skill is a
// separate choice inside the gallery and import dialog, gated on
// `canManageCustomTools` there.
const ADD_CUSTOM_ACTION_GATE = {
  mcp: "canManageCustomTools",
  "skill-blueprint": "canCreateSkills",
  "skill-import": "canCreateSkills",
} as const satisfies Record<AddCustomAction, keyof AddCustomPermissions>;

export const addCustomActions = (
  permissions: AddCustomPermissions,
): readonly AddCustomAction[] =>
  ADD_CUSTOM_ACTIONS.filter(
    (action) => permissions[ADD_CUSTOM_ACTION_GATE[action]],
  );
