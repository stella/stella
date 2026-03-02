import { create } from "zustand";

type MockMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type TemplateAssistantState = {
  active: boolean;
  templateId: string | null;
  templateName: string | null;
  selectedText: string | null;
  messages: MockMessage[];
  setActive: (active: boolean, id?: string, name?: string) => void;
  setSelectedText: (text: string | null) => void;
  addMessage: (msg: MockMessage) => void;
  clearMessages: () => void;
};

export const useTemplateAssistantStore = create<TemplateAssistantState>(
  (set) => ({
    active: false,
    templateId: null,
    templateName: null,
    selectedText: null,
    messages: [],
    setActive: (active, id, name) =>
      set({
        active,
        templateId: id ?? null,
        templateName: name ?? null,
        selectedText: null,
        messages: [],
      }),
    setSelectedText: (text) => set({ selectedText: text }),
    addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
    clearMessages: () => set({ messages: [] }),
  }),
);
