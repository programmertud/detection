/**
 * ============================================================================
 * FIREGUARD IOT — MONITORING SYSTEM CONTROLLER
 * ============================================================================
 * Framework : Vanilla JavaScript (ES Modules) + Vite
 * Database  : Supabase Client (PostgreSQL + Realtime WebSocket)
 * ============================================================================
 */

import { createClient } from '@supabase/supabase-js';
import './style.css';

// ----------------------------------------------------------------------------
// CONFIG & STATE
// ----------------------------------------------------------------------------
const CONFIG = {
  STALE_THRESHOLD_MS: 15000,
  DEFAULT_THRESHOLD:  50.0,
  MAX_FEED_EVENTS:    50,
  MAX_SPARKLINE:      20,
  HISTORY_LIMIT:      30,
};

const state = {
  supabase:          null,
  isConfigured:      false,
  latestReading:     null,
  lastProcessedId:   null,
  historyData:       [],
  historyFilter:     'ALL',
  currentPage:       1,
  flameThreshold:    parseFloat(localStorage.getItem('flame_threshold') || CONFIG.DEFAULT_THRESHOLD),
  audioEnabled:      localStorage.getItem('audio_alert_enabled') === 'true',
  feedEvents:        [],       // live scrolling feed entries
  sparklineData:     [],       // last 20 intensity values
  sessionStart:      Date.now(),
  totalAlerts:       0,
  totalSafe:         0,
  totalReadings:     0,
  pollTimer:         null,
  staleTimer:        null,
  isNodeOnline:      false,
};

let audioCtx = null;
let sirenNode = null;

// ----------------------------------------------------------------------------
// BOOT
// ----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setupControls();
  initSupabase();
  startClockTick();
  startSessionTimer();
});

// ----------------------------------------------------------------------------
// LIVE CLOCK
// ----------------------------------------------------------------------------
function startClockTick() {
  const el = document.getElementById('live-clock');
  function tick() {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('en-US', { hour12: false });
  }
  tick();
  setInterval(tick, 1000);
}

// ----------------------------------------------------------------------------
// SESSION UPTIME TIMER
// ----------------------------------------------------------------------------
function startSessionTimer() {
  setInterval(() => {
    const secs = Math.floor((Date.now() - state.sessionStart) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const el = document.getElementById('stat-uptime');
    if (el) el.textContent = h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
  }, 1000);
}

// ----------------------------------------------------------------------------
// SUPABASE INIT
// ----------------------------------------------------------------------------
function initSupabase() {
  const url = localStorage.getItem('supabase_url')
    || import.meta.env.VITE_SUPABASE_URL || '';
  const key = localStorage.getItem('supabase_key')
    || import.meta.env.VITE_SUPABASE_ANON_KEY || '';

  if (!url || !key) {
    setHdrSync('NO CONFIG', false);
    openModal();
    return;
  }

  try {
    state.supabase = createClient(url, key);
    state.isConfigured = true;
    setHdrSync('CONNECTING', null);
    startDataStream();
    loadHistory();
  } catch (e) {
    console.error('Supabase init error:', e);
    setHdrSync('ERROR', false);
  }
}

// ----------------------------------------------------------------------------
// REALTIME SUBSCRIPTION + POLLING FALLBACK
// ----------------------------------------------------------------------------
function startDataStream() {
  if (!state.supabase) return;

  // Realtime subscription
  state.supabase
    .channel('fireguard-live')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'detection_readings',
    }, (payload) => {
      handleNewReading(payload.new);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setHdrSync('LIVE', true);
      }
    });

  // Dual Polling fallback: constantly sync both latest reading AND history table every 1500ms
  // This guarantees live data streaming even if Supabase Realtime WebSocket drops or fails
  state.pollTimer = setInterval(async () => {
    await fetchLatestReading();
    await loadHistory();
  }, 1500);

  // Initial fetch of latest reading
  fetchLatestReading();

  // Stale detection
  state.staleTimer = setInterval(checkStaleness, 2000);
}

async function fetchLatestReading() {
  if (!state.supabase) return;
  try {
    const { data, error } = await state.supabase
      .from('detection_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!error && data) handleNewReading(data);
  } catch (e) { /* silent */ }
}

function handleNewReading(row) {
  if (!row) return;

  const isDuplicate = state.lastProcessedId === row.id;
  state.latestReading = row;

  let rawIntensity = parseFloat(row.distance_cm) || 0;
  // Ambient room light filter: clamp minor baseline fluctuations (< 5%) to clean 0.0%
  let intensity = rawIntensity < 5.0 ? 0.0 : rawIntensity;

  const ageMs = Math.abs(Date.now() - new Date(row.created_at).getTime());
  const isLive = ageMs < CONFIG.STALE_THRESHOLD_MS;
  state.isNodeOnline = isLive;

  // When offline/disconnected, show 0.0%
  const displayIntensity = isLive ? intensity : 0.0;
  const isFire = isLive && displayIntensity >= state.flameThreshold;
  const isWarm = isLive && displayIntensity >= 26.0 && displayIntensity < state.flameThreshold;

  // Only increment counters and feed on genuinely newly arrived packets
  if (!isDuplicate && isLive) {
    state.lastProcessedId = row.id;
    state.totalReadings++;
    if (isFire) state.totalAlerts++;
    else state.totalSafe++;

    // Update sparkline buffer
    state.sparklineData.push({ intensity: displayIntensity, isFire, isWarm });
    if (state.sparklineData.length > CONFIG.MAX_SPARKLINE)
      state.sparklineData.shift();

    // Add to feed
    prependFeedEvent(row, displayIntensity, isFire, isWarm);
  }

  // Render all panels
  renderStatusPanel(displayIntensity, isLive);
  renderIntensityPanel(displayIntensity, isLive);
  renderNodePanel(row, isLive);
  renderStatsPanel();
  renderSparkline();

  // Global status pill
  setGlobalStatus(displayIntensity, isLive);

  // Alert banner
  setFireBanner(isFire, displayIntensity);

  // Browser siren: only sounds if fire detected (>= 50%)
  if (isFire && state.audioEnabled) triggerBrowserSiren(true);
  else triggerBrowserSiren(false);
}

// ----------------------------------------------------------------------------
// STALENESS CHECK
// ----------------------------------------------------------------------------
function checkStaleness() {
  if (!state.latestReading) return;
  const age = Math.abs(Date.now() - new Date(state.latestReading.created_at).getTime());
  const isStale = age > CONFIG.STALE_THRESHOLD_MS;
  state.isNodeOnline = !isStale;

  const badge = document.getElementById('node-hw-status');
  if (badge) {
    badge.textContent = isStale ? 'OFFLINE' : 'ONLINE';
    badge.className = 'node-badge ' + (isStale ? 'badge-offline' : 'badge-online');
  }

  const wifiEl = document.getElementById('node-wifi-status');
  if (wifiEl) {
    wifiEl.textContent = isStale ? 'Disconnected' : 'Connected';
    wifiEl.className = 'node-badge ' + (isStale ? 'badge-offline' : 'badge-online');
  }

  // When offline/stale, clear any active fire alarm state and show clean 0.0%
  if (isStale) {
    renderStatusPanel(0, false);
    renderIntensityPanel(0, false);
    setGlobalStatus(0, false);
    setFireBanner(false, 0);
    triggerBrowserSiren(false);
  }
}

// ----------------------------------------------------------------------------
// RENDER: FIRE STATUS PANEL
// ----------------------------------------------------------------------------
function renderStatusPanel(intensity, isLive = true) {
  const panel  = document.getElementById('panel-fire-status');
  const icon   = document.getElementById('mon-status-icon');
  const label  = document.getElementById('mon-status-label');
  const sub    = document.getElementById('mon-status-sub');

  panel?.classList.remove('fire-active', 'warm-active');
  icon?.classList.remove('icon-offline', 'icon-fire', 'icon-warm');

  if (!isLive) {
    icon?.classList.add('icon-offline');
    if (label) {
      label.textContent = 'STANDBY';
      label.className = 'mon-status-label text-muted';
    }
    if (sub) sub.textContent = 'Hardware offline — Connect ESP32 to monitor';
  } else if (intensity >= state.flameThreshold) {
    // 50% - 100%: Fire
    panel?.classList.add('fire-active');
    icon?.classList.add('icon-fire');
    if (label) { label.textContent = 'FIRE!'; label.className = 'mon-status-label fire'; }
    if (sub) sub.textContent = `CRITICAL: Flame intensity ${intensity.toFixed(1)}% (50-100%) — Buzzer active`;
  } else if (intensity >= 26.0) {
    // 26% - 50%: Warm
    panel?.classList.add('warm-active');
    icon?.classList.add('icon-warm');
    if (label) { label.textContent = 'WARM'; label.className = 'mon-status-label warm'; }
    if (sub) sub.textContent = `CAUTION: Thermal buildup ${intensity.toFixed(1)}% (26-50%)`;
  } else {
    // 0% - 25%: Safe
    if (label) { label.textContent = 'SAFE'; label.className = 'mon-status-label'; }
    if (sub) sub.textContent = `Environment normal: ${intensity.toFixed(1)}% (0-25%)`;
  }
}

// ----------------------------------------------------------------------------
// RENDER: INTENSITY PANEL
// ----------------------------------------------------------------------------
function renderIntensityPanel(intensity, isLive = true) {
  const displayVal = isLive ? (intensity < 5.0 ? 0.0 : intensity) : 0.0;
  const valEl  = document.getElementById('intensity-value');
  const barEl  = document.getElementById('intensity-bar');
  const pinEl  = document.getElementById('threshold-pin');
  const pinLbl = document.querySelector('.threshold-pin-label');
  const rawEl  = document.getElementById('raw-adc');
  const thrLbl = document.getElementById('thresh-label');

  if (valEl) valEl.textContent = displayVal.toFixed(1);
  if (barEl) barEl.style.width = Math.min(displayVal, 100) + '%';

  const pct = state.flameThreshold;
  if (pinEl)  pinEl.style.left  = pct + '%';
  if (pinLbl) pinLbl.textContent = pct + '%';
  if (thrLbl) thrLbl.textContent = pct + '%';

  // Estimate raw ADC from intensity: intensity = (4095 - raw) / 4095 * 100
  const rawApprox = isLive ? Math.round(4095 - (displayVal / 100) * 4095) : 4095;
  if (rawEl) rawEl.textContent = rawApprox;
}

// ----------------------------------------------------------------------------
// RENDER: NODE STATUS PANEL
// ----------------------------------------------------------------------------
function renderNodePanel(row, isLive = true) {
  const lastSeen = document.getElementById('node-last-seen');
  const doState  = document.getElementById('node-do-state');
  const wifiEl   = document.getElementById('node-wifi-status');
  const hwBadge  = document.getElementById('node-hw-status');

  if (lastSeen) {
    const age = Math.max(0, Math.floor(Math.abs(Date.now() - new Date(row.created_at).getTime()) / 1000));
    lastSeen.textContent = age < 60 ? `${age}s ago` : `${Math.floor(age/60)}m ago`;
  }

  const intensity = parseFloat(row.distance_cm) || 0;
  const isFire = (row.detected === true || row.sensor_status === 'Fire Alert' || intensity >= state.flameThreshold) && isLive;

  if (doState) {
    if (!isLive) {
      doState.textContent = 'OFFLINE';
      doState.className   = 'node-badge badge-offline';
    } else {
      doState.textContent = isFire ? 'LOW (FLAME)' : 'HIGH (Clear)';
      doState.className   = 'node-badge ' + (isFire ? 'badge-offline' : 'badge-online');
    }
  }

  if (wifiEl) {
    wifiEl.textContent  = isLive ? 'Connected' : 'Disconnected';
    wifiEl.className    = 'node-badge ' + (isLive ? 'badge-online' : 'badge-offline');
  }

  if (hwBadge) {
    hwBadge.textContent = isLive ? 'ONLINE' : 'OFFLINE';
    hwBadge.className   = 'node-badge ' + (isLive ? 'badge-online' : 'badge-offline');
  }

  // Update header node uptime placeholder
  const uptimeEl = document.getElementById('node-uptime');
  if (uptimeEl) {
    const sess = Math.floor((Date.now() - state.sessionStart) / 1000);
    uptimeEl.textContent = sess < 60 ? `${sess}s` : `${Math.floor(sess/60)}m`;
  }
}

// ----------------------------------------------------------------------------
// RENDER: STATISTICS PANEL
// ----------------------------------------------------------------------------
function renderStatsPanel() {
  const totalEl  = document.getElementById('stat-total');
  const alertsEl = document.getElementById('stat-alerts');
  const safeEl   = document.getElementById('stat-safe');

  if (totalEl)  totalEl.textContent  = state.totalReadings.toLocaleString();
  if (alertsEl) alertsEl.textContent = state.totalAlerts.toLocaleString();
  if (safeEl)   safeEl.textContent   = state.totalSafe.toLocaleString();
}

// ----------------------------------------------------------------------------
// RENDER: LIVE FEED
// ----------------------------------------------------------------------------
function prependFeedEvent(row, intensity, isFire, isWarm) {
  const container = document.getElementById('live-feed-container');
  if (!container) return;

  // Remove empty state
  const empty = document.getElementById('feed-empty');
  if (empty) empty.remove();

  const time = new Date(row.created_at).toLocaleTimeString('en-US', { hour12: false });
  const statusText = isFire ? 'FIRE DETECTED' : isWarm ? 'WARM (26-50%)' : 'Safe (0-25%)';
  const statusClass = isFire ? 'text-red' : isWarm ? 'text-amber' : 'text-green';
  const dotClass = isFire ? 'feed-dot-fire' : isWarm ? 'feed-dot-warm' : 'feed-dot-safe';

  const div = document.createElement('div');
  div.className = `feed-event ${isFire ? 'event-fire' : isWarm ? 'event-warm' : ''}`;
  div.innerHTML = `
    <span class="feed-dot ${dotClass}"></span>
    <span class="feed-time">${time}</span>
    <span class="feed-status ${statusClass}">${statusText}</span>
    <span class="feed-intensity">${intensity.toFixed(1)}%</span>
  `;

  container.insertBefore(div, container.firstChild);

  // Trim excess
  while (container.children.length > CONFIG.MAX_FEED_EVENTS) {
    container.removeChild(container.lastChild);
  }
}

// ----------------------------------------------------------------------------
// RENDER: SPARKLINE CHART
// ----------------------------------------------------------------------------
function renderSparkline() {
  const container = document.getElementById('sparkline-container');
  if (!container) return;

  container.innerHTML = '';
  const data = state.sparklineData;
  const maxVal = Math.max(...data.map(d => d.intensity), 1);

  data.forEach(d => {
    const bar = document.createElement('div');
    const heightPct = Math.max((d.intensity / maxVal) * 100, 4);
    bar.className = `spark-bar ${d.isFire ? 'spark-fire' : d.isWarm ? 'spark-warn' : ''}`;
    bar.style.height = heightPct + '%';
    bar.title = `${d.intensity.toFixed(1)}%`;
    container.appendChild(bar);
  });
}

// ----------------------------------------------------------------------------
// GLOBAL STATUS PILL
// ----------------------------------------------------------------------------
function setGlobalStatus(intensity, isLive = true) {
  const pill = document.getElementById('global-status-pill');
  const text = document.getElementById('global-status-text');
  if (!pill || !text) return;

  pill.className = 'global-status-pill';

  if (!isLive) {
    pill.classList.add('status-offline');
    text.textContent = 'STANDBY (NODE OFFLINE)';
  } else if (intensity >= state.flameThreshold) {
    pill.classList.add('status-fire');
    text.textContent = '⚠ FIRE ALERT (50-100%)';
  } else if (intensity >= 26.0) {
    pill.classList.add('status-warm');
    text.textContent = '⚡ WARM (26-50%)';
  } else {
    pill.classList.add('status-safe');
    text.textContent = 'SYSTEM NORMAL (0-25%)';
  }
}

// ----------------------------------------------------------------------------
// FIRE ALERT BANNER
// ----------------------------------------------------------------------------
function setFireBanner(isFire, intensity) {
  const banner  = document.getElementById('fire-alert-banner');
  const intEl   = document.getElementById('fire-banner-intensity');
  if (!banner) return;

  if (isFire) {
    banner.classList.remove('hidden');
    if (intEl) intEl.textContent = intensity.toFixed(1) + '%';
  } else {
    banner.classList.add('hidden');
  }
}

// ----------------------------------------------------------------------------
// HEADER SYNC LABEL
// ----------------------------------------------------------------------------
function setHdrSync(text, online) {
  const el = document.getElementById('hdr-sync');
  if (!el) return;
  el.textContent = text;
  if (online === true)  el.className = 'header-meta-val mono text-green';
  else if (online === false) el.className = 'header-meta-val mono text-red';
  else el.className = 'header-meta-val mono text-amber';
}

// ----------------------------------------------------------------------------
// HISTORY TABLE
// ----------------------------------------------------------------------------
async function loadHistory() {
  if (!state.supabase) return;
  try {
    let query = state.supabase
      .from('detection_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(CONFIG.HISTORY_LIMIT);

    if (state.historyFilter === 'DETECTED') {
      // Fire (50-100%)
      query = query.gte('distance_cm', 50.0);
    } else if (state.historyFilter === 'CLEAR') {
      // Safe (0-25%)
      query = query.lt('distance_cm', 26.0);
    }

    const { data, error } = await query;
    if (error) return;
    state.historyData = data || [];
    renderHistoryTable();
  } catch (e) { /* silent */ }
}

function renderHistoryTable() {
  const tbody = document.getElementById('history-table-body');
  const info  = document.getElementById('history-pagination-info');
  if (!tbody) return;

  if (!state.historyData.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="log-empty-cell">No records found</td></tr>`;
    if (info) info.textContent = '0 records';
    return;
  }

  if (info) info.textContent = `${state.historyData.length} records`;

  tbody.innerHTML = state.historyData.map((row, i) => {
    let rawIntensity = parseFloat(row.distance_cm) || 0;
    // Ambient noise filter: clamp minor baseline fluctuations (< 5%) to clean 0.0%
    const intensity = rawIntensity < 5.0 ? 0.0 : rawIntensity;
    const isFire    = intensity >= 50.0;
    const isWarm    = intensity >= 26.0 && intensity < 50.0;
    const ts        = new Date(row.created_at);
    const timeStr   = ts.toLocaleString('en-US', { hour12: false });
    const ageMs     = Date.now() - ts.getTime();
    const ageSecs   = Math.floor(ageMs / 1000);
    const ageStr    = ageSecs < 60 ? `${ageSecs}s` : ageSecs < 3600 ? `${Math.floor(ageSecs/60)}m` : `${Math.floor(ageSecs/3600)}h`;

    let statusBadge;
    let intensityColor;
    if (isFire) {
      statusBadge = `<span class="log-status-badge log-status-fire">🔥 Fire Alert</span>`;
      intensityColor = 'text-red';
    } else if (isWarm) {
      statusBadge = `<span class="log-status-badge log-status-warm">⚡ Warm</span>`;
      intensityColor = 'text-amber';
    } else {
      statusBadge = `<span class="log-status-badge log-status-safe">✓ Safe</span>`;
      intensityColor = 'text-green';
    }

    return `<tr>
      <td class="log-id">#${row.id || (state.historyData.length - i)}</td>
      <td class="log-time mono">${timeStr}</td>
      <td class="log-intensity ${intensityColor}">${intensity.toFixed(1)}%</td>
      <td>${statusBadge}</td>
      <td class="log-age">${ageStr}</td>
    </tr>`;
  }).join('');
}

// ----------------------------------------------------------------------------
// BROWSER SIREN (Web Audio API)
// ----------------------------------------------------------------------------
function triggerBrowserSiren(activate) {
  if (!state.audioEnabled) return;

  if (activate) {
    if (sirenNode) return; // already running
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(2400, audioCtx.currentTime);
      osc.frequency.setValueAtTime(1600, audioCtx.currentTime + 0.5);
      osc.frequency.setValueAtTime(2400, audioCtx.currentTime + 1.0);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      osc.start();
      sirenNode = osc;
    } catch (e) { /* audio not available */ }
  } else {
    if (sirenNode) {
      try { sirenNode.stop(); } catch (e) {}
      sirenNode = null;
    }
  }
}

function playTestSiren() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2400, audioCtx.currentTime);
    osc.frequency.setValueAtTime(1600, audioCtx.currentTime + 0.4);
    osc.frequency.setValueAtTime(2400, audioCtx.currentTime + 0.8);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 1.5);
    osc.start();
    osc.stop(audioCtx.currentTime + 1.5);
  } catch (e) { alert('Audio not supported in this browser.'); }
}

// ----------------------------------------------------------------------------
// CSV EXPORT
// ----------------------------------------------------------------------------
function exportCSV() {
  if (!state.historyData.length) { alert('No data to export.'); return; }
  const headers = ['ID', 'Timestamp', 'Flame Intensity (%)', 'Fire Status', 'Detected'];
  const rows = state.historyData.map(r => [
    r.id || '',
    r.created_at,
    parseFloat(r.distance_cm || 0).toFixed(1),
    r.sensor_status || '',
    r.detected ? 'YES' : 'NO',
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `fireguard-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------------
// THRESHOLD UPDATE
// ----------------------------------------------------------------------------
function updateThreshold(val) {
  val = Math.min(90, Math.max(10, parseFloat(val)));
  state.flameThreshold = val;
  localStorage.setItem('flame_threshold', val);

  const slider = document.getElementById('threshold-slider');
  const input  = document.getElementById('threshold-input');
  if (slider) slider.value = val;
  if (input)  input.value  = val;

  // Re-render intensity pin
  if (state.latestReading) {
    renderIntensityPanel(parseFloat(state.latestReading.distance_cm) || 0);
  }
}

// ----------------------------------------------------------------------------
// MODAL
// ----------------------------------------------------------------------------
function openModal() {
  const modal = document.getElementById('config-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  // Pre-fill saved values
  const urlEl = document.getElementById('cfg-url');
  const keyEl = document.getElementById('cfg-key');
  if (urlEl) urlEl.value = localStorage.getItem('supabase_url') || import.meta.env.VITE_SUPABASE_URL || '';
  if (keyEl) keyEl.value = localStorage.getItem('supabase_key') || import.meta.env.VITE_SUPABASE_ANON_KEY || '';
}

function closeModal() {
  document.getElementById('config-modal')?.classList.add('hidden');
}

// ----------------------------------------------------------------------------
// CONTROLS SETUP
// ----------------------------------------------------------------------------
function setupControls() {
  // Config modal
  document.getElementById('open-config-btn')?.addEventListener('click', openModal);
  document.getElementById('close-config-btn')?.addEventListener('click', closeModal);
  document.getElementById('config-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('config-modal')) closeModal();
  });

  // Config form submit
  document.getElementById('config-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const url = document.getElementById('cfg-url')?.value.trim();
    const key = document.getElementById('cfg-key')?.value.trim();
    if (!url || !key) return;
    localStorage.setItem('supabase_url', url);
    localStorage.setItem('supabase_key', key);
    closeModal();
    location.reload();
  });

  // Reset config
  document.getElementById('reset-config-btn')?.addEventListener('click', () => {
    localStorage.removeItem('supabase_url');
    localStorage.removeItem('supabase_key');
    location.reload();
  });

  // Manual refresh
  document.getElementById('manual-refresh-btn')?.addEventListener('click', () => {
    fetchLatestReading();
    loadHistory();
  });

  // Threshold slider
  document.getElementById('threshold-slider')?.addEventListener('input', e => {
    updateThreshold(e.target.value);
  });

  // Threshold number input
  document.getElementById('threshold-input')?.addEventListener('change', e => {
    updateThreshold(e.target.value);
  });

  // Preset chips
  document.querySelectorAll('.preset-chip').forEach(btn => {
    btn.addEventListener('click', () => updateThreshold(btn.dataset.val));
  });

  // History filter
  document.getElementById('history-filter-select')?.addEventListener('change', e => {
    state.historyFilter = e.target.value;
    loadHistory();
  });

  // Export CSV
  document.getElementById('export-csv-btn')?.addEventListener('click', exportCSV);

  // Clear Logs / Reset Data button
  document.getElementById('clear-data-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all incident logs and reset readings counter to 0?')) return;

    // Reset local state immediately
    state.totalReadings = 0;
    state.totalAlerts = 0;
    state.totalSafe = 0;
    state.historyData = [];
    state.sparklineData = [];
    renderStatsPanel();
    renderHistoryTable();
    renderSparkline();

    const feedContainer = document.getElementById('live-feed-container');
    if (feedContainer) {
      feedContainer.innerHTML = '<div class="feed-empty-state" id="feed-empty"><span>Logs and counters reset to 0. Waiting for new live readings...</span></div>';
    }

    if (state.supabase) {
      try {
        const { error } = await state.supabase
          .from('detection_readings')
          .delete()
          .gt('id', 0);
        if (error) {
          console.log('Database notice: Run TRUNCATE TABLE detection_readings; in Supabase SQL editor to clear historical cloud records.');
        }
      } catch (e) {
        /* silent */
      }
    }
  });

  // Audio toggle switch
  const audioSwitch = document.getElementById('audio-toggle-switch');
  if (audioSwitch) {
    audioSwitch.checked = state.audioEnabled;
    audioSwitch.addEventListener('change', e => {
      state.audioEnabled = e.target.checked;
      localStorage.setItem('audio_alert_enabled', state.audioEnabled);
      if (!state.audioEnabled) triggerBrowserSiren(false);
      // Sync top-bar button text
      const btn = document.getElementById('audio-btn-text');
      if (btn) btn.textContent = state.audioEnabled ? 'Siren ON' : 'Siren OFF';
    });
  }

  // Top-bar audio button (shortcut toggle)
  document.getElementById('audio-alert-btn')?.addEventListener('click', () => {
    const sw = document.getElementById('audio-toggle-switch');
    if (sw) {
      sw.checked = !sw.checked;
      sw.dispatchEvent(new Event('change'));
    }
  });

  // Sync initial button text
  const audioBtn = document.getElementById('audio-btn-text');
  if (audioBtn) audioBtn.textContent = state.audioEnabled ? 'Siren ON' : 'Siren OFF';

  // Test siren button
  document.getElementById('test-audio-btn')?.addEventListener('click', playTestSiren);

  // Pagination (prev/next — data already loaded, just for display)
  document.getElementById('history-prev-page')?.addEventListener('click', () => {
    if (state.currentPage > 1) { state.currentPage--; renderHistoryTable(); }
  });
  document.getElementById('history-next-page')?.addEventListener('click', () => {
    state.currentPage++;
    renderHistoryTable();
  });

  // Init threshold display
  updateThreshold(state.flameThreshold);
}
