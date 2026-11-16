// Passive regression fixture for
// `no-raw-e2e-route-fulfill/no-raw-e2e-route-fulfill`.

declare const route: { fulfill: (options: object) => Promise<void> };
declare const respond: (route: object, reply: object) => Promise<void>;
declare const apiJson: (path: string, method: string, body: object) => object;

export const answerWithHandWrittenJson = async (): Promise<void> => {
  // MUST flag: the body is an untyped copy of the route's response.
  // oxlint-disable-next-line no-raw-e2e-route-fulfill/no-raw-e2e-route-fulfill -- fixture: a raw fulfill takes any JSON
  await route.fulfill({ json: { items: [], nextCursor: null } });
};

export const answerThroughOwner = async (): Promise<void> => {
  // expect-clean: no-raw-e2e-route-fulfill/no-raw-e2e-route-fulfill
  await respond(
    route,
    apiJson("v1/lists/:workspaceId", "get", { items: [], nextCursor: null }),
  );
};
