export function relTime(at: number, now: number): string {
  const d = Math.max(0, now - at);
  // "刚刚" under 5s, "<1m" from 5s to 1min, then plain Nm (no seconds/hours granularity)
  if (d < 5_000) return '刚刚';
  if (d < 60_000) return '<1m';
  return `${Math.floor(d / 60_000)}m`;
}
