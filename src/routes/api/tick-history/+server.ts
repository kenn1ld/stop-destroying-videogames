import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const DAILY_STATS_DB = path.resolve(STORAGE_DIR, 'daily-stats.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');

const TZ_OFFSET_MS = 2 * 60 * 60 * 1000;

interface DailyStat {
  date: string;
  signaturesCollected: number;
  startCount: number;
  endCount: number;
  dataPoints: number;
}

function getLocalStartOfDay(ts: number = Date.now()): number {
  const shifted = new Date(ts + TZ_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_MS;
}

async function loadDailyStats(): Promise<DailyStat[]> {
  try {
    const raw = await fs.readFile(DAILY_STATS_DB, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Error loading daily stats:', e);
    }
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
    const todayStart = getLocalStartOfDay(now);
    const clientETag = event.request.headers.get('if-none-match');
    let arr: { ts: number; count: number }[] = [];
    let dailyStats: DailyStat[] = [];

    // Try to load tick history
    try {
      const raw = await fs.readFile(DB, 'utf-8');
      const parsed = JSON.parse(raw);
      
      if (Array.isArray(parsed)) {
        // Validate and filter data
        arr = parsed
          .filter(t => t && typeof t.ts === 'number' && typeof t.count === 'number' && t.ts > 0 && t.count >= 0)
          .sort((a, b) => a.ts - b.ts);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error parsing tick history:', err);
        
        // Try backup
        try {
          const bkup = await fs.readFile(BACKUP_DB, 'utf-8');
          const parsed = JSON.parse(bkup);
          
          if (Array.isArray(parsed)) {
            arr = parsed
              .filter(t => t && typeof t.ts === 'number' && typeof t.count === 'number' && t.ts > 0 && t.count >= 0)
              .sort((a, b) => a.ts - b.ts);
            console.log('Served from backup');
          }
        } catch (be) {
          console.error('Backup read failed:', be);
          // arr remains empty
        }
      }
      // If ENOENT, arr remains empty (expected for new installations)
    }

    // Load daily stats
    dailyStats = await loadDailyStats();
    
    // Filter to only include today's data and recent history (last 7 days for rate calculations)
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    const filteredArr = arr.filter(t => t.ts >= sevenDaysAgo);
    
    // Generate ETag based on filtered data
    const etag = `"${filteredArr.length}-${filteredArr.length ? filteredArr[filteredArr.length-1].ts : 0}-${dailyStats.length}"`;

    if (clientETag === etag) {
      return new Response(null, { status: 304 });
    }

    const payload = { 
      ticks: filteredArr, 
      dailyStats,
      metadata: {
        todayStart,
        totalHistoricalTicks: arr.length,
        oldestTick: arr.length > 0 ? arr[0].ts : null,
        newestTick: arr.length > 0 ? arr[arr.length - 1].ts : null
      }
    };
    
    return new Response(JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, must-revalidate',
        'ETag': etag,
        'Last-Modified': new Date(now).toUTCString(),
        'X-Tick-Count': filteredArr.length.toString(),
        'X-Daily-Stats-Count': dailyStats.length.toString()
      }
    });
  } catch (error) {
    console.error('Error in GET handler:', error);
    return new Response(JSON.stringify({ ticks: [], dailyStats: [], metadata: {} }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
};