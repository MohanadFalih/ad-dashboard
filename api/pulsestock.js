// api/pulsestock.js — Vercel Serverless Function v1.1
// Meta → PulseStock bridge. AD-LEVEL insights (SKU lives in ad names),
// aggregated per product SKU. Consumed live by the PulseStock dashboard.
// Reuses the same env vars as api/ads.js: META_ACCESS_TOKEN, AD_ACCOUNT_ID,
// META_APP_ID, META_APP_SECRET (optional, for token refresh).
// Optional: USD_TO_IQD (default 1380), TARGET_CPA, TARGET_ROAS.

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const META_APP_ID = process.env.META_APP_ID || null;
const META_APP_SECRET = process.env.META_APP_SECRET || null;

// ── DENIZ MODA BUSINESS CONFIG (same as ads.js) ──
const TARGET_CPA = parseFloat(process.env.TARGET_CPA) || 14.08;
const TARGET_ROAS = parseFloat(process.env.TARGET_ROAS) || 4.0;
const USD_TO_IQD = parseFloat(process.env.USD_TO_IQD) || 1380;
const MIN_SPEND_FOR_CLASSIFICATION = 20;
const MIN_IMPRESSIONS_FOR_CLASSIFICATION = 1000;
const MIN_SPEND_FOR_KILL = 40;
const MAX_FREQ_FOR_HEALTHY = 2.5;
const MAX_FREQ_FOR_WATCH = 3.5;
const CPM_WATCH_THRESHOLD = 40;
const CPM_ELEVATED_THRESHOLD = 80;

const CPA_WATCH_THRESHOLD = TARGET_CPA;
const CPA_CEILING_THRESHOLD = TARGET_CPA * 1.2;
const CPA_KILL_THRESHOLD = TARGET_CPA * 1.5;

const INSIGHT_FIELDS = 'spend,impressions,cpm,cpc,ctr,frequency,actions,action_values';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (!META_ACCESS_TOKEN || !AD_ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing META_ACCESS_TOKEN or AD_ACCOUNT_ID env vars' });
  }

  try {
    // ── DATE RANGE: display window (default last 3 days) + fixed 3-day health window ──
    const { start, end, preset } = req.query;
    const healthSince = getDateString(-2);
    const healthUntil = getDateString(0);
    const healthRange = encodeURIComponent(JSON.stringify({ since: healthSince, until: healthUntil }));

    let displayInsightsParam;
    let rangeLabel;
    if (start && end) {
      displayInsightsParam = `insights.time_range(${encodeURIComponent(JSON.stringify({ since: start, until: end }))}){${INSIGHT_FIELDS}}`;
      rangeLabel = `${start} → ${end}`;
    } else if (preset) {
      displayInsightsParam = `insights.date_preset(${preset}){${INSIGHT_FIELDS}}`;
      rangeLabel = preset;
    } else {
      displayInsightsParam = `insights.time_range(${encodeURIComponent(JSON.stringify({ since: healthSince, until: healthUntil }))}){${INSIGHT_FIELDS}}`;
      rangeLabel = 'last_3d';
    }

    // ── FETCH AD-LEVEL DATA (display window) ──
    const fields = `name,status,effective_status,adset{name},campaign{name},${displayInsightsParam}`;
    let displayData = await fetchAllPages(
      `https://graph.facebook.com/v18.0/act_${AD_ACCOUNT_ID}/ads?fields=${fields}&limit=500`,
      META_ACCESS_TOKEN
    );
    if (displayData.error) return res.status(400).json({ error: displayData.error });

    // ── FETCH AD-LEVEL HEALTH DATA (3-day window) — skip if same window ──
    let healthData = displayData;
    const sameWindow = (!start && !end && !preset) || preset === 'last_3d' ||
      (start === healthSince && end === healthUntil);
    if (!sameWindow) {
      const hFields = `name,status,effective_status,adset{name},campaign{name},insights.time_range(${healthRange}){${INSIGHT_FIELDS}}`;
      healthData = await fetchAllPages(
        `https://graph.facebook.com/v18.0/act_${AD_ACCOUNT_ID}/ads?fields=${hFields}&limit=500`,
        META_ACCESS_TOKEN
      );
      if (healthData.error) healthData = displayData; // degrade gracefully
    }

    const healthMap = {};
    (healthData.data || []).forEach(ad => {
      healthMap[ad.id] = ad.insights?.data?.[0] || {};
    });

    // ── PROCESS ADS ──
    const ads = (displayData.data || []).map(ad => {
      const ins = ad.insights?.data?.[0] || {};
      const h = healthMap[ad.id] || ins;

      const spent = parseFloat(ins.spend) || 0;
      const impressions = parseInt(ins.impressions) || 0;
      const purchases = parseInt(getActionCount(ins.actions, 'purchase')) || 0;
      const purchaseValue = parseFloat(getActionValue(ins.action_values, 'purchase')) || 0;

      const hSpent = parseFloat(h.spend) || 0;
      const hImpressions = parseInt(h.impressions) || 0;
      const hPurchases = parseInt(getActionCount(h.actions, 'purchase')) || 0;
      const hPurchaseValue = parseFloat(getActionValue(h.action_values, 'purchase')) || 0;
      const hFreq = parseFloat(h.frequency) || 0;
      const hCpa = hPurchases > 0 ? hSpent / hPurchases : null;

      const sku = extractModelCode(ad.name);

      return {
        id: ad.id,
        name: ad.name,
        sku,                       // e.g. "T-7079" — null for funnel ads (DM_SHOP etc.)
        status: ad.status,
        effectiveStatus: ad.effective_status,
        adset: ad.adset?.name || '',
        campaign: ad.campaign?.name || '',
        spent: round2(spent),
        impressions,
        purchases,
        purchaseValue: purchaseValue > 0 ? round2(purchaseValue) : null,
        cpa: purchases > 0 ? round2(spent / purchases) : null,
        roas: spent > 0 ? round2(purchaseValue / spent) : null,
        cpm: parseFloat(ins.cpm) > 0 ? round2(parseFloat(ins.cpm)) : null,
        ctr: parseFloat(ins.ctr) > 0 ? round2(parseFloat(ins.ctr)) : null,
        frequency: parseFloat(ins.frequency) > 0 ? round2(parseFloat(ins.frequency)) : null,
        healthSpent: round2(hSpent),
        healthPurchases: hPurchases,
        healthRoas: hSpent > 0 ? round2(hPurchaseValue / hSpent) : null,
        healthCpa: hCpa ? round2(hCpa) : null,
        healthFrequency: hFreq > 0 ? round2(hFreq) : null,
        health: classifyHealth(ad.status, ad.effective_status, hSpent, hImpressions, hPurchases, hCpa, hFreq)
      };
    });

    // ── AGGREGATE PER PRODUCT SKU ──
    const bySku = {};
    const unattributed = [];
    ads.forEach(ad => {
      if (!ad.sku) { unattributed.push(ad); return; }
      if (!bySku[ad.sku]) {
        bySku[ad.sku] = { sku: ad.sku, spent: 0, impressions: 0, purchases: 0, purchaseValue: 0,
                          healthSpent: 0, healthPurchases: 0, healthPurchaseValue: 0, ads: [] };
      }
      const p = bySku[ad.sku];
      p.spent += ad.spent;
      p.impressions += ad.impressions;
      p.purchases += ad.purchases;
      p.purchaseValue += ad.purchaseValue || 0;
      p.healthSpent += ad.healthSpent;
      p.healthPurchases += ad.healthPurchases;
      p.healthPurchaseValue += (ad.healthRoas || 0) * ad.healthSpent;
      p.ads.push({ id: ad.id, name: ad.name, status: ad.status, campaign: ad.campaign,
                   spent: ad.spent, purchases: ad.purchases, health: ad.health });
    });

    const products = Object.values(bySku).map(p => {
      const hCpa = p.healthPurchases > 0 ? p.healthSpent / p.healthPurchases : null;
      return {
        sku: p.sku,
        spent: round2(p.spent),
        spentIQD: Math.round(p.spent * USD_TO_IQD),
        impressions: p.impressions,
        purchases: p.purchases,
        purchaseValue: round2(p.purchaseValue),
        cpa: p.purchases > 0 ? round2(p.spent / p.purchases) : null,
        roas: p.spent > 0 ? round2(p.purchaseValue / p.spent) : null,
        healthSpent: round2(p.healthSpent),
        healthRoas: p.healthSpent > 0 ? round2(p.healthPurchaseValue / p.healthSpent) : null,
        healthCpa: hCpa ? round2(hCpa) : null,
        health: classifyHealth('ACTIVE', 'ACTIVE', p.healthSpent, p.impressions,
                               p.healthPurchases, hCpa, 0),
        adCount: p.ads.length,
        ads: p.ads
      };
    }).sort((a, b) => b.spent - a.spent);

    // ── SUMMARY ──
    const totalSpent = ads.reduce((s, a) => s + a.spent, 0);
    const totalPurchases = ads.reduce((s, a) => s + a.purchases, 0);
    const totalRevenue = ads.reduce((s, a) => s + (a.purchaseValue || 0), 0);
    const healthCounts = { healthy: 0, watch: 0, refresh_creative: 0, kill: 0, in_review: 0, gathering_data: 0, dead: 0 };
    ads.forEach(a => { healthCounts[a.health] = (healthCounts[a.health] || 0) + 1; });

    return res.status(200).json({
      source: 'meta-marketing-api',
      currency: 'USD',
      usdToIqd: USD_TO_IQD,
      syncedAt: new Date().toISOString(),
      dateRange: rangeLabel,
      healthWindow: `${healthSince} → ${healthUntil}`,
      config: { targetCPA: TARGET_CPA, targetROAS: TARGET_ROAS, minSpendKill: MIN_SPEND_FOR_KILL },
      summary: {
        totalAds: ads.length,
        productAds: ads.filter(a => a.sku).length,
        unattributedAds: unattributed.length,
        matchedSkus: products.length,
        totalSpent: round2(totalSpent),
        totalSpentIQD: Math.round(totalSpent * USD_TO_IQD),
        unattributedSpent: round2(unattributed.reduce((s, a) => s + a.spent, 0)),
        totalPurchases,
        totalRevenue: round2(totalRevenue),
        avgCPA: totalPurchases > 0 ? round2(totalSpent / totalPurchases) : null,
        avgROAS: totalSpent > 0 ? round2(totalRevenue / totalSpent) : null,
        healthCounts,
        killList: ads.filter(a => a.health === 'kill').map(a => ({ name: a.name, sku: a.sku, spent: a.healthSpent }))
      },
      products,
      ads
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ── HELPERS (ported from ads.js) ──

async function fetchAllPages(baseUrl, token) {
  let url = `${baseUrl}&access_token=${token}`;
  let all = [];
  let guard = 0;
  while (url && guard < 10) {
    let r = await fetch(url);
    let d = await r.json();
    if (d.error && d.error.code === 190 && META_APP_ID && META_APP_SECRET) {
      const refreshed = await refreshToken(token);
      if (refreshed) { token = refreshed; url = url.replace(/access_token=[^&]+/, `access_token=${refreshed}`); continue; }
    }
    if (d.error) return d;
    all = all.concat(d.data || []);
    url = d.paging?.next || null;
    guard++;
  }
  return { data: all };
}

function classifyHealth(status, effectiveStatus, hSpent, hImpressions, hPurchases, hCpa, hFreq) {
  if (status === 'PAUSED' || status === 'OFF') return 'dead';
  if (effectiveStatus === 'PENDING_REVIEW' || effectiveStatus === 'PENDING_BILLING_INITIAL') return 'in_review';
  if (hSpent < MIN_SPEND_FOR_CLASSIFICATION || hImpressions < MIN_IMPRESSIONS_FOR_CLASSIFICATION) return 'gathering_data';
  if (hSpent >= MIN_SPEND_FOR_KILL && hPurchases === 0) return 'kill';
  if (hCpa && hCpa > CPA_KILL_THRESHOLD && hSpent >= MIN_SPEND_FOR_KILL) return 'kill';
  if (hFreq >= MAX_FREQ_FOR_WATCH) return 'refresh_creative';
  if (hCpa && hCpa > CPA_CEILING_THRESHOLD) return 'watch';
  if (hCpa && hCpa > CPA_WATCH_THRESHOLD) return 'watch';
  if (hFreq >= MAX_FREQ_FOR_HEALTHY) return 'watch';
  return 'healthy';
}

function extractModelCode(name) {
  // Word-boundary: the letter must NOT be part of a longer word
  // (prevents "fast with 136 products" -> false "H-136")
  const match = (name || '').match(/(?:^|[^A-Za-z0-9])([A-Z])[-\s]?(\d{3,4})(?!\d)/i);
  if (match) return `${match[1].toUpperCase()}-${match[2]}`;
  const nameMatch = (name || '').match(/(KOLIK|TAFETTA)/i);
  if (nameMatch) return nameMatch[1].toUpperCase();
  return null;
}

function getDateString(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

function getActionCount(actions, actionType) {
  if (!actions || !Array.isArray(actions)) return 0;
  if (actionType === 'purchase') {
    const pixel = actions.find(a => a.action_type === 'offsite_conversion.fb_pixel_purchases');
    if (pixel) return parseInt(pixel.value) || 0;
    const p = actions.find(a => a.action_type === 'purchase');
    if (p) return parseInt(p.value) || 0;
    const any = actions.find(a => a.action_type?.includes('purchase'));
    return any ? parseInt(any.value) || 0 : 0;
  }
  const act = actions.find(a => a.action_type === actionType);
  return act ? parseInt(act.value) : 0;
}

function getActionValue(actionValues, actionType) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;
  if (actionType === 'purchase') {
    const pixel = actionValues.find(a => a.action_type === 'offsite_conversion.fb_pixel_purchases');
    if (pixel) return parseFloat(pixel.value) || 0;
    const p = actionValues.find(a => a.action_type === 'purchase');
    if (p) return parseFloat(p.value) || 0;
    const any = actionValues.find(a => a.action_type?.includes('purchase'));
    return any ? parseFloat(any.value) || 0 : 0;
  }
  const act = actionValues.find(a => a.action_type === actionType);
  return act ? parseFloat(act.value) : 0;
}

async function refreshToken(token) {
  if (!META_APP_ID || !META_APP_SECRET) return null;
  try {
    const url = `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${token}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.access_token || null;
  } catch (e) { return null; }
}

function round2(n) { return Math.round(n * 100) / 100; }
