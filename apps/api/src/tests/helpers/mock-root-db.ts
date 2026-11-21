import { mock } from "bun:test";
import type { SQL } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

export const rootDbExecuteMock = mock(
  async (_query: SQL): Promise<Record<string, unknown>[]> =>
    await Promise.resolve([]),
);
const rootDbTransactionMock = mock(
  async (
    runTransaction: (tx: {
      execute: typeof rootDbExecuteMock;
    }) => Promise<unknown>,
  ) => await runTransaction({ execute: rootDbExecuteMock }),
);
const rootDbLimitMock = mock(
  async (): Promise<Record<string, unknown>[]> =>
    await Promise.resolve([{ searchableText: "Document content" }]),
);
const rootDbWhereMock = mock(() => ({ limit: rootDbLimitMock }));
const rootDbFromMock = mock(() => ({ where: rootDbWhereMock }));
export const rootDbSelectMock = mock(() => ({ from: rootDbFromMock }));
const rootDbCaseLawDecisionFindFirstMock = mock(
  async () => await Promise.resolve(null),
);
export const rootDbChatThreadFindFirstMock = mock(
  async (): Promise<Record<string, unknown> | null> =>
    await Promise.resolve(null),
);

export const rootDbTestDouble = asTestRaw<
  Pick<typeof rootDb, "execute" | "query" | "select" | "transaction">
>({
  execute: rootDbExecuteMock,
  transaction: rootDbTransactionMock,
  select: rootDbSelectMock,
  query: {
    caseLawDecisions: {
      findFirst: rootDbCaseLawDecisionFindFirstMock,
    },
    chatThreads: {
      findFirst: rootDbChatThreadFindFirstMock,
    },
  },
});

export const clearRootDbMocks = () => {
  rootDbExecuteMock.mockClear();
  rootDbExecuteMock.mockImplementation(
    async (_query: SQL): Promise<Record<string, unknown>[]> =>
      await Promise.resolve([]),
  );
  rootDbTransactionMock.mockClear();
  rootDbTransactionMock.mockImplementation(
    async (
      runTransaction: (tx: {
        execute: typeof rootDbExecuteMock;
      }) => Promise<unknown>,
    ) => await runTransaction({ execute: rootDbExecuteMock }),
  );
  rootDbSelectMock.mockClear();
  rootDbSelectMock.mockImplementation(() => ({ from: rootDbFromMock }));
  rootDbFromMock.mockClear();
  rootDbFromMock.mockImplementation(() => ({ where: rootDbWhereMock }));
  rootDbWhereMock.mockClear();
  rootDbWhereMock.mockImplementation(() => ({ limit: rootDbLimitMock }));
  rootDbLimitMock.mockClear();
  rootDbLimitMock.mockImplementation(
    async (): Promise<Record<string, unknown>[]> =>
      await Promise.resolve([{ searchableText: "Document content" }]),
  );
  rootDbCaseLawDecisionFindFirstMock.mockClear();
  rootDbCaseLawDecisionFindFirstMock.mockImplementation(
    async () => await Promise.resolve(null),
  );
  rootDbChatThreadFindFirstMock.mockClear();
  rootDbChatThreadFindFirstMock.mockImplementation(
    async () => await Promise.resolve(null),
  );
};
