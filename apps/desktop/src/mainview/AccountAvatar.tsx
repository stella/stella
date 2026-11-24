import { Avatar, AvatarFallback, AvatarImage } from "@stll/ui/avatar";
import { StellaMark } from "@stll/ui/stella-mark";

import type { accountDisplay } from "./account-presentation";

/**
 * The linked account's picture, in the sidebar and on General. The initials
 * (or the stella mark before an account is linked) show while the picture
 * loads, when there is none, and when it fails to load.
 */
export const AccountAvatar = ({
  display,
}: {
  display: Pick<ReturnType<typeof accountDisplay>, "avatar" | "initials">;
}) => (
  <Avatar className="size-8 border">
    {display.avatar === null ? null : (
      <AvatarImage alt="" src={display.avatar} />
    )}
    <AvatarFallback className="text-xs">
      {display.initials ?? <StellaMark className="size-4" />}
    </AvatarFallback>
  </Avatar>
);
