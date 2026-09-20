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
    minPeriod: 10, minHt: 2.0, swellPoint: 'south', coef: 1.25,
  },
  yellowbanks: {
    name: 'Yellow Banks', beachNormal: 180, swellDirs: [168, 215], ideal: [175, 195],
    pointIdeal: [175, 195], bowlWindow: [196, 215],
    minPeriod: 13, minHt: 2.8, swellPoint: 'south', coef: 0.85,
  },
  chinese: {
    name: 'Chinese Harbor', beachNormal: 340, swellDirs: [278, 340], ideal: [285, 318],
    pointIdeal: null, bowlWindow: null,
    minPeriod: 9, minHt: 1.8, swellPoint: 'north', coef: 0.55,
  }
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const mToFt   = m  => (m * 3.28084).toFixed(1);
const msToKt  = ms => Math.round(ms * 1.94384);
const dirName = d  => ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d / 22.5) % 16];
const starsStr = n => '★'.repeat(n) + '☆'.repeat(5 - n);

const dayLabel = (date, i) => i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
  : date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });

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

// ── WAVE MODEL v2 (Sep 2026) — keep identical in index.html and forecast.js ──
// Source: NOAA GFS Wave 0.25° via Open-Meteo. Primary, secondary AND tertiary
// swell partitions all come from this ONE model (v1 mixed two models and never
// read GFS's primary partition, which is how the 9/11 SSW swell was missed).
// Each hour: keep partitions inside the spot's swell window, fade out partitions
// shorter than the spot's minPeriod, weight by approach angle, combine by energy,
// then convert to breaking face height (Komar–Gaudet) × a per-spot coef.
// The day's value is the average over SURF_HOURS (morning session window).
// Marmetta coef set from 4 logged sessions (8/10/24, 7/20/25, 8/2/26, 9/11/26).
// YB and Chinese coefs are PROVISIONAL until their logged sessions are replayed.
const SURF_HOURS = [7, 8, 9, 10, 11, 12];
const CARD_HOUR  = 9;   // hour used for the swell cards / description text
const PARTITION_KEYS = [
  ['swell_wave_height',           'swell_wave_direction',           'swell_wave_period'],
  ['secondary_swell_wave_height', 'secondary_swell_wave_direction', 'secondary_swell_wave_period'],
  ['tertiary_swell_wave_height',  'tertiary_swell_wave_direction',  'tertiary_swell_wave_period'],
];
const MARINE_HOURLY = PARTITION_KEYS.flat().join(',');

function inSwellWindow(dir, spotKey) {
  const [lo, hi] = SPOTS[spotKey].swellDirs;
  return dir >= lo && dir <= hi;
}

// Komar & Gaudet (1973) breaking wave height (m) from deep-water H (m) and period T (s)
function komarGaudet(Hm, T) {
  return 0.39 * Math.pow(9.81, 0.2) * Math.pow(T * Hm * Hm, 0.4);
}

// All swell partitions for one hourly index of an Open-Meteo marine response
function partitionsAt(hourly, idx) {
  return PARTITION_KEYS.map(([hk, dk, pk]) => ({
    ht:  (hourly[hk] && hourly[hk][idx])  || 0,
    dir: (hourly[dk] && hourly[dk][idx])  || 0,
    per: (hourly[pk] && hourly[pk][idx])  || 0,
  })).filter(p => p.ht > 0.05 && p.per > 0);
}

// Effective deep-water height (m) this partition delivers to the spot (0 if blocked)
// 0 at (minPeriod − 2s), ramping to 1 at minPeriod
function periodRamp(per, spotKey) {
  const minP = SPOTS[spotKey].minPeriod;
  return Math.min(1, Math.max(0, (per - (minP - 2)) / 2));
}

function partitionContribution(p, spotKey) {
  const sp = SPOTS[spotKey];
  if (!inSwellWindow(p.dir, spotKey)) return 0;
  const angle = Math.sqrt(Math.max(0, Math.cos((p.dir - sp.beachNormal) * Math.PI / 180)));
  return p.ht * angle * periodRamp(p.per, spotKey);
}

function hourWave(parts, spotKey) {
  let E = 0, ET = 0;
  const scored = parts.map(p => {
    const c = partitionContribution(p, spotKey);
    E += c * c; ET += c * c * p.per;
    return { ...p, contrib: c, inWindow: inSwellWindow(p.dir, spotKey), ramp: periodRamp(p.per, spotKey) };
  }).sort((a, b) => (b.contrib - a.contrib) || (b.ht - a.ht));
  scored.forEach(p => { p.share = E > 0 ? (p.contrib * p.contrib) / E : 0; });   // share of wave energy
  const per = E > 0 ? ET / E : 0;
  const faceFt = E > 0 ? komarGaudet(Math.sqrt(E), per) * 3.28084 * SPOTS[spotKey].coef : 0;
  return { faceFt, per, parts: scored };
}

function faceLabel(ft) {
  if (ft < 1.5) return 'Flat';
  if (ft < 2.5) return 'Ankle–Knee';
  if (ft < 3.5) return 'Knee–Waist';
  if (ft < 4.5) return 'Waist–Chest';
  if (ft < 5.5) return 'Chest High';
  if (ft < 6.5) return 'Chest–Head';
  if (ft < 7.5) return 'Head High';
  if (ft < 9.0) return 'Head–Overhead';
  return 'Overhead+';
}

// d.swell[point] = 24 hourly partition arrays for that day
function spotWave(d, spotKey) {
  const hours = d.swell[SPOTS[spotKey].swellPoint];
  const hw = SURF_HOURS.map(h => hourWave(hours[h] || [], spotKey));
  const faceExact = hw.reduce((s, x) => s + x.faceFt, 0) / hw.length;

  // Dominant direction = energy-weighted circular mean of each hour's top in-window partition
  let sx = 0, sy = 0, perSum = 0, wSum = 0;
  hw.forEach(x => {
    const top = x.parts[0];
    if (top && top.contrib > 0) {
      const w = top.contrib * top.contrib;
      sx += w * Math.cos(top.dir * Math.PI / 180);
      sy += w * Math.sin(top.dir * Math.PI / 180);
      perSum += x.per * w; wSum += w;
    }
  });
  let dominantDir = wSum > 0 ? Math.atan2(sy, sx) * 180 / Math.PI : 0;
  if (dominantDir < 0) dominantDir += 360;

  const card = hourWave(hours[CARD_HOUR] || [], spotKey);
  const contributing = card.parts.filter(p => p.contrib > 0.05);
  return {
    faceExact,
    faceFt: Math.round(faceExact),
    label: faceLabel(faceExact),
    blendedPer: wSum > 0 ? Math.round(perSum / wSum) : 0,
    dominantDir,
    hasSwell: wSum > 0,
    cardParts: card.parts,          // all partitions at CARD_HOUR, best-for-this-spot first
    isBlended: contributing.length > 1,
  };
}

// ── SCORING ───────────────────────────────────────────────────────────────────
function scoreSpot(spot, waveEst, windSpd, windDir) {
  const faceFt = Math.round(waveEst.faceExact * 10) / 10;
  const correctedSpd = spotWindCorrection(spot, windSpd, windDir);
  const wkt = msToKt(correctedSpd);
  const offshore = spot === 'chinese' ? (windDir >= 55 && windDir <= 145) : (windDir >= 280 || windDir <= 35);
  let sc = 0;

  // ── Yellow Banks two-mode scoring ────────────────────────────────────────
  if (spot === 'yellowbanks') {
    const sp = SPOTS['yellowbanks'];

    // Mode set by the swell delivering the most energy to YB (v2)
    const dirs = waveEst.hasSwell ? [waveEst.dominantDir] : [];
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
  else if (faceFt >= 3.0) sc += 30;
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
  // ── Swell: NOAA GFS Wave 0.25° ONLY, all three partitions, hourly (model v2)
  // S point (33.1°N 119.7°W) → Marmetta & Yellow Banks; N point near NDBC 46218 → Chinese Harbor
  const marineURL = (lat, lon) =>
    'https://marine-api.open-meteo.com/v1/marine' +
    `?latitude=${lat}&longitude=${lon}` +
    '&hourly=' + MARINE_HOURLY +
    '&models=ncep_gfswave025&forecast_days=7&timezone=America%2FLos_Angeles';
  const marineSWURL = marineURL(33.1, -119.7);
  const marineCHURL = marineURL(34.448, -120.779);

  // ── Wind — mid-channel point unchanged (34.18°N 119.84°W)
  const windURL =
    'https://api.open-meteo.com/v1/forecast' +
    '?latitude=34.18&longitude=-119.84' +
    '&hourly=windspeed_10m,winddirection_10m' +
    '&forecast_days=7&timezone=America%2FLos_Angeles&windspeed_unit=ms';

  const nwsURL = 'https://api.weather.gov/alerts/active?zone=PZZ650';

  const [marineSWRes, marineCHRes, windRes, nwsRes] = await Promise.all([
    fetch(marineSWURL),
    fetch(marineCHURL),
    fetch(windURL),
    fetch(nwsURL, { headers: { 'Accept': 'application/geo+json' } }).catch(() => null)
  ]);

  if (!marineSWRes.ok) throw new Error(`Marine SW API: ${marineSWRes.status}`);
  if (!marineCHRes.ok) throw new Error(`Marine CH API: ${marineCHRes.status}`);
  if (!windRes.ok)     throw new Error(`Wind API: ${windRes.status}`);

  const marineSW = await marineSWRes.json();
  const marineCH = await marineCHRes.json();

  const wind = await windRes.json();
  const nws  = nwsRes && nwsRes.ok ? await nwsRes.json() : null;
  return { marineSW, marineCH, wind, nws };
}

// ── BUILD DAYS (with direction averaging 8am–4pm) ─────────────────────────────
function buildDays(raw) {
  const { marineSW, marineCH, wind } = raw;
  const days = [];

  for (let i = 0; i < 7; i++) {
    const date = new Date(marineSW.hourly.time[i * 24].slice(0, 10) + 'T12:00:00-07:00');
    const base = i * 24;
    const wh   = wind.hourly;
    const noon = base + 12;
    const wNoon = { spd: wh.windspeed_10m[noon] || 0, dir: wh.winddirection_10m[noon] || 0 };

    // 24 hourly partition lists per point for this day (index = local hour)
    const hoursOf = m => Array.from({ length: 24 }, (_, hr) => partitionsAt(m.hourly, base + hr));
    const swell = { south: hoursOf(marineSW), north: hoursOf(marineCH) };

    days.push({
      date,
      label: dayLabel(date, i),
      swell,
      windSpd: wNoon.spd, windDir: wNoon.dir
    });
  }
  return days;
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
      const we = spotWave(d, key);
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
      Open-Meteo Marine (NOAA GFS Wave) · NWS PZZ650 · model v2
    </div>

  </div>
</body>
</html>`;

  return { html, subject };
}

// ── SEND EMAIL ────────────────────────────────────────────────────────────────
// Resend free tier only allows a single `to` address per API call.
// We loop over recipients and send individually so a list works on free tier.
async function sendEmail(subject, html) {
  const recipients = TO_EMAIL.split(',').map(e => e.trim()).filter(Boolean);
  if (recipients.length === 0) throw new Error('No recipients in TO_EMAIL');

  for (const recipient of recipients) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to:   recipient,
        subject,
        html
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resend API error ${res.status} for ${recipient}: ${err}`);
    }
    console.log(`Email sent to ${recipient}`);
  }
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
