import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const DAILY_STATS_DB = path.resolve(STORAGE_DIR, 'daily-stats.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');

const TZ_OFFSET_MS = 2 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

// Pre-calculate timezone offset function
function getLocalStartOfDay(ts: number = Date.now()): number {
  const shifted = new Date(ts + TZ_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_MS;
}

// Optimized tick validation and filtering function
function isValidTick(tick: any, cutoffTime: number): tick is Tick {
  return tick && 
         typeof tick.ts === 'number' && 
         typeof tick.count === 'number' && 
         tick.ts > cutoffTime && 
         tick.ts > 0 && 
         tick.count >= 0 &&
         Number.isFinite(tick.ts) && 
         Number.isFinite(tick.count);
}

// Cached storage directory creation
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

// Optimized daily stats loader with error recovery
async function loadDailyStats(): Promise<DailyStat[]> {
  try {
    const raw = await fs.readFile(DAILY_STATS_DB, 'utf-8');
    const parsed = JSON.parse(raw);
    
    // Validate daily stats structure
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

// Optimized tick data loader with single-pass filtering
async function loadAndFilterTicks(cutoffTime: number): Promise<{
  ticks: Tick[];
  metadata: {
    totalHistoricalTicks: number;
    oldestTick: number | null;
    newestTick: number | null;
  };
}> {
  let allTicks: Tick[] = [];
  let totalHistorical = 0;
  let oldestTick: number | null = null;
  let newestTick: number | null = null;

  // Primary data source
  try {
    const raw = await fs.readFile(DB, 'utf-8');
    const parsed = JSON.parse(raw);
    
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Single-pass filter, validate, and collect metadata
      const validTicks: Tick[] = [];
      
      for (const tick of parsed) {
        // Track metadata for all ticks
        if (tick && typeof tick.ts === 'number' && typeof tick.count === 'number' && 
            tick.ts > 0 && tick.count >= 0 && Number.isFinite(tick.ts) && Number.isFinite(tick.count)) {
          
          totalHistorical++;
          
          if (oldestTick === null || tick.ts < oldestTick) {
            oldestTick = tick.ts;
          }
          if (newestTick === null || tick.ts > newestTick) {
            newestTick = tick.ts;
          }
          
          // Only include recent ticks in output
          if (tick.ts > cutoffTime) {
            validTicks.push(tick);
          }
        }
      }
      
      // Sort only the filtered data (much smaller array)
      validTicks.sort((a, b) => a.ts - b.ts);
      allTicks = validTicks;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Error parsing tick history:', err);
      
      // Fallback to backup with same optimization
      try {
        const backup = await fs.readFile(BACKUP_DB, 'utf-8');
        const parsed = JSON.parse(backup);
        
        if (Array.isArray(parsed) && parsed.length > 0) {
          const validTicks: Tick[] = [];
          
          for (const tick of parsed) {
            if (tick && typeof tick.ts === 'number' && typeof tick.count === 'number' && 
                tick.ts > 0 && tick.count >= 0 && Number.isFinite(tick.ts) && Number.isFinite(tick.count)) {
              
              totalHistorical++;
              
              if (oldestTick === null || tick.ts < oldestTick) {
                oldestTick = tick.ts;
              }
              if (newestTick === null || tick.ts > newestTick) {
                newestTick = tick.ts;
              }
              
              if (tick.ts > cutoffTime) {
                validTicks.push(tick);
              }
            }
          }
          
          validTicks.sort((a, b) => a.ts - b.ts);
          allTicks = validTicks;
          console.log('Served from backup with optimized filtering');
        }
      } catch (be) {
        console.error('Backup read failed:', be);
        // allTicks remains empty
      }
    }
    // If ENOENT, allTicks remains empty (expected for new installations)
  }

  return {
    ticks: allTicks,
    metadata: {
      totalHistoricalTicks: totalHistorical,
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
    const cutoffTime = now - SEVEN_DAYS_MS;
    const clientETag = event.request.headers.get('if-none-match');

    // Load data in parallel for better performance
    const [tickData, dailyStats] = await Promise.all([
      loadAndFilterTicks(cutoffTime),
      loadDailyStats()
    ]);

    const { ticks, metadata } = tickData;
    
    // Optimized ETag generation with cached values
    const ticksLength = ticks.length;
    const lastTickTs = ticksLength > 0 ? ticks[ticksLength - 1].ts : 0;
    const dailyStatsLength = dailyStats.length;
    const etag = `"${ticksLength}-${lastTickTs}-${dailyStatsLength}"`;

    // Early return for unchanged data
    if (clientETag === etag) {
      return new Response(null, { status: 304 });
    }

    // Construct payload with pre-calculated values
    const payload = { 
      ticks, 
      dailyStats,
      metadata: {
        todayStart,
        totalHistoricalTicks: metadata.totalHistoricalTicks,
        oldestTick: metadata.oldestTick,
        newestTick: metadata.newestTick
      }
    };
    
    // Optimized headers with cached values
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
      'Last-Modified': new Date(now).toUTCString(),
      'X-Tick-Count': ticksLength.toString(),
      'X-Daily-Stats-Count': dailyStatsLength.toString()
    };
    
    return new Response(JSON.stringify(payload), { headers });
    
  } catch (error) {
    console.error('Error in GET handler:', error);
    
    // Optimized error response
    const errorPayload = { 
      ticks: [], 
      dailyStats: [], 
      metadata: {
        todayStart: getLocalStartOfDay(),
        totalHistoricalTicks: 0,
        oldestTick: null,
        newestTick: null
      }
    };
    
    return new Response(JSON.stringify(errorPayload), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
};