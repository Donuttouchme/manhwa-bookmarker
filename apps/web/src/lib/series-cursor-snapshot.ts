/** A serializable snapshot of per-source cursor positions for one series. */
export interface CursorSnapshot {
  seriesId: string;
  /** Decimal values are serialized as strings so the snapshot survives JSON round-trips. */
  cursors: Array<{ seriesSourceId: string; lastReadChapter: string }>;
}
