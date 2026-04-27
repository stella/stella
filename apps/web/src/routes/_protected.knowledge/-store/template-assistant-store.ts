import { create } from "zustand";

type MockMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type TemplateAssistantSession =
  | { status: "inactive" }
  | {
      status: "active";
      templateId: string;
      templateName: string;
      selectedText: string | null;
      messages: MockMessage[];
    };

type TemplateAssistantState = {
  session: TemplateAssistantSession;
  openForTemplate: (template: { id: string; name: string }) => void;
  close: () => void;
  setSelectedText: (text: string | null) => void;
  addMessage: (msg: MockMessage) => void;
  clearMessages: () => void;
};

export const useTemplateAssistantStore = create<TemplateAssistantState>(
  (set) => ({
    session: { status: "inactive" },
    openForTemplate: (template) =>
      set({
        session: {
          status: "active",
          templateId: template.id,
          templateName: template.name,
          selectedText: null,
          messages: [],
        },
      }),
    close: () => set({ session: { status: "inactive" } }),
    setSelectedText: (text) =>
      set((state) => {
        if (state.session.status !== "active") {
          return state;
        }

        return {
          session: {
            ...state.session,
            selectedText: text,
          },
        };
      }),
    addMessage: (msg) =>
      set((state) => {
        if (state.session.status !== "active") {
          return state;
        }

        return {
          session: {
            ...state.session,
            messages: [...state.session.messages, msg],
          },
        };
      }),
    clearMessages: () =>
      set((state) => {
        if (state.session.status !== "active") {
          return state;
        }

        return {
          session: {
            ...state.session,
            messages: [],
          },
        };
      }),
  }),
);
