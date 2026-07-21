import { EmptyStateScreen } from "@/components/empty-state-screen";

export default function ChatsScreen() {
  return (
    <EmptyStateScreen
      description="Keep ongoing work close and continue from any device."
      emptyDescription="New conversations and recent threads will appear here."
      emptyTitle="No conversations yet"
      title="Chats"
    />
  );
}
