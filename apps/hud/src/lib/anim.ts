/** Global phase-lock for the dot animations (breathe 2.4s / blink 1.2s).
 *  CSS animations start counting from element mount, so later-mounted dots are
 *  naturally out of phase, and negative animation-delay semantics are unreliable.
 *  On mount we seek each dot to the current phase of the document timeline via
 *  the Web Animations API — identical periods then keep every dot locked in sync.
 *  Signature is React callback-ref compatible: ref={syncDotPhase}. */
export function syncDotPhase(el: HTMLElement | null): void {
  if (!el || typeof el.getAnimations !== 'function') return;
  for (const a of el.getAnimations()) {
    const name = (a as CSSAnimation).animationName;
    if (name !== 'breathe') continue;
    const dur = Number(a.effect?.getComputedTiming().duration) || 0;
    const now = Number(document.timeline.currentTime ?? 0);
    if (dur > 0) a.currentTime = now % dur;
  }
}
