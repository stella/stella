export const FOLIO_COLLAB_TRANSITION_IDENTITIES = {
  FOLIO_COLLAB_SEED_TRANSITIONS: {
    tableName: "folioCollabRooms",
    key: "id",
    scope: ["workspaceId"],
    stateColumn: "seedState",
  },
} as const;
