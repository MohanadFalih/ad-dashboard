// api/ads.js — Vercel Serverless Function v2.1
// Rewritten with 3-day rolling window, minimum data gates, and Deniz Moda business rules
// TRUE CPA ceiling = $12. Meta-reported equivalents used for thresholds.
// Default view: last 3 days (rolling). Single-day views available via query params for drill-down only.

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const BASELINE_CPM = JSON.parse(process.env.BASELINE_CPM || '{}');
const META_APP_ID = process.env.META_APP_ID || null;
const META_APP_SECRET = process.env.META_APP_SECRET || null;

// ── DENIZ MODA BUSINESS CONFIG ──
// Meta captures ~71% of purchases (chat-based orders).
// True CPA target = $10 (profitable sweet spot). True CPA ceiling = $12 (MAX acceptable).
// True CPA kill = $15 (clearly unprofitable).
// Meta-reported equivalents: $10÷0.71=$14.08 | $12÷0.71=$16.90 | $15÷0.71=$21.13
const TARGET_CPA = parseFloat(process.env.TARGET_CPA) || 14.08;      // Meta-reported healthy target
const TARGET_ROAS = parseFloat(process.env.TARGET_ROAS) || 4.0;
const MIN_SPEND_FOR_CLASSIFICATION = 20;   // $20 in 3 days to get a health label
const MIN_IMPRESSIONS_FOR_CLASSIFICATION = 1000;
const MIN_SPEND_FOR_KILL = 50;             // $50 in 3 days before "kill" is allowed
const MAX_FREQ_FOR_HEALTHY = 2.5;
const MAX_FREQ_FOR_WATCH = 3.5;
const CPM_WATCH_THRESHOLD = 40;            // +40% above baseline
const CPM_ELEVATED_THRESHOLD = 80;         // +80% above baseline

// ── CPA THRESHOLDS (Meta-reported) ──
// These map to true CPA: $14.08=$10 | $16.90=$12 | $21.13=$15
const CPA_WATCH_THRESHOLD = TARGET_CPA;                    // > $14.08 meta = true > $10
const CPA_CEILING_THRESHOLD = TARGET_CPA * 1.2;             // > $16.90 meta = true > $12 (MAX)
const CPA_KILL_THRESHOLD = TARGET_CPA * 1.5;                // > $21.13 meta = true > $15

// Baseline CPMs from your current sheet
const defaultBaselines = {
  "5 AUG H-1840": 1.46,
  "2 AUG T-7071": 1.28,
  "29 JULY H-1846": 1.03,
  "tafetta": 1.32,
  "29 july T-7067": 1.39,
  "K-6494": 1.50,
  "9 AUG H-1851": 1.45,
  "8 AUG L-4114": 1.35,
  "7 AUG H-1865": 1.42,
  "7 AUG L-1718": 1.38,
  "6 AUG T-7054": 1.40,
  "H-1843 / 3 ads": 1.50,
  "H-1843 on ad (3-videos)": 1.48,
  "6 AUG H-1852": 1.45
};

const baselines = { ...defaultBaselines, ...BASELINE_CPM };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (!META_ACCESS_TOKEN || !AD_ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing META_ACCESS_TOKEN or AD_ACCOUNT_ID env vars' });
  }

  try {
    // ── DATE RANGE LOGIC ──
    const { start, end, preset } = req.query;
    let displayInsightsParam;
    let rangeLabel;
    let healthInsightsParam;

    // HEALTH DATA: always pull last 3 days for classification
    const healthSince = getDateString(-2);
    const healthUntil = getDateString(0);
    const healthTimeRange = { since: healthSince, until: healthUntil };
    healthInsightsParam = `insights.time_range(${encodeURIComponent(JSON.stringify(healthTimeRange))}){spend,impressions,cpm,cpc,ctr,frequency,actions,action_values}`;

    // DISPLAY DATA: user-selected range (defaults to same 3-day window)
    if (start && end) {
      const timeRange = { since: start, until: end };
      displayInsightsParam = `insights.time_range(${encodeURIComponent(JSON.stringify(timeRange))}){spend,impressions,cpm,cpc,ctr,frequency,actions,action_values}`;
      rangeLabel = `${start} → ${end}`;
    } else if (preset) {
      displayInsightsParam = `insights.date_preset(${preset}){spend,impressions,cpm,cpc,ctr,frequency,actions,action_values}`;
      rangeLabel = preset;
    } else {
      // Default: last 3 days (rolling window)
      const since = getDateString(-2);
      const until = getDateString(0);
      const timeRange = { since, until };
      displayInsightsParam = `insights.time_range(${encodeURIComponent(JSON.stringify(timeRange))}){spend,impressions,cpm,cpc,ctr,frequency,actions,action_values}`;
      rangeLabel = 'Last 3 days';
    }

    // ── FETCH ADSETS (display range) ──
    let displayUrl = `https://graph.facebook.com/v18.0/act_${AD_ACCOUNT_ID}/adsets` +
      `?fields=name,status,daily_budget,effective_status,campaign{name},${displayInsightsParam}` +
      `&limit=500` +
      `&access_token=${META_ACCESS_TOKEN}`;

    let displayRes = await fetch(displayUrl);
    let displayData = await displayRes.json();

    // Token refresh fallback
    if (displayData.error && displayData.error.code === 190) {
      const refreshed = await refreshToken(META_ACCESS_TOKEN);
      if (refreshed) {
        displayUrl = displayUrl.replace(/access_token=[^&]+/, `access_token=${refreshed}`);
        displayRes = await fetch(displayUrl);
        displayData = await displayRes.json();
      }
    }

    if (displayData.error) {
      return res.status(400).json({
        error: displayData.error,
        hint: 'If token expired, generate a System User token in Business Manager (never expires)'
      });
    }

    // ── FETCH ADSETS (health range — last 3 days) ──
    let healthData = displayData;
    const isHealthSameAsDisplay = (!start && !end && !preset) ||
      (preset === 'last_3d') ||
      (start === healthSince && end === healthUntil);

    if (!isHealthSameAsDisplay) {
      let healthUrl = `https://graph.facebook.com/v18.0/act_${AD_ACCOUNT_ID}/adsets` +
        `?fields=name,status,effective_status,campaign{name},${healthInsightsParam}` +
        `&limit=500` +
        `&access_token=${META_ACCESS_TOKEN}`;

      let healthRes = await fetch(healthUrl);
      healthData = await healthRes.json();

      if (healthData.error && healthData.error.code === 190) {
        const refreshed = await refreshToken(META_ACCESS_TOKEN);
        if (refreshed) {
          healthUrl = healthUrl.replace(/access_token=[^&]+/, `access_token=${refreshed}`);
          healthRes = await fetch(healthUrl);
          healthData = await healthRes.json();
        }
      }
    }

    // Build a map of health insights by adset ID
    const healthMap = {};
    (healthData.data || []).forEach(adset => {
      const insights = adset.insights?.data?.[0] || {};
      healthMap[adset.id] = insights;
    });

    // ── PROCESS ADSETS ──
    let ads = (displayData.data || []).map(adset => {
      const displayInsights = adset.insights?.data?.[0] || {};
      const healthInsights = healthMap[adset.id] || displayInsights;

      // ── DISPLAY METRICS (from user-selected range) ──
      const dispSpent = parseFloat(displayInsights.spend) || 0;
      const dispImpressions = parseInt(displayInsights.impressions) || 0;
      const dispPurchases = parseInt(getActionCount(displayInsights.actions, 'purchase')) || 0;
      const dispPurchaseValue = parseFloat(getActionValue(displayInsights.action_values, 'purchase')) || 0;
      const dispCpm = parseFloat(displayInsights.cpm) || 0;
      const dispFreq = parseFloat(displayInsights.frequency) || 0;
      const dispCpa = dispPurchases > 0 ? (dispSpent / dispPurchases).toFixed(2) : null;
      const dispRoas = dispSpent > 0 ? (dispPurchaseValue / dispSpent).toFixed(2) : null;

      // ── HEALTH METRICS (from 3-day rolling window) ──
      const hSpent = parseFloat(healthInsights.spend) || 0;
      const hImpressions = parseInt(healthInsights.impressions) || 0;
      const hPurchases = parseInt(getActionCount(healthInsights.actions, 'purchase')) || 0;
      const hPurchaseValue = parseFloat(getActionValue(healthInsights.action_values, 'purchase')) || 0;
      const hCpm = parseFloat(healthInsights.cpm) || 0;
      const hFreq = parseFloat(healthInsights.frequency) || 0;
      const hCpa = hPurchases > 0 ? (hSpent / hPurchases) : null;
      const hRoas = hSpent > 0 ? (hPurchaseValue / hSpent) : null;

      const baseline = baselines[adset.name] || null;
      const cpmPct = baseline && hCpm > 0
        ? Math.round(((hCpm - baseline) / baseline) * 100)
        : null;

      const daysSinceLaunch = estimateDays(adset.name);

      // ── HEALTH CLASSIFICATION (v2.1 logic) ──
      let health = 'healthy';
      let action = 'Let it run';
      let killReason = null;
      let healthNote = null;

      // 1. Dead / paused
      if (adset.status === 'PAUSED' || adset.status === 'OFF') {
        health = 'dead';
        action = 'Already killed';
      }
      // 2. In review / not yet started
      else if (adset.effective_status === 'PENDING_REVIEW' || adset.effective_status === 'PENDING_BILLING_INITIAL') {
        health = 'in_review';
        action = 'In review — wait for approval';
      }
      else if (hSpent === 0 && daysSinceLaunch !== null && daysSinceLaunch <= 2) {
        health = 'in_review';
        action = 'Just launched — waiting for first spend';
      }
      // 3. Not enough data to classify
      else if (hSpent < MIN_SPEND_FOR_CLASSIFICATION || hImpressions < MIN_IMPRESSIONS_FOR_CLASSIFICATION) {
        health = 'gathering_data';
        action = 'Gathering data — check back tomorrow';
        healthNote = `$${hSpent.toFixed(2)} spent, ${hImpressions} impressions (need $${MIN_SPEND_FOR_CLASSIFICATION}+ and ${MIN_IMPRESSIONS_FOR_CLASSIFICATION}+)`;
      }
      // 4. Full classification with 3-day data
      else {
        // ── KILL checks (strictest — requires sufficient spend) ──
        if (hSpent >= MIN_SPEND_FOR_KILL && hPurchases === 0) {
          health = 'kill';
          action = 'KILL — No conversions after significant spend';
          killReason = `$${hSpent.toFixed(0)} spent, 0 purchases in 3 days`;
        }
        else if (hCpa && hCpa > CPA_KILL_THRESHOLD && hSpent >= MIN_SPEND_FOR_KILL) {
          health = 'kill';
          action = 'KILL — CPA too high over 3 days';
          killReason = `3-day CPA $${hCpa.toFixed(2)} > $${CPA_KILL_THRESHOLD.toFixed(2)} (true CPA > $15)`;
        }
        // ── REFRESH CREATIVE (frequency exhaustion — NOT kill) ──
        else if (hFreq >= MAX_FREQ_FOR_WATCH) {
          health = 'refresh_creative';
          action = 'REFRESH CREATIVE — Swap image/video + hook';
          healthNote = `Frequency ${hFreq.toFixed(2)} over 3 days. Audience is not dead — creative is exhausted.`;
        }
        // ── WATCH checks ──
        else if (hCpa && hCpa > CPA_CEILING_THRESHOLD) {
          health = 'watch';
          action = 'Watch — CPA above $12 ceiling';
          healthNote = `3-day CPA $${hCpa.toFixed(2)} > $${CPA_CEILING_THRESHOLD.toFixed(2)} (true CPA > $12)`;
        }
        else if (hCpa && hCpa > CPA_WATCH_THRESHOLD) {
          health = 'watch';
          action = 'Watch — CPA above $10 target';
          healthNote = `3-day CPA $${hCpa.toFixed(2)} vs target $${CPA_WATCH_THRESHOLD.toFixed(2)} (true ~$${(hCpa * 0.71).toFixed(2)})`;
        }
        else if (cpmPct && cpmPct > CPM_ELEVATED_THRESHOLD) {
          health = 'watch';
          action = 'Watch — CPM significantly elevated';
          healthNote = `CPM +${cpmPct}% above baseline, but still converting`;
        }
        else if (cpmPct && cpmPct > CPM_WATCH_THRESHOLD) {
          health = 'watch';
          action = 'Watch — CPM rising';
          healthNote = `CPM +${cpmPct}% above baseline`;
        }
        else if (hFreq >= MAX_FREQ_FOR_HEALTHY) {
          health = 'watch';
          action = 'Watch — Frequency climbing';
          healthNote = `Frequency ${hFreq.toFixed(2)} — approaching creative exhaustion`;
        }
        // ── HEALTHY ──
        else {
          health = 'healthy';
          action = 'Let it run';
        }
      }

      return {
        id: adset.id,
        name: adset.name,
        status: adset.status,
        effectiveStatus: adset.effective_status,
        campaign: adset.campaign?.name || '',
        // Display metrics (from selected range)
        spent: dispSpent,
        impressions: dispImpressions,
        purchases: dispPurchases,
        purchaseValue: dispPurchaseValue > 0 ? parseFloat(dispPurchaseValue.toFixed(2)) : null,
        cpa: dispCpa ? parseFloat(dispCpa) : null,
        roas: dispRoas ? parseFloat(dispRoas) : null,
        cpm: dispCpm > 0 ? parseFloat(dispCpm.toFixed(2)) : null,
        frequency: dispFreq > 0 ? parseFloat(dispFreq.toFixed(2)) : null,
        // Health metrics (from 3-day window)
        healthSpent: hSpent,
        healthImpressions: hImpressions,
        healthPurchases: hPurchases,
        healthCpa: hCpa ? parseFloat(hCpa.toFixed(2)) : null,
        healthRoas: hRoas ? parseFloat(hRoas.toFixed(2)) : null,
        healthCpm: hCpm > 0 ? parseFloat(hCpm.toFixed(2)) : null,
        healthFrequency: hFreq > 0 ? parseFloat(hFreq.toFixed(2)) : null,
        // Classification
        baselineCPM: baseline,
        cpmVsBaseline: cpmPct,
        health,
        action,
        killReason,
        healthNote,
        daysSinceLaunch,
        lastUpdated: new Date().toISOString()
      };
    });

    // ── SORT: ACTIVE FIRST, DEAD LAST ──
    ads.sort((a, b) => {
      const aDead = a.status === 'PAUSED' || a.status === 'OFF';
      const bDead = b.status === 'PAUSED' || b.status === 'OFF';
      if (aDead && !bDead) return 1;
      if (!aDead && bDead) return -1;
      return 0;
    });

    // ── SUMMARY ──
    const activeAds = ads.filter(a => a.status !== 'PAUSED' && a.status !== 'OFF');
    const killList = ads.filter(a => a.health === 'kill');

    const summary = {
      totalAds: ads.length,
      activeAds: activeAds.length,
      healthy: ads.filter(a => a.health === 'healthy').length,
      watch: ads.filter(a => a.health === 'watch').length,
      refreshCreative: ads.filter(a => a.health === 'refresh_creative').length,
      kill: killList.length,
      inReview: ads.filter(a => a.health === 'in_review').length,
      gatheringData: ads.filter(a => a.health === 'gathering_data').length,
      dead: ads.filter(a => a.health === 'dead').length,
      totalSpent: ads.reduce((s, a) => s + a.spent, 0).toFixed(2),
      totalPurchases: ads.reduce((s, a) => s + a.purchases, 0),
      totalRevenue: ads.reduce((s, a) => s + (a.purchaseValue || 0), 0).toFixed(2),
      avgCPA: activeAds.filter(a => a.cpa).length > 0
        ? (activeAds.filter(a => a.cpa).reduce((s, a) => s + a.cpa, 0) / activeAds.filter(a => a.cpa).length).toFixed(2)
        : null,
      avgROAS: activeAds.filter(a => a.roas).length > 0
        ? (activeAds.filter(a => a.roas).reduce((s, a) => s + a.roas, 0) / activeAds.filter(a => a.roas).length).toFixed(2)
        : null,
      killList: killList.map(a => ({ name: a.name, reason: a.killReason })),
      dateRange: rangeLabel,
      healthWindow: `${healthSince} → ${healthUntil}`,
      targetCPA: TARGET_CPA,
      targetROAS: TARGET_ROAS,
      trueCPACeiling: 12.00,
      lastRefresh: new Date().toLocaleString()
    };

    return res.status(200).json({ summary, ads });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

// ── HELPERS ──

function getDateString(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

function getActionCount(actions, actionType) {
  if (!actions || !Array.isArray(actions)) return 0;

  if (actionType === 'purchase') {
    const pixelPurchase = actions.find(a =>
      a.action_type === 'offsite_conversion.fb_pixel_purchases'
    );
    if (pixelPurchase) return parseInt(pixelPurchase.value) || 0;

    const purchase = actions.find(a => a.action_type === 'purchase');
    if (purchase) return parseInt(purchase.value) || 0;

    const anyPurchase = actions.find(a => a.action_type?.includes('purchase'));
    return anyPurchase ? parseInt(anyPurchase.value) || 0 : 0;
  }

  const act = actions.find(a => a.action_type === actionType);
  return act ? parseInt(act.value) : 0;
}

function getActionValue(actionValues, actionType) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;

  if (actionType === 'purchase') {
    const pixelPurchase = actionValues.find(a =>
      a.action_type === 'offsite_conversion.fb_pixel_purchases'
    );
    if (pixelPurchase) return parseFloat(pixelPurchase.value) || 0;

    const purchase = actionValues.find(a => a.action_type === 'purchase');
    if (purchase) return parseFloat(purchase.value) || 0;

    const anyPurchase = actionValues.find(a => a.action_type?.includes('purchase'));
    return anyPurchase ? parseFloat(anyPurchase.value) || 0 : 0;
  }

  const act = actionValues.find(a => a.action_type === actionType);
  return act ? parseFloat(act.value) : 0;
}

function estimateDays(name) {
  const match = name.match(/(\d{1,2})\s+(AUG|JULY|JUN|SEP|OCT|NOV|DEC|JAN|FEB|MAR|APR|MAY)/i);
  if (!match) return null;
  const day = parseInt(match[1]);
  const monthMap = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JULY: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
  };
  const month = monthMap[match[2].toUpperCase()];
  const launch = new Date(2026, month, day);
  const now = new Date();
  return Math.max(1, Math.floor((now - launch) / (1000 * 60 * 60 * 24)));
}

async function refreshToken(token) {
  if (!META_APP_ID || !META_APP_SECRET) return null;
  try {
    const url = `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${token}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.access_token || null;
  } catch (e) {
    return null;
  }
}
