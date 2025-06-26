// ===== /api/tick-history/+server.ts =====
import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

// Use Railway's persistent volume with fallback for development
const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const BACKUP_DB = path.resolve(STORAGE_DIR, 'tick-history.backup.json');

// Cache for GET requests to reduce file reads
let historyCache: { data: any[]; lastModified: number; etag: string } | null = null;
const CACHE_TTL = 5000; // 5 seconds cache

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
    const clientLastModified = event.request.headers.get('if-modified-since');
    
    // Check if we have valid server cache
    if (historyCache && (now - historyCache.lastModified) < CACHE_TTL) {
      // If client has same ETag, return 304
      if (clientETag === historyCache.etag) {
        return new Response(null, { status: 304 });
      }
      
      return new Response(JSON.stringify(historyCache.data), {
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, must-revalidate',
          'ETag': historyCache.etag,
          'Last-Modified': new Date(historyCache.lastModified).toUTCString(),
          'X-Total-Count': historyCache.data.length.toString()
        }
      });
    }

    let arr: { ts: number; count: number }[] = [];
    
    try {
      const rawData = await fs.readFile(DB, 'utf-8');
      arr = JSON.parse(rawData);
      
      // Validate and clean data
      if (Array.isArray(arr)) {
        arr = arr.filter(tick => 
          tick && 
          typeof tick.ts === 'number' && 
          typeof tick.count === 'number' &&
          tick.ts > 0 && 
          tick.count >= 0
        );
        
        // Sort to ensure order
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
    }
    
    // Optional: Implement pagination for very large datasets
    const url = new URL(event.request.url);
    const limit = parseInt(url.searchParams.get('limit') || '0');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const originalLength = arr.length;
    
    if (limit > 0 && limit <= 10000) { // Cap limit to prevent abuse
      arr = arr.slice(offset, offset + limit);
    }
    
    // Create ETag based on data length and last timestamp
    const etag = `"${originalLength}-${arr.length > 0 ? arr[arr.length - 1].ts : 0}"`;
    
    // If client has same ETag, return 304
    if (clientETag === etag) {
      return new Response(null, { status: 304 });
    }
    
    // Update cache
    historyCache = { data: arr, lastModified: now, etag };
    
    return new Response(JSON.stringify(arr), {
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, must-revalidate',
        'ETag': etag,
        'Last-Modified': new Date(now).toUTCString(),
        'X-Total-Count': originalLength.toString(),
        'X-Returned-Count': arr.length.toString()
      }
    });
    
  } catch (error) {
    console.error('Error reading tick history:', error);
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
};