const STORAGE_KEY = 'cloud-relay:session-id';

/**
 * Anonymous visitor ID. Every upload is tagged with it, and the gallery only
 * shows images for this ID, so visitors never see strangers' photos.
 * Falls back to a per-tab ID if storage is unavailable (private mode, etc.).
 */
export function getSessionId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}
