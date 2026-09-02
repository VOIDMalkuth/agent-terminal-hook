import { parseAthMessage } from '@ath/protocol';
import { useSessions } from '../store/sessions';

/**
 * Single entry point for ATH events: real events forwarded by the Tauri backend
 * and the mock script share this pipeline. The protocol has no action channel
 * (the HUD is display-only); malformed/unknown messages are dropped silently
 * (dev builds log a warning).
 */
export function handleAthMessage(raw: unknown): void {
  const msg = parseAthMessage(raw);
  if (!msg) {
    if (import.meta.env.DEV) console.warn('[ath] dropping invalid ATH message:', raw);
    return;
  }
  useSessions.getState().apply(msg);
}
