import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const DAILY_STATS_DB = path.resolve(STORAGE_DIR, 'daily-stats.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');
const LOCK_FILE = path.resolve(STORAGE_DIR, '.write.lock');

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 120;
const RETENTION_MS = 26 * 60 * 60 * 1000; // 26 hours
let lastWrittenData: { ts: number; count: number } | null = null;

interface DailyStat {
  date: string;
  signaturesCollected: number;
  startCount: number;
  endCount: number;
  dataPoints: number;
}

const TZ_OFFSET_MS = 2 * 60 * 60 * 1000;

function getLocalDateString(ts: number = Date.now()): string {
  return new Date(ts + TZ_OFFSET_MS).toISOString().split('T')[0];
}

function getLocalStartOfDay(ts: number = Date.now()): number {
  const shifted = new Date(ts + TZ_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_MS;
}

async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create storage directory:', error);
  }
}

function getRealIP(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || request.headers.get('cf-connecting-ip')
    || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);
  
  if (requestCounts.size > 1000) {
    for (const [key, value] of requestCounts.entries()) {
      if (now > value.resetTime) {
        requestCounts.delete(key);
      }
    }
  }
  
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
    const tmp = `${DAILY_STATS_DB}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(stats, null, 2), 'utf-8');
    await fs.rename(tmp, DAILY_STATS_DB);
  } catch (error) {
    console.error('Error saving daily stats:', error);
  }
}

async function archiveAndCleanup(allTicks: { ts: number; count: number }[]): Promise<{ ts: number; count: number }[]> {
  const now = Date.now();
  const todayStart = getLocalStartOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const yesterdayLabel = getLocalDateString(yesterdayStart);

  // Archive yesterday's data
  const yesterdayData = allTicks.filter(t => t.ts >= yesterdayStart && t.ts < todayStart);
  
  if (yesterdayData.length >= 10) { // Reduced threshold since we have less data
    const startCount = yesterdayData[0].count;
    const endCount = yesterdayData[yesterdayData.length - 1].count;
    const signaturesCollected = endCount - startCount;

    const dailyStats = await loadDailyStats();
    const idx = dailyStats.findIndex(s => s.date === yesterdayLabel);
    const newStat: DailyStat = {
      date: yesterdayLabel,
      signaturesCollected,
      startCount,
      endCount,
      dataPoints: yesterdayData.length
    };

    if (idx >= 0) {
      dailyStats[idx] = newStat;
    } else {
      dailyStats.push(newStat);
    }

    // Keep only last 30 days of daily stats
    const cutoff = getLocalDateString(now - 30 * 24 * 60 * 60 * 1000);
    const filtered = dailyStats.filter(s => s.date >= cutoff);
    await saveDailyStats(filtered);

    console.log(`✅ Archived ${signaturesCollected} signatures from ${yesterdayLabel}`);
  }

  // Aggressive cleanup: only keep last 26 hours
  const retentionCutoff = now - RETENTION_MS;
  const recentTicks = allTicks.filter(t => t.ts >= retentionCutoff);
  
  if (allTicks.length > recentTicks.length) {
    console.log(`🧹 Cleaned up ${allTicks.length - recentTicks.length} old ticks (keeping 26h)`);
  }
  
  return recentTicks;
}

async function createBackup(data: any[]): Promise<void> {
  try {
    const tmp = `${BACKUP_DB}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), 'utf-8');
    await fs.rename(tmp, BACKUP_DB);
  } catch (error) {
    console.error('Failed to create backup:', error);
  }
}

async function acquireLock(maxWaitMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    try {
      await fs.writeFile(LOCK_FILE, process.pid.toString(), { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  
  return false;
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(LOCK_FILE);
  } catch (error) {
    // Ignore errors when releasing lock
  }
}

export const POST: RequestHandler = async (event) => {
  await ensureStorageDir();

  try {
    const ip = getRealIP(event.request);
    if (isRateLimited(ip)) {
      return new Response('Rate limit exceeded', {
        status: 429,
        headers: { 'Retry-After': '60' }
      });
    }

    const { ts, count } = await event.request.json();
    
    // Validate input
    if (
      !ts || typeof ts !== 'number' ||
      typeof count !== 'number' ||
      ts <= 0 || count < 0 ||
      ts > Date.now() + 60_000 ||
      !Number.isFinite(ts) || !Number.isFinite(count)
    ) {
      return new Response('Invalid data format', { status: 400 });
    }

    // Deduplicate identical requests
    if (lastWrittenData?.ts === ts && lastWrittenData.count === count) {
      return new Response(null, { status: 204 });
    }

    const lockAcquired = await acquireLock();
    if (!lockAcquired) {
      return new Response('Server busy, please retry', { 
        status: 503,
        headers: { 'Retry-After': '1' }
      });
    }

    try {
      // Load tick history
      let arr: { ts: number; count: number }[] = [];
      try {
        const raw = await fs.readFile(DB, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          arr = parsed;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Error loading tick history:', e);
        }
      }

      // Archive and cleanup with 26h retention
      arr = await archiveAndCleanup(arr);

      // Add or update current tick
      const idx = arr.findIndex(t => t.ts === ts);
      if (idx >= 0) {
        arr[idx].count = count;
      } else {
        arr.push({ ts, count });
      }

      // Sort by timestamp
      arr.sort((a, b) => a.ts - b.ts);
      
      // Create backup less frequently since data is smaller
      if (arr.length % 500 === 0) {
        await createBackup(arr);
      }

      // Write atomically
      const tmp = `${DB}.tmp.${Date.now()}`;
      try {
        await fs.writeFile(tmp, JSON.stringify(arr), 'utf-8');
        await fs.rename(tmp, DB);
        lastWrittenData = { ts, count };
      } catch (writeError) {
        try {
          await fs.unlink(tmp);
        } catch {}
        throw writeError;
      }

      return new Response(null, { status: 204 });
    } finally {
      await releaseLock();
    }
  } catch (err) {
    console.error('Error saving tick:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
};