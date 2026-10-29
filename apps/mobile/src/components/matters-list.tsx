import { Suspense, useState, useTransition } from "react";

import { Result } from "better-result";

import { Loader } from "@stll/ui/loader";

import { useRevision } from "@/components/changes";
import { LoadedMatters } from "@/components/loaded-matters";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import type { MattersLoad } from "@/state/matters";

/**
 * Loads the signed-in person's matters once, again on every pull to
 * refresh, and afresh after a matter is opened from the header's "+".
 */
export const MattersList = ({ source }: { source: AccessTokenSource }) => {
  const revision = useRevision("matters");
  return <MattersLoader key={revision} source={source} />;
};

const MattersLoader = ({ source }: { source: AccessTokenSource }) => {
  const { end } = useSession();
  // A session the server ended sends the person back to sign in, from the
  // load itself rather than from a render.
  const loadMatters = async (): Promise<MattersLoad> => {
    const result = await listMatters({ fetch, source });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return { loadedAt: epochMilliseconds(), result };
  };
  const [load, setLoad] = useState(loadMatters);
  const [refreshing, startRefresh] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadMatters());
    });
  };

  return (
    <Suspense fallback={<Loader className="flex-1" />}>
      <LoadedMatters load={load} onReload={reload} refreshing={refreshing} />
    </Suspense>
  );
};
