/**
 * Lightweight Holt–Winters triple-exponential-smoothing implementation.
 * – Seasonality is additive.
 * – Optimised for short, daily time–series (petition signatures per day).
 *
 * Author: ChatGPT 2025-06-27
 */

export interface HWOptions {
  /**
   * Seasonal period length, e.g. 7 = weekly seasonality for daily data.
   * At least two full seasons (2 × period) are recommended.
   */
  seasonPeriod: number;

  /** Level smoothing factor α (0–1).  Default 0.3 */
  alpha?: number;

  /** Trend smoothing factor β (0–1).  Default 0.1 */
  beta?: number;

  /** Seasonal smoothing factor γ (0–1).  Default 0.3 */
  gamma?: number;
}

export interface HWModel {
  /** Point forecast h steps ahead (h ≥ 1). */
  forecast: (h: number) => number[];

  /**
   * Approximate confidence interval for horizon h.
   * level = 0.9 → 90 % interval.
   */
  confidence: (level: number, h: number) => { lower: number[]; upper: number[] };

  /**
   * Returns {days, date} when cumulative forecast ≥ target.
   * If never met within 10 years, returns null.
   */
  dateWhenTarget: (current: number, target: number) =>
    | { days: number; date: Date }
    | null;
}

/**
 * Convenience factory.
 */
export function holtWinters(series: number[], opts: HWOptions): HWModel {
  const {
    seasonPeriod,
    alpha = 0.3,
    beta = 0.1,
    gamma = 0.3
  } = opts;

  if (series.length < seasonPeriod * 2) {
    throw new Error(
      `Need ≥ ${seasonPeriod * 2} observations (have ${series.length}).`
    );
  }

  // ---------- INITIALISATION ----------
  const seasons = Math.floor(series.length / seasonPeriod);

  // average of each season
  const seasonAverages = new Array<number>(seasons)
    .fill(0)
    .map((_, s) => {
      const start = s * seasonPeriod;
      const slice = series.slice(start, start + seasonPeriod);
      return slice.reduce((a, v) => a + v, 0) / seasonPeriod;
    });

  // initial seasonal indices
  const initialSI = new Array<number>(seasonPeriod).fill(0).map((_, i) => {
    let sum = 0;
    for (let s = 0; s < seasons; s++) {
      sum += series[s * seasonPeriod + i] - seasonAverages[s];
    }
    return sum / seasons;
  });

  // initial level and trend
  let level = series[0];
  let trend = series[seasonPeriod] - series[0];

  let SI = [...initialSI];
  // ---------- SMOOTHING ----------
  for (let t = 0; t < series.length; t++) {
    const value = series[t];
    const idx = t % seasonPeriod;
    const prevLevel = level;
    const prevSI = SI[idx];

    level = alpha * (value - prevSI) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    SI[idx] = gamma * (value - level) + (1 - gamma) * prevSI;
  }

  // ---------- FORECAST FUNCTION ----------
  function pointForecast(h: number): number[] {
    const out: number[] = [];
    for (let i = 1; i <= h; i++) {
      const idx = (series.length + i - 1) % seasonPeriod;
      out.push(level + i * trend + SI[idx]);
    }
    return out;
  }

  // ---------- CONFIDENCE INTERVAL ----------
  // crude residual std-dev
  const fitted = series.map((_, t) => {
    const idx = t % seasonPeriod;
    return level + (t - series.length) * trend + SI[idx]; // back-cast
  });
  const residuals = series.map((v, i) => v - fitted[i]);
  const s =
    residuals.reduce((a, v) => a + v * v, 0) / (residuals.length - 1) ** 0.5 ||
    1;

  function z(level: number) {
    // 2-sided z values for common levels (quick table)
    const table: Record<number, number> = {
      0.8: 1.282,
      0.9: 1.645,
      0.95: 1.96,
      0.98: 2.326,
      0.99: 2.576
    };
    return table[level] ?? 1.96;
  }

  function conf(level: number, h: number) {
    const pf = pointForecast(h);
    const zVal = z(level);
    const half = zVal * s;
    return {
      lower: pf.map((v) => v - half),
      upper: pf.map((v) => v + half)
    };
  }

  function whenTarget(current: number, target: number) {
    let cum = current;
    const horizon = 365 * 10; // safety cap
    const pf = pointForecast(horizon);
    for (let i = 0; i < pf.length; i++) {
      cum += pf[i];
      if (cum >= target) {
        const days = i + 1;
        const date = new Date(Date.now() + days * 86_400_000);
        return { days, date };
      }
    }
    return null;
  }

  return {
    forecast: pointForecast,
    confidence: conf,
    dateWhenTarget: whenTarget
  };
}
