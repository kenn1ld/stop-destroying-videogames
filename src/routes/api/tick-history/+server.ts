import { Pool } from 'pg';
import type { RequestHandler } from '@sveltejs/kit';

// Separate pools for read and write operations
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

const readPool = new Pool({
  connectionString: process.env.READ_DATABASE_URL || process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 25, // More connections for reads
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

const TZ_OFFSET_MS = 2 * 60 * 60 * 1000;
const RETENTION_MS = 26 * 60 * 60 * 1000;

// Enhanced caching system
interface CacheEntry {
  data: any;
  etag: string;
  timestamp: number;
  size: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 50; // Maximum cache entries
const CACHE_TTL = 30000; // 30 seconds base TTL
const METADATA_CACHE_TTL = 10000; // 10 seconds for metadata

// Rate calculation windows in milliseconds
const RATE_WINDOWS = {
  perSec: 30 * 1000,
  perMin: 5 * 60 * 1000,
  perHour: 60 * 60 * 1000,
  perDay: 24 * 60 * 60 * 1000
} as const;

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
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_signatures_recent 
      ON signatures(timestamp) 
      WHERE timestamp > extract(epoch from now() - interval '2 hours') * 1000
    `);
    
    tableEnsured = true;
  } catch (error) {
    console.error('Schema setup error:', error);
  }
}

function getLocalStartOfDay(ts: number = Date.now()): number {
  const shifted = new Date(ts + TZ_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_MS;
}

function cleanupCache() {
  const now = Date.now();
  const entries = Array.from(cache.entries());
  
  // Remove expired entries
  for (const [key, entry] of entries) {
    if (now - entry.timestamp > CACHE_TTL * 2) {
      cache.delete(key);
    }
  }
  
  // If still too large, remove oldest entries
  if (cache.size > MAX_CACHE_SIZE) {
    const sortedEntries = entries
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, cache.size - MAX_CACHE_SIZE);
    
    for (const [key] of sortedEntries) {
      cache.delete(key);
    }
  }
}

function getCacheKey(url: URL): string {
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    params.set(key, value);
  }
  return params.toString();
}

async function getMetadata(now: number): Promise<any> {
  const cacheKey = 'metadata';
  const cached = cache.get(cacheKey);
  
  if (cached && (now - cached.timestamp) < METADATA_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const result = await readPool.query(`
      SELECT 
        COUNT(*) as total_count,
        MIN(timestamp) as oldest_tick,
        MAX(timestamp) as newest_tick,
        MAX(count) as max_signatures
      FROM signatures 
      WHERE timestamp > $1
    `, [now - RETENTION_MS]);

    const metadata = {
      totalTicks: Number(result.rows[0].total_count),
      oldestTick: Number(result.rows[0].oldest_tick) || null,
      newestTick: Number(result.rows[0].newest_tick) || null,
      maxSignatures: Number(result.rows[0].max_signatures) || 0,
      serverTime: now,
      retentionHours: 26
    };

    cache.set(cacheKey, {
      data: metadata,
      etag: `meta-${metadata.totalTicks}-${metadata.newestTick}`,
      timestamp: now,
      size: JSON.stringify(metadata).length
    });

    return metadata;
  } catch (error) {
    console.error('Metadata query error:', error);
    return {
      totalTicks: 0,
      oldestTick: null,
      newestTick: null,
      maxSignatures: 0,
      serverTime: now,
      retentionHours: 26
    };
  }
}

async function calculateRates(now: number): Promise<any> {
  const cacheKey = 'rates';
  const cached = cache.get(cacheKey);
  
  if (cached && (now - cached.timestamp) < 5000) { // 5 second cache for rates
    return cached.data;
  }

  try {
    // Optimized single query for all rate calculations
    const rateQuery = `
      WITH time_windows AS (
        SELECT 
          timestamp,
          count,
          CASE 
            WHEN timestamp > $1 THEN 'perSec'
            WHEN timestamp > $2 THEN 'perMin' 
            WHEN timestamp > $3 THEN 'perHour'
            WHEN timestamp > $4 THEN 'perDay'
            ELSE NULL
          END as window_type
        FROM signatures 
        WHERE timestamp > $4
        ORDER BY timestamp ASC
      ),
      window_bounds AS (
        SELECT 
          window_type,
          COUNT(*) as data_points,
          MIN(timestamp) as first_ts,
          MAX(timestamp) as last_ts,
          FIRST_VALUE(count) OVER (PARTITION BY window_type ORDER BY timestamp ASC) as first_count,
          LAST_VALUE(count) OVER (PARTITION BY window_type ORDER BY timestamp ASC 
            RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_count
        FROM time_windows 
        WHERE window_type IS NOT NULL
        GROUP BY window_type, count, timestamp
      ),
      rates AS (
        SELECT 
          window_type,
          MAX(data_points) as data_points,
          CASE 
            WHEN MAX(last_ts) > MAX(first_ts) AND MAX(last_count) >= MAX(first_count)
            THEN GREATEST(0, (MAX(last_count) - MAX(first_count))::float / ((MAX(last_ts) - MAX(first_ts))::float / 1000))
            ELSE 0 
          END as rate_per_second
        FROM window_bounds
        GROUP BY window_type
      )
      SELECT 
        window_type,
        data_points,
        CASE window_type
          WHEN 'perSec' THEN rate_per_second
          WHEN 'perMin' THEN rate_per_second * 60
          WHEN 'perHour' THEN rate_per_second * 3600  
          WHEN 'perDay' THEN rate_per_second * 86400
        END as rate
      FROM rates
    `;

    const result = await readPool.query(rateQuery, [
      now - RATE_WINDOWS.perSec,   // $1
      now - RATE_WINDOWS.perMin,   // $2  
      now - RATE_WINDOWS.perHour,  // $3
      now - RATE_WINDOWS.perDay    // $4
    ]);

    // Convert to expected format
    const rates = {
      perSec: 0,
      perMin: 0, 
      perHour: 0,
      perDay: 0,
      dataPoints: {
        perSec: 0,
        perMin: 0,
        perHour: 0, 
        perDay: 0
      }
    };

    result.rows.forEach(row => {
      const windowType = row.window_type as keyof typeof rates;
      if (windowType !== 'dataPoints') {
        rates[windowType] = Math.max(0, Number(row.rate) || 0);
        rates.dataPoints[windowType] = Number(row.data_points) || 0;
      }
    });

    cache.set(cacheKey, {
      data: rates,
      etag: `rates-${now}`,
      timestamp: now,
      size: JSON.stringify(rates).length
    });

    return rates;
  } catch (error) {
    console.error('Rate calculation error:', error);
    return {
      perSec: 0, perMin: 0, perHour: 0, perDay: 0,
      dataPoints: { perSec: 0, perMin: 0, perHour: 0, perDay: 0 }
    };
  }
}

async function calculateTodayStats(now: number): Promise<any> {
  const todayStart = getLocalStartOfDay(now);
  const cacheKey = `today-${todayStart}`;
  const cached = cache.get(cacheKey);
  
  if (cached && (now - cached.timestamp) < 10000) { // 10 second cache
    return cached.data;
  }
  
  try {
    const todayQuery = `
      SELECT 
        COUNT(*) as data_points,
        MIN(count) as baseline_count,
        MAX(count) as current_count,
        MIN(timestamp) as first_timestamp,
        MAX(timestamp) as last_timestamp
      FROM signatures 
      WHERE timestamp >= $1
    `;

    const result = await readPool.query(todayQuery, [todayStart]);
    const row = result.rows[0];
    
    const dataPoints = Number(row.data_points);
    const baselineKnown = dataPoints > 0;
    const collected = baselineKnown ? 
      Math.max(0, Number(row.current_count) - Number(row.baseline_count)) : 0;
    
    const msUntilReset = Math.max(0, todayStart + 24 * 60 * 60 * 1000 - now);
    const hrs = Math.floor(msUntilReset / 3_600_000);
    const mins = Math.floor((msUntilReset % 3_600_000) / 60_000);

    const stats = {
      collected,
      utcStartOfDay: todayStart,
      timeUntilResetText: `${hrs}h ${mins}m`,
      baselineKnown,
      dataPointsToday: dataPoints,
      firstTimestamp: Number(row.first_timestamp) || null,
      lastTimestamp: Number(row.last_timestamp) || null
    };

    cache.set(cacheKey, {
      data: stats,
      etag: `today-${collected}-${dataPoints}`,
      timestamp: now,
      size: JSON.stringify(stats).length
    });

    return stats;
  } catch (error) {
    console.error('Today stats calculation error:', error);
    
    const msUntilReset = Math.max(0, todayStart + 24 * 60 * 60 * 1000 - now);
    const hrs = Math.floor(msUntilReset / 3_600_000);
    const mins = Math.floor((msUntilReset % 3_600_000) / 60_000);
    
    return {
      collected: 0,
      utcStartOfDay: todayStart,
      timeUntilResetText: `${hrs}h ${mins}m`,
      baselineKnown: false,
      dataPointsToday: 0,
      firstTimestamp: null,
      lastTimestamp: null
    };
  }
}

async function getHistoryData(now: number, limit: number): Promise<any[]> {
  try {
    let historyQuery = `
      SELECT timestamp as ts, count
      FROM signatures 
      WHERE timestamp > $1 
      ORDER BY timestamp ASC
    `;
    const params = [now - RETENTION_MS];
    
    if (limit > 0) {
      // For large limits, use a more efficient approach
      if (limit > 10000) {
        // Sample the data to reduce load
        historyQuery = `
          SELECT timestamp as ts, count
          FROM (
            SELECT timestamp, count, ROW_NUMBER() OVER (ORDER BY timestamp) as rn,
                   COUNT(*) OVER () as total_count
            FROM signatures 
            WHERE timestamp > $1
          ) sampled
          WHERE rn % GREATEST(1, total_count / $2) = 0
          ORDER BY timestamp ASC
        `;
        params.push(Math.min(limit, 5000)); // Cap sampling at 5000 points
      } else {
        historyQuery += ` LIMIT $2`;
        params.push(limit);
      }
    }

    const historyResult = await readPool.query(historyQuery, params);
    return historyResult.rows.map(row => ({
      ts: Number(row.ts),
      count: Number(row.count)
    }));
  } catch (error) {
    console.error('History query error:', error);
    return [];
  }
}

export const GET: RequestHandler = async (event) => {
  await ensureTable();

  const startTime = Date.now();
  const now = Date.now();
  const url = new URL(event.request.url);
  
  // Parse query parameters
  const includeHistory = url.searchParams.get('history') !== 'false';
  const includeRates = url.searchParams.get('rates') !== 'false'; 
  const includeTodayStats = url.searchParams.get('today') !== 'false';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '0'), 50000); // Cap at 50k
  const compress = url.searchParams.get('compress') === 'true';

  try {
    // Check cache first
    const cacheKey = getCacheKey(url);
    const cached = cache.get(cacheKey);
    
    // Get basic metadata for ETag generation
    const metadata = await getMetadata(now);
    const etag = `"${metadata.totalTicks}-${metadata.newestTick}-${Math.floor(now / 60000)}"`;
    
    // Check client ETag
    const clientETag = event.request.headers.get('if-none-match');
    if (clientETag === etag && cached && (now - cached.timestamp) < CACHE_TTL) {
      return new Response(null, { 
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'no-cache, must-revalidate',
          'X-Cache': 'HIT',
          'X-Processing-Time': `${Date.now() - startTime}ms`
        }
      });
    }

    // Build response data
    const responseData: any = { metadata };

    // Fetch data in parallel when possible
    const promises: Promise<any>[] = [];
    
    if (includeHistory) {
      promises.push(getHistoryData(now, limit));
    }
    if (includeRates) {
      promises.push(calculateRates(now));
    }
    if (includeTodayStats) {
      promises.push(calculateTodayStats(now));
    }

    const results = await Promise.all(promises);
    let resultIndex = 0;

    if (includeHistory) {
      responseData.ticks = results[resultIndex++];
    }
    if (includeRates) {
      responseData.rates = results[resultIndex++];
    }
    if (includeTodayStats) {
      responseData.todayStats = results[resultIndex++];
    }

    // Maintain backward compatibility
    responseData.dailyStats = [];
    
    // Cache the response
    const responseSize = JSON.stringify(responseData).length;
    cache.set(cacheKey, {
      data: responseData,
      etag,
      timestamp: now,
      size: responseSize
    });

    // Cleanup cache periodically
    if (Math.random() < 0.1) { // 10% chance
      cleanupCache();
    }

    const processingTime = Date.now() - startTime;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
      'Last-Modified': new Date(now).toUTCString(),
      'X-Tick-Count': metadata.totalTicks.toString(),
      'X-Retention': '26h',
      'X-Server-Time': now.toString(),
      'X-Processing-Time': `${processingTime}ms`,
      'X-Cache': 'MISS',
      'X-Response-Size': responseSize.toString()
    };

    // Add compression header if requested
    if (compress && responseSize > 1000) {
      headers['Content-Encoding'] = 'gzip';
    }
    
    return new Response(JSON.stringify(responseData), { headers });
    
  } catch (error: any) {
    console.error('[GET Error]', {
      error: error.message,
      stack: error.stack?.substring(0, 500),
      url: event.request.url,
      timestamp: now,
      processingTime: Date.now() - startTime
    });
    
    // Return fallback data structure
    const errorPayload = { 
      ticks: [], 
      dailyStats: [], 
      metadata: {
        todayStart: getLocalStartOfDay(),
        totalTicks: 0,
        oldestTick: null,
        newestTick: null,
        retentionHours: 26,
        serverTime: now,
        error: 'Database error occurred'
      },
      rates: {
        perSec: 0, perMin: 0, perHour: 0, perDay: 0,
        dataPoints: { perSec: 0, perMin: 0, perHour: 0, perDay: 0 }
      },
      todayStats: {
        collected: 0,
        utcStartOfDay: getLocalStartOfDay(),
        timeUntilResetText: '0h 0m',
        baselineKnown: false,
        dataPointsToday: 0
      }
    };
    
    return new Response(JSON.stringify(errorPayload), {
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, must-revalidate',
        'X-Error': 'true',
        'X-Processing-Time': `${Date.now() - startTime}ms`
      },
      status: 500
    });
  }
};