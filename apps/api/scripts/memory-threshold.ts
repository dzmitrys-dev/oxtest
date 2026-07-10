export const RSS_THRESHOLD_MB = 240;
const BYTES_PER_MB = 1024 * 1024;

export function assertRssWithinThreshold(rawRssBytes: number): void {
  const thresholdBytes = RSS_THRESHOLD_MB * BYTES_PER_MB;
  if (rawRssBytes > thresholdBytes) {
    const peakRssMb = Number((rawRssBytes / BYTES_PER_MB).toFixed(1));
    throw new Error(`Peak RSS ${peakRssMb}MB exceeds ${RSS_THRESHOLD_MB}MB threshold`);
  }
}
