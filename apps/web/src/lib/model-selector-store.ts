import { create } from "zustand";

type ModelSelectorState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

export const useModelSelectorStore = create<ModelSelectorState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
