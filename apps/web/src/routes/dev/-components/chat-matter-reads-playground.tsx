import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import { ChatCitationsPlayground } from "@/routes/dev/-components/chat-citations-playground";
import {
  CHAT_MATTER_READS_CASSETTE,
  CHAT_MATTER_READS_VIEWER,
} from "@/routes/dev/-components/chat-matter-reads-cassette";

/**
 * A code step's matter reads as a signed-in member sees them: the viewer's
 * own matter list decides which found documents and matters open.
 */
export const ChatMatterReadsPlayground = () => (
  <AuthenticatedUserProvider user={CHAT_MATTER_READS_VIEWER}>
    <ChatCitationsPlayground cassette={CHAT_MATTER_READS_CASSETTE} />
  </AuthenticatedUserProvider>
);
