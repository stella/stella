import { mock } from "bun:test";

export const rootDbExecuteMock = mock(
  async (_query: unknown) => await Promise.resolve([]),
);
export const rootDbCaseLawDecisionFindFirstMock = mock(
  async () => await Promise.resolve(null),
);

void mock.module("@/api/db/root", () => ({
  db: {
    execute: rootDbExecuteMock,
    query: {
      caseLawDecisions: {
        findFirst: rootDbCaseLawDecisionFindFirstMock,
      },
    },
  },
}));

export const clearRootDbMocks = () => {
  rootDbExecuteMock.mockClear();
  rootDbCaseLawDecisionFindFirstMock.mockClear();
};
