// api/ads.js — Vercel Serverless Function
// Pulls Meta Ads data, calculates health, returns JSON
// Supports ?start=YYYY-MM-DD&end=YYYY-MM-DD or preset query params

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const BASELINE_CPM = JSON.parse(process.env.BASELINE_CPM || '{}');
const META_APP_ID = process.env.META_APP_ID || null;
const META_APP_SECRET = process.env.META_APP_SECRET || null;

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
    let timeRange;
    let datePreset;
    let rangeLabel;

    if (start && end) {
      // Custom range
      timeRange = { since: start, until: end };
      rangeLabel = `${start} → ${end}`;
    } else if (preset) {
      // Preset mode
      datePreset = preset;
      rangeLabel = preset;
    } else {
      // Default: yesterday
      const since = getDateString(-1);
      const until = getDateString(-1);
      timeRange = { since, until };
      rangeLabel = 'Yesterday';
    }

    // ── FETCH ADSETS ──
    let url = `https://graph.facebook.com/v18.0/act_${AD_ACCOUNT_ID}/adsets` +
      `?fields=name,status,daily_budget,campaign{name},` +
      `insights{spend,cpm,cpc,ctr,frequency,actions,action_values}`;

    if (timeRange) {
      url += `&time_range=${encodeURIComponent(JSON.stringify(timeRange))}`;
    } else if (datePreset) {
      url += `&date_preset=${datePreset}`;
    }

    url += `&access_token=${META_ACCESS_TOKEN}`;

    let metaRes = await fetch(url);
    let metaData = await metaRes.json();

    // ── TOKEN REFRESH FALLBACK ──
    if (metaData.error && metaData.error.code === 190) {
      console.log('Token expired, attempting refresh...');
      const refreshed = await refreshToken(META_ACCESS_TOKEN);
      if (refreshed) {
        url = url.replace(/access_token=[^&]+/, `access_token=${refreshed}`);
        metaRes = await fetch(url);
        metaData = await metaRes.json();
      }
    }

    if (metaData.error) {
      return res.status(400).json({
        error: metaData.error,
        hint: 'If token expired, generate a System User token in Business Manager (never expires)'
      });
    }

    // ── PROCESS ADSETS ──
    const ads = (metaData.data || []).map(adset => {
      const insights = adset.insights?.data?.[0] || {};
      const prevInsights = adset.insights?.data?.[1] || {};

      const spent = parseFloat(insights.spend) || 0;
      const purchases = parseInt(getActionCount(insights.actions, 'purchase')) || 0;
      const purchaseValue = parseFloat(getActionValue(insights.action_values, 'purchase')) || 0;
      const cpm = parseFloat(insights.cpm) || 0;
      const freq = parseFloat(insights.frequency) || 0;
      const prevFreq = parseFloat(prevInsights.frequency) || 0;
      const cpa = purchases > 0 ? (spent / purchases).toFixed(2) : null;
      const roas = spent > 0 ? (purchaseValue / spent).toFixed(2) : null;

      const baseline = baselines[adset.name] || null;
      const cpmPct = baseline && cpm > 0
        ? Math.round(((cpm - baseline) / baseline) * 100)
        : null;

      const freqChange = prevFreq > 0 && freq > 0
        ? parseFloat((freq - prevFreq).toFixed(2))
        : null;

      // Health scoring logic
      let health = 'healthy';
      let action = 'Let it run';
      let killReason = null;

      if (adset.status === 'PAUSED' || adset.status === 'OFF') {
        health = 'dead';
        action = 'Already killed';
      } else if (spent > 25 && purchases === 0) {
        health = 'danger';
        action = 'KILL NOW';
        killReason = `$${spent} spent, 0 purchases`;
      } else if (cpmPct && cpmPct > 80) {
        health = 'danger';
        action = 'KILL — CPM breach';
        killReason = `CPM +${cpmPct}% above baseline`;
      } else if (freq > 2.5) {
        health = 'danger';
        action = 'KILL — Audience exhausted';
        killReason = `Frequency ${freq}, audience burned`;
      } else if (cpa && parseFloat(cpa) > 25) {
        health = 'dying';
        action = 'Watch closely';
      } else if (spent > 15 && purchases === 0) {
        health = 'warning';
        action = 'Watch — no purchases yet';
      } else if (cpmPct && cpmPct > 40) {
        health = 'warning';
        action = 'Watch — CPM rising';
      } else if (freqChange && freqChange > 0.3) {
        health = 'warning';
        action = 'Watch — frequency spike';
      }

      return {
        id: adset.id,
        name: adset.name,
        status: adset.status,
        campaign: adset.campaign?.name || '',
        spent,
        purchases,
        purchaseValue: purchaseValue > 0 ? parseFloat(purchaseValue.toFixed(2)) : null,
        cpa: cpa ? parseFloat(cpa) : null,
        roas: roas ? parseFloat(roas) : null,
        cpm: cpm > 0 ? parseFloat(cpm.toFixed(2)) : null,
        frequency: freq > 0 ? parseFloat(freq.toFixed(2)) : null,
        freqChange,
        baselineCPM: baseline,
        cpmVsBaseline: cpmPct,
        health,
        action,
        killReason,
        daysSinceLaunch: estimateDays(adset.name),
        lastUpdated: new Date().toISOString()
      };
    });

    // ── SUMMARY ──
    const activeAds = ads.filter(a => a.status !== 'PAUSED' && a.status !== 'OFF');
    const killList = ads.filter(a => a.health === 'danger');

    const summary = {
      totalAds: ads.length,
      activeAds: activeAds.length,
      healthy: ads.filter(a => a.health === 'healthy').length,
      warning: ads.filter(a => a.health === 'warning').length,
      dying: ads.filter(a => a.health === 'dying').length,
      danger: killList.length,
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
  const act = actions.find(a => {
    if (a.action_type === actionType) return true;
    if (actionType === 'purchase' && a.action_type?.includes('purchase')) return true;
    return false;
  });
  return act ? parseInt(act.value) : 0;
}

function getActionValue(actionValues, actionType) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;
  const act = actionValues.find(a => {
    if (a.action_type === actionType) return true;
    if (actionType === 'purchase' && a.action_type?.includes('purchase')) return true;
    return false;
  });
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
