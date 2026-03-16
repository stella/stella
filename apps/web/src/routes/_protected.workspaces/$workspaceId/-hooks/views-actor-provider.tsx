import { createActorProvider } from "@/hooks/create-actor-provider";

export const {
  ActorProvider: ViewsActorProvider,
  useSuspenseActor: useSuspenseViewsActor,
} = createActorProvider<"views">();
