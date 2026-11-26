import { useQuery } from "@tanstack/react-query";

import { useObjectUrl } from "@stll/ui/effects/dom";
import { cn } from "@stll/ui/utils";

import { sessionSignInMapOptions } from "@/lib/account/session-sign-ins";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

type SignInMapProps = {
  sessionId: string;
  alt: string;
  /** The image's box; the placeholder keeps it while the map loads. */
  className: string;
};

/**
 * The map of where a session signed in. It is read only once this mounts
 * (a popover that opens, a review card), and a failed read leaves the
 * placeholder: the place's name beside the map still says where.
 */
export const SignInMap = ({ sessionId, alt, className }: SignInMapProps) => {
  const { id: userId } = useAuthenticatedUser();
  const view = queryView(
    useQuery(sessionSignInMapOptions({ userId, sessionId })),
  );
  useQueryViewError(view, "SignInMap:read");
  const src = useObjectUrl(view.type === "items" ? view.items : undefined);
  return src === undefined ? (
    <div aria-hidden="true" className={cn("bg-muted", className)} />
  ) : (
    <img alt={alt} className={className} decoding="async" src={src} />
  );
};
