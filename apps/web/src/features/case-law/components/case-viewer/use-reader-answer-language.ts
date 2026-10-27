import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import { authClient } from "@/lib/auth-client";
import { sessionOptions } from "@/lib/auth-queries";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toAuthClientError } from "@/lib/errors/auth";
import { queryView, queryViewError } from "@/lib/query-view.logic";

/** Account-owned answer preference; session observers share persisted changes. */
export const useReaderAnswerLanguage = (
  documentLanguage: string | undefined,
) => {
  const user = useMaybeAuthenticatedUser();
  const queryClient = useQueryClient();
  const session = queryView(useQuery({ ...sessionOptions, enabled: false }));
  const sessionUser =
    session.type === "items" ? session.items?.user : undefined;
  const languagePreference =
    (sessionUser?.id === user?.id
      ? sessionUser?.readerAnswerLanguage
      : undefined) ??
    user?.readerAnswerLanguage ??
    "document";
  const locale =
    languagePreference === "document" ? documentLanguage : languagePreference;
  const [isSavingLanguage, setIsSavingLanguage] = useState(false);
  const saveLanguage = async (language: string) => {
    if (isSavingLanguage) {
      return Result.ok({ status: "pending" } as const);
    }
    if (user === null) {
      panic("Saving a reader language requires an authenticated user");
    }
    const ownerId = user.id;
    setIsSavingLanguage(true);
    try {
      const { error } = await authClient.updateUser({
        readerAnswerLanguage: language,
      });
      if (error) {
        return Result.err(toAuthClientError(error));
      }
      const currentSession = queryClient.getQueryData(sessionOptions.queryKey);
      if (currentSession?.user.id !== ownerId) {
        return Result.ok({ status: "superseded" } as const);
      }
      queryClient.setQueryData(sessionOptions.queryKey, (current) => {
        if (current?.user.id !== ownerId) {
          return current;
        }
        return {
          ...current,
          user: { ...current.user, readerAnswerLanguage: language },
        };
      });
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
      const savedLocale = language === "document" ? documentLanguage : language;
      return Result.ok({ status: "saved", locale: savedLocale } as const);
    } finally {
      setIsSavingLanguage(false);
    }
  };
  return {
    languagePreference,
    locale,
    isSavingLanguage,
    saveLanguage,
    error: queryViewError(session),
  };
};
