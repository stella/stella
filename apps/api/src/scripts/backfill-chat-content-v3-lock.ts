import type { OnlineMigrationConnection } from "../db/online-migration-connection";
import {
  acquireOnlineMigrationLock,
  releaseOnlineMigrationLock,
} from "../db/online-migrations";

export const withChatContentV3MigrationLock = async <T>(
  connection: OnlineMigrationConnection,
  work: () => Promise<T>,
): Promise<T> => {
  // The gate terminates this session when it cannot cancel its own work; the
  // lock went with the session, and an unlock there would mask why.
  let sessionStatus: "active" | "terminated" = "active";
  const sessionIsActive = () => sessionStatus === "active";
  const terminate = connection.terminate;
  if (terminate) {
    connection.terminate = async () => {
      sessionStatus = "terminated";
      await terminate();
    };
  }

  await acquireOnlineMigrationLock(connection);
  try {
    return await work();
  } finally {
    if (sessionIsActive()) {
      await releaseOnlineMigrationLock(connection);
    }
  }
};
