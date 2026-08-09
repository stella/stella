import { EmptyStateScreen } from "@/components/empty-state-screen";

const TasksScreen = () => (
  <EmptyStateScreen
    description="See what needs attention without opening the full workspace."
    emptyDescription="Assigned and upcoming work will appear here."
    emptyTitle="No open tasks"
    title="Tasks"
  />
);

export default TasksScreen;
