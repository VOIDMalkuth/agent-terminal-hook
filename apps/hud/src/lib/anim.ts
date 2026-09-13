import { useEffect, useRef } from 'react';

/** Global phase-lock for the dot breathe animation (2.4s). CSS animations count from the
 *  moment they (re)start, so a dot is only in phase with its peers if every restart is
 *  seeked back onto the document timeline. Restarts happen on mount and on class swaps
 *  that kill breathe (done/stale use animation:none). A commit-time seek is unreliable —
 *  a freshly attached animation can be play-pending and override the seek — so run it
 *  from the next animation frame, when the animation is live with a resolved startTime.
 *  Seeking a never-restarted animation to the global phase is a visual no-op. */
export function syncDotPhase(el: HTMLElement | null): void {
  if (!el || typeof el.getAnimations !== 'function') return;
  for (const a of el.getAnimations()) {
    if ((a as CSSAnimation).animationName !== 'breathe') continue;
    const dur = Number(a.effect?.getComputedTiming().duration) || 0;
    const now = Number(document.timeline.currentTime ?? 0);
    if (dur > 0) a.currentTime = now % dur;
  }
}

/** Ref for a status dot: re-seeks the breathe phase after paint whenever the dot's
 *  class changes (class = animation identity: mount, done/stale swaps, state colors). */
export function useDotPhase(cls: string) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => syncDotPhase(ref.current));
    return () => cancelAnimationFrame(id);
  }, [cls]);
  return ref;
}
