import type { ReactNode } from "react";

export const HandoffShell = ({
  title,
  account,
  confirm,
  cancel,
}: {
  title: ReactNode;
  account: ReactNode;
  confirm: ReactNode;
  cancel: ReactNode;
}) => (
  <div className="flex w-full max-w-md flex-col gap-4">
    <h1 className="text-xl font-semibold">{title}</h1>
    <p>{account}</p>
    <div className="flex flex-wrap gap-2">
      {confirm}
      {cancel}
    </div>
  </div>
);
