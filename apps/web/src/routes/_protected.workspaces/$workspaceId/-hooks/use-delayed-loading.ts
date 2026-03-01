import { useEffect, useRef, useState } from "react";

export type UseDelayedLoadingProps = {
  isLoading: boolean;
  timeout: number;
};

export const useDelayedLoading = ({
  isLoading,
  timeout,
}: UseDelayedLoadingProps) => {
  const [isDelayedLoading, setIsDelayedLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isLoading) {
      setIsDelayedLoading(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const timeoutId = setTimeout(() => {
      setIsDelayedLoading(true);
    }, timeout);

    return () => {
      clearTimeout(timeoutId);
      timerRef.current = null;
    };
  }, [isLoading, timeout]);

  return isDelayedLoading;
};
