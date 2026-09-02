import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../lib/tauri';
import { handleAthMessage } from '../lib/pipeline';
import { useUi, type GatewayStatus } from '../store/ui';

/** Subscribe to the Rust backend: ATH event stream + gateway status, then query gateway info once */
export function useAthEvents(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: Array<() => void> = [];
    // StrictMode double-mount: cleanup may run before listen() resolves — the
    // pending listener must be unregistered via the cancelled branch, or events
    // get handled twice (same pattern as useWindowPersistence)
    let cancelled = false;
    const track = (p: Promise<() => void>) => {
      void p.then((un) => {
        if (cancelled) un();
        else unlisteners.push(un);
      });
    };

    track(listen<unknown>('ath-event', (e) => handleAthMessage(e.payload)));

    track(
      listen<Partial<GatewayStatus>>('ath-gateway-status', (e) => {
        const cur = useUi.getState().gateway;
        useUi.getState().setGateway({ bound: false, port: 7301, ...cur, ...e.payload });
      }),
    );

    void invoke<GatewayStatus | null>('gateway_info')
      .then((info) => {
        if (cancelled || !info) return;
        useUi.getState().setGateway(info);
        if (info.token) useUi.getState().setToken(info.token);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, []);
}
