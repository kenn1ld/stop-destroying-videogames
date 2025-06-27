// ===== /api/tick-history/+server.ts =====
import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

// Use Railway's persistent volume with fallback for development
const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const DAILY_STATS_DB = path.resolve(STORAGE_DIR, 'daily-stats.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');

interface DailyStat {
  date: string; // YYYY-MM-DD UTC
  signaturesCollected: number;
  startCount: number;
  endCount: number;
  dataPoints: number;
}

// Helper functions
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

// Ensure storage directory exists
async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create storage directory:', error);
  }
}

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
        
        // Try backup
        try {
          const backupData = await fs.readFile(BACKUP_DB, 'utf-8');
          arr = JSON.parse(backupData);
          console.log('Served from backup');
        } catch (backupError) {
          console.error('Backup read failed:', backupError);
          arr = [];
        }
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
    
    // Return both current ticks and daily stats (NEW FORMAT)
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