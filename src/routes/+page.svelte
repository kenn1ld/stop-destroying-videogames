<!-- ===== Optimized Svelte Component with Circular Buffers ===== -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { writable, derived, get } from 'svelte/store';
  import { browser } from '$app/environment';

  interface Progression { signatureCount: number; goal: number; }
  interface InitiativeInfo { registrationDate: string; closingDate: string; }
  interface Tick { ts: number; count: number; }
  interface RateData {
    perSec: number;
    perMin: number;
    perHour: number;
    perDay: number;
    dataPoints: Record<string, number>;
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MS_PER_HOUR = 60 * 60 * 1000;
  const TZ_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2
  const MAX_RECONNECT_ATTEMPTS = 5;

  // Pre-calculated window constants
  const WINDOWS = {
    perSec: 30 * 1000,
    perMin: 5 * 60 * 1000,
    perHour: 60 * 60 * 1000,
    perDay: MS_PER_DAY
  } as const;

  const CONFIDENCE_THRESHOLDS = {
    perSec: { good: 10, ok: 5 },
    perMin: { good: 50, ok: 20 },
    perHour: { good: 200, ok: 100 },
    perDay: { good: 2_400, ok: 1_200 }
  } as const;

  // ===== Circular Buffer Implementation =====
  class CircularBuffer<T> {
    private buffer: T[];
    private head = 0;
    private size = 0;
    
    constructor(private capacity: number) {
      this.buffer = new Array(capacity);
    }
    
    push(item: T): void {
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      if (this.size < this.capacity) this.size++;
    }
    
    toArray(): T[] {
      if (this.size === 0) return [];
      if (this.size < this.capacity) {
        return this.buffer.slice(0, this.size);
      }
      return [
        ...this.buffer.slice(this.head),
        ...this.buffer.slice(0, this.head)
      ];
    }
    
    filter(predicate: (item: T) => boolean): T[] {
      return this.toArray().filter(predicate);
    }
    
    get length(): number { return this.size; }
    
    clear(): void {
      this.head = 0;
      this.size = 0;
    }
    
    getMemoryUsage(): number {
      return this.size;
    }
  }

  // ===== Optimized Tick Manager =====
  class TickManager {
    // Use circular buffers to limit memory usage
    private recentTicks = new CircularBuffer<Tick>(3600); // Last hour at 1/sec
    private minuteTicks = new CircularBuffer<Tick>(1440); // Last day at 1/min
    private hourTicks = new CircularBuffer<Tick>(720); // Last month at 1/hour
    
    private lastMinuteAgg = 0;
    private lastHourAgg = 0;
    
    // Cache for expensive calculations
    private rateCache: { rates: RateData; timestamp: number } | null = null;
    private todayCache: { data: any; timestamp: number; startOfDay: number } | null = null;
    private readonly CACHE_TTL = 5000; // 5 second cache
    
    addTick(tick: Tick): void {
      this.recentTicks.push(tick);
      
      // Aggregate to minute-level data
      const currentMinute = Math.floor(tick.ts / 60000);
      if (currentMinute > this.lastMinuteAgg) {
        this.minuteTicks.push(tick);
        this.lastMinuteAgg = currentMinute;
      }
      
      // Aggregate to hour-level data  
      const currentHour = Math.floor(tick.ts / 3600000);
      if (currentHour > this.lastHourAgg) {
        this.hourTicks.push(tick);
        this.lastHourAgg = currentHour;
      }
      
      // Invalidate caches
      this.rateCache = null;
      this.todayCache = null;
    }
    
    getRates(): RateData {
      const now = Date.now();
      
      // Return cached rates if still valid
      if (this.rateCache && (now - this.rateCache.timestamp) < this.CACHE_TTL) {
        return this.rateCache.rates;
      }
      
      const rates = this.calculateRates(now);
      this.rateCache = { rates, timestamp: now };
      return rates;
    }
    
    private calculateRates(now: number): RateData {
      const recent = this.recentTicks.filter(t => now - t.ts <= 30000); // 30s
      const minute = this.recentTicks.filter(t => now - t.ts <= 300000); // 5m  
      const hour = this.minuteTicks.filter(t => now - t.ts <= 3600000); // 1h
      const day = this.hourTicks.filter(t => now - t.ts <= 86400000); // 1d
      
      return {
        perSec: this.calcRate(recent, 1),
        perMin: this.calcRate(minute, 60),
        perHour: this.calcRate(hour, 3600),
        perDay: this.calcRate(day, 86400),
        dataPoints: {
          perSec: recent.length,
          perMin: minute.length,
          perHour: hour.length,
          perDay: day.length
        }
      };
    }
    
    private calcRate(ticks: Tick[], multiplier: number): number {
      if (ticks.length < 2) return 0;
      
      const sorted = ticks.sort((a, b) => a.ts - b.ts);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      
      const dt = (last.ts - first.ts) / 1000;
      const dc = last.count - first.count;
      
      return dt > 0 ? Math.max(0, (dc / dt) * multiplier) : 0;
    }
    
    getTodayData(startOfDay: number): any {
      const now = Date.now();
      
      // Return cached data if valid
      if (this.todayCache && 
          this.todayCache.startOfDay === startOfDay &&
          (now - this.todayCache.timestamp) < this.CACHE_TTL) {
        return this.todayCache.data;
      }
      
      const todayTicks = this.recentTicks.filter(t => t.ts >= startOfDay);
      
      if (todayTicks.length === 0) {
        const msUntilReset = Math.max(0, startOfDay + MS_PER_DAY - now);
        const hrs = Math.floor(msUntilReset / 3_600_000);
        const mins = Math.floor((msUntilReset % 3_600_000) / 60_000);
        
        const data = {
          collected: 0,
          utcStartOfDay: startOfDay,
          timeUntilResetText: `${hrs}h ${mins}m`,
          baselineKnown: false,
          dataPointsToday: 0
        };
        
        this.todayCache = { data, timestamp: now, startOfDay };
        return data;
      }
      
      const sorted = todayTicks.sort((a, b) => a.ts - b.ts);
      const baseline = sorted[0].count;
      const current = sorted[sorted.length - 1].count;
      const collected = Math.max(0, current - baseline);
      
      const msUntilReset = Math.max(0, startOfDay + MS_PER_DAY - now);
      const hrs = Math.floor(msUntilReset / 3_600_000);
      const mins = Math.floor((msUntilReset % 3_600_000) / 60_000);
      
      const data = {
        collected,
        utcStartOfDay: startOfDay,
        timeUntilResetText: `${hrs}h ${mins}m`,
        baselineKnown: true,
        dataPointsToday: todayTicks.length
      };
      
      this.todayCache = { data, timestamp: now, startOfDay };
      return data;
    }
    
    getMemoryUsage(): { recent: number; minute: number; hour: number; total: number } {
      const recent = this.recentTicks.length;
      const minute = this.minuteTicks.length;
      const hour = this.hourTicks.length;
      return { recent, minute, hour, total: recent + minute + hour };
    }
    
    clear(): void {
      this.recentTicks.clear();
      this.minuteTicks.clear(); 
      this.hourTicks.clear();
      this.rateCache = null;
      this.todayCache = null;
    }
    
    // Get recent tick count for status
    getRecentTickCount(): number {
      const now = Date.now();
      return this.recentTicks.filter(t => now - t.ts <= 10000).length; // Last 10 seconds
    }
  }

  // ===== Utility Functions =====
  function parseEUDate(input: string): Date {
    const [d, m, y] = input.split('/').map(Number);
    return new Date(y, m - 1, d);
  }

  function getLocalStartOfDay(date: Date = new Date()): number {
    const ts = date.getTime() + TZ_OFFSET_MS;
    const d = new Date(ts);
    const utcMid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return utcMid - TZ_OFFSET_MS;
  }

  function calculateDailyQuota(sigsLeft: number, daysLeft: number): number {
    return daysLeft > 0 ? Math.ceil(sigsLeft / daysLeft) : sigsLeft;
  }

  // ===== Stores =====
  const progression = writable<Progression>({ signatureCount: 0, goal: 1 });
  const initiative = writable<InitiativeInfo>({ registrationDate: '', closingDate: '' });
  const error = writable<string | null>(null);
  const lastUpdate = writable<number>(0);
  
  // Initialize tick manager
  const tickManager = new TickManager();
  const rateStore = writable<RateData>({
    perSec: 0, perMin: 0, perHour: 0, perDay: 0,
    dataPoints: { perSec: 0, perMin: 0, perHour: 0, perDay: 0 }
  });

  // Optimized today's data calculation
  const todayData = derived([rateStore], ([_]) => {
    const start = getLocalStartOfDay();
    return tickManager.getTodayData(start);
  });

  // Optimized quota check
  const metToday = derived(
    [todayData, progression, initiative],
    ([$today, $prog, $init]) => {
      if (!$init.registrationDate || !$today.baselineKnown) return false;
      
      const now = Date.now();
      const close = parseEUDate($init.closingDate);
      const daysLeft = Math.max((close.getTime() - now) / MS_PER_DAY, 0);
      const sigsLeft = $prog.goal - $prog.signatureCount;
      const needed = calculateDailyQuota(sigsLeft, daysLeft);
      
      return $today.collected >= needed;
    }
  );

  // Optimized projections with shared calculations
  const projections = derived([rateStore, progression, initiative], 
    ([$rate, $prog, $init]) => {
      const sigsLeft = $prog.goal - $prog.signatureCount;
      let dailyQuota = 0;
      let daysRemaining = 0;
      
      if ($init.closingDate) {
        const now = Date.now();
        const close = parseEUDate($init.closingDate);
        daysRemaining = Math.max((close.getTime() - now) / MS_PER_DAY, 0);
        dailyQuota = calculateDailyQuota(sigsLeft, daysRemaining);
      }
      
      const currentRatePerDay = $rate.perDay;
      const daysToGoalAtCurrentRate = currentRatePerDay > 0 ? sigsLeft / currentRatePerDay : Infinity;
      const baseTime = Date.now();
      
      return {
        timeToGoal: {
          atCurrentRate: daysToGoalAtCurrentRate,
          atNeededRate: daysRemaining
        },
        projectedCompletion: {
          current: currentRatePerDay > 0 ? new Date(baseTime + daysToGoalAtCurrentRate * MS_PER_DAY) : null,
          needed: dailyQuota > 0 ? new Date(baseTime + daysRemaining * MS_PER_DAY) : null
        },
        dailyQuota,
        daysRemaining
      };
    }
  );

  // Shared calculation for daily quota display
  const dailyQuotaNeeded = derived([progression, initiative], ([$prog, $init]) => {
    if (!$init.registrationDate) return 0;
    
    const now = Date.now();
    const close = parseEUDate($init.closingDate);
    const daysLeft = Math.max((close.getTime() - now) / MS_PER_DAY, 0);
    const sigsLeft = $prog.goal - $prog.signatureCount;
    
    return calculateDailyQuota(sigsLeft, daysLeft);
  });

  // ===== Network Management =====
  let handle: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempts = 0;
  let lastETag: string | null = null;
  let lastSent: Tick | null = null;
  let memoryMonitorHandle: ReturnType<typeof setInterval> | null = null;

  // Request deduplication
  let pendingRequest = false;
  let lastRequestTime = 0;
  const MIN_REQUEST_INTERVAL = 500; // Minimum 500ms between requests

  onMount(() => {
    if (!browser) return;
    
    (async () => { 
      await loadHistory(); 
      await tick(); 
      handle = setInterval(tick, 1000);
      
      // Memory monitoring
      memoryMonitorHandle = setInterval(() => {
        const usage = tickManager.getMemoryUsage();
        if (usage.total > 10000) { // Log if using more than 10k ticks
          console.log(`Tick Manager Memory: ${usage.total} total (${usage.recent} recent, ${usage.minute} minute, ${usage.hour} hour)`);
        }
      }, 60000); // Every minute
    })();
    
    return () => {
      if (handle) clearInterval(handle);
      if (memoryMonitorHandle) clearInterval(memoryMonitorHandle);
    };
  });

  onDestroy(() => {
    if (handle) clearInterval(handle);
    if (memoryMonitorHandle) clearInterval(memoryMonitorHandle);
  });

  async function loadHistory() {
    const now = Date.now();
    if (pendingRequest || now - lastRequestTime < MIN_REQUEST_INTERVAL) {
      return;
    }
    
    pendingRequest = true;
    lastRequestTime = now;
    
    try {
      const headers: Record<string, string> = {};
      if (lastETag) headers['If-None-Match'] = lastETag;
      
      // Limit initial load to prevent memory issues
      const res = await fetch('/api/tick-history?limit=3600&compress=true', { headers });
      
      if (res.status === 304) { 
        reconnectAttempts = 0; 
        return; 
      }
      
      if (res.ok) {
        const data = await res.json();
        
        // Clear and repopulate tick manager
        tickManager.clear();
        
        if (Array.isArray(data.ticks)) {
          // Add ticks in chronological order
          data.ticks
            .sort((a: Tick, b: Tick) => a.ts - b.ts)
            .forEach((tick: Tick) => tickManager.addTick(tick));
          
          // Update rate store
          rateStore.set(tickManager.getRates());
          
          console.log(`Loaded ${data.ticks.length} historical ticks. Memory usage:`, tickManager.getMemoryUsage());
        }
        
        lastETag = res.headers.get('ETag');
        reconnectAttempts = 0;
        
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      console.error('Failed to load history:', e);
      reconnectAttempts++;
      tickManager.clear();
      rateStore.set({
        perSec: 0, perMin: 0, perHour: 0, perDay: 0,
        dataPoints: { perSec: 0, perMin: 0, perHour: 0, perDay: 0 }
      });
    } finally {
      pendingRequest = false;
    }
  }

  async function saveTickToServer(ts: number, count: number, retry = 0) {
    // Enhanced deduplication
    if (lastSent?.ts === ts && lastSent.count === count) return;
    
    // Check recent tick manager data
    const recentTicks = tickManager.getRecentTickCount();
    if (recentTicks > 0) {
      // Don't send if we have very recent data with same count
      const currentRates = tickManager.getRates();
      if (currentRates.perSec < 0.1 && retry === 0) return; // Skip if no recent activity
    }
    
    try {
      const res = await fetch('/api/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts, count })
      });
      
      if (res.status === 429) {
        const delay = parseInt(res.headers.get('Retry-After') || '60') * 1000;
        await new Promise(r => setTimeout(r, delay));
        return;
      }
      
      if (res.status === 503) {
        await new Promise(r => setTimeout(r, 1000));
        if (retry < 2) return saveTickToServer(ts, count, retry + 1);
        return;
      }
      
      if (!res.ok) {
        console.warn(`Server responded with ${res.status}`);
        return;
      }
      
      lastSent = { ts, count };
      reconnectAttempts = 0;
    } catch (e) {
      console.error('Failed saving tick:', e);
      
      if (retry < 3) {
        await new Promise(r => setTimeout(r, Math.pow(2, retry) * 1000));
        return saveTickToServer(ts, count, retry + 1);
      }
      
      reconnectAttempts++;
      
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) { 
        await loadHistory(); 
        reconnectAttempts = 0; 
      }
    }
  }

  async function tick() {
    if (pendingRequest) return; // Skip if already processing
    
    try {
      const [progRes, infoRes] = await Promise.all([
        fetch('https://eci.ec.europa.eu/045/public/api/report/progression'),
        fetch('https://eci.ec.europa.eu/045/public/api/initiative/description')
      ]);
      
      const prog = await progRes.json();
      const info = await infoRes.json();

      progression.set({ signatureCount: prog.signatureCount, goal: prog.goal });
      initiative.set({
        registrationDate: info.initiativeInfo.registrationDate,
        closingDate: info.initiativeInfo.closingDate
      });
      
      error.set(null);
      lastUpdate.set(Date.now());

      const nowTs = Date.now();
      
      // Add to tick manager
      tickManager.addTick({ ts: nowTs, count: prog.signatureCount });
      
      // Update rate store with cached calculation
      rateStore.set(tickManager.getRates());
      
      // Save to server (with enhanced deduplication)
      await saveTickToServer(nowTs, prog.signatureCount);
      
    } catch (e) {
      error.set((e as Error).message);
      console.error('Tick error:', e);
    }
  }

  // ===== UI Helper Functions =====
  function getConfidenceIndicator(dp: number, type: keyof typeof CONFIDENCE_THRESHOLDS) {
    const threshold = CONFIDENCE_THRESHOLDS[type];
    if (dp >= threshold.good) return '✅';
    if (dp >= threshold.ok) return '⚠️';
    return '⏳';
  }

  function formatDuration(days: number): string {
    if (days === Infinity) return 'Never at current rate';
    if (days < 0) return 'Already passed';
    
    const totalDays = Math.floor(days);
    
    if (totalDays === 0) {
      const hours = Math.floor(days * 24);
      return hours === 0 ? 'Less than 1 hour' : `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    
    if (totalDays < 7) {
      return `${totalDays} day${totalDays !== 1 ? 's' : ''}`;
    }
    
    if (totalDays < 365) {
      const weeks = Math.floor(totalDays / 7);
      const remainingDays = totalDays % 7;
      
      if (remainingDays === 0) {
        return `${weeks} week${weeks !== 1 ? 's' : ''}`;
      }
      return `${weeks} week${weeks !== 1 ? 's' : ''} ${remainingDays} day${remainingDays !== 1 ? 's' : ''}`;
    }
    
    const years = Math.floor(totalDays / 365);
    const remainingDaysAfterYears = totalDays % 365;
    const months = Math.floor(remainingDaysAfterYears / 30);
    const remainingDaysAfterMonths = remainingDaysAfterYears % 30;
    
    let result = `${years} year${years !== 1 ? 's' : ''}`;
    if (months > 0) {
      result += ` ${months} month${months !== 1 ? 's' : ''}`;
    }
    if (remainingDaysAfterMonths > 0 && months === 0) {
      result += ` ${remainingDaysAfterMonths} day${remainingDaysAfterMonths !== 1 ? 's' : ''}`;
    }
    
    return result;
  }

  function formatDate(d: Date | null): string {
    if (!d) return 'Unknown';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function getConnectionStatus(ageMs: number, reconnects: number): string {
    if (reconnects > 0) return '🔄 Reconnecting...';
    if (ageMs > 30_000) return '❌ Connection lost';
    if (ageMs > 10_000) return '⚠️ Connection issue';
    return '🟢 Live';
  }

  function shareApp() {
    const $prog = get(progression);
    const $rate = get(rateStore);
    const shareText = `🎮 Stop Destroying Videogames petition: ${$prog.signatureCount.toLocaleString()} signatures! Gaining ${Math.round($rate.perHour)}/hour. Help reach ${$prog.goal.toLocaleString()}!`;
    
    if (navigator.share) {
      navigator.share({ 
        title: 'Stop Destroying Videogames - Live Tracker', 
        text: shareText, 
        url: window.location.href 
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(`${shareText} ${window.location.href}`)
        .then(() => alert('Share text copied!'))
        .catch(() => alert(`Share: ${shareText} ${window.location.href}`));
    }
  }

  // Performance monitoring
  $: memoryUsage = tickManager.getMemoryUsage();
  $: recentActivity = tickManager.getRecentTickCount();
</script>

<main class="min-h-screen bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 flex items-center justify-center p-4 sm:p-6">
  <div class="w-full max-w-lg bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-6 sm:p-8 space-y-4 sm:space-y-6">
    
    <!-- Message about today's data -->
    <div class="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300">
      Today's signature count is wrong due to a system update. Will fix itself at midnight.
    </div>

    <div class="flex items-start justify-between gap-4">
      <h1 class="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-gray-100 leading-tight">Stop Destroying Videogames</h1>
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-xs text-gray-500 whitespace-nowrap">{getConnectionStatus(Date.now() - $lastUpdate, reconnectAttempts)}</span>
        <button on:click={shareApp} class="p-2 text-gray-500 hover:text-blue-600 transition-colors" title="Share this tracker">📤</button>
      </div>
    </div>

    {#if $error}
      <div class="text-center p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
        <p class="text-red-600 dark:text-red-400">Error: {$error}</p>
        <p class="text-xs text-red-500 dark:text-red-300 mt-1">Retrying... ({reconnectAttempts}/{MAX_RECONNECT_ATTEMPTS})</p>
      </div>
    {:else}

      <div class="grid grid-cols-2 gap-4 text-sm text-gray-700 dark:text-gray-300">
        <div class="flex items-center justify-between">
          <span>Rate/sec:</span>
          <span class="flex items-center gap-1">
            <strong>{$rateStore.perSec.toFixed(2)}</strong>
            <span class="text-xs">{getConfidenceIndicator($rateStore.dataPoints.perSec, 'perSec')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/min:</span>
          <span class="flex items-center gap-1">
            <strong>{$rateStore.perMin.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($rateStore.dataPoints.perMin, 'perMin')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/hr:</span>
          <span class="flex items-center gap-1">
            <strong>{$rateStore.perHour.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($rateStore.dataPoints.perHour, 'perHour')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/day:</span>
          <span class="flex items-center gap-1">
            <strong>{$rateStore.perDay.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($rateStore.dataPoints.perDay, 'perDay')}</span>
          </span>
        </div>
      </div>

      <div class="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 space-y-2">
        <div class="flex justify-between items-center">
          <h3 class="font-semibold text-blue-900 dark:text-blue-100 text-sm">📊 Projections</h3>
        </div>
        
        <div class="grid grid-cols-2 gap-4 text-xs text-blue-800 dark:text-blue-200">
          <div>
            <div class="font-medium">At current rate:</div>
            <div>{formatDuration($projections.timeToGoal.atCurrentRate)}</div>
            <div class="text-blue-600 dark:text-blue-300">{formatDate($projections.projectedCompletion.current)}</div>
          </div>
          <div>
            <div class="font-medium">If quota met daily:</div>
            <div>{formatDuration($projections.timeToGoal.atNeededRate)}</div>
            <div class="text-blue-600 dark:text-blue-300">{formatDate($projections.projectedCompletion.needed)}</div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-4 text-sm text-gray-700 dark:text-gray-300 text-center">
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">Signatures Today (UTC+2)</div>
          <strong class="text-lg">{$todayData.collected.toLocaleString()}</strong>
          <div class="text-xs text-gray-400 mt-1">Resets in {$todayData.timeUntilResetText}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">Daily Quota</div>
          {#if $todayData.baselineKnown}
            {#if $metToday}
              <span class="text-green-600 dark:text-green-400 font-semibold">✅ Met</span>
            {:else}
              <span class="text-red-600 dark:text-red-400 font-semibold">❌ Not met</span>
            {/if}
          {:else}
            <span class="text-yellow-600 dark:text-yellow-400 font-semibold">❓ Unknown</span>
          {/if}
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">Today's Data Points</div>
          <strong class="text-lg">{$todayData.dataPointsToday}</strong>
        </div>
      </div>

      <div class="text-xs text-gray-500 dark:text-gray-400 text-center">
        Data points: {$rateStore.dataPoints.perSec}s / {$rateStore.dataPoints.perMin}m / {$rateStore.dataPoints.perHour}h / {$rateStore.dataPoints.perDay}d
        <br>
        Memory: {memoryUsage.total} ticks ({memoryUsage.recent}+{memoryUsage.minute}+{memoryUsage.hour}) | Activity: {recentActivity}
      </div>

      <div class="mt-4 grid grid-cols-2 gap-4 text-sm text-gray-600 dark:text-gray-400">
        <div><strong>Registered:</strong> {$initiative.registrationDate}</div>
        <div><strong>Closes:</strong> {$initiative.closingDate}</div>
      </div>

      <div class="space-y-2">
        <div class="flex justify-between items-baseline">
          <span class="text-3xl font-mono text-blue-600 dark:text-blue-400">{$progression.signatureCount.toLocaleString()}</span>
          <span class="text-lg text-gray-500 dark:text-gray-400">/ {$progression.goal.toLocaleString()}</span>
        </div>
        <div class="relative h-4 bg-gray-300 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            class="absolute inset-0 bg-gradient-to-r from-blue-400 via-blue-600 to-purple-600 transition-[width] duration-1000 ease-out"
            style="width: {Math.min(($progression.signatureCount / $progression.goal) * 100, 100)}%;"
          ></div>
        </div>
        <div class="text-right text-sm text-gray-600 dark:text-gray-400">
          {(Math.min(($progression.signatureCount / $progression.goal) * 100, 100)).toFixed(1)}%
        </div>
      </div>

      <div class="space-y-2">
        <div class="flex justify-between items-baseline">
          <span class="text-base text-gray-700 dark:text-gray-300">Time elapsed</span>
          <span class="text-sm text-gray-500 dark:text-gray-400">
            {Math.floor((Date.now() - parseEUDate($initiative.registrationDate).getTime()) / MS_PER_DAY)} / {Math.ceil((parseEUDate($initiative.closingDate).getTime() - parseEUDate($initiative.registrationDate).getTime()) / MS_PER_DAY)} days
          </span>
        </div>
        <div class="relative h-3 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
          <div
            class="absolute inset-0 bg-gradient-to-r from-green-400 via-yellow-400 to-red-400 transition-[width] duration-1000 ease-out"
            style="width: {Math.min(((Date.now() - parseEUDate($initiative.registrationDate).getTime()) / MS_PER_DAY) / ((parseEUDate($initiative.closingDate).getTime() - parseEUDate($initiative.registrationDate).getTime()) / MS_PER_DAY) * 100, 100)}%;"
          ></div>
        </div>
      </div>

      <div class="text-center text-sm text-gray-700 dark:text-gray-300">
        We need <span class="font-semibold">{$dailyQuotaNeeded.toLocaleString()}</span> signatures/day to reach <strong>{$progression.goal.toLocaleString()}</strong>.
      </div>

      <div class="text-xs text-gray-500 dark:text-gray-400 text-center border-t pt-3">
        <div class="grid grid-cols-3 gap-2">
          <span>✅ Reliable</span>
          <span>⚠️ Stabilizing</span>
          <span>⏳ Warming up</span>
        </div>
      </div>

      <div class="text-xs text-center text-gray-400 dark:text-gray-500 border-t pt-3">
        <div>Live tracker • Updates every second • UTC+2 timezone • Daily reset</div>
        <div class="mt-1">
          <a href="https://eci.ec.europa.eu/045/public/" target="_blank" class="text-blue-500 hover:text-blue-600 transition-colors">
            Sign the petition →
          </a>
        </div>
        
        <!-- Performance indicator for development -->
        {#if memoryUsage.total > 5000}
          <div class="mt-2 text-xs text-orange-500">
            High memory usage detected: {memoryUsage.total} ticks
          </div>
        {/if}
        
        {#if recentActivity === 0 && Date.now() - $lastUpdate > 15000}
          <div class="mt-1 text-xs text-yellow-500">
            No recent server activity detected
          </div>
        {/if}
      </div>

    {/if}
  </div>
</main>

<style>
  :global(.svelte) { 
    animation: fadeIn 0.8s ease-out both; 
  }
  
  @keyframes fadeIn { 
    from { 
      opacity: 0; 
      transform: translateY(10px);
    } 
    to { 
      opacity: 1; 
      transform: translateY(0);
    } 
  }
  
  /* Optimize repaints for frequently updating elements */
  :global(.font-mono) {
    will-change: contents;
  }
  
  /* Smooth transitions for progress bars */
  :global(.transition-\[width\]) {
    will-change: width;
  }
</style>