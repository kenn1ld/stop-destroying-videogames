<script lang="ts">
  import { onMount } from 'svelte';
  import { writable, derived } from 'svelte/store';
  import { browser } from '$app/environment';

  // ─── TYPES ───────────────────────────────────────────────────────────────
  interface Progression { signatureCount: number; goal: number; }
  interface InitiativeInfo { registrationDate: string; closingDate: string; }
  interface Tick { ts: number; count: number; }

  // ─── HELPERS ─────────────────────────────────────────────────────────────
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  function parseEUDate(input: string) {
    const [d, m, y] = input.split('/').map(Number);
    return new Date(y, m - 1, d);
  }
  const HISTORY_KEY = 'eci-history';

  // ─── STORES ───────────────────────────────────────────────────────────────
  const progression = writable<Progression>({ signatureCount: 0, goal: 1 });
  const initiative  = writable<InitiativeInfo>({ registrationDate: '', closingDate: '' });
  const error       = writable<string | null>(null);
  const lastUpdate  = writable<number>(0);

  // history of ticks - now using server-side storage
  const history = writable<Tick[]>([]);

  // derive averaged live rate with proper time windows
  const rate = derived(history, $h => {
    const now = Date.now();
    
    // Different time windows for different rates
    const WINDOWS = {
      perSec: 30 * 1000,        // 30 seconds for per-second rate
      perMin: 5 * 60 * 1000,    // 5 minutes for per-minute rate  
      perHour: 30 * 60 * 1000,  // 30 minutes for per-hour rate
      perDay: 4 * 60 * 60 * 1000 // 4 hours for per-day rate
    };

    function calculateRate(windowMs: number, targetUnit: number) {
      const windowTicks = $h.filter(t => now - t.ts <= windowMs);
      
      if (windowTicks.length >= 2) {
        const sortedTicks = windowTicks.sort((a, b) => a.ts - b.ts);
        const first = sortedTicks[0];
        const last = sortedTicks[sortedTicks.length - 1];
        
        const deltaTime = (last.ts - first.ts) / 1000; // seconds
        const deltaCount = last.count - first.count;
        
        if (deltaTime > 0) {
          const perSecond = deltaCount / deltaTime;
          return perSecond * targetUnit;
        }
      }
      
      // Fallback: use last two ticks if available
      if ($h.length >= 2) {
        const sorted = [...$h].sort((a, b) => a.ts - b.ts);
        const a = sorted[sorted.length - 2];
        const b = sorted[sorted.length - 1];
        
        const deltaTime = (b.ts - a.ts) / 1000;
        const deltaCount = b.count - a.count;
        
        if (deltaTime > 0) {
          const perSecond = deltaCount / deltaTime;
          return perSecond * targetUnit;
        }
      }
      
      return 0;
    }

    return {
      perSec: calculateRate(WINDOWS.perSec, 1),          // signatures per second
      perMin: calculateRate(WINDOWS.perMin, 60),         // signatures per minute  
      perHour: calculateRate(WINDOWS.perHour, 3600),     // signatures per hour
      perDay: calculateRate(WINDOWS.perDay, 86400),      // signatures per day
      
      // Additional info for confidence indicators
      dataPoints: {
        perSec: $h.filter(t => now - t.ts <= WINDOWS.perSec).length,
        perMin: $h.filter(t => now - t.ts <= WINDOWS.perMin).length,
        perHour: $h.filter(t => now - t.ts <= WINDOWS.perHour).length,
        perDay: $h.filter(t => now - t.ts <= WINDOWS.perDay).length
      }
    };
  });

  // derive today's collected count using boundary baseline
  const todayData = derived(history, $h => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const all = [...$h].sort((a, b) => a.ts - b.ts);
    // last tick before today
    let baselineTick = all.filter(t => t.ts < startOfDay).pop();
    let baselineKnown = Boolean(baselineTick);
    // if none before today, we cannot know baseline
    if (!baselineTick && all.length) {
      baselineTick = all[0];
      baselineKnown = false;
    }
    const todayTicks = all.filter(t => t.ts >= startOfDay);
    const lastToday = todayTicks.length ? todayTicks[todayTicks.length - 1] : baselineTick;
    const firstCount = baselineTick?.count ?? 0;
    const collected = lastToday && firstCount != null
      ? lastToday.count - firstCount
      : 0;
    return { collected, baselineKnown };
  });

  // derive if today's quota met
  const metToday = derived(
    [todayData, progression, initiative],
    ([$today, $prog, $init]) => {
      if (!$init.registrationDate) return false;
      const now = new Date();
      const reg = parseEUDate($init.registrationDate);
      const close = parseEUDate($init.closingDate);
      const totalDays = (close.getTime() - reg.getTime()) / MS_PER_DAY;
      const daysLeft  = Math.max((close.getTime() - now.getTime()) / MS_PER_DAY, 0);
      const sigsLeft  = $prog.goal - $prog.signatureCount;
      const neededPerDay = daysLeft > 0
        ? Math.ceil(sigsLeft / daysLeft)
        : sigsLeft;
      return $today.collected >= neededPerDay;
    }
  );

  // Derive time-based projections
  const projections = derived([rate, progression], ([$rate, $prog]) => {
    const sigsLeft = $prog.goal - $prog.signatureCount;
    
    return {
      timeToGoal: {
        atCurrentRate: $rate.perDay > 0 ? Math.ceil(sigsLeft / $rate.perDay) : Infinity,
        atNeededRate: Math.ceil(sigsLeft / 13071) // based on current daily quota
      },
      projectedCompletion: {
        current: $rate.perDay > 0 ? new Date(Date.now() + (sigsLeft / $rate.perDay) * MS_PER_DAY) : null,
        needed: new Date(Date.now() + (sigsLeft / 13071) * MS_PER_DAY)
      }
    };
  });

  // ─── POLLING WITH RAILWAY BACKEND ────────────────────────────────────────
  let handle: ReturnType<typeof setInterval>;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;

  onMount(() => {
    if (!browser) return;

    // Load history from server and start polling
    (async () => {
      await loadHistory();
      await tick();
      handle = setInterval(tick, 1000);
    })();
    
    return () => clearInterval(handle);
  });

  async function loadHistory() {
    try {
      const response = await fetch('/api/tick-history');
      if (response.ok) {
        const serverHistory = await response.json();
        history.set(serverHistory);
        reconnectAttempts = 0; // Reset on successful connection
      }
    } catch (e) {
      console.error('Failed to load history from server:', e);
      // Fallback to localStorage for development
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        history.set(raw ? JSON.parse(raw) : []);
      } catch {
        history.set([]);
      }
    }
  }

  async function saveTickToServer(ts: number, count: number) {
    try {
      const response = await fetch('/api/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts, count })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      reconnectAttempts = 0; // Reset on successful save
    } catch (e) {
      console.error('Failed to save tick to server:', e);
      reconnectAttempts++;
      
      // Fallback to localStorage for development
      try {
        history.update(h => {
          const next = [...h, { ts, count }];
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
          return next;
        });
      } catch (localErr) {
        console.error('Failed to save to localStorage:', localErr);
      }
      
      // If too many failures, try to reload history
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('Too many failures, attempting to reload history...');
        await loadHistory();
        reconnectAttempts = 0;
      }
    }
  }

  async function tick() {
    try {
      const [prog, infoJson] = await Promise.all([
        fetch('https://eci.ec.europa.eu/045/public/api/report/progression').then(r => r.json()),
        fetch('https://eci.ec.europa.eu/045/public/api/initiative/description').then(r => r.json())
      ]);
      
      progression.set({ signatureCount: prog.signatureCount, goal: prog.goal });
      initiative.set({
        registrationDate: infoJson.initiativeInfo.registrationDate,
        closingDate:      infoJson.initiativeInfo.closingDate
      });
      error.set(null);
      lastUpdate.set(Date.now());
      
      const nowTs = Date.now();
      
      // Save to server and update local state
      await saveTickToServer(nowTs, prog.signatureCount);
      history.update(h => [...h, { ts: nowTs, count: prog.signatureCount }]);
      
    } catch (e) {
      error.set((e as Error).message);
      console.error('Tick error:', e);
    }
  }

  // Helper function to get confidence indicator
  function getConfidenceIndicator(dataPoints: number, type: 'perSec' | 'perMin' | 'perHour' | 'perDay') {
    const thresholds = {
      perSec: { good: 10, ok: 5 },
      perMin: { good: 50, ok: 20 },
      perHour: { good: 200, ok: 100 },
      perDay: { good: 800, ok: 400 }
    };
    
    const threshold = thresholds[type];
    if (dataPoints >= threshold.good) return '✅';
    if (dataPoints >= threshold.ok) return '⚠️';
    return '⏳';
  }

  function formatDuration(days: number): string {
    if (days === Infinity) return 'Never at current rate';
    if (days > 365) return `${Math.ceil(days / 365)} years`;
    if (days > 30) return `${Math.ceil(days / 30)} months`;
    if (days > 7) return `${Math.ceil(days / 7)} weeks`;
    return `${Math.ceil(days)} days`;
  }

  function formatDate(date: Date | null): string {
    if (!date) return 'Unknown';
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    });
  }

  function getConnectionStatus(): string {
    if (reconnectAttempts > 0) return '🔄 Reconnecting...';
    const timeSinceUpdate = Date.now() - $lastUpdate;
    if (timeSinceUpdate > 10000) return '⚠️ Connection issue';
    return '🟢 Live';
  }

  // Share functionality
  function shareApp() {
    if (navigator.share) {
      navigator.share({
        title: 'Stop Destroying Videogames - Live Tracker',
        text: `${$progression.signatureCount.toLocaleString()} signatures so far! Track the progress live.`,
        url: window.location.href
      }).catch(console.error);
    } else {
      // Fallback: copy to clipboard
      navigator.clipboard.writeText(window.location.href).then(() => {
        alert('Link copied to clipboard!');
      }).catch(() => {
        alert(`Share this link: ${window.location.href}`);
      });
    }
  }
</script>

<main class="min-h-screen bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 flex items-center justify-center p-6">
  <div class="w-full max-w-lg bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-8 space-y-6">
    <!-- Header with connection status -->
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold text-gray-900 dark:text-gray-100">Stop Destroying Videogames</h1>
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500">{getConnectionStatus()}</span>
        <button 
          on:click={shareApp}
          class="p-2 text-gray-500 hover:text-blue-600 transition-colors"
          title="Share this tracker"
        >
          📤
        </button>
      </div>
    </div>

    {#if $error}
      <div class="text-center p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
        <p class="text-red-600 dark:text-red-400">Error: {$error}</p>
        <p class="text-xs text-red-500 dark:text-red-300 mt-1">
          Retrying... ({reconnectAttempts}/{MAX_RECONNECT_ATTEMPTS})
        </p>
      </div>
    {:else}
      <!-- Live Rates with Confidence Indicators -->
      <div class="grid grid-cols-2 gap-4 text-sm text-gray-700 dark:text-gray-300">
        <div class="flex items-center justify-between">
          <span>Rate/sec:</span>
          <span class="flex items-center gap-1">
            <strong>{$rate.perSec.toFixed(2)}</strong>
            <span class="text-xs">{getConfidenceIndicator($rate.dataPoints.perSec, 'perSec')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/min:</span>
          <span class="flex items-center gap-1">
            <strong>{$rate.perMin.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($rate.dataPoints.perMin, 'perMin')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/hr:</span>
          <span class="flex items-center gap-1">
            <strong>{$rate.perHour.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($rate.dataPoints.perHour, 'perHour')}</span>
          </span>
        </div>
        <div class="flex items-center justify-between">
          <span>Rate/day:</span>
          <span class="flex items-center gap-1">
            <strong>{$rate.perDay.toFixed(0)}</strong>
            <span class="text-xs">{getConfidenceIndicator($rate.dataPoints.perDay, 'perDay')}</span>
          </span>
        </div>
      </div>

      <!-- Projections (only show if daily rate is reliable) -->
      {#if $rate.dataPoints.perDay >= 100}
        <div class="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 space-y-2">
          <h3 class="font-semibold text-blue-900 dark:text-blue-100 text-sm">📊 Projections</h3>
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
      {/if}

      <!-- Data Quality Indicator -->
      <div class="text-xs text-gray-500 dark:text-gray-400 text-center">
        Data points: {$rate.dataPoints.perSec}s / {$rate.dataPoints.perMin}m / {$rate.dataPoints.perHour}h / {$rate.dataPoints.perDay}d
      </div>

      <!-- Today's Stats -->
      <div class="grid grid-cols-3 gap-4 text-sm text-gray-700 dark:text-gray-300 text-center">
        <div>
          <div class="text-xs text-gray-500 dark:text-gray-400">Collected Today</div>
          <strong class="text-lg">{$todayData.collected.toLocaleString()}</strong>
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
          <div class="text-xs text-gray-500 dark:text-gray-400">Data Points</div>
          <strong class="text-lg">{$history.length}</strong>
        </div>
      </div>

      <!-- Original Progress & Time UI -->
      <div class="mt-4 grid grid-cols-2 gap-4 text-sm text-gray-600 dark:text-gray-400">
        <div><strong>Registered:</strong> {$initiative.registrationDate}</div>
        <div><strong>Closes:</strong> {$initiative.closingDate}</div>
      </div>
      <div class="space-y-2">
        <div class="flex justify-between items-baseline">
          <span class="text-3xl font-mono text-blue-600 dark:text-blue-400">
            {$progression.signatureCount.toLocaleString()}</span>
          <span class="text-lg text-gray-500 dark:text-gray-400">
            / {$progression.goal.toLocaleString()}</span>
        </div>
        <div class="relative h-4 bg-gray-300 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            class="absolute inset-0 bg-gradient-to-r from-blue-400 via-blue-600 to-purple-600 transition-[width] duration-1000 ease-out"
            style="width: {Math.min(($progression.signatureCount / $progression.goal) * 100, 100)}%;"
          ></div>
        </div>
        <div class="text-right text-sm text-gray-600 dark:text-gray-400">
          {(Math.min(($progression.signatureCount / $progression.goal) * 100, 100)).toFixed(1)}%</div>
      </div>
      <div class="space-y-2">
        <div class="flex justify-between items-baseline">
          <span class="text-base text-gray-700 dark:text-gray-300">
            Time elapsed</span>
          <span class="text-sm text-gray-500 dark:text-gray-400">
            {Math.floor((Date.now() - parseEUDate($initiative.registrationDate).getTime()) / MS_PER_DAY)} / {Math.ceil((parseEUDate($initiative.closingDate).getTime() - parseEUDate($initiative.registrationDate).getTime()) / MS_PER_DAY)} days</span>
        </div>
        <div class="relative h-3 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
          <div
            class="absolute inset-0 bg-gradient-to-r from-green-400 via-yellow-400 to-red-400 transition-[width] duration-1000 ease-out"
            style="width: {Math.min(((Date.now() - parseEUDate($initiative.registrationDate).getTime()) / MS_PER_DAY) / ((parseEUDate($initiative.closingDate).getTime() - parseEUDate($initiative.registrationDate).getTime()) / MS_PER_DAY) * 100, 100)}%;"
          ></div>
        </div>
      </div>
      <div class="text-center text-sm text-gray-700 dark:text-gray-300">
        We need <span class="font-semibold">{(() => {
          const now = new Date(); const reg = parseEUDate($initiative.registrationDate);
          const close = parseEUDate($initiative.closingDate);
          const totalDays = (close.getTime() - reg.getTime()) / MS_PER_DAY;
          const daysLeft = Math.max((close.getTime() - now.getTime()) / MS_PER_DAY, 0);
          const sigsLeft = $progression.goal - $progression.signatureCount;
          return (daysLeft>0 ? Math.ceil(sigsLeft / daysLeft) : sigsLeft).toLocaleString();
        })()}</span> signatures/day to reach <strong>{$progression.goal.toLocaleString()}</strong>.
      </div>

      <!-- Legend for confidence indicators -->
      <div class="text-xs text-gray-500 dark:text-gray-400 text-center border-t pt-3">
        <div class="grid grid-cols-3 gap-2">
          <span>✅ Reliable</span>
          <span>⚠️ Stabilizing</span>
          <span>⏳ Warming up</span>
        </div>
      </div>

      <!-- Footer -->
      <div class="text-xs text-center text-gray-400 dark:text-gray-500 border-t pt-3">
        <div>Live tracker • Updates every second</div>
        <div class="mt-1">
          <a href="https://citizens-initiative.europa.eu/initiatives/details/2024/000045_en" 
             target="_blank" 
             class="text-blue-500 hover:text-blue-600 transition-colors">
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