import { create } from 'zustand';

export interface GatewayStatus {
  bound: boolean;
  port: number;
  error?: string;
  token?: string;
}

interface UiState {
  gateway: GatewayStatus | null;
  token: string | null;
  settingsOpen: boolean;
  setGateway: (g: GatewayStatus | null) => void;
  setToken: (t: string | null) => void;
  setSettingsOpen: (v: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  gateway: null,
  token: null,
  settingsOpen: false,

  setGateway: (gateway) => set({ gateway }),
  setToken: (token) => set({ token }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));
