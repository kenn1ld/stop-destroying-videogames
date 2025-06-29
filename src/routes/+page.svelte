<!-- ===== Optimized client with server-side calculations ===== -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { writable, derived, get } from 'svelte/store';
  import { browser } from '$app/environment';

  interface Progression { signatureCount: number; goal: number; }
  interface InitiativeInfo { registrationDate: string; closingDate: string; }
  interface Tick { ts: number; count: number; }
  
  interface ServerRates {
    perSec: number;
    perMin: number;
    perHour: number;
    perDay: number;
    dataPoints: {
      perSec: number;
      perMin: number;
      perHour: number;
      perDay: number;
    };
  }

  interface TodayStats {
    collected: number;
    utcStartOfDay: number;
    timeUntilResetText: string;
    baselineKnown: boolean;
    dataPointsToday: number;
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MAX_RECONNECT_ATTEMPTS = 5;

  function parseEUDate(input: string): Date {
    const [d, m, y] = input.split('/').map(Number);
    return new Date(y, m - 1, d);
  }

  function calculateDailyQuota(sigsLeft: number, daysLeft: number): number {
    return daysLeft > 0 ? Math.ceil(sigsLeft / daysLeft) : sigsLeft;
  }

  // Core stores
  const progression = writable<Progression>({ signatureCount: 0, goal: 1 });
  const initiative = writable<InitiativeInfo>({ registrationDate: '', closingDate: '' });
  const error = writable<string | null>(null);
  const lastUpdate = writable<number>(0);
  
  // Server-calculated data stores
  const serverRates = writable<ServerRates>({
    perSec: 0, perMin: 0, perHour: 0, perDay: 0,
    dataPoints: { perSec: 0, perMin: 0, perHour: 0, perDay: 0 }
  });
  const todayStats = writable<TodayStats>({
    collected: 0,
    utcStartOfDay: 0,
    timeUntilResetText: '0h 0m',
    baselineKnown: false,
    dataPointsToday: 0
  });

  // Optional history store (only loaded when needed)
  const history = writable<Tick[]>([]);
  const historyLoaded = writable<boolean>(false);

  // Quota check using server data
  const metToday = derived(
    [todayStats, progression, initiative],
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

  // Projections using server rates
  const projections = derived([serverRates, progression, initiative], 
    ([$rates, $prog, $init]) => {
      const sigsLeft = $prog.goal - $prog.signatureCount;
      let dailyQuota = 0;
      let daysRemaining = 0;
      
      if ($init.closingDate) {
        const now = Date.now();
        const close = parseEUDate($init.closingDate);
        daysRemaining = Math.max((close.getTime() - now) / MS_PER_DAY, 0);
        dailyQuota = calculateDailyQuota(sigsLeft, daysRemaining);
      }
      
      const currentRatePerDay = $rates.perDay;
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

  const dailyQuotaNeeded = derived([progression, initiative], ([$prog, $init]) => {
    if (!$init.registrationDate) return 0;
    
    const now = Date.now();
    const close = parseEUDate($init.closingDate);
    const daysLeft = Math.max((close.getTime() - now) / MS_PER_DAY, 0);
    const sigsLeft = $prog.goal - $prog.signatureCount;
    
    return calculateDailyQuota(sigsLeft, daysLeft);
  });

  let handle: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempts = 0;
  let lastETag: string | null = null;
  let lastSent: Tick | null = null;

  onMount(() => {
    if (!browser) return;
    
    (async () => { 
      await loadServerData(); 
      await tick(); 
      handle = setInterval(tick, 1000); 
    })();
    
    return () => {
      if (handle) clearInterval(handle);
    };
  });

  // Load optimized server data (no history by default)
  async function loadServerData(includeHistory = false) {
    try {
      const params = new URLSearchParams({
        history: includeHistory.toString(),
        rates: 'true',
        today: 'true'
      });
      
      const headers: Record<string, string> = {};
      if (lastETag) headers['If-None-Match'] = lastETag;
      
      const res = await fetch(`/api/tick-history?${params}`, { headers });
      if (res.status === 304) { 
        reconnectAttempts = 0; 
        return; 
      }
      
      if (res.ok) {
        const data = await res.json();
        
        // Update server-calculated data
        if (data.rates) {
          serverRates.set(data.rates);
        }
        
        if (data.todayStats) {
          todayStats.set(data.todayStats);
        }
        
        // Only update history if it was requested and provided
        if (includeHistory && Array.isArray(data.ticks)) {
          history.set(data.ticks);
          historyLoaded.set(true);
        }
        
        lastETag = res.headers.get('ETag');
        reconnectAttempts = 0;
        
        if (data.metadata) {
          console.log('Server metadata:', data.metadata);
        }
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      console.error('Failed to load server data:', e);
      reconnectAttempts++;
      
      // Reset to safe defaults
      serverRates.set({
        perSec: 0, perMin: 0, perHour: 0, perDay: 0,
        dataPoints: { perSec: 0, perMin: 0, perHour: 0, perDay: 0 }
      });
    }
  }

  // Load full history on demand (for charts, etc.)
  async function loadFullHistory() {
    if (get(historyLoaded)) return; // Already loaded
    await loadServerData(true);
  }

  async function saveTickToServer(ts: number, count: number, retry = 0) {
    if (lastSent?.ts === ts && lastSent.count === count) return;
    
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
        return saveTickToServer(ts, count, retry + 1);
      }
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
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
        await loadServerData(); 
        reconnectAttempts = 0; 
      }
    }
  }

  async function tick() {
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
      await saveTickToServer(nowTs, prog.signatureCount);
      
      // Refresh server calculations periodically
      if (nowTs % 10000 < 1000) { // Every ~10 seconds
        await loadServerData();
      }
    } catch (e) {
      error.set((e as Error).message);
      console.error('Tick error:', e);
    }
  }

  function getConfidenceIndicator(dp: number, type: 'perSec' | 'perMin' | 'perHour' | 'perDay') {
    const thresholds = {
      perSec: { good: 10, ok: 5 },
      perMin: { good: 50, ok: 20 },
      perHour: { good: 200, ok: 100 },
      perDay: { good: 2_400, ok: 1_200 }
    };
    
    const threshold = thresholds[type];
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
    return ageMs > 10_000 ? '⚠️ Connection issue' : '🟢 Live';
  }

  function shareApp() {
    const $prog = get(progression);
    const $rates = get(serverRates);
    const shareText = `🎮 Stop Destroying Videogames petition: ${$prog.signatureCount.toLocaleString()} signatures! Gaining ${Math.round($rates.perHour)}/hour. Help reach ${$prog.goal.toLocaleString()}!`;
    
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

  // Function to show detailed history view (loads full data)
  async function showDetailedView() {
    await loadFullHistory();
    // Could open a modal or navigate to detailed page
  }
</script>

<main class="min-h-screen bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 flex items-center justify-center p-4 sm:p-6">
  <div class="w-full max-w-lg bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-6 sm:p-8 space-y-4 sm:space-y-6">
    
    <!-- Performance improvement notice -->
    <div class="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-sm text-green-700 dark:text-green-300">
      ⚡ Due to corruption issues, the tracker shows wrong numbers today. Currently fixing the issue. The problem should be fixed before tomorrow.
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

      <!-- Server-calculated rates -->
      <div class="grid grid-cols-2 gap-4 text-sm text-gray-700 dark:text-gray-300">
        <div class="flex items-center justify-between">
          <span>Rate/sec:</span>
          <span class="flex items-center gap-1">
            <strong>{$serverRates.perSec.toFixed(2)}</strong>
            <span class="text-xs">{getConfidenceIndicator($serverRates.dataPoints.perSec, 'perSec')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/min:</span>
          <span class="flex items-center gap-1">
            <strong>{$serverRates.perMin.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($serverRates.dataPoints.perMin, 'perMin')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/hr:</span>
          <span class="flex items-center gap-1">
            <strong>{$serverRates.perHour.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($serverRates.dataPoints.perHour, 'perHour')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/day:</span>
          <span class="flex items-center gap-1">
            <strong>{$serverRates.perDay.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($serverRates.dataPoints.perDay, 'perDay')}</span>
          </span>
        </div>
      </div>

      <div class="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 space-y-2">
        <div class="flex justify-between items-center">
          <h3 class="font-semibold text-blue-900 dark:text-blue-100 text-sm">📊 Projections</h3>
        </div>
        
        <div class="grid grid-cols-2 gap-4 text-xs text-blue-800 dark:text-blue-200">
          <div>
            <div class="text-blue-600 dark:text-blue-300">{formatDate($projections.projectedCompletion.current)}</div>
          </div>
          <div>
            <div class="font-medium">If quota met daily:</div>
            <div>{formatDuration($projections.timeToGoal.atNeededRate)}</div>
            <div class="text-blue-600 dark:text-blue-300">{formatDate($projections.projectedCompletion.needed)}</div>
          </div>
        </div>
      </div>

      <!-- Server-calculated today stats -->
      <div class="grid grid-cols-3 gap-4 text-sm text-gray-700 dark:text-gray-300 text-center">
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">Signatures Today (UTC+2)</div>
          <strong class="text-lg">{$todayStats.collected.toLocaleString()}</strong>
          <div class="text-xs text-gray-400 mt-1">Resets in {$todayStats.timeUntilResetText}</div>
        </div>
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">Daily Quota</div>
          {#if $todayStats.baselineKnown}
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
          <strong class="text-lg">{$todayStats.dataPointsToday}</strong>
        </div>
      </div>

      <div class="text-xs text-gray-500 dark:text-gray-400 text-center">
        Data points: {$serverRates.dataPoints.perSec}s / {$serverRates.dataPoints.perMin}m / {$serverRates.dataPoints.perHour}h / {$serverRates.dataPoints.perDay}d
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

      <!-- Optional: Button to load detailed history -->
      {#if !$historyLoaded}
        <div class="text-center">
          <button 
            on:click={showDetailedView}
            class="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            📈 Load Detailed History
          </button>
        </div>
      {/if}

      <div class="text-xs text-gray-500 dark:text-gray-400 text-center border-t pt-3">
        <div class="grid grid-cols-3 gap-2">
          <span>✅ Reliable</span>
          <span>⚠️ Stabilizing</span>
          <span>⏳ Warming up</span>
        </div>
      </div>

      <div class="text-xs text-center text-gray-400 dark:text-gray-500 border-t pt-3">
        <div>⚡ Server-optimized • Updates every second • UTC+2 timezone • Daily reset</div>
        <div class="mt-1">
          <a href="https://eci.ec.europa.eu/045/public/" target="_blank" class="text-blue-500 hover:text-blue-600 transition-colors">
            Sign the petition →
          </a>
        </div>
      </div>

    {/if}
  </div>
</main>

<style>
  :global(.svelte) { animation: fadeIn 0.8s ease-out both; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(10px);} to { opacity: 1; transform: translateY(0);} }
</style>