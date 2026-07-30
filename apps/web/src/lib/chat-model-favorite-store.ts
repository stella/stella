import { create } from "zustand";
import { persist } from "zustand/middleware";

export const CHAT_MODEL_MODE = {
  standard: "standard",
  deepThinking: "deepThinking",
  fast: "fast",
} as const;

export type ChatModelMode =
  (typeof CHAT_MODEL_MODE)[keyof typeof CHAT_MODEL_MODE];

export type ChatModelFavorite =
  | { type: "mode"; mode: ChatModelMode }
  | { type: "model"; value: string };

type ChatModelFavoriteStore = {
  favoritesByOrganization: Record<string, ChatModelFavorite>;
  setFavorite: (
    organizationId: string,
    favorite: ChatModelFavorite | null,
  ) => void;
};

export const useChatModelFavoriteStore = create<ChatModelFavoriteStore>()(
  persist(
    (set) => ({
      favoritesByOrganization: {},
      setFavorite: (organizationId, favorite) => {
        set(({ favoritesByOrganization }) => {
          const nextFavorites = { ...favoritesByOrganization };
          if (favorite) {
            nextFavorites[organizationId] = favorite;
          } else {
            delete nextFavorites[organizationId];
          }
          return { favoritesByOrganization: nextFavorites };
        });
      },
    }),
    {
      name: "stella.chat.modelFavorite",
      version: 1,
      partialize: ({ favoritesByOrganization }) => ({
        favoritesByOrganization,
      }),
      migrate: (persisted) => ({
        favoritesByOrganization: readPersistedFavorites(persisted),
      }),
    },
  ),
);

const isChatModelMode = (value: unknown): value is ChatModelMode =>
  Object.values(CHAT_MODEL_MODE).some((mode) => mode === value);

const readPersistedFavorites = (
  persisted: unknown,
): Record<string, ChatModelFavorite> => {
  if (
    typeof persisted !== "object" ||
    persisted === null ||
    !("favoritesByOrganization" in persisted) ||
    typeof persisted.favoritesByOrganization !== "object" ||
    persisted.favoritesByOrganization === null
  ) {
    return {};
  }

  const favorites: Record<string, ChatModelFavorite> = {};
  for (const [organizationId, favorite] of Object.entries(
    persisted.favoritesByOrganization,
  )) {
    if (typeof favorite !== "object" || favorite === null) {
      continue;
    }
    if (
      "type" in favorite &&
      favorite.type === "mode" &&
      "mode" in favorite &&
      isChatModelMode(favorite.mode)
    ) {
      favorites[organizationId] = { type: "mode", mode: favorite.mode };
      continue;
    }
    if (
      "type" in favorite &&
      favorite.type === "model" &&
      "value" in favorite &&
      typeof favorite.value === "string" &&
      favorite.value.length > 0
    ) {
      favorites[organizationId] = { type: "model", value: favorite.value };
    }
  }
  return favorites;
};
