import { API_URL } from '@/lib/api';

export interface CreatorSummary {
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  donationGoal: number | null;
  // ISO timestamp of the last profile change; used for JSON-LD dateModified
  // so crawlers see a stable value instead of the render time (#459).
  updatedAt: string;
}

type CreatorSummaryResult =
  | { status: 'found'; creator: CreatorSummary }
  | { status: 'not-found' | 'unavailable'; creator: null };

// Server-side lookup for the page, metadata, and preview images.
// The client component does its own fetch (with live SSE updates) for the
// actual page. Next dedupes/caches this fetch across metadata and image routes.
export async function fetchCreatorSummary(username: string): Promise<CreatorSummaryResult> {
  try {
    const res = await fetch(`${API_URL}/api/creators/${encodeURIComponent(username)}`, {
      next: { revalidate: 60 },
    });
    if (res.status === 404) return { status: 'not-found', creator: null };
    if (!res.ok) return { status: 'unavailable', creator: null };
    const creator: CreatorSummary = await res.json();
    return { status: 'found', creator };
  } catch {
    return { status: 'unavailable', creator: null };
  }
}
