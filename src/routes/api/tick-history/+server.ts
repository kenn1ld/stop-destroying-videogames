import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const DAILY_STATS_DB = path.resolve(STORAGE_DIR, 'daily-stats.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');

const TZ_OFFSET_MS = 2 * 60 * 60 * 1000;
const RETENTION_MS = 26 * 60 * 60 * 1000; // Only keep 48 hours

interface DailyStat {
  date: string;
  signaturesCollected: number;
  startCount: number;
  endCount: number;
  dataPoints: number;
}

interface Tick {
  ts: number;
  count: number;
}

function getLocalStartOfDay(ts: number = Date.now()): number {
  const shifted = new Date(ts + TZ_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_MS;
}

let storageDirEnsured = false;
async function ensureStorageDir(): Promise<void> {
  if (storageDirEnsured) return;
  
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    storageDirEnsured = true;
  } catch (e) {
    console.error('Failed to create storage dir:', e);
  }
}

async function loadDailyStats(): Promise<DailyStat[]> {
  try {
    const raw = await fs.readFile(DAILY_STATS_DB, 'utf-8');
    const parsed = JSON.parse(raw);
    
    if (Array.isArray(parsed)) {
      return parsed.filter(stat => 
        stat && 
        typeof stat.date === 'string' && 
        typeof stat.signaturesCollected === 'number' &&
        typeof stat.startCount === 'number' &&
        typeof stat.endCount === 'number' &&
        typeof stat.dataPoints === 'number'
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Error loading daily stats:', e);
    }
  }
  return [];
}

async function loadAndFilterTicks(): Promise<{
  ticks: Tick[];
  metadata: {
    totalTicks: number;
    oldestTick: number | null;
    newestTick: number | null;
  };
}> {
  const now = Date.now();
  const cutoffTime = now - RETENTION_MS;
  
  let validTicks: Tick[] = [];
  let totalTicks = 0;
  let oldestTick: number | null = null;
  let newestTick: number | null = null;

  try {
    const raw = await fs.readFile(DB, 'utf-8');
    const parsed = JSON.parse(raw);
    
    if (Array.isArray(parsed)) {
      for (const tick of parsed) {
        if (tick && 
            typeof tick.ts === 'number' && 
            typeof tick.count === 'number' && 
            tick.ts > 0 && 
            tick.count >= 0 &&
            Number.isFinite(tick.ts) && 
            Number.isFinite(tick.count) &&
            tick.ts > cutoffTime) {
          
          validTicks.push(tick);
          totalTicks++;
          
          if (oldestTick === null || tick.ts < oldestTick) {
            oldestTick = tick.ts;
          }
          if (newestTick === null || tick.ts > newestTick) {
            newestTick = tick.ts;
          }
        }
      }
      
      validTicks.sort((a, b) => a.ts - b.ts);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Error loading ticks:', err);
      
      try {
        const backup = await fs.readFile(BACKUP_DB, 'utf-8');
        const parsed = JSON.parse(backup);
        
        if (Array.isArray(parsed)) {
          for (const tick of parsed) {
            if (tick && 
                typeof tick.ts === 'number' && 
                typeof tick.count === 'number' && 
                tick.ts > 0 && 
                tick.count >= 0 &&
                Number.isFinite(tick.ts) && 
                Number.isFinite(tick.count) &&
                tick.ts > cutoffTime) {
              
              validTicks.push(tick);
              totalTicks++;
              
              if (oldestTick === null || tick.ts < oldestTick) {
                oldestTick = tick.ts;
              }
              if (newestTick === null || tick.ts > newestTick) {
                newestTick = tick.ts;
              }
            }
          }
          
          validTicks.sort((a, b) => a.ts - b.ts);
          console.log('Served from backup (48h retention)');
        }
      } catch (be) {
        console.error('Backup read failed:', be);
      }
    }
  }

  return {
    ticks: validTicks,
    metadata: {
      totalTicks,
      oldestTick,
      newestTick
    }
  };
}

export const GET: RequestHandler = async (event) => {
  await ensureStorageDir();
  
  try {
    const now = Date.now();
    const todayStart = getLocalStartOfDay(now);
    const clientETag = event.request.headers.get('if-none-match');

    const [tickData, dailyStats] = await Promise.all([
      loadAndFilterTicks(),
      loadDailyStats()
    ]);

    const { ticks, metadata } = tickData;
    
    const ticksLength = ticks.length;
    const lastTickTs = ticksLength > 0 ? ticks[ticksLength - 1].ts : 0;
    const dailyStatsLength = dailyStats.length;
    const etag = `"${ticksLength}-${lastTickTs}-${dailyStatsLength}"`;

    if (clientETag === etag) {
      return new Response(null, { status: 304 });
    }

    const payload = { 
      ticks, 
      dailyStats,
      metadata: {
        todayStart,
        totalTicks: metadata.totalTicks,
        oldestTick: metadata.oldestTick,
        newestTick: metadata.newestTick,
        retentionHours: 48
      }
    };
    
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
      'Last-Modified': new Date(now).toUTCString(),
      'X-Tick-Count': ticksLength.toString(),
      'X-Retention': '48h'
    };
    
    return new Response(JSON.stringify(payload), { headers });
    
  } catch (error) {
    console.error('Error in GET handler:', error);
    
    const errorPayload = { 
      ticks: [], 
      dailyStats: [], 
      metadata: {
        todayStart: getLocalStartOfDay(),
        totalTicks: 0,
        oldestTick: null,
        newestTick: null,
        retentionHours: 48
      }
    };
    
    return new Response(JSON.stringify(errorPayload), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
};