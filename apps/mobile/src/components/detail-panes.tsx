import { useHeaderHeight } from "expo-router/react-navigation";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { useTranslations } from "use-intl";

import { useRevision } from "@/components/changes";
import { ChatThreadView } from "@/components/chat-thread-view";
import { screenStyles } from "@/components/empty-state-screen";
import { EntityDetailSheet } from "@/components/entity-detail-sheet";
import { MatterEntities } from "@/components/matter-entities";
import { Pane } from "@/components/pane";
import type {
  MatterSelection,
  TaskSelection,
  ThreadSelection,
} from "@/components/selection";
import { useSession } from "@/connection/session-provider";

/**
 * The thread selected in the chats' list, beside it: its messages and the
 * message box, which rides above the keyboard as on the thread's own screen.
 */
export const ThreadPane = ({ thread }: { thread: ThreadSelection }) => {
  const t = useTranslations("chat");
  const headerHeight = useHeaderHeight();
  const { state } = useSession();

  return (
    <Pane title={thread.title ?? t("threadTitle")}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={headerHeight}
        style={screenStyles.screen}
      >
        {state.status === "signed-in" ? (
          <ChatThreadView
            fresh={thread.fresh === true}
            matterId={thread.matterId}
            source={state.source}
            threadId={thread.threadId}
          />
        ) : null}
      </KeyboardAvoidingView>
    </Pane>
  );
};

/** The matter selected in the matters' list, beside it: its documents and tasks. */
export const MatterPane = ({ matter }: { matter: MatterSelection }) => {
  const { state } = useSession();
  const revision = useRevision("documents", "tasks");

  return (
    <Pane title={matter.name}>
      {state.status === "signed-in" ? (
        <MatterEntities
          key={revision}
          source={state.source}
          workspaceId={matter.workspaceId}
        />
      ) : null}
    </Pane>
  );
};

/** The task selected in the tasks' list, beside it, as its sheet shows it. */
export const TaskPane = ({ task }: { task: TaskSelection }) => {
  const { state } = useSession();
  const headerHeight = useHeaderHeight();

  return state.status === "signed-in" ? (
    <View className="flex-1" style={{ paddingTop: headerHeight }}>
      <EntityDetailSheet
        entityId={task.entityId}
        source={state.source}
        workspaceId={task.workspaceId}
      />
    </View>
  ) : null;
};
