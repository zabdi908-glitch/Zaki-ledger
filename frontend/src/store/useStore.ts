import { create } from 'zustand';

interface AppState {
  sidebarCollapsed: boolean;
  toast: string | null;
  toastVisible: boolean;
  user: { id: string; email?: string } | null;
  toggleSidebar: () => void;
  showToast: (msg: string) => void;
  hideToast: () => void;
  setUser: (user: { id: string; email?: string } | null) => void;
}

export const useStore = create<AppState>((set) => ({
  sidebarCollapsed: false,
  toast: null,
  toastVisible: false,
  user: null,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  showToast: (msg) => {
    set({ toast: msg, toastVisible: true });
    setTimeout(() => set({ toastVisible: false }), 2500);
    setTimeout(() => set({ toast: null }), 2800);
  },
  hideToast: () => set({ toastVisible: false, toast: null }),
  setUser: (user) => set({ user }),
}));
