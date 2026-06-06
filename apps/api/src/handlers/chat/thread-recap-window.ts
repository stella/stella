export const RECAP_RECENT_MESSAGE_LIMIT = 24;

type RecapWindowMessage = {
  id: string;
};

type BuildRecapMessageWindowOptions<TMessage extends RecapWindowMessage> = {
  firstUserMessage: TMessage | null;
  recentMessagesDesc: readonly TMessage[];
};

export const buildRecapMessageWindow = <TMessage extends RecapWindowMessage>({
  firstUserMessage,
  recentMessagesDesc,
}: BuildRecapMessageWindowOptions<TMessage>): TMessage[] => {
  const recentMessages = recentMessagesDesc.toReversed();
  if (
    !firstUserMessage ||
    recentMessages.some((message) => message.id === firstUserMessage.id)
  ) {
    return recentMessages;
  }

  return [firstUserMessage, ...recentMessages];
};
