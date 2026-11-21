import type { ReactNode } from "react";

type RecoverableErrorStatusProps = {
  message: ReactNode;
  actions: ReactNode;
  className: string;
  messageClassName?: string;
  icon?: ReactNode;
};

/** A failed read stays in place with the actions that can recover its surface. */
export const RecoverableErrorStatus = ({
  message,
  actions,
  className,
  messageClassName,
  icon,
}: RecoverableErrorStatusProps) => (
  <div className={className} role="alert">
    {icon}
    <p className={messageClassName}>{message}</p>
    {actions}
  </div>
);
