// api/ads.js — Vercel Serverless Function v2.2
// 3-day rolling window, $40 kill gate, optional Odoo integration for true CPA

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const BASELINE_CPM = JSON.parse(process.env.BASELINE_CPM || '{}');
const META_APP_ID = process.env.META_APP_ID || null;
const META_APP_SECRET = process.env.META_APP_SECRET || null;

// ── ODOO CONFIG (optional) ──
const ODOO_URL = process.env.ODOO_URL || null;       // e.g. https://deniz-moda.odoo.sh
const ODOO_DB = process.env.ODOO_DB || null;
const ODOO_USER = process.env.ODOO_USER || null;     // email
const ODOO_API_KEY = process.env.ODOO_API_KEY || null;

// ── DENIZ MODA BUSINESS CONFIG ──
const TARGET_CPA = parseFloat(process.env.TARGET_CPA) || 14.08;
const TARGET_ROAS = parseFloat(process.env.TARGET_ROAS) || 4.0;
const MIN_SPEND_FOR_CLASSIFICATION = 20;
const MIN_IMPRESSIONS_FOR_CLASSIFICATION = 1000;
const MIN_SPEND_FOR_KILL = 40;                       // ← lowered from 50 to 40
const MAX_FREQ_FOR_HEALTHY = 2.5;
const MAX_FREQ_FOR_WATCH = 3.5;
const CPM_WATCH_THRESHOLD = 40;
const CPM_ELEVATED_THRESHOLD = 80;

const CPA_WATCH_THRESHOLD = TARGET_CPA;
const CPA_CEILING_THRESHOLD = TARGET_CPA * 1.2;
const CPA_KILL_THRESHOLD = TARGET_CPA * 1.5;

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

    const healthSince = getDateString(-2);
    const healthUntil = getDateString(0);
    const healthTimeRange = { since: healthSince, until: healthUntil };
    healthInsightsParam = `insights.time_range(${encodeURIComponent(JSON.stringify(healthTimeRange))}){spend,impressions,cpm,cpc,ctr,frequency,actions,action_values}`;

    if (start && end) {
      const timeRange = { since: start, until: end };
      displayInsightsParam = `insights.time_range(${encodeURIComponent(JSON.stringify(timeRange))}){spend,impressions,cpm,cpc,ctr,frequency,actions,action_values}`;
      rangeLabel = `${start} → ${end}`;
    } else if (preset) {
      displayInsightsParam = `insights.date_preset(${preset}){spend,impressions,cpm,cpc,ctr,frequency,actions,action_values}`;
      rangeLabel = preset;
    } else {
      const since = getDateString(-2);
      const until = getDateString(0);
      const timeRange = { since, until };
      displayInsightsParam = `insights.time_range(${encodeURIComponent(JSON.stringify(timeRange))}){spend,impressions,cpm,cpc,ctr,frequency,actions,action_values}`;
      rangeLabel = 'Last 3 days';
    }

    // ── FETCH META ADSETS ──
    let displayUrl = `https://graph.facebook.com/v18.0/act_${AD_ACCOUNT_ID}/adsets` +
      `?fields=name,status,daily_budget,effective_status,campaign{name},${displayInsightsParam}` +
      `&limit=500` +
      `&access_token=${META_ACCESS_TOKEN}`;

    let displayRes = await fetch(displayUrl);
    let displayData = await displayRes.json();

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

    // ── FETCH HEALTH DATA (3-day) ──
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

    const healthMap = {};
    (healthData.data || []).forEach(adset => {
      const insights = adset.insights?.data?.[0] || {};
      healthMap[adset.id] = insights;
    });

    // ── FETCH ODOO DATA (optional) ──
    let odooData = null;
    if (ODOO_URL && ODOO_DB && ODOO_USER && ODOO_API_KEY) {
      try {
        odooData = await fetchOdooData(healthSince, healthUntil);
      } catch (e) {
        console.error('Odoo fetch failed:', e.message);
      }
    }

    // ── PROCESS ADSETS ──
    let ads = (displayData.data || []).map(adset => {
      const displayInsights = adset.insights?.data?.[0] || {};
      const healthInsights = healthMap[adset.id] || displayInsights;

      // Display metrics
      const dispSpent = parseFloat(displayInsights.spend) || 0;
      const dispImpressions = parseInt(displayInsights.impressions) || 0;
      const dispPurchases = parseInt(getActionCount(displayInsights.actions, 'purchase')) || 0;
      const dispPurchaseValue = parseFloat(getActionValue(displayInsights.action_values, 'purchase')) || 0;
      const dispCpm = parseFloat(displayInsights.cpm) || 0;
      const dispFreq = parseFloat(displayInsights.frequency) || 0;
      const dispCpa = dispPurchases > 0 ? (dispSpent / dispPurchases).toFixed(2) : null;
      const dispRoas = dispSpent > 0 ? (dispPurchaseValue / dispSpent).toFixed(2) : null;

      // Health metrics
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

      // ── ODOO MATCHING ──
      const modelCode = extractModelCode(adset.name);
      let odooOrders = 0;
      let odooRevenue = 0;
      let odooTrend = null;
      let trueCpa = null;

      if (odooData && modelCode) {
        const match = odooData.byModel[modelCode];
        if (match) {
          odooOrders = match.totalOrders;
          odooRevenue = match.totalRevenue;
          odooTrend = match.trend; // 'rising', 'falling', 'stable', 'peak_then_drop'
          if (hSpent > 0 && odooOrders > 0) {
            trueCpa = hSpent / odooOrders;
          }
        }
      }

      // ── HEALTH CLASSIFICATION ──
      let health = 'healthy';
      let action = 'Let it run';
      let killReason = null;
      let healthNote = null;

      if (adset.status === 'PAUSED' || adset.status === 'OFF') {
        health = 'dead';
        action = 'Already killed';
      }
      else if (adset.effective_status === 'PENDING_REVIEW' || adset.effective_status === 'PENDING_BILLING_INITIAL') {
        health = 'in_review';
        action = 'In review — wait for approval';
      }
      else if (hSpent === 0 && daysSinceLaunch !== null && daysSinceLaunch <= 2) {
        health = 'in_review';
        action = 'Just launched — waiting for first spend';
      }
      else if (hSpent < MIN_SPEND_FOR_CLASSIFICATION || hImpressions < MIN_IMPRESSIONS_FOR_CLASSIFICATION) {
        health = 'gathering_data';
        action = 'Gathering data — check back tomorrow';
        healthNote = `$${hSpent.toFixed(2)} spent, ${hImpressions} impressions (need $${MIN_SPEND_FOR_CLASSIFICATION}+ and ${MIN_IMPRESSIONS_FOR_CLASSIFICATION}+)`;
      }
      else {
        // ── ODOO TREND OVERRIDE ──
        // If Odoo shows peak-then-drop, downgrade to refresh creative
        if (odooTrend === 'peak_then_drop' && health !== 'kill') {
          health = 'refresh_creative';
          action = 'REFRESH CREATIVE — Odoo orders peaked then dropped';
          healthNote = `Odoo: ${odooOrders} orders, trend: peak then drop. Meta may have algorithmic fatigue.`;
        }
        // ── KILL checks ──
        else if (hSpent >= MIN_SPEND_FOR_KILL && hPurchases === 0) {
          health = 'kill';
          action = 'KILL — No conversions after significant spend';
          killReason = `$${hSpent.toFixed(0)} spent, 0 purchases in 3 days`;
        }
        else if (hCpa && hCpa > CPA_KILL_THRESHOLD && hSpent >= MIN_SPEND_FOR_KILL) {
          health = 'kill';
          action = 'KILL — CPA too high over 3 days';
          killReason = `3-day CPA $${hCpa.toFixed(2)} > $${CPA_KILL_THRESHOLD.toFixed(2)} (true CPA > $15)`;
        }
        // ── REFRESH CREATIVE (frequency) ──
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
        // Display
        spent: dispSpent,
        impressions: dispImpressions,
        purchases: dispPurchases,
        purchaseValue: dispPurchaseValue > 0 ? parseFloat(dispPurchaseValue.toFixed(2)) : null,
        cpa: dispCpa ? parseFloat(dispCpa) : null,
        roas: dispRoas ? parseFloat(dispRoas) : null,
        cpm: dispCpm > 0 ? parseFloat(dispCpm.toFixed(2)) : null,
        frequency: dispFreq > 0 ? parseFloat(dispFreq.toFixed(2)) : null,
        // Health
        healthSpent: hSpent,
        healthImpressions: hImpressions,
        healthPurchases: hPurchases,
        healthCpa: hCpa ? parseFloat(hCpa.toFixed(2)) : null,
        healthRoas: hRoas ? parseFloat(hRoas.toFixed(2)) : null,
        healthCpm: hCpm > 0 ? parseFloat(hCpm.toFixed(2)) : null,
        healthFrequency: hFreq > 0 ? parseFloat(hFreq.toFixed(2)) : null,
        // Odoo
        modelCode,
        odooOrders,
        odooRevenue: odooRevenue > 0 ? parseFloat(odooRevenue.toFixed(2)) : null,
        odooTrend,
        trueCpa: trueCpa ? parseFloat(trueCpa.toFixed(2)) : null,
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

    ads.sort((a, b) => {
      const aDead = a.status === 'PAUSED' || a.status === 'OFF';
      const bDead = b.status === 'PAUSED' || b.status === 'OFF';
      if (aDead && !bDead) return 1;
      if (!aDead && bDead) return -1;
      return 0;
    });

    const activeAds = ads.filter(a => a.status !== 'PAUSED' && a.status !== 'OFF');
    const killList = ads.filter(a => a.health === 'kill');

    // ── FIXED: Calculate weighted totals for correct averages ──
    const totalSpentNum = ads.reduce((s, a) => s + a.spent, 0);
    const totalPurchasesNum = ads.reduce((s, a) => s + a.purchases, 0);
    const totalRevenueNum = ads.reduce((s, a) => s + (a.purchaseValue || 0), 0);

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
      // ── FIXED: Use pre-calculated numeric totals ──
      totalSpent: totalSpentNum.toFixed(2),
      totalPurchases: totalPurchasesNum,
      totalRevenue: totalRevenueNum.toFixed(2),
      // ── FIXED: Weighted averages (Total Spent / Total Purchases, Total Revenue / Total Spent) ──
      avgCPA: totalPurchasesNum > 0 ? (totalSpentNum / totalPurchasesNum).toFixed(2) : null,
      avgROAS: totalSpentNum > 0 ? (totalRevenueNum / totalSpentNum).toFixed(2) : null,
      killList: killList.map(a => ({ name: a.name, reason: a.killReason })),
      dateRange: rangeLabel,
      healthWindow: `${healthSince} → ${healthUntil}`,
      targetCPA: TARGET_CPA,
      targetROAS: TARGET_ROAS,
      trueCPACeiling: 12.00,
      odooConnected: !!odooData,
      lastRefresh: new Date().toLocaleString()
    };

    return res.status(200).json({ summary, ads });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

// ── ODOO INTEGRATION ──

async function fetchOdooData(since, until) {
  // Step 1: Authenticate
  const authRes = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'common',
        method: 'authenticate',
        args: [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]
      },
      id: 1
    })
  });

  const authData = await authRes.json();
  const uid = authData.result;
  if (!uid) throw new Error('Odoo authentication failed');

  // Step 2: Fetch confirmed sales orders in date range
  const orderRes = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          ODOO_DB, uid, ODOO_API_KEY,
          'sale.order',
          'search_read',
          [
            [
              ['state', 'in', ['sale', 'done']],
              ['date_order', '>=', `${since} 00:00:00`],
              ['date_order', '<=', `${until} 23:59:59`]
            ]
          ],
          { fields: ['id', 'name', 'date_order', 'amount_total', 'order_line'] }
        ]
      },
      id: 2
    })
  });

  const orderData = await orderRes.json();
  const orders = orderData.result || [];

  // Step 3: Fetch order lines to get products
  const lineIds = orders.flatMap(o => o.order_line || []);
  const lineRes = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          ODOO_DB, uid, ODOO_API_KEY,
          'sale.order.line',
          'read',
          [lineIds],
          { fields: ['product_id', 'price_unit', 'product_uom_qty'] }
        ]
      },
      id: 3
    })
  });

  const lineData = await lineRes.json();
  const lines = lineData.result || [];

  // Step 4: Fetch product names to match with ad set model codes
  const productIds = [...new Set(lines.map(l => l.product_id?.[0]).filter(Boolean))];
  const productRes = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          ODOO_DB, uid, ODOO_API_KEY,
          'product.product',
          'read',
          [productIds],
          { fields: ['id', 'name', 'default_code'] }
        ]
      },
      id: 4
    })
  });

  const productData = await productRes.json();
  const products = productData.result || [];
  const productMap = {};
  products.forEach(p => {
    productMap[p.id] = p;
  });

  // Step 5: Group by model code and calculate trends
  const byModel = {};
  const byDate = {};

  orders.forEach(order => {
    const orderDate = order.date_order.split(' ')[0];
    const orderLines = lines.filter(l => (order.order_line || []).includes(l.id));

    orderLines.forEach(line => {
      const product = productMap[line.product_id?.[0]];
      if (!product) return;

      const modelCode = extractModelFromProduct(product.name, product.default_code);
      if (!modelCode) return;

      if (!byModel[modelCode]) {
        byModel[modelCode] = { totalOrders: 0, totalRevenue: 0, daily: {} };
      }

      byModel[modelCode].totalOrders += 1;
      byModel[modelCode].totalRevenue += (line.price_unit * line.product_uom_qty);

      if (!byModel[modelCode].daily[orderDate]) {
        byModel[modelCode].daily[orderDate] = 0;
      }
      byModel[modelCode].daily[orderDate] += 1;
    });
  });

  // Calculate trends
  Object.keys(byModel).forEach(modelCode => {
    const daily = byModel[modelCode].daily;
    const dates = Object.keys(daily).sort();

    if (dates.length >= 3) {
      const first = daily[dates[0]];
      const mid = daily[dates[Math.floor(dates.length / 2)]];
      const last = daily[dates[dates.length - 1]];

      if (mid > first * 2 && last < mid * 0.5) {
        byModel[modelCode].trend = 'peak_then_drop';
      } else if (last > mid) {
        byModel[modelCode].trend = 'rising';
      } else if (last < mid * 0.7) {
        byModel[modelCode].trend = 'falling';
      } else {
        byModel[modelCode].trend = 'stable';
      }
    } else if (dates.length === 2) {
      const first = daily[dates[0]];
      const last = daily[dates[1]];
      if (last < first * 0.5) {
        byModel[modelCode].trend = 'falling';
      } else if (last > first * 1.5) {
        byModel[modelCode].trend = 'rising';
      } else {
        byModel[modelCode].trend = 'stable';
      }
    } else {
      byModel[modelCode].trend = 'stable';
    }
  });

  return { byModel, totalOrders: orders.length };
}

function extractModelCode(adSetName) {
  // Extract model codes like H-1869, T-7054, K-6494, L-4114
  const match = adSetName.match(/([A-Z])[-\s]?(\d{3,4})/i);
  if (match) {
    return `${match[1].toUpperCase()}-${match[2]}`;
  }
  // Also match "KOLIK", "TAFETTA" etc.
  const nameMatch = adSetName.match(/(KOLIK|TAFETTA)/i);
  if (nameMatch) {
    return nameMatch[1].toUpperCase();
  }
  return null;
}

function extractModelFromProduct(productName, defaultCode) {
  // Try default_code first (e.g., "H-1869")
  if (defaultCode) {
    const match = defaultCode.match(/([A-Z])[-\s]?(\d{3,4})/i);
    if (match) return `${match[1].toUpperCase()}-${match[2]}`;
  }
  // Try product name
  if (productName) {
    const match = productName.match(/([A-Z])[-\s]?(\d{3,4})/i);
    if (match) return `${match[1].toUpperCase()}-${match[2]}`;
    const nameMatch = productName.match(/(KOLIK|TAFETTA)/i);
    if (nameMatch) return nameMatch[1].toUpperCase();
  }
  return null;
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
    const pixelPurchase = actions.find(a => a.action_type === 'offsite_conversion.fb_pixel_purchases');
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
    const pixelPurchase = actionValues.find(a => a.action_type === 'offsite_conversion.fb_pixel_purchases');
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
