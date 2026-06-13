// ── SCI SURF — Daily Forecast Emailer ────────────────────────────────────────
// Fetches Open-Meteo Marine + NWS data, scores all three spots,
// sends a simplified HTML email via Resend.
// Runs daily via GitHub Actions (cron: '0 13 * * *' = ~6am PT).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL       = process.env.TO_EMAIL;   // comma-separated for multiple recipients
const FROM_EMAIL     = process.env.FROM_EMAIL;

// ── SPOT DEFINITIONS (keep in sync with index.html) ──────────────────────────
const SPOTS = {
  marmetta: {
    name: 'Marmetta', beachNormal: 195, swellDirs: [165, 262], ideal: [190, 235],
    pointIdeal: null, bowlWindow: null,
    minPeriod: 10, minHt: 2.0, waveMultiplier: 1.05,
  },
  yellowbanks: {
    name: 'Yellow Banks', beachNormal: 180, swellDirs: [168, 215], ideal: [175, 195],
    pointIdeal: [175, 195], bowlWindow: [196, 215],
    minPeriod: 13, minHt: 2.8, waveMultiplier: 1.05,
  },
  chinese: {
    name: 'Chinese Harbor', beachNormal: 340, swellDirs: [278, 340], ideal: [285, 318],
    pointIdeal: null, bowlWindow: null,
    minPeriod: 9, minHt: 1.8, waveMultiplier: 0.82,
  }
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const mToFt   = m  => (m * 3.28084).toFixed(1);
const msToKt  = ms => Math.round(ms * 1.94384);
const dirName = d  => ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d / 22.5) % 16];
const starsStr = n => '★'.repeat(n) + '☆'.repeat(5 - n);

const dayLabel = (date, i) => i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
  : date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });

function circularMean(dirs) {
  const valid = dirs.filter(d => d > 0 && d < 999);
  if (!valid.length) return 0;
  const sinSum = valid.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
  const cosSum = valid.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
  const mean = Math.atan2(sinSum, cosSum) * 180 / Math.PI;
  return mean < 0 ? mean + 360 : mean;
}

// ── SPOT WIND CORRECTION ──────────────────────────────────────────────────────
function spotWindCorrection(spot, windSpd, windDir) {
  const isWesterly = windDir >= 240 && windDir <= 320;
  const isEasterly = windDir >= 60  && windDir <= 150;
  const kt = msToKt(windSpd);

  if (spot === 'chinese') {
    return isEasterly ? windSpd * 0.5 : windSpd;
  }
  if (spot === 'marmetta' || spot === 'yellowbanks') {
    // Smooth lee-shadow curve: island blocks wind up to 15kt, then half the excess
    // 19kt channel → 2kt at spot; 25kt → 5kt; 35kt → 10kt
    if (isWesterly) return Math.max(0, (kt - 15) * 0.5) / 1.94384;
  }
  return windSpd;
}

// ── WAVE FACE ESTIMATE ────────────────────────────────────────────────────────
function angularFactor(swellDir, beachNormal) {
  return Math.max(0, Math.cos((swellDir - beachNormal) * Math.PI / 180));
}

function decayFactor(period) {
  if (period >= 15) return 0.98;
  if (period >= 12) return 0.95;
  if (period >= 10) return 0.92;
  return 0.88;
}

function estimateWaveFace(s1HtM, s1Dir, s1Per, s2HtM, s2Dir, s2Per, spotKey) {
  const sp  = SPOTS[spotKey];
  const bn  = sp.beachNormal;
  const h1c = s1HtM * angularFactor(s1Dir, bn) * decayFactor(s1Per);
  const h2c = s2HtM > 0.2 ? s2HtM * angularFactor(s2Dir, bn) * decayFactor(s2Per) : 0;
  const combinedM = Math.sqrt(h1c * h1c + h2c * h2c);
  const h1sq = h1c * h1c, h2sq = h2c * h2c, totalSq = h1sq + h2sq;
  const blendedPer = totalSq > 0 ? (h1sq * s1Per + h2sq * s2Per) / totalSq : s1Per;
  const periodFactor = 0.7 + (Math.min(blendedPer, 22) / 22) * 0.8;
  const faceFt = combinedM * 3.28084 * periodFactor * sp.waveMultiplier;
  const dominantDir = h1c >= h2c ? s1Dir : s2Dir;
  return { faceFt: Math.round(faceFt), blendedPer: Math.round(blendedPer), dominantDir, s1Dir, s2Dir: s2HtM > 0.2 ? s2Dir : 0 };
}

// ── SCORING ───────────────────────────────────────────────────────────────────
function scoreSpot(spot, waveEst, windSpd, windDir) {
  const faceFt = parseFloat(waveEst.faceFt);
  const correctedSpd = spotWindCorrection(spot, windSpd, windDir);
  const wkt = msToKt(correctedSpd);
  const offshore = spot === 'chinese' ? (windDir >= 55 && windDir <= 145) : (windDir >= 280 || windDir <= 35);
  let sc = 0;

  // ── Yellow Banks two-mode scoring ────────────────────────────────────────
  if (spot === 'yellowbanks') {
    const sp = SPOTS['yellowbanks'];

    // Check BOTH swell components independently — either one in the window qualifies.
    const dirs = [waveEst.s1Dir, waveEst.s2Dir].filter(d => d > 0);
    const inPoint = d => d >= sp.pointIdeal[0] && d <= sp.pointIdeal[1];
    const inBowl  = d => d >= sp.bowlWindow[0]  && d <= sp.bowlWindow[1];
    const pointMode = dirs.some(inPoint);
    const bowlMode  = !pointMode && dirs.some(inBowl);

    if (!pointMode && !bowlMode) return { stars: 1, go: 'nogo', score: 5 };

    if (pointMode) {
      if      (faceFt >= 7.0) sc += 65;
      else if (faceFt >= 5.5) sc += 55;
      else if (faceFt >= 4.5) sc += 45;
      else if (faceFt >= 3.5) sc += 35;
      else if (faceFt >= 3.0) sc += 35;
      else if (faceFt >= 2.5) sc += 25;
      else if (faceFt >= 1.5) sc += 12;
    } else {
      if      (faceFt >= 6.0) sc += 52;
      else if (faceFt >= 4.5) sc += 42;
      else if (faceFt >= 3.0) sc += 30;
      else if (faceFt >= 2.5) sc += 18;
    }

    if (offshore && wkt < 12)       sc += 15;
    else if (wkt < 8)                sc += 10;
    else if (!offshore && wkt > 18)  sc -= 12;
    else if (!offshore && wkt > 10)  sc -= 4;

    return {
      stars: sc>=70?5:sc>=55?4:sc>=38?3:sc>=20?2:1,
      go:    sc>=40?'go':sc>=22?'maybe':'nogo',
      score: sc,
      ybMode: pointMode ? 'point' : 'bowl'
    };
  }

  // ── Standard scoring (Marmetta + Chinese Harbor) ──────────────────────────
  if      (faceFt >= 7.0) sc += 65;
  else if (faceFt >= 5.5) sc += 55;
  else if (faceFt >= 4.5) sc += 45;
  else if (faceFt >= 3.5) sc += 35;
  else if (faceFt >= 3.0) sc += 35;
  else if (faceFt >= 2.5) sc += 25;
  else if (faceFt >= 1.5) sc += 12;
  else if (faceFt >= 0.5) sc += 4;

  if (offshore && wkt < 12)       sc += 15;
  else if (wkt < 8)                sc += 10;
  else if (!offshore && wkt > 18)  sc -= 12;
  else if (!offshore && wkt > 10)  sc -= 4;

  return {
    stars: sc>=70?5:sc>=55?4:sc>=38?3:sc>=20?2:1,
    go:    sc>=40?'go':sc>=22?'maybe':'nogo',
    score: sc
  };
}

// ── DATA FETCH ────────────────────────────────────────────────────────────────
async function fetchAll() {
  // ── S/SW swell — queried at open Pacific (33.1°N 119.7°W)
  // South of SCI, outside the Santa Cruz Basin, full open-ocean S/SW exposure.
  // Slightly north of prior 32.7°N point to avoid overcounting pre-island swell;
  // still well clear of the basin attenuation seen at 46251 (33.769°N).
  const marineSWURL =
    'https://marine-api.open-meteo.com/v1/marine' +
    '?latitude=33.1&longitude=-119.7' +
    '&daily=swell_wave_height_max,swell_wave_direction_dominant,swell_wave_period_max' +
    '&hourly=swell_wave_height,swell_wave_direction,swell_wave_period' +
    '&forecast_days=7&timezone=America%2FLos_Angeles';

  const marineSW2URL =
    'https://marine-api.open-meteo.com/v1/marine' +
    '?latitude=33.1&longitude=-119.7' +
    '&hourly=secondary_swell_wave_height,secondary_swell_wave_direction,secondary_swell_wave_period' +
    '&forecast_days=7&timezone=America%2FLos_Angeles&models=ncep_gfswave025';

  // ── NW swell — queried near NDBC 46218 Harvest (34.448°N 120.779°W)
  // Open Pacific west of Point Conception — full unobstructed NW swell exposure.
  // Validated against 46218 historical data: MWD stable 271-302° vs 204-281° at old 46053 point.
  // Multiplier recalibrated from 1.65 → 0.82 to account for higher raw open-ocean WVHT.
  const marineCHURL =
    'https://marine-api.open-meteo.com/v1/marine' +
    '?latitude=34.448&longitude=-120.779' +
    '&daily=swell_wave_height_max,swell_wave_direction_dominant,swell_wave_period_max' +
    '&hourly=swell_wave_height,swell_wave_direction,swell_wave_period' +
    '&forecast_days=7&timezone=America%2FLos_Angeles';

  const marineCH2URL =
    'https://marine-api.open-meteo.com/v1/marine' +
    '?latitude=34.448&longitude=-120.779' +
    '&hourly=secondary_swell_wave_height,secondary_swell_wave_direction,secondary_swell_wave_period' +
    '&forecast_days=7&timezone=America%2FLos_Angeles&models=ncep_gfswave025';

  // ── Wind — mid-channel point unchanged (34.18°N 119.84°W)
  const windURL =
    'https://api.open-meteo.com/v1/forecast' +
    '?latitude=34.18&longitude=-119.84' +
    '&hourly=windspeed_10m,winddirection_10m' +
    '&forecast_days=7&timezone=America%2FLos_Angeles&windspeed_unit=ms';

  const nwsURL = 'https://api.weather.gov/alerts/active?zone=PZZ650';

  const [marineSWRes, marineSW2Res, marineCHRes, marineCH2Res, windRes, nwsRes] = await Promise.all([
    fetch(marineSWURL),
    fetch(marineSW2URL).catch(() => null),
    fetch(marineCHURL),
    fetch(marineCH2URL).catch(() => null),
    fetch(windURL),
    fetch(nwsURL, { headers: { 'Accept': 'application/geo+json' } }).catch(() => null)
  ]);

  if (!marineSWRes.ok) throw new Error(`Marine SW API: ${marineSWRes.status}`);
  if (!marineCHRes.ok) throw new Error(`Marine CH API: ${marineCHRes.status}`);
  if (!windRes.ok)     throw new Error(`Wind API: ${windRes.status}`);

  const marineSW = await marineSWRes.json();
  const marineCH = await marineCHRes.json();

  if (marineSW2Res && marineSW2Res.ok) {
    try {
      const m2 = await marineSW2Res.json();
      if (m2.hourly) {
        marineSW.hourly.secondary_swell_wave_height    = m2.hourly.secondary_swell_wave_height    || null;
        marineSW.hourly.secondary_swell_wave_direction = m2.hourly.secondary_swell_wave_direction || null;
        marineSW.hourly.secondary_swell_wave_period    = m2.hourly.secondary_swell_wave_period    || null;
      }
    } catch(e) { /* secondary swell unavailable */ }
  }

  if (marineCH2Res && marineCH2Res.ok) {
    try {
      const m2 = await marineCH2Res.json();
      if (m2.hourly) {
        marineCH.hourly.secondary_swell_wave_height    = m2.hourly.secondary_swell_wave_height    || null;
        marineCH.hourly.secondary_swell_wave_direction = m2.hourly.secondary_swell_wave_direction || null;
        marineCH.hourly.secondary_swell_wave_period    = m2.hourly.secondary_swell_wave_period    || null;
      }
    } catch(e) { /* secondary swell unavailable */ }
  }

  const wind = await windRes.json();
  const nws  = nwsRes && nwsRes.ok ? await nwsRes.json() : null;
  return { marineSW, marineCH, wind, nws };
}

// ── BUILD DAYS (with direction averaging 8am–4pm) ─────────────────────────────
function buildDays(raw) {
  const { marineSW, marineCH, wind } = raw;
  const days = [];

  // Helper: extract primary+secondary swell from one marine object for day i
  function extractSwell(m, i) {
    const base = i * 24;
    const h = m.hourly;
    const sampleIdxs = [8, 10, 12, 14, 16].map(hr => base + hr);
    const noon = base + 12;
    const s1Dirs   = sampleIdxs.map(idx => h.swell_wave_direction?.[idx] || 0);
    const s1DirAvg = circularMean(s1Dirs);
    const s2Ht  = h.secondary_swell_wave_height ? (h.secondary_swell_wave_height[noon] || 0) : 0;
    const s2Per = h.secondary_swell_wave_period  ? (h.secondary_swell_wave_period[noon] || 0) : 0;
    const s2Dirs   = sampleIdxs.map(idx => h.secondary_swell_wave_direction?.[idx] || 0);
    const s2DirAvg = s2Ht > 0.2 ? circularMean(s2Dirs) : 0;
    return {
      s1Ht:  m.daily.swell_wave_height_max[i]  || 0,
      s1Dir: s1DirAvg,
      s1Per: m.daily.swell_wave_period_max[i]  || 10,
      s2Ht, s2Dir: s2DirAvg, s2Per
    };
  }

  for (let i = 0; i < 7; i++) {
    const date = new Date(marineSW.daily.time[i] + 'T12:00:00-07:00');
    const base = i * 24;
    const wh   = wind.hourly;
    const noon = base + 12;
    const wNoon = { spd: wh.windspeed_10m[noon] || 0, dir: wh.winddirection_10m[noon] || 0 };

    // swSwell: buoy 46251 coords — Marmetta & Yellow Banks
    // chSwell: buoy 46053 coords — Chinese Harbor
    const swSwell = extractSwell(marineSW, i);
    const chSwell = extractSwell(marineCH, i);

    days.push({
      date,
      label: dayLabel(date, i),
      swSwell,
      chSwell,
      // Flat legacy fields default to SW swell
      s1Ht: swSwell.s1Ht, s1Dir: swSwell.s1Dir, s1Per: swSwell.s1Per,
      s2Ht: swSwell.s2Ht, s2Dir: swSwell.s2Dir, s2Per: swSwell.s2Per,
      windSpd: wNoon.spd, windDir: wNoon.dir
    });
  }
  return days;
}

// Return the correct swell object for a given spot from a day
function swellForSpot(d, spotKey) {
  return SPOTS[spotKey].buoyRef === '46053' ? d.chSwell : d.swSwell;
}

// ── NWS ALERTS ────────────────────────────────────────────────────────────────
function parseNWS(nws) {
  if (!nws || !nws.features) return [];
  return nws.features.map(f => {
    const p  = f.properties;
    const ev = (p.event || '').toLowerCase();
    let sev  = 'info';
    if      (ev.includes('storm warning') || ev.includes('hurricane')) sev = 'storm';
    else if (ev.includes('gale'))        sev = 'gale';
    else if (ev.includes('small craft')) sev = 'sca';
    return { severity: sev, headline: p.headline || p.event };
  }).filter(a => a.severity !== 'info');
}

// ── EMAIL BUILDER ─────────────────────────────────────────────────────────────
function buildEmail(days, alerts) {

  // Score every spot for every day using the correct per-spot swell source
  const scored = days.map(d => {
    const out = {};
    for (const key of Object.keys(SPOTS)) {
      const dsw = swellForSpot(d, key);
      const we = estimateWaveFace(dsw.s1Ht, dsw.s1Dir, dsw.s1Per, dsw.s2Ht, dsw.s2Dir, dsw.s2Per, key);
      out[key] = { we, r: scoreSpot(key, we, d.windSpd, d.windDir) };
    }
    return out;
  });

  // ── Find GO days ─────────────────────────────────────────────────────────
  const goDays = [];
  days.forEach((d, i) => {
    const goSpots = Object.entries(SPOTS)
      .filter(([key]) => scored[i][key].r.go === 'go')
      .map(([key]) => {
        const { we, r } = scored[i][key];
        const mode = r.ybMode ? ` (${r.ybMode})` : '';
        return `${SPOTS[key].name}${mode} — ~${we.faceFt}ft ${starsStr(r.stars)}`;
      });
    if (goSpots.length) goDays.push({ label: d.label, spots: goSpots });
  });

  // ── NWS alert banner ─────────────────────────────────────────────────────
  let alertBanner = '';
  if (alerts.length) {
    const a = alerts[0];
    const color = a.severity === 'storm' ? '#c0392b' : a.severity === 'gale' ? '#e67e22' : '#d4a017';
    const label = a.severity === 'storm' ? 'STORM WARNING' : a.severity === 'gale' ? 'GALE WARNING' : 'SMALL CRAFT ADVISORY';
    alertBanner = `
      <div style="background:${color}22;border-left:3px solid ${color};border-radius:6px;
                  padding:10px 14px;margin-bottom:16px;font-size:12px;color:#dde4f5">
        <strong style="color:${color}">${label} · NWS PZZ650</strong><br>
        ${a.headline}
      </div>`;
  }

  // ── Promising days section ────────────────────────────────────────────────
  let goSection = '';
  if (goDays.length) {
    const rows = goDays.map(d => `
      <tr>
        <td style="padding:8px 12px;white-space:nowrap;font-weight:500;color:#4ecdc4;
                   border-bottom:1px solid rgba(255,255,255,.06)">${d.label}</td>
        <td style="padding:8px 12px;color:#dde4f5;border-bottom:1px solid rgba(255,255,255,.06)">
          ${d.spots.join('<br>')}
        </td>
      </tr>`).join('');

    goSection = `
      <div style="background:#0d2a1a;border:1px solid rgba(78,205,196,.25);border-left:3px solid #4ecdc4;
                  border-radius:8px;padding:14px 16px;margin-bottom:16px">
        <div style="font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
                    color:#4ecdc4;margin-bottom:10px">🌊 Go days this week</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          ${rows}
        </table>
      </div>`;
  } else {
    goSection = `
      <div style="background:#1a1a2e;border:1px solid rgba(160,120,220,.2);border-left:3px solid #4a5078;
                  border-radius:8px;padding:14px 16px;margin-bottom:16px;
                  font-size:13px;color:#6a7098">
        No GO days in the next 7 days. Check the site for marginal days.
      </div>`;
  }

  // ── Assemble email ────────────────────────────────────────────────────────
  const todayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles'
  });

  const subject = goDays.length > 0
    ? `🌊 SCI Surf — ${goDays[0].label} looks good`
    : `SCI Surf Forecast — ${todayStr}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#0d0f1a;color:#dde4f5;font-family:system-ui,-apple-system,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px 40px">

    <div style="border-bottom:1px solid rgba(160,120,220,.2);padding-bottom:12px;margin-bottom:16px">
      <div style="font-family:monospace;font-size:20px;font-weight:700;letter-spacing:2px;color:#4ecdc4">SBI WX</div>
      <div style="font-size:11px;color:#4a5078;margin-top:3px;letter-spacing:.08em;text-transform:uppercase">
        Daily Forecast · ${todayStr}
      </div>
    </div>

    ${alertBanner}
    ${goSection}

    <div style="font-size:10px;color:#4a5078;border-top:1px solid rgba(160,120,220,.12);padding-top:12px;line-height:1.8">
      Open-Meteo Marine (ECMWF WAM) · NWS PZZ650 · NDBC 46251 + 46053
    </div>

  </div>
</body>
</html>`;

  return { html, subject };
}

// ── SEND EMAIL ────────────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  // Split comma-separated TO_EMAIL into array for multiple recipients
  const recipients = TO_EMAIL.split(',').map(e => e.trim()).filter(Boolean);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to:   recipients,
      subject,
      html
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log('Fetching forecast data...');
    const raw    = await fetchAll();
    const days   = buildDays(raw);
    const alerts = parseNWS(raw.nws);
    console.log(`Built ${days.length} days, ${alerts.length} NWS alerts`);

    const { html, subject } = buildEmail(days, alerts);
    console.log(`Subject: ${subject}`);

    await sendEmail(subject, html);
    console.log('Email sent successfully.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
