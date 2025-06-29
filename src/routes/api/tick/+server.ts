import { Pool } from 'pg';
import type { RequestHandler } from '@sveltejs/kit';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20, // Increased for better concurrency
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

const RETENTION_MS = 26 * 60 * 60 * 1000; // 26 hours

// Enhanced rate limiting with IP-based and global throttling
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 120;
const GLOBAL_RATE_LIMIT = 1000; // Global limit per minute
let globalRequestCount = 0;
let globalResetTime = 0;

// Enhanced deduplication with time-based and signature-based filtering
let lastWrittenData: { ts: number; count: number } | null = null;
let recentWrites = new Map<string, number>(); // signature -> timestamp
const DUPLICATE_WINDOW = 10000; // 10 seconds

let tableEnsured = false;
let lastCleanup = 0;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

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
    
    // Enhanced indexing for better performance - using DO blocks for safer index creation
    await pool.query(`
      DO $ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_signatures_timestamp') THEN
          CREATE INDEX idx_signatures_timestamp ON signatures(timestamp);
        END IF;
      END $;
    `);
    
    await pool.query(`
      DO $ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_signatures_created_at') THEN
          CREATE INDEX idx_signatures_created_at ON signatures(created_at);
        END IF;
      END $;
    `);
    
    await pool.query(`
      DO $ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_signatures_timestamp_desc') THEN
          CREATE INDEX idx_signatures_timestamp_desc ON signatures(timestamp DESC);
        END IF;
      END $;
    `);
    
    tableEnsured = true;
  } catch (error) {
    console.error('Schema setup error:', error);
    // Don't throw error to prevent application failure
    // The basic table should still work even without indexes
  }
}

function getRealIP(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || request.headers.get('cf-connecting-ip')
    || request.headers.get('x-client-ip')
    || 'unknown';
}

function cleanupOldEntries() {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW;
  
  // Cleanup rate limiting entries
  if (requestCounts.size > 2000) {
    for (const [key, value] of requestCounts.entries()) {
      if (value.resetTime < cutoff) {
        requestCounts.delete(key);
      }
    }
  }
  
  // Cleanup recent writes
  const duplicateCutoff = now - DUPLICATE_WINDOW;
  for (const [key, timestamp] of recentWrites.entries()) {
    if (timestamp < duplicateCutoff) {
      recentWrites.delete(key);
    }
  }
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  
  // Global rate limiting
  if (now > globalResetTime) {
    globalRequestCount = 0;
    globalResetTime = now + RATE_LIMIT_WINDOW;
  }
  
  if (globalRequestCount >= GLOBAL_RATE_LIMIT) {
    return true;
  }
  
  // Per-IP rate limiting
  const record = requestCounts.get(ip);
  
  // Periodic cleanup
  if (now - lastCleanup > 30000) { // Every 30 seconds
    cleanupOldEntries();
    lastCleanup = now;
  }
  
  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    globalRequestCount++;
    return false;
  }
  
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }
  
  record.count++;
  globalRequestCount++;
  return false;
}

function isDuplicateRequest(ts: number, count: number): boolean {
  // Exact duplicate check
  if (lastWrittenData?.ts === ts && lastWrittenData.count === count) {
    return true;
  }
  
  // Time-proximity duplicate check (within 2 seconds with same count)
  if (lastWrittenData && 
      Math.abs(ts - lastWrittenData.ts) < 2000 && 
      lastWrittenData.count === count) {
    return true;
  }
  
  // Signature-based deduplication
  const signature = `${count}-${Math.floor(ts / 1000)}`; // Per-second signature
  const existingTime = recentWrites.get(signature);
  if (existingTime && ts - existingTime < DUPLICATE_WINDOW) {
    return true;
  }
  
  return false;
}

function validateTickData(ts: number, count: number): string | null {
  const now = Date.now();
  
  // Type validation
  if (typeof ts !== 'number' || typeof count !== 'number') {
    return 'Invalid data types';
  }
  
  // Integer validation
  if (!Number.isInteger(ts) || !Number.isInteger(count)) {
    return 'Data must be integers';
  }
  
  // Range validation
  if (ts <= 0 || count < 0) {
    return 'Invalid data range';
  }
  
  // Time validation (not too far in future/past)
  if (ts > now + 60_000) {
    return 'Timestamp too far in future';
  }
  
  if (ts < now - 86400_000) { // Max 24 hours old
    return 'Timestamp too old';
  }
  
  // Reasonable signature count
  if (count > 50_000_000) { // Reasonable max
    return 'Signature count too high';
  }
  
  // Rate change validation (prevent manipulation)
  if (lastWrittenData) {
    const timeDiff = ts - lastWrittenData.ts;
    const countDiff = count - lastWrittenData.count;
    
    // Maximum reasonable rate: 1000 signatures/second
    if (timeDiff > 0 && countDiff / (timeDiff / 1000) > 1000) {
      return 'Signature rate too high';
    }
    
    // Prevent backwards counting (unless reasonable time gap)
    if (countDiff < 0 && timeDiff < 300000) { // 5 minutes
      return 'Signatures cannot decrease';
    }
  }
  
  return null;
}

export const POST: RequestHandler = async (event) => {
  await ensureTable();

  const startTime = Date.now();

  try {
    const ip = getRealIP(event.request);
    
    // Rate limiting check
    if (isRateLimited(ip)) {
      return new Response(JSON.stringify({ 
        error: 'Rate limit exceeded',
        retryAfter: 60 
      }), {
        status: 429,
        headers: { 
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'X-RateLimit-Remaining': '0'
        }
      });
    }

    // Parse and validate request
    let requestData;
    try {
      requestData = await event.request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { ts, count } = requestData;
    
    // Validate data
    const validationError = validateTickData(ts, count);
    if (validationError) {
      return new Response(JSON.stringify({ error: validationError }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Duplicate check
    if (isDuplicateRequest(ts, count)) {
      return new Response(null, { 
        status: 204,
        headers: {
          'X-Duplicate': 'true',
          'X-Processing-Time': `${Date.now() - startTime}ms`
        }
      });
    }

    // Database operation with enhanced error handling
    let result;
    try {
      // Use a more efficient upsert with conditional cleanup
      const shouldCleanup = Math.random() < 0.1; // 10% chance to cleanup
      
      if (shouldCleanup) {
        result = await pool.query(`
          WITH cleanup AS (
            DELETE FROM signatures 
            WHERE timestamp < $1
            RETURNING 1
          ),
          upsert AS (
            INSERT INTO signatures (timestamp, count) 
            VALUES ($2, $3)
            ON CONFLICT (timestamp) DO UPDATE SET count = $3
            WHERE signatures.count != $3
            RETURNING 1
          )
          SELECT 
            (SELECT COUNT(*) FROM cleanup) as cleaned,
            (SELECT COUNT(*) FROM upsert) as upserted
        `, [Date.now() - RETENTION_MS, ts, count]);
      } else {
        // Fast path without cleanup
        result = await pool.query(`
          INSERT INTO signatures (timestamp, count) 
          VALUES ($1, $2)
          ON CONFLICT (timestamp) DO UPDATE SET count = $2
          WHERE signatures.count != $2
          RETURNING count
        `, [ts, count]);
      }

      // Update deduplication tracking
      lastWrittenData = { ts, count };
      const signature = `${count}-${Math.floor(ts / 1000)}`;
      recentWrites.set(signature, ts);
      
      // Log cleanup results if any
      if (shouldCleanup && result.rows[0]?.cleaned > 0) {
        console.log(`[${new Date().toISOString()}] Cleaned ${result.rows[0].cleaned} old records`);
      }
      
      const processingTime = Date.now() - startTime;
      
      return new Response(null, { 
        status: 204,
        headers: {
          'X-Processing-Time': `${processingTime}ms`,
          'X-Timestamp': ts.toString(),
          'X-Count': count.toString()
        }
      });
      
    } catch (dbError: any) {
      console.error('[Database Error]', {
        error: dbError.message,
        code: dbError.code,
        timestamp: ts,
        count: count,
        ip: ip.substring(0, 10) + '...' // Partial IP for privacy
      });
      
      // Handle specific database errors
      if (dbError.code === '23505') { // Unique violation
        return new Response(null, { status: 204 }); // Treat as success
      }
      
      if (dbError.code === '08006' || dbError.code === '08001') { // Connection error
        return new Response(JSON.stringify({ 
          error: 'Database temporarily unavailable' 
        }), {
          status: 503,
          headers: { 
            'Content-Type': 'application/json',
            'Retry-After': '5'
          }
        });
      }
      
      throw dbError; // Re-throw for general error handler
    }
    
  } catch (err: any) {
    console.error('[General Error]', {
      error: err.message,
      stack: err.stack?.substring(0, 500),
      url: event.request.url,
      method: event.request.method,
      timestamp: Date.now()
    });
    
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      timestamp: Date.now()
    }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        'X-Processing-Time': `${Date.now() - startTime}ms`
      }
    });
  }
};