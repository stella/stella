import { useTranslations } from "use-intl";

import { timerErrorKey } from "@/features/time-timers/timer.logic";

export const TimerError = ({ error }: { error: Error | null }) => {
  const t = useTranslations();
  if (error === null) {
    return null;
  }
  const key = timerErrorKey(error);
  return (
    <p className="text-destructive text-sm" role="alert">
      {key === null ? error.message : t(key)}
    </p>
  );
};
