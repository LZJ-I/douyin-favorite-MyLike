// Shared by likes and favorites. Page sizes remain platform hints, not guarantees.
export const collectionPolicy = {
  interval: 800,
  retry: 3000,
  pagesPerSegment: 24,
  segmentMs: 180_000,
  cooldown: 1500
}

export type ScanMode = 'normal' | 'fast'
export function scanPolicy(base: typeof collectionPolicy, mode: ScanMode): typeof collectionPolicy {
  return mode === 'fast'
    ? { ...base, interval: 350, pagesPerSegment: Number.MAX_SAFE_INTEGER, segmentMs: 600_000, cooldown: 750 }
    : base
}

export function scanNeedsRecycle(
  policy: typeof collectionPolicy,
  pages: number,
  elapsed: number,
  memoryMB = 0
) {
  return pages >= policy.pagesPerSegment || elapsed >= policy.segmentMs || (pages > 0 && memoryMB >= 512)
}
