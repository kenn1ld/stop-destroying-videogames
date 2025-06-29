import fs from 'fs/promises';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');
const RETENTION_MS = 26 * 60 * 60 * 1000; // 26 hours

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 120;
let lastWrittenData: { ts: number; count: number } | null = null;

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

    // Aggressive deduplication
    if (lastWrittenData?.ts === ts && lastWrittenData.count === count) {
      return new Response(null, { status: 204 });
    }
    
    if (lastWrittenData && Math.abs(ts - lastWrittenData.ts) < 2000 && lastWrittenData.count === count) {
      return new Response(null, { status: 204 });
    }

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

    // Simple cleanup - just keep last 26 hours
    const retentionCutoff = Date.now() - RETENTION_MS;
    arr = arr.filter(t => t.ts >= retentionCutoff);

    // Add or update current tick
    const idx = arr.findIndex(t => t.ts === ts);
    if (idx >= 0) {
      arr[idx].count = count;
    } else {
      arr.push({ ts, count });
    }

    // Sort by timestamp
    arr.sort((a, b) => a.ts - b.ts);

    // Write directly (atomic on most filesystems)
    await fs.writeFile(DB, JSON.stringify(arr), 'utf-8');
    lastWrittenData = { ts, count };

    return new Response(null, { status: 204 });
    
  } catch (err) {
    console.error('Error saving tick:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
};