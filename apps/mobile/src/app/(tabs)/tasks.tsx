import { EmptyStateScreen } from "@/components/empty-state-screen";

export default function TasksScreen() {
  return (
    <EmptyStateScreen
      description="See what needs attention without opening the full workspace."
      emptyDescription="Assigned and upcoming work will appear here."
      emptyTitle="No open tasks"
      title="Tasks"
    />
  );
}
