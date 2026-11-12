import { Suspense, use } from "react";

import { Result } from "better-result";

import { useRevisedLoad } from "@/components/changes";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { readMatter } from "@/state/matter-detail";
import type { MatterDetail } from "@/state/matter-detail";

type NameProps = {
  /** The name the screen was opened with, shown until the matter is read. */
  readonly fallback: string;
  readonly matterId: string;
  readonly children: (name: string) => React.ReactNode;
};

/**
 * A matter's name as the matter itself has it, read when shown and again
 * whenever a matter changes here, so a rename shows in every title that
 * names the matter, not only in the screen it was made in.
 */
export const MatterName = ({ children, fallback, matterId }: NameProps) => {
  const { state } = useSession();
  return state.status === "signed-in" ? (
    <ReadName fallback={fallback} matterId={matterId} source={state.source}>
      {children}
    </ReadName>
  ) : (
    children(fallback)
  );
};

const ReadName = ({
  children,
  fallback,
  matterId,
  source,
}: NameProps & { readonly source: AccessTokenSource }) => {
  const [load] = useRevisedLoad(
    async () => await readMatter({ fetch, matterId, source }),
    ["matters"],
  );
  return (
    <Suspense fallback={children(fallback)}>
      <ReadNameOf fallback={fallback} load={load}>
        {children}
      </ReadNameOf>
    </Suspense>
  );
};

const ReadNameOf = ({
  children,
  fallback,
  load,
}: {
  readonly children: (name: string) => React.ReactNode;
  readonly fallback: string;
  readonly load: Promise<Result<MatterDetail, ApiError>>;
}) => {
  const read = use(load);
  // A matter that could not be read keeps the name it was opened with; its
  // list says why.
  return children(Result.isOk(read) ? read.value.name : fallback);
};
