// ===== /api/tick/+server.ts (POST Handler) =====
import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

// Use Railway's persistent volume with fallback for development
const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const DAILY_STATS_DB = path.resolve(STORAGE_DIR, 'daily-stats.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');

// Rate limiting per IP
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 120; // 2 requests per second average

// In-memory cache to avoid duplicate writes
let lastWrittenData: { ts: number; count: number } | null = null;

interface DailyStat {
  date: string; // YYYY-MM-DD UTC
  signaturesCollected: number;
  startCount: number;
  endCount: number;
  dataPoints: number;
}

// Helper functions
function getUTCDateString(timestamp: number = Date.now()): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

function getUTCStartOfDay(timestamp: number = Date.now()): number {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).getTime();
}

// Ensure storage directory exists
async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create storage directory:', error);
  }
}

function getRealIP(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
         request.headers.get('x-real-ip') ||
         request.headers.get('cf-connecting-ip') ||
         'unknown';
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);
  
  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return false;
  }
  
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }
  
  record.count++;
  return false;
}

async function loadDailyStats(): Promise<DailyStat[]> {
  try {
    const rawData = await fs.readFile(DAILY_STATS_DB, 'utf-8');
    return JSON.parse(rawData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Error loading daily stats:', error);
    }
    return [];
  }
}

async function saveDailyStats(stats: DailyStat[]): Promise<void> {
  try {
    await fs.writeFile(DAILY_STATS_DB, JSON.stringify(stats, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving daily stats:', error);
  }
}

async function archiveYesterdayAndCleanup(currentData: { ts: number; count: number }[]): Promise<{ ts: number; count: number }[]> {
  const now = Date.now();
  const todayStart = getUTCStartOfDay(now);
  const yesterday = getUTCDateString(now - 24 * 60 * 60 * 1000);
  
  // Separate today's data from yesterday's
  const todayData = currentData.filter(tick => tick.ts >= todayStart);
  const yesterdayData = currentData.filter(tick => tick.ts < todayStart && tick.ts >= todayStart - 24 * 60 * 60 * 1000);
  
  if (yesterdayData.length > 0) {
    console.log(`Archiving ${yesterdayData.length} data points from ${yesterday}`);
    
    // Calculate yesterday's stats
    const startCount = yesterdayData[0].count;
    const endCount = yesterdayData[yesterdayData.length - 1].count;
    const signaturesCollected = endCount - startCount;
    
    // Load existing daily stats
    const dailyStats = await loadDailyStats();
    
    // Check if we already have stats for yesterday (prevent duplicates)
    const existingIndex = dailyStats.findIndex(stat => stat.date === yesterday);
    const yesterdayStat: DailyStat = {
      date: yesterday,
      signaturesCollected,
      startCount,
      endCount,
      dataPoints: yesterdayData.length
    };
    
    if (existingIndex >= 0) {
      dailyStats[existingIndex] = yesterdayStat;
    } else {
      dailyStats.push(yesterdayStat);
    }
    
    // Keep only last 7 days of daily stats to prevent unlimited growth
    const cutoffDate = getUTCDateString(now - 7 * 24 * 60 * 60 * 1000);
    const filteredStats = dailyStats.filter(stat => stat.date >= cutoffDate);
    
    // Save updated daily stats
    await saveDailyStats(filteredStats);
    
    console.log(`Archived yesterday (${yesterday}): ${signaturesCollected} signatures collected`);
  }
  
  // Return only today's data
  console.log(`Keeping ${todayData.length} data points for today`);
  return todayData;
}

async function createBackup(data: any[]): Promise<void> {
  try {
    await fs.writeFile(BACKUP_DB, JSON.stringify(data), 'utf-8');
  } catch (error) {
    console.error('Failed to create backup:', error);
  }
}

export const POST: RequestHandler = async (event) => {
  await ensureStorageDir();
  
  try {
    // Rate limiting
    const ip = getRealIP(event.request);
    if (isRateLimited(ip)) {
      return new Response('Rate limit exceeded', { 
        status: 429,
        headers: { 'Retry-After': '60' }
      });
    }

    const { ts, count } = await event.request.json();
    
    // Enhanced validation
    if (!ts || typeof ts !== 'number' || 
        typeof count !== 'number' || 
        ts <= 0 || count < 0 ||
        ts > Date.now() + 60000) { // Allow 1 minute future tolerance
      return new Response('Invalid data format', { status: 400 });
    }

    // Skip if identical to last written data (deduplication)
    if (lastWrittenData && lastWrittenData.ts === ts && lastWrittenData.count === count) {
      return new Response(null, { status: 204 });
    }

    let arr: { ts: number; count: number }[] = [];
    
    // Read existing data
    try {
      const rawData = await fs.readFile(DB, 'utf-8');
      arr = JSON.parse(rawData);
      
      if (!Array.isArray(arr)) {
        throw new Error('Invalid data structure');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error parsing existing tick history:', error);
        arr = [];
      }
    }
    
    // Check if we need to archive yesterday's data and cleanup
    const todayStart = getUTCStartOfDay(ts);
    const hasOldData = arr.some(tick => tick.ts < todayStart);
    
    if (hasOldData) {
      arr = await archiveYesterdayAndCleanup(arr);
    }
    
    // Prevent duplicate timestamps (keep latest count for same timestamp)
    const existingIndex = arr.findIndex(tick => tick.ts === ts);
    if (existingIndex !== -1) {
      arr[existingIndex].count = count;
    } else {
      arr.push({ ts, count });
    }
    
    // Sort by timestamp to maintain order
    arr.sort((a, b) => a.ts - b.ts);
    
    // Create backup every 1000 new entries (but now this will be much less frequent)
    if (arr.length % 1000 === 0) {
      await createBackup(arr);
    }
    
    // Write atomically with temp file
    const tempFile = `${DB}.tmp.${Date.now()}`;
    try {
      await fs.writeFile(tempFile, JSON.stringify(arr), 'utf-8');
      await fs.rename(tempFile, DB);
      
      // Update cache
      lastWrittenData = { ts, count };
      
    } catch (writeError) {
      // Clean up temp file if write failed
      try {
        await fs.unlink(tempFile);
      } catch {}
      throw writeError;
    }
    
    return new Response(null, { status: 204 });
    
  } catch (error) {
    console.error('Error saving tick:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};

// ===== /api/tick-history/+server.ts =====
export const GET: RequestHandler = async (event) => {
  await ensureStorageDir();
  
  try {
    const now = Date.now();
    
    // Check client cache first
    const clientETag = event.request.headers.get('if-none-match');
    
    let arr: { ts: number; count: number }[] = [];
    let dailyStats: DailyStat[] = [];
    
    // Load current tick data (should only be today's data now)
    try {
      const rawData = await fs.readFile(DB, 'utf-8');
      arr = JSON.parse(rawData);
      
      if (Array.isArray(arr)) {
        arr = arr.filter(tick => 
          tick && 
          typeof tick.ts === 'number' && 
          typeof tick.count === 'number' &&
          tick.ts > 0 && 
          tick.count >= 0
        );
        arr.sort((a, b) => a.ts - b.ts);
      } else {
        arr = [];
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error parsing tick history:', error);
      }
      arr = [];
    }
    
    // Load daily stats
    dailyStats = await loadDailyStats();
    
    // Create ETag based on data length and last timestamp
    const etag = `"${arr.length}-${arr.length > 0 ? arr[arr.length - 1].ts : 0}-${dailyStats.length}"`;
    
    // If client has same ETag, return 304
    if (clientETag === etag) {
      return new Response(null, { status: 304 });
    }
    
    // Return both current ticks and daily stats
    const responseData = {
      ticks: arr,
      dailyStats: dailyStats
    };
    
    return new Response(JSON.stringify(responseData), {
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