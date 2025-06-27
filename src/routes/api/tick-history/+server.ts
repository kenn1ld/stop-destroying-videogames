// ===== /api/tick-history/+server.ts (GET Handler) =====
import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

// Use Railway's persistent volume with fallback for development
const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const DAILY_STATS_DB = path.resolve(STORAGE_DIR, 'daily-stats.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');

interface DailyStat {
  date: string; // YYYY-MM-DD local (UTC+2)
  signaturesCollected: number;
  startCount: number;
  endCount: number;
  dataPoints: number;
}

async function loadDailyStats(): Promise<DailyStat[]> {
  try {
    const raw = await fs.readFile(DAILY_STATS_DB, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Error loading daily stats:', e);
    return [];
  }
}

async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (e) {
    console.error('Failed to create storage dir:', e);
  }
}

export const GET: RequestHandler = async (event) => {
  await ensureStorageDir();
  try {
    const now = Date.now();
    const clientETag = event.request.headers.get('if-none-match');
    let arr: { ts: number; count: number }[] = [];
    let dailyStats: DailyStat[] = [];

    try {
      const raw = await fs.readFile(DB, 'utf-8');
      arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr = arr
          .filter(t => t && typeof t.ts === 'number' && typeof t.count === 'number' && t.ts > 0 && t.count >= 0)
          .sort((a, b) => a.ts - b.ts);
      } else {
        arr = [];
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error parsing tick history:', err);
        try {
          const bkup = await fs.readFile(BACKUP_DB, 'utf-8');
          arr = JSON.parse(bkup);
          console.log('Served from backup');
        } catch (be) {
          console.error('Backup read failed:', be);
          arr = [];
        }
      }
      arr = [];
    }

    dailyStats = await loadDailyStats();
    const etag = `"${arr.length}-${arr.length ? arr[arr.length-1].ts : 0}-${dailyStats.length}"`;

    if (clientETag === etag) {
      return new Response(null, { status: 304 });
    }

    const payload = { ticks: arr, dailyStats };
    return new Response(JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, must-revalidate',
        'ETag': etag,
        'Last-Modified': new Date(now).toUTCString(),
        'X-Tick-Count': arr.length.toString(),
        'X-Daily-Stats-Count': dailyStats.length.toString()
      }
    });
  } catch (error) {
    console.error('Error reading data:', error);
    return new Response(JSON.stringify({ ticks: [], dailyStats: [] }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
};
