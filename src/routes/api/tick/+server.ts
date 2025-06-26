// ===== /api/tick/+server.ts (POST Handler) =====
import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

// Use Railway's persistent volume with fallback for development
const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');

// Rate limiting per IP
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 120; // 2 requests per second average

// In-memory cache to avoid duplicate writes
let lastWrittenData: { ts: number; count: number } | null = null;

// Ensure storage directory exists
async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create storage directory:', error);
  }
}

function getRealIP(request: Request): string {
  // Railway provides real IP in these headers
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
    
    // Read existing data with async fs
    try {
      const rawData = await fs.readFile(DB, 'utf-8');
      arr = JSON.parse(rawData);
      
      // Validate array structure
      if (!Array.isArray(arr)) {
        throw new Error('Invalid data structure');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error parsing existing tick history:', error);
        
        // Try to read backup
        try {
          const backupData = await fs.readFile(BACKUP_DB, 'utf-8');
          arr = JSON.parse(backupData);
          console.log('Restored from backup');
        } catch (backupError) {
          console.error('Backup also failed, starting fresh:', backupError);
          arr = [];
        }
      }
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
    
    // Create backup every 1000 new entries
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