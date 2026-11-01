const SEARCH_ACTIVITY_ACTOR: unique symbol = Symbol(
  "stella.searchActivityActor",
);

export type WorkspaceSearchActivityActor = {
  readonly type: "workspace-search-activity";
  readonly [SEARCH_ACTIVITY_ACTOR]: true;
};

/** The search bookkeeping owner alone may mint this private scope actor. */
export const createWorkspaceSearchActivityActor =
  (): WorkspaceSearchActivityActor => ({
    type: "workspace-search-activity",
    [SEARCH_ACTIVITY_ACTOR]: true,
  });
