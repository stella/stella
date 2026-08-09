import { EmptyStateScreen } from "@/components/empty-state-screen";

const ChatsScreen = () => (
  <EmptyStateScreen
    description="Keep ongoing work close and continue from any device."
    emptyDescription="New conversations and recent threads will appear here."
    emptyTitle="No conversations yet"
    title="Chats"
  />
);

export default ChatsScreen;
