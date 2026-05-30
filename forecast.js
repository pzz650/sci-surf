// ── SCI SURF — Daily Forecast Emailer ─────────────────────────────────────────
// Fetches Open-Meteo Marine + NWS data, scores all three spots,
// and sends a formatted HTML email via Resend.
// Runs daily via GitHub Actions at 6am PT.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL       = process.env.TO_EMAIL;
const FROM_EMAIL     = process.env.FROM_EMAIL; // e.g. forecast@yourdomain.com

// ── SPOT DEFINITIONS (mirrors index.html) ─────────────────────────────────────
const SPOTS = {
  marmetta: {
    name: 'Marmetta', beachNormal: 195, swellDirs: [165, 255], ideal: [190, 235],
    minPeriod: 10, minHt: 2.0, waveMultiplier: 1.55,
    notes: 'S/SW 165–255°. Best mid-tide. Rock near takeoff at low. Glass in the mornings.'
  },
  yellowbanks: {
    name: 'Yellow Banks', beachNormal: 180, swellDirs: [168, 205], ideal: [175, 185],
    minPeriod: 13, minHt: 2.8, waveMultiplier: 1.6,
    notes: 'Needs true S 175–185° to fire the point. Very direction-sensitive.'
  },
  chinese: {
    name: 'Chinese Harbor', beachNormal: 340, swellDirs: [278, 340], ideal: [285, 318],
    minPeriod: 9, minHt: 1.8, waveMultiplier: 1.45,
    notes: 'NW swell 278°+. Below ~278° = flat. E/SE wind kills anchorage. Best mornings.'
  }
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const mToFt    = m  => (m * 3.28084).toFixed(1);
const msToKt   = ms => Math.round(ms * 1.94384);
const dirName  = d  => ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d / 22.5) % 16];
const stars    = n  => '★'.repeat(n) + '☆'.repeat(5 - n);
const dayLabel = (date, i) => i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
  : date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });

function angularFactor(swellDir, beachNormal) {
  const diff = (swellDir - beachNormal) * Math.PI / 180;
  return Math.max(0, Math.cos(diff));
}

function decayFactor(period) {
  if (period >= 15) return 0.98;
  if (period >= 12) return 0.95;
  if (period >= 10) return 0.92;
  return 0.88;
}

function spotWindCorrection(spot, windSpd, windDir) {
  const isWesterly = windDir >= 240 && windDir <= 320;
  const isEasterly = windDir >= 60  && windDir <= 150;
  const kt = msToKt(windSpd);
  if (spot === 'chinese') {
    return isEasterly ? windSpd * 0.5 : windSpd;
  }
  if (spot === 'marmetta' || spot === 'yellowbanks') {
    if (isWesterly) return kt <= 15 ? 0 : windSpd * 0.6;
  }
  return windSpd;
}

function estimateWaveFace(s1HtM, s1Dir, s1Per, s2HtM, s2Dir, s2Per, spotKey) {
  const sp = SPOTS[spotKey];
  const bn = sp.beachNormal;
  const h1c = s1HtM * angularFactor(s1Dir, bn) * decayFactor(s1Per);
  const h2c = s2HtM > 0.2 ? s2HtM * angularFactor(s2Dir, bn) * decayFactor(s2Per) : 0;
  const combinedM = Math.sqrt(h1c * h1c + h2c * h2c);
  const h1sq = h1c * h1c, h2sq = h2c * h2c, totalSq = h1sq + h2sq;
  const blendedPer = totalSq > 0 ? (h1sq * s1Per + h2sq * s2Per) / totalSq : s1Per;
  const periodFactor = 0.7 + (Math.min(blendedPer, 22) / 22) * 0.8;
  const faceFt = (combinedM * 3.28084) * periodFactor * sp.waveMultiplier;
  let label;
  if      (faceFt < 1.5) label = 'Flat';
  else if (faceFt < 2.5) label = 'Ankle–Knee';
  else if (faceFt < 3.5) label = 'Knee–Waist';
  else if (faceFt < 4.5) label = 'Waist–Chest';
  else if (faceFt < 5.5) label = 'Chest High';
  else if (faceFt < 6.5) label = 'Chest–Head';
  else if (faceFt < 7.5) label = 'Head High';
  else if (faceFt < 9.0) label = 'Head–Overhead';
  else                   label = 'Overhead+';
  return { faceFt: faceFt.toFixed(1), label, blendedPer: Math.round(blendedPer) };
}

function scoreSpot(spot, waveEst, windSpd, windDir) {
  const faceFt = parseFloat(waveEst.faceFt);
  const correctedSpd = spotWindCorrection(spot, windSpd, windDir);
  const wkt = msToKt(correctedSpd);
  let sc = 0;
  const reasons = [];
  if      (faceFt >= 7.0) { sc += 65; reasons.push(`~${faceFt}ft — overhead+`); }
  else if (faceFt >= 5.5) { sc += 55; reasons.push(`~${faceFt}ft — head high`); }
  else if (faceFt >= 4.5) { sc += 45; reasons.push(`~${faceFt}ft — chest to head`); }
  else if (faceFt >= 3.5) { sc += 35; reasons.push(`~${faceFt}ft — chest high`); }
  else if (faceFt >= 2.5) { sc += 25; reasons.push(`~${faceFt}ft — waist to chest`); }
  else if (faceFt >= 1.5) { sc += 12; reasons.push(`~${faceFt}ft — knee to waist`); }
  else if (faceFt >= 0.5) { sc += 4;  reasons.push(`~${faceFt}ft — ankle to knee`); }
  else                     { sc += 0;  reasons.push('Flat'); }
  const offshore = spot === 'chinese' ? (windDir >= 55 && windDir <= 145) : (windDir >= 280 || windDir <= 35);
  if      (offshore && wkt < 12)      { sc += 15; reasons.push(`Light offshore ${wkt}kt ${dirName(windDir)} — glassy`); }
  else if (wkt < 8)                   { sc += 10; reasons.push(`Light wind ${wkt}kt`); }
  else if (!offshore && wkt > 18)     { sc -= 12; reasons.push(`Strong onshore ${wkt}kt ${dirName(windDir)}`); }
  else if (!offshore && wkt > 10)     { sc -= 4;  reasons.push(`Onshore ${wkt}kt ${dirName(windDir)}`); }
  else                                {           reasons.push(`${wkt}kt ${dirName(windDir)}`); }
  const go    = sc >= 40 ? 'go' : sc >= 22 ? 'maybe' : 'nogo';
  const nStars = sc >= 70 ? 5 : sc >= 55 ? 4 : sc >= 38 ? 3 : sc >= 20 ? 2 : 1;
  return { stars: nStars, go, score: sc, reasons };
}

// ── DATA FETCH ────────────────────────────────────────────────────────────────
async function fetchAll() {
  const marineURL =
    'https://marine-api.open-meteo.com/v1/marine' +
    '?latitude=34.04&longitude=-119.75' +
    '&daily=swell_wave_height_max,swell_wave_direction_dominant,swell_wave_period_max' +
    '&hourly=swell_wave_height,swell_wave_direction,swell_wave_period' +
    '&forecast_days=7&timezone=America%2FLos_Angeles';

  const marine2URL =
    'https://marine-api.open-meteo.com/v1/marine' +
    '?latitude=34.04&longitude=-119.75' +
    '&hourly=secondary_swell_wave_height,secondary_swell_wave_direction,secondary_swell_wave_period' +
    '&forecast_days=7&timezone=America%2FLos_Angeles&models=ncep_gfswave025';

  const windURL =
    'https://api.open-meteo.com/v1/forecast' +
    '?latitude=34.18&longitude=-119.84' +
    '&hourly=windspeed_10m,winddirection_10m' +
    '&forecast_days=7&timezone=America%2FLos_Angeles&windspeed_unit=ms';

  const nwsURL = 'https://api.weather.gov/alerts/active?zone=PZZ650';

  const [marineRes, marine2Res, windRes, nwsRes] = await Promise.all([
    fetch(marineURL),
    fetch(marine2URL).catch(() => null),
    fetch(windURL),
    fetch(nwsURL, { headers: { 'Accept': 'application/geo+json' } }).catch(() => null)
  ]);

  if (!marineRes.ok) throw new Error(`Marine API: ${marineRes.status}`);
  if (!windRes.ok)   throw new Error(`Wind API: ${windRes.status}`);

  const marine = await marineRes.json();
  if (marine2Res && marine2Res.ok) {
    try {
      const m2 = await marine2Res.json();
      if (m2.hourly) {
        marine.hourly.secondary_swell_wave_height    = m2.hourly.secondary_swell_wave_height    || null;
        marine.hourly.secondary_swell_wave_direction = m2.hourly.secondary_swell_wave_direction || null;
        marine.hourly.secondary_swell_wave_period    = m2.hourly.secondary_swell_wave_period    || null;
      }
    } catch(e) { /* secondary swell unavailable */ }
  }

  const wind = await windRes.json();
  const nws  = nwsRes && nwsRes.ok ? await nwsRes.json() : null;
  return { marine, wind, nws };
}

function buildDays(raw) {
  const { marine, wind } = raw;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(marine.daily.time[i] + 'T12:00:00-07:00');
    const base = i * 24;
    const h    = marine.hourly;
    const noon = base + 12;
    const s2Ht  = h.secondary_swell_wave_height    ? (h.secondary_swell_wave_height[noon]    || 0) : 0;
    const s2Dir = h.secondary_swell_wave_direction ? (h.secondary_swell_wave_direction[noon] || 0) : 0;
    const s2Per = h.secondary_swell_wave_period    ? (h.secondary_swell_wave_period[noon]    || 0) : 0;
    const wh = wind.hourly;
    const wAt = idx => ({ spd: wh.windspeed_10m[idx] || 0, dir: wh.winddirection_10m[idx] || 0 });
    const wNoon = wAt(noon);
    days.push({
      date, label: dayLabel(date, i),
      s1Ht:  marine.daily.swell_wave_height_max[i]         || 0,
      s1Dir: marine.daily.swell_wave_direction_dominant[i] || 0,
      s1Per: marine.daily.swell_wave_period_max[i]         || 10,
      s2Ht, s2Dir, s2Per,
      wMorn:  wAt(base + 7),
      wAftn:  wAt(base + 14),
      wNight: wAt(base + 20),
      windSpd: wNoon.spd, windDir: wNoon.dir
    });
  }
  return days;
}

function parseNWS(nws) {
  if (!nws || !nws.features) return [];
  return nws.features.map(f => {
    const p  = f.properties;
    const ev = (p.event || '').toLowerCase();
    let sev  = 'info';
    if      (ev.includes('storm warning') || ev.includes('hurricane')) sev = 'storm';
    else if (ev.includes('gale'))        sev = 'gale';
    else if (ev.includes('small craft')) sev = 'sca';
    return { severity: sev, headline: p.headline || p.event, event: p.event };
  }).filter(a => a.severity !== 'info');
}

// ── EMAIL BUILDER ─────────────────────────────────────────────────────────────
function buildEmail(days, alerts) {

  // Score every spot for every day
  const scored = days.map(d => {
    const result = {};
    for (const [key, sp] of Object.entries(SPOTS)) {
      const we = estimateWaveFace(d.s1Ht, d.s1Dir, d.s1Per, d.s2Ht, d.s2Dir, d.s2Per, key);
      const r  = scoreSpot(key, we, d.windSpd, d.windDir);
      result[key] = { we, r };
    }
    return result;
  });

  // ── Headline summary: flag promising days ─────────────────────────────────
  const promising = [];
  days.forEach((d, i) => {
    const goodSpots = Object.entries(SPOTS)
      .filter(([key]) => scored[i][key].r.go === 'go' || scored[i][key].r.go === 'maybe')
      .filter(([key]) => scored[i][key].r.stars >= 3)
      .map(([key]) => {
        const { we, r } = scored[i][key];
        return `${SPOTS[key].name} (${stars(r.stars)} ~${we.faceFt}ft)`;
      });
    if (goodSpots.length > 0) promising.push({ label: d.label, spots: goodSpots });
  });

  const headlineBg   = promising.length > 0 ? '#0f2a1a' : '#1a1a2a';
  const headlineText = promising.length > 0
    ? `<strong style="color:#4ecdc4">🌊 Promising days ahead:</strong><br><br>` +
      promising.map(p => `<span style="color:#dde4f5">• ${p.label}:</span> <span style="color:#8a96c8">${p.spots.join(', ')}</span>`).join('<br>')
    : `<span style="color:#8a96c8">No standout days in the next 7 days — check back tomorrow.</span>`;

  // NWS alert banner
  const alertBanner = alerts.length > 0
    ? `<div style="background:#2a1a0a;border-left:3px solid #e8c84a;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px;color:#e8c84a">
        <strong>⚠ NWS MARINE WARNING · PZZ650</strong><br>
        <span style="color:#c8b080">${alerts[0].headline}</span>
      </div>`
    : '';

  // ── Per-spot day tables ───────────────────────────────────────────────────
  const spotSections = Object.entries(SPOTS).map(([key, sp]) => {
    const rows = days.map((d, i) => {
      const { we, r } = scored[i][key];
      const corrWind  = spotWindCorrection(key, d.windSpd, d.windDir);
      const wkt       = msToKt(corrWind);
      const goBg      = r.go === 'go' ? '#0f2a1a' : r.go === 'maybe' ? '#2a2008' : '#2a0f1a';
      const goColor   = r.go === 'go' ? '#4ecdc4' : r.go === 'maybe' ? '#e8c84a' : '#d46fa0';
      const goLabel   = r.go === 'go' ? 'GO' : r.go === 'nogo' ? 'NO GO' : 'MAYBE';
      const s2cell    = d.s2Ht > 0.2
        ? `${mToFt(d.s2Ht)}ft @ ${Math.round(d.s2Per)}s ${dirName(d.s2Dir)}`
        : '<span style="color:#4a5078">—</span>';
      return `
        <tr style="background:${goBg};border-bottom:1px solid rgba(160,120,220,0.1)">
          <td style="padding:9px 10px;color:#dde4f5;font-weight:600;white-space:nowrap">${d.label}</td>
          <td style="padding:9px 10px;font-family:monospace;color:${goColor};font-weight:700;white-space:nowrap">
            ${stars(r.stars)}<br><span style="font-size:11px;letter-spacing:.08em">${goLabel}</span>
          </td>
          <td style="padding:9px 10px;font-family:monospace;color:#4ecdc4;font-weight:700;font-size:15px">~${we.faceFt}ft</td>
          <td style="padding:9px 10px;color:#8a96c8;font-size:12px">${we.label}</td>
          <td style="padding:9px 10px;color:#8a96c8;font-size:12px;white-space:nowrap">
            ${mToFt(d.s1Ht)}ft @ ${Math.round(d.s1Per)}s ${dirName(d.s1Dir)}
          </td>
          <td style="padding:9px 10px;color:#8a96c8;font-size:12px;white-space:nowrap">${s2cell}</td>
          <td style="padding:9px 10px;color:#e8c84a;font-size:12px;white-space:nowrap">
            ${wkt < 2 ? 'Calm' : wkt + 'kt ' + dirName(d.windDir)}
          </td>
          <td style="padding:9px 10px;color:#6a7098;font-size:11px">${r.reasons.join(' · ')}</td>
        </tr>`;
    }).join('');

    return `
      <div style="margin-bottom:28px">
        <div style="font-family:monospace;font-size:13px;font-weight:700;letter-spacing:.1em;color:#9b87d4;
                    text-transform:uppercase;margin-bottom:8px;padding-bottom:6px;
                    border-bottom:1px solid rgba(155,135,212,.3)">
          ${sp.name}
          <span style="font-weight:400;font-size:10px;color:#4a5078;margin-left:8px">${sp.notes}</span>
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px;font-family:'DM Sans',sans-serif">
            <thead>
              <tr style="border-bottom:1px solid rgba(160,120,220,0.25)">
                <th style="padding:7px 10px;text-align:left;font-size:10px;color:#4a5078;font-weight:600;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Day</th>
                <th style="padding:7px 10px;text-align:left;font-size:10px;color:#4a5078;font-weight:600;text-transform:uppercase;letter-spacing:.08em">Rating</th>
                <th style="padding:7px 10px;text-align:left;font-size:10px;color:#4a5078;font-weight:600;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Wave Face</th>
                <th style="padding:7px 10px;text-align:left;font-size:10px;color:#4a5078;font-weight:600;text-transform:uppercase;letter-spacing:.08em">Size</th>
                <th style="padding:7px 10px;text-align:left;font-size:10px;color:#4a5078;font-weight:600;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Primary Swell</th>
                <th style="padding:7px 10px;text-align:left;font-size:10px;color:#4a5078;font-weight:600;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Secondary Swell</th>
                <th style="padding:7px 10px;text-align:left;font-size:10px;color:#4a5078;font-weight:600;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">Spot Wind</th>
                <th style="padding:7px 10px;text-align:left;font-size:10px;color:#4a5078;font-weight:600;text-transform:uppercase;letter-spacing:.08em">Notes</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  // ── Assemble full HTML email ──────────────────────────────────────────────
  const todayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles'
  });

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#0d0f1a;color:#dde4f5;font-family:'DM Sans',sans-serif">
  <div style="max-width:780px;margin:0 auto;padding:28px 20px 48px">

    <!-- Header -->
    <div style="border-bottom:1px solid rgba(160,120,220,.28);padding-bottom:16px;margin-bottom:20px">
      <div style="font-family:monospace;font-size:22px;font-weight:700;letter-spacing:2px;
                  background:linear-gradient(90deg,#4ecdc4,#9b87d4,#d46fa0);
                  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
                  background-clip:text">SBI WX</div>
      <div style="font-size:11px;color:#4a5078;margin-top:4px;letter-spacing:.1em;text-transform:uppercase">
        Daily Forecast · ${todayStr}
      </div>
    </div>

    <!-- NWS Alert if any -->
    ${alertBanner}

    <!-- Headline summary -->
    <div style="background:${headlineBg};border:1px solid rgba(160,120,220,.2);border-left:3px solid #4ecdc4;
                border-radius:10px;padding:16px 18px;margin-bottom:24px;line-height:1.9;font-size:13px">
      ${headlineText}
    </div>

    <!-- Per-spot tables -->
    ${spotSections}

    <!-- Footer -->
    <div style="border-top:1px solid rgba(160,120,220,.15);padding-top:14px;
                font-family:monospace;font-size:10px;color:#4a5078;line-height:1.8">
      Open-Meteo Marine (ECMWF WAM) · NWS PZZ650 · NDBC 46251 + 46053<br>
      Swell data as of 12:00 PT · Wind terrain-corrected per spot
    </div>

  </div>
</body>
</html>`;

  const subject = promising.length > 0
    ? `🌊 SCI Surf — ${promising[0].label}: ${promising[0].spots[0].split('(')[0].trim()} looks good`
    : `SCI Surf Forecast — ${todayStr}`;

  return { html, subject };
}

// ── SEND EMAIL ────────────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to:   [TO_EMAIL],
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
