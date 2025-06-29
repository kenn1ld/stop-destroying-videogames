// ===== Enhanced GET endpoint with server-side calculations =====
import { Pool } from 'pg';
import type { RequestHandler } from '@sveltejs/kit';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

const TZ_OFFSET_MS = 2 * 60 * 60 * 1000;
const RETENTION_MS = 26 * 60 * 60 * 1000;
let tableEnsured = false;

// Rate calculation windows in milliseconds
const RATE_WINDOWS = {
  perSec: 30 * 1000,
  perMin: 5 * 60 * 1000,
  perHour: 60 * 60 * 1000,
  perDay: 24 * 60 * 60 * 1000
} as const;

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

function getLocalStartOfDay(ts: number = Date.now()): number {
  const shifted = new Date(ts + TZ_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_MS;
}

async function calculateRates(now: number) {
  // Single query to get rate data for all windows
  const rateQuery = `
    WITH rate_windows AS (
      SELECT 
        timestamp,
        count,
        CASE 
          WHEN timestamp > $1 THEN 'perSec'
          WHEN timestamp > $2 THEN 'perMin' 
          WHEN timestamp > $3 THEN 'perHour'
          WHEN timestamp > $4 THEN 'perDay'
          ELSE 'outside'
        END as window_type
      FROM signatures 
      WHERE timestamp > $4  -- Only get data from largest window
      ORDER BY timestamp ASC
    ),
    window_stats AS (
      SELECT 
        window_type,
        COUNT(*) as data_points,
        MIN(timestamp) as first_ts,
        MAX(timestamp) as last_ts,
        FIRST_VALUE(count) OVER (PARTITION BY window_type ORDER BY timestamp ASC) as first_count,
        LAST_VALUE(count) OVER (PARTITION BY window_type ORDER BY timestamp ASC 
          RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_count
      FROM rate_windows 
      WHERE window_type != 'outside'
      GROUP BY window_type, count, timestamp
    ),
    rate_calcs AS (
      SELECT 
        window_type,
        MAX(data_points) as data_points,
        MAX(CASE 
          WHEN last_ts > first_ts AND last_count > first_count 
          THEN (last_count - first_count)::float / ((last_ts - first_ts)::float / 1000)
          ELSE 0 
        END) as rate_per_second
      FROM window_stats
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
    FROM rate_calcs
  `;

  const result = await pool.query(rateQuery, [
    now - RATE_WINDOWS.perSec,   // $1
    now - RATE_WINDOWS.perMin,   // $2  
    now - RATE_WINDOWS.perHour,  // $3
    now - RATE_WINDOWS.perDay    // $4
  ]);

  // Convert to object format expected by client
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
      rates[windowType] = Number(row.rate) || 0;
      rates.dataPoints[windowType] = Number(row.data_points) || 0;
    }
  });

  return rates;
}

async function calculateTodayStats(now: number) {
  const todayStart = getLocalStartOfDay(now);
  
  const todayQuery = `
    SELECT 
      COUNT(*) as data_points,
      MIN(count) as baseline_count,
      MAX(count) as current_count,
      CASE WHEN COUNT(*) > 0 THEN TRUE ELSE FALSE END as baseline_known
    FROM signatures 
    WHERE timestamp >= $1
  `;

  const result = await pool.query(todayQuery, [todayStart]);
  const row = result.rows[0];
  
  const collected = row.baseline_known ? 
    (Number(row.current_count) - Number(row.baseline_count)) : 0;
  
  const msUntilReset = Math.max(0, todayStart + 24 * 60 * 60 * 1000 - now);
  const hrs = Math.floor(msUntilReset / 3_600_000);
  const mins = Math.floor((msUntilReset % 3_600_000) / 60_000);

  return {
    collected,
    utcStartOfDay: todayStart,
    timeUntilResetText: `${hrs}h ${mins}m`,
    baselineKnown: row.baseline_known,
    dataPointsToday: Number(row.data_points)
  };
}

export const GET: RequestHandler = async (event) => {
  await ensureTable();

  try {
    const now = Date.now();
    const url = new URL(event.request.url);
    
    // Check what data the client wants
    const includeHistory = url.searchParams.get('history') !== 'false';
    const includeRates = url.searchParams.get('rates') !== 'false'; 
    const includeTodayStats = url.searchParams.get('today') !== 'false';
    const limit = parseInt(url.searchParams.get('limit') || '0');

    const clientETag = event.request.headers.get('if-none-match');

    // Build response data based on what's requested
    const responseData: any = {
      metadata: {
        serverTime: now,
        retentionHours: 26
      }
    };

    // Always get basic metadata for ETag generation
    const metadataResult = await pool.query(`
      SELECT 
        COUNT(*) as total_count,
        MIN(timestamp) as oldest_tick,
        MAX(timestamp) as newest_tick
      FROM signatures 
      WHERE timestamp > $1
    `, [now - RETENTION_MS]);

    const metadata = metadataResult.rows[0];
    const totalTicks = Number(metadata.total_count);
    const newestTick = Number(metadata.newest_tick) || 0;

    // Generate ETag
    const etag = `"${totalTicks}-${newestTick}-${Math.floor(now / 60000)}"`;
    
    if (clientETag === etag) {
      return new Response(null, { 
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'no-cache, must-revalidate'
        }
      });
    }

    // Add metadata
    responseData.metadata = {
      ...responseData.metadata,
      totalTicks,
      oldestTick: Number(metadata.oldest_tick) || null,
      newestTick: newestTick || null
    };

    // Conditionally include history (potentially limited)
    if (includeHistory) {
      let historyQuery = `
        SELECT timestamp as ts, count
        FROM signatures 
        WHERE timestamp > $1 
        ORDER BY timestamp ASC
      `;
      const params = [now - RETENTION_MS];
      
      if (limit > 0) {
        historyQuery += ` LIMIT $2`;
        params.push(limit);
      }

      const historyResult = await pool.query(historyQuery, params);
      responseData.ticks = historyResult.rows.map(row => ({
        ts: Number(row.ts),
        count: row.count
      }));
    }

    // Calculate rates server-side if requested
    if (includeRates) {
      responseData.rates = await calculateRates(now);
    }

    // Calculate today stats server-side if requested  
    if (includeTodayStats) {
      responseData.todayStats = await calculateTodayStats(now);
    }

    // Maintain backward compatibility
    responseData.dailyStats = [];
    
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
      'Last-Modified': new Date(now).toUTCString(),
      'X-Tick-Count': totalTicks.toString(),
      'X-Retention': '26h',
      'X-Server-Time': now.toString()
    };
    
    return new Response(JSON.stringify(responseData), { headers });
    
  } catch (error) {
    console.error('Database error:', error);
    
    const errorPayload = { 
      ticks: [], 
      dailyStats: [], 
      metadata: {
        todayStart: getLocalStartOfDay(),
        totalTicks: 0,
        oldestTick: null,
        newestTick: null,
        retentionHours: 26,
        serverTime: Date.now()
      }
    };
    
    return new Response(JSON.stringify(errorPayload), {
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, must-revalidate'
      },
      status: 500
    });
  }
};