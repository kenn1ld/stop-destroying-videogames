import { Pool } from 'pg';
import type { RequestHandler } from '@sveltejs/kit';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const RETENTION_MS = 26 * 60 * 60 * 1000; // 26 hours

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 120;
let lastWrittenData: { ts: number; count: number } | null = null;
let tableEnsured = false;

async function ensureTable() {
  if (tableEnsured) return;
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signatures (
        timestamp BIGINT PRIMARY KEY,
        count INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_signatures_timestamp 
      ON signatures(timestamp)
    `);
    
    tableEnsured = true;
  } catch (error) {
    console.error('Schema setup error:', error);
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
  await ensureTable();

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

    // Single atomic database operation - upsert and cleanup
    await pool.query(`
      WITH cleanup AS (
        DELETE FROM signatures 
        WHERE timestamp < $1
      )
      INSERT INTO signatures (timestamp, count) 
      VALUES ($2, $3)
      ON CONFLICT (timestamp) DO UPDATE SET count = $3
    `, [Date.now() - RETENTION_MS, ts, count]);

    lastWrittenData = { ts, count };
    return new Response(null, { status: 204 });
    
  } catch (err) {
    console.error('Database error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
};