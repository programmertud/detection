/**
 * ============================================================================
 * FIREGUARD IOT - FIRE & FLAME DETECTION SYSTEM CONTROLLER
 * ============================================================================
 * Framework: Vanilla JavaScript (ES Modules) + Vite
 * Database:  Supabase Client (PostgreSQL + Realtime WebSocket)
 * Icons:     Lucide Icons
 * ============================================================================
 */

import { createClient } from '@supabase/supabase-js';
import { createIcons, icons } from 'lucide';
import './style.css';

// ----------------------------------------------------------------------------
// APPLICATION CONFIGURATION & STATE
// ----------------------------------------------------------------------------
const CONFIG = {
  POLL_INTERVAL_MS: 2000,          // Polling rate matching ESP32
  STALE_THRESHOLD_MS: 6500,        // Offline detection threshold
  DEFAULT_FLAME_THRESHOLD: 40.0,   // Flame intensity trigger threshold (%)
};

const state = {
  supabase: null,
  isConfigured: false,
  isRealtimeConnected: false,
  latestReading: null,
  totalReadingsCount: 0,
  historyData: [],
  historyLimit: 30,
  historyFilter: 'ALL',
  currentPage: 1,
  flameThreshold: parseFloat(localStorage.getItem('flame_threshold') || CONFIG.DEFAULT_FLAME_THRESHOLD),
  audioAlertEnabled: localStorage.getItem('audio_alert_enabled') === 'true',
  lastStateAlerted: null,
  pollTimer: null,
  staleCheckTimer: null,
  activeSection: 'overview',
};

// Web Audio API context for browser fire alarm siren
let audioCtx = null;

// ----------------------------------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initIcons();
  setupNavigation();
  setupControls();
  initSupabaseClient();
  setupAudioAlert();
  startSyncLoops();
});

function initIcons() {
  createIcons({ icons });
}

// ----------------------------------------------------------------------------
// SUPABASE CLIENT SETUP
// ----------------------------------------------------------------------------
function initSupabaseClient() {
  const envUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

  const storedUrl = localStorage.getItem('supabase_url') || envUrl;
  const storedKey = localStorage.getItem('supabase_key') || envKey;

  const isValidUrl = storedUrl && storedUrl.startsWith('https://') && !storedUrl.includes('your-project-id');
  const isValidKey = storedKey && storedKey.length > 20 && !storedKey.includes('...');

  if (isValidUrl && isValidKey) {
    try {
      state.supabase = createClient(storedUrl, storedKey, {
        realtime: {
          params: {
            eventsPerSecond: 10,
          },
        },
      });
      state.isConfigured = true;
      updateSyncStatus('Connected', 'emerald');
      showBanner('Connected to Supabase. Monitoring real-time fire telemetry...', 'success');
      setupRealtimeSubscription();
      fetchLatestTelemetry();
      fetchHistoryData();
    } catch (err) {
      console.error('[Supabase Init Error]', err);
      state.isConfigured = false;
      updateSyncStatus('Init Error', 'red');
      showBanner(`Connection error: ${err.message}`, 'error');
    }
  } else {
    state.isConfigured = false;
    updateSyncStatus('Config Required', 'amber');
    showBanner('Supabase credentials missing. Click "API Config" in sidebar to connect.', 'warning');
  }
}

function setupRealtimeSubscription() {
  if (!state.supabase) return;

  try {
    const channel = state.supabase
      .channel('fire-detection-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'detection_readings' },
        (payload) => {
          handleIncomingReading(payload.new);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          state.isRealtimeConnected = true;
          updateSyncStatus('Realtime Active', 'emerald');
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          state.isRealtimeConnected = false;
          updateSyncStatus('Polling Fallback', 'amber');
        }
      });
  } catch (err) {
    console.warn('[Realtime Subscription Warning]', err);
  }
}

// ----------------------------------------------------------------------------
// DATA FETCHING & SYNCHRONIZATION
// ----------------------------------------------------------------------------
function startSyncLoops() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    fetchLatestTelemetry();
    if (state.activeSection === 'history') {
      fetchHistoryData(false);
    }
  }, CONFIG.POLL_INTERVAL_MS);

  if (state.staleCheckTimer) clearInterval(state.staleCheckTimer);
  state.staleCheckTimer = setInterval(() => {
    evaluateSensorFreshness();
  }, 1000);
}

async function fetchLatestTelemetry() {
  if (!state.supabase) return;

  try {
    const { data, error, count } = await state.supabase
      .from('detection_readings')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;

    if (count !== null && count !== undefined) {
      state.totalReadingsCount = count;
      const countEl = document.getElementById('kpi-readings-count');
      if (countEl) countEl.textContent = count.toLocaleString();
    }

    if (data && data.length > 0) {
      handleIncomingReading(data[0]);
    }
  } catch (err) {
    console.error('[Fetch Latest Telemetry Error]', err);
  }
}

async function fetchHistoryData(showLoadingIndicator = true) {
  if (!state.supabase) return;

  const tbody = document.getElementById('history-table-body');
  if (showLoadingIndicator && tbody && state.historyData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-8 text-center text-slate-500 font-sans">
          <div class="flex items-center justify-center gap-2">
            <div class="w-4 h-4 border-2 border-rose-500 border-t-transparent rounded-full animate-spin"></div>
            <span>Loading database records...</span>
          </div>
        </td>
      </tr>
    `;
  }

  try {
    let query = state.supabase
      .from('detection_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(state.historyLimit);

    if (state.historyFilter === 'DETECTED') {
      query = query.eq('detected', true);
    } else if (state.historyFilter === 'CLEAR') {
      query = query.eq('detected', false);
    }

    const { data, error } = await query;
    if (error) throw error;

    state.historyData = data || [];
    renderHistoryTable();
  } catch (err) {
    console.error('[History Fetch Error]', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="py-6 text-center text-rose-400 font-sans">
            Unable to retrieve historical fire records: ${err.message}
          </td>
        </tr>
      `;
    }
  }
}

// ----------------------------------------------------------------------------
// TELEMETRY PROCESSING & UI UPDATES
// ----------------------------------------------------------------------------
function handleIncomingReading(reading) {
  if (!reading) return;

  const isNewer = !state.latestReading || reading.id !== state.latestReading.id;
  state.latestReading = reading;

  renderOverviewCard(reading);
  renderRadarVisualizer(reading);
  renderFireMonitor(reading);

  // Trigger audio siren on transition to FIRE ALERT
  if (isNewer && reading.detected && state.lastStateAlerted !== 'FIRE') {
    triggerFireAlarmSiren();
    showBanner('🚨 EMERGENCY ALERT: Flame / Fire Detected by Sensor Node!', 'error');
  } else if (isNewer && !reading.detected && state.lastStateAlerted === 'FIRE') {
    showBanner('🛡️ Area Safe: Fire extinguished or clear.', 'success');
  }

  if (isNewer) {
    state.lastStateAlerted = reading.detected ? 'FIRE' : 'SAFE';
  }

  evaluateSensorFreshness();

  if (isNewer && state.activeSection === 'history') {
    state.historyData.unshift(reading);
    if (state.historyData.length > state.historyLimit) {
      state.historyData.pop();
    }
    renderHistoryTable();
  }
}

function evaluateSensorFreshness() {
  const badge = document.getElementById('hardware-status-badge');
  const connKpi = document.getElementById('kpi-conn-value');
  const connSub = document.getElementById('kpi-conn-sub');
  const connIconWrap = document.getElementById('kpi-conn-icon-wrap');

  if (!state.latestReading || !state.latestReading.created_at) {
    if (badge) {
      badge.className = 'flex items-center gap-1.5 text-slate-400 font-medium';
      badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-500"></span> Awaiting HW`;
    }
    return;
  }

  const readingTime = new Date(state.latestReading.created_at).getTime();
  const ageMs = Date.now() - readingTime;
  const isFresh = ageMs < CONFIG.STALE_THRESHOLD_MS;
  const timeAgoText = formatTimeAgo(ageMs);

  if (isFresh) {
    if (badge) {
      badge.className = 'flex items-center gap-1.5 text-emerald-400 font-medium';
      badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> Live Node`;
    }
    if (connKpi) {
      connKpi.className = 'text-2xl font-bold text-emerald-400 tracking-tight flex items-center gap-2';
      connKpi.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span> Online`;
    }
    if (connSub) connSub.textContent = `Packet age: ${timeAgoText}`;
    if (connIconWrap) {
      connIconWrap.className = 'w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400';
    }
  } else {
    if (badge) {
      badge.className = 'flex items-center gap-1.5 text-rose-400 font-medium';
      badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-500"></span> Node Inactive`;
    }
    if (connKpi) {
      connKpi.className = 'text-2xl font-bold text-rose-400 tracking-tight flex items-center gap-2';
      connKpi.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-rose-500"></span> Offline / Stale`;
    }
    if (connSub) connSub.textContent = `Last seen: ${timeAgoText}`;
    if (connIconWrap) {
      connIconWrap.className = 'w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400';
    }
  }
}

// ----------------------------------------------------------------------------
// VIEW RENDERING: OVERVIEW & MONITOR
// ----------------------------------------------------------------------------
function renderOverviewCard(reading) {
  const statusVal = document.getElementById('kpi-status-value');
  const statusSub = document.getElementById('kpi-status-sub');
  const statusAccent = document.getElementById('kpi-status-accent');
  const distVal = document.getElementById('kpi-distance-value');
  const distBar = document.getElementById('kpi-distance-bar');
  const iconWrap = document.getElementById('kpi-status-icon-wrap');

  const isFire = reading.detected;
  const intensity = reading.distance_cm !== null ? parseFloat(reading.distance_cm) : 0.0;

  if (isFire) {
    if (statusVal) {
      statusVal.innerHTML = `<span class="text-rose-500 flex items-center gap-1.5"><i data-lucide="flame" class="w-6 h-6 animate-pulse"></i> FIRE ALERT</span>`;
    }
    if (statusSub) {
      statusSub.innerHTML = `<span class="text-rose-400 font-semibold">🚨 Emergency Alarm Active</span>`;
    }
    if (statusAccent) statusAccent.className = 'absolute bottom-0 left-0 right-0 h-1 bg-rose-500 animate-pulse';
    if (iconWrap) {
      iconWrap.className = 'w-8 h-8 rounded-lg bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400';
      iconWrap.innerHTML = `<i data-lucide="flame" class="w-4 h-4"></i>`;
    }
  } else {
    if (statusVal) {
      statusVal.innerHTML = `<span class="text-emerald-400 flex items-center gap-1.5"><i data-lucide="shield-check" class="w-6 h-6"></i> Normal</span>`;
    }
    if (statusSub) {
      statusSub.innerHTML = `<span class="text-slate-400">Environment Safe</span>`;
    }
    if (statusAccent) statusAccent.className = 'absolute bottom-0 left-0 right-0 h-1 bg-emerald-500';
    if (iconWrap) {
      iconWrap.className = 'w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400';
      iconWrap.innerHTML = `<i data-lucide="shield-check" class="w-4 h-4"></i>`;
    }
  }

  if (distVal) {
    distVal.textContent = intensity.toFixed(1);
    distVal.className = isFire ? 'font-mono text-rose-400 font-extrabold' : 'font-mono text-slate-100 font-bold';
  }

  if (distBar) {
    distBar.style.width = `${Math.min(intensity, 100)}%`;
  }

  initIcons();
}

function renderRadarVisualizer(reading) {
  const blip = document.getElementById('radar-blip');
  const blipTag = document.getElementById('radar-blip-tag');
  const statusLabel = document.getElementById('radar-status-label');
  const distLabel = document.getElementById('radar-distance-label');

  const isFire = reading.detected;
  const intensity = reading.distance_cm !== null ? parseFloat(reading.distance_cm) : 0.0;

  if (statusLabel) {
    statusLabel.textContent = isFire ? 'FIRE ALERT!' : 'Normal';
    statusLabel.className = isFire ? 'text-rose-400 font-bold animate-pulse' : 'text-emerald-400 font-medium';
  }

  if (distLabel) {
    distLabel.textContent = `${intensity.toFixed(1)} %`;
    distLabel.className = isFire ? 'text-rose-400 font-mono font-bold' : 'text-slate-300 font-mono';
  }

  if (blip) {
    if (intensity > 5 || isFire) {
      blip.style.opacity = '1';
      // Map intensity to radial position
      const radiusPercent = 20 + (intensity / 100.0) * 28;
      blip.style.top = `${50 - radiusPercent * 0.7}%`;
      blip.style.left = `${50 + radiusPercent * 0.7}%`;
      if (blipTag) blipTag.textContent = `${intensity.toFixed(1)}%`;
    } else {
      blip.style.opacity = '0';
    }
  }
}

function renderFireMonitor(reading) {
  const ring = document.getElementById('monitor-hero-ring');
  const heroStatus = document.getElementById('monitor-hero-status');
  const heroDistance = document.getElementById('monitor-hero-distance');
  const heroIcon = document.getElementById('monitor-state-icon');
  const barDistVal = document.getElementById('bar-dist-val');
  const progressFill = document.getElementById('distance-progress-fill');

  const badgeDetected = document.getElementById('badge-detected');
  const badgeClear = document.getElementById('badge-clear');
  const badgeNoReading = document.getElementById('badge-noreading');

  const isFire = reading.detected;
  const intensity = reading.distance_cm !== null ? parseFloat(reading.distance_cm) : 0.0;

  if (barDistVal) barDistVal.textContent = intensity.toFixed(1);
  if (progressFill) progressFill.style.width = `${Math.min(intensity, 100)}%`;

  if (badgeDetected) badgeDetected.className = 'px-3 py-1 rounded-full text-xs font-medium bg-slate-800/60 text-slate-500 border border-slate-700/50 flex items-center gap-1.5 transition-all';
  if (badgeClear) badgeClear.className = 'px-3 py-1 rounded-full text-xs font-medium bg-slate-800/60 text-slate-500 border border-slate-700/50 flex items-center gap-1.5 transition-all';
  if (badgeNoReading) badgeNoReading.className = 'px-3 py-1 rounded-full text-xs font-medium bg-slate-800/60 text-slate-500 border border-slate-700/50 flex items-center gap-1.5 transition-all';

  if (isFire) {
    if (ring) {
      ring.className = 'relative w-52 h-52 sm:w-64 sm:h-64 rounded-full border-4 flex flex-col items-center justify-center text-center transition-all duration-500 shadow-2xl state-detected';
    }
    if (heroStatus) {
      heroStatus.textContent = 'FIRE DETECTED!';
      heroStatus.className = 'text-xl sm:text-2xl font-extrabold tracking-tight text-rose-500 uppercase px-4 animate-pulse';
    }
    if (heroIcon) {
      heroIcon.className = 'text-rose-500 mb-2 animate-bounce';
      heroIcon.innerHTML = `<i data-lucide="flame" class="w-14 h-14"></i>`;
    }
    if (badgeDetected) {
      badgeDetected.className = 'px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition-all badge-active-detected';
    }
  } else {
    if (ring) {
      ring.className = 'relative w-52 h-52 sm:w-64 sm:h-64 rounded-full border-4 flex flex-col items-center justify-center text-center transition-all duration-500 shadow-2xl state-clear';
    }
    if (heroStatus) {
      heroStatus.textContent = 'Normal / Safe';
      heroStatus.className = 'text-xl sm:text-2xl font-extrabold tracking-tight text-emerald-400 uppercase px-4';
    }
    if (heroIcon) {
      heroIcon.className = 'text-emerald-400 mb-2';
      heroIcon.innerHTML = `<i data-lucide="shield-check" class="w-14 h-14"></i>`;
    }
    if (badgeClear) {
      badgeClear.className = 'px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition-all badge-active-clear';
    }
  }

  if (heroDistance) heroDistance.textContent = intensity.toFixed(1);

  initIcons();
}

// ----------------------------------------------------------------------------
// HISTORY TABLE RENDERING
// ----------------------------------------------------------------------------
function renderHistoryTable() {
  const tbody = document.getElementById('history-table-body');
  const countInfo = document.getElementById('history-pagination-info');
  if (!tbody) return;

  if (state.historyData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-8 text-center text-slate-500 font-sans">
          No fire incident records logged yet.
        </td>
      </tr>
    `;
    if (countInfo) countInfo.textContent = 'Showing 0 records';
    return;
  }

  if (countInfo) {
    countInfo.textContent = `Showing ${state.historyData.length} records`;
  }

  tbody.innerHTML = state.historyData
    .map((item) => {
      const isFire = item.detected;
      const intensity = item.distance_cm !== null ? parseFloat(item.distance_cm).toFixed(1) : '0.0';
      const timeStr = formatLocalTimestamp(item.created_at);
      const ageStr = formatTimeAgo(Date.now() - new Date(item.created_at).getTime());

      const statusBadge = isFire
        ? `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/40">🔥 Fire Alert</span>`
        : `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">🛡️ Safe</span>`;

      return `
        <tr class="border-b border-slate-800/60 hover:bg-slate-900/40 transition-colors">
          <td class="py-3 px-4 font-mono text-slate-400">#${item.id}</td>
          <td class="py-3 px-4 font-mono text-slate-200">${timeStr}</td>
          <td class="py-3 px-4 font-mono font-semibold ${isFire ? 'text-rose-400' : 'text-slate-300'}">${intensity}%</td>
          <td class="py-3 px-4 font-sans">${statusBadge}</td>
          <td class="py-3 px-4 font-sans text-slate-300">${item.sensor_status || (isFire ? 'Fire Alert' : 'Safe')}</td>
          <td class="py-3 px-4 text-right font-mono text-slate-500">${ageStr}</td>
        </tr>
      `;
    })
    .join('');
}

// ----------------------------------------------------------------------------
// AUDIO EMERGENCY SIREN (Zero external assets, Web Audio API)
// ----------------------------------------------------------------------------
function setupAudioAlert() {
  const toggle = document.getElementById('audio-toggle-switch');
  const btn = document.getElementById('audio-alert-btn');
  const text = document.getElementById('audio-alert-text');
  const testBtn = document.getElementById('test-audio-btn');

  function updateAudioUI(enabled) {
    state.audioAlertEnabled = enabled;
    localStorage.setItem('audio_alert_enabled', enabled ? 'true' : 'false');
    if (toggle) toggle.checked = enabled;
    if (text) text.textContent = enabled ? 'Siren: ON' : 'Siren: OFF';
    if (btn) {
      if (enabled) {
        btn.classList.add('border-rose-500/50', 'text-rose-400', 'bg-rose-950/30');
      } else {
        btn.classList.remove('border-rose-500/50', 'text-rose-400', 'bg-rose-950/30');
      }
    }
  }

  updateAudioUI(state.audioAlertEnabled);

  if (toggle) toggle.addEventListener('change', (e) => updateAudioUI(e.target.checked));
  if (btn) btn.addEventListener('click', () => updateAudioUI(!state.audioAlertEnabled));
  if (testBtn) testBtn.addEventListener('click', () => triggerFireAlarmSiren(true));
}

function triggerFireAlarmSiren(force = false) {
  if (!state.audioAlertEnabled && !force) return;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sawtooth';
    // Frequency modulation: urgent alternating high-low fire siren
    osc.frequency.setValueAtTime(2400, now);
    osc.frequency.linearRampToValueAtTime(1600, now + 0.15);
    osc.frequency.linearRampToValueAtTime(2400, now + 0.30);
    osc.frequency.linearRampToValueAtTime(1600, now + 0.45);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.50);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.50);
  } catch (err) {
    console.warn('[Audio Siren Error]', err);
  }
}

// ----------------------------------------------------------------------------
// NAVIGATION & CONTROLS
// ----------------------------------------------------------------------------
function setupNavigation() {
  const navBtns = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.dashboard-section');
  const title = document.getElementById('current-section-title');
  const sidebar = document.getElementById('sidebar');
  const menuBtn = document.getElementById('mobile-menu-btn');
  const backdrop = document.getElementById('backdrop');

  const titles = {
    overview: 'System Overview',
    monitor: 'Fire Alarm Monitor',
    history: 'Incident History',
    system: 'System Information',
  };

  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.section;
      state.activeSection = target;

      navBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      sections.forEach((sec) => {
        if (sec.id === `section-${target}`) {
          sec.classList.remove('hidden');
        } else {
          sec.classList.add('hidden');
        }
      });

      if (title && titles[target]) title.textContent = titles[target];

      // Close mobile menu
      if (sidebar) sidebar.classList.remove('open');
      if (backdrop) backdrop.classList.add('hidden');

      if (target === 'history') fetchHistoryData();
    });
  });

  if (menuBtn && sidebar && backdrop) {
    menuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      backdrop.classList.toggle('hidden');
    });
    backdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      backdrop.classList.add('hidden');
    });
  }
}

function setupControls() {
  // Sensitivity slider
  const slider = document.getElementById('threshold-slider');
  const input = document.getElementById('threshold-input');
  const radarLabel = document.getElementById('radar-threshold-label');
  const barLabel = document.getElementById('bar-thresh-val');
  const threshMarker = document.getElementById('distance-threshold-marker');
  const threshPosLabel = document.getElementById('thresh-pos-label');
  const presetBtns = document.querySelectorAll('.preset-btn');

  function updateThreshold(val) {
    const num = Math.min(Math.max(parseFloat(val) || 40, 10), 90);
    state.flameThreshold = num;
    localStorage.setItem('flame_threshold', num);

    if (slider) slider.value = num;
    if (input) input.value = num;
    if (radarLabel) radarLabel.textContent = `${num.toFixed(1)} %`;
    if (barLabel) barLabel.textContent = num.toFixed(1);
    if (threshMarker) threshMarker.style.left = `${num}%`;
    if (threshPosLabel) threshPosLabel.textContent = `Alert Limit (${num}%)`;
  }

  if (slider) slider.addEventListener('input', (e) => updateThreshold(e.target.value));
  if (input) input.addEventListener('change', (e) => updateThreshold(e.target.value));

  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => updateThreshold(btn.dataset.val));
  });

  updateThreshold(state.flameThreshold);

  // Refresh button
  const refreshBtn = document.getElementById('manual-refresh-btn');
  const refreshIcon = document.getElementById('refresh-icon');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (refreshIcon) refreshIcon.classList.add('animate-spin');
      fetchLatestTelemetry().finally(() => {
        setTimeout(() => {
          if (refreshIcon) refreshIcon.classList.remove('animate-spin');
        }, 500);
      });
      if (state.activeSection === 'history') fetchHistoryData();
    });
  }

  // History controls
  const limitSelect = document.getElementById('history-limit-select');
  const filterSelect = document.getElementById('history-filter-select');
  const exportBtn = document.getElementById('export-csv-btn');

  if (limitSelect) {
    limitSelect.addEventListener('change', (e) => {
      state.historyLimit = parseInt(e.target.value, 10);
      fetchHistoryData();
    });
  }

  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      state.historyFilter = e.target.value;
      fetchHistoryData();
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', exportHistoryToCSV);
  }

  setupConfigModal();
}

function setupConfigModal() {
  const modal = document.getElementById('config-modal');
  const openBtn = document.getElementById('open-config-btn');
  const closeBtn = document.getElementById('close-config-btn');
  const form = document.getElementById('config-form');
  const resetBtn = document.getElementById('reset-config-btn');
  const cfgUrl = document.getElementById('cfg-url');
  const cfgKey = document.getElementById('cfg-key');

  if (!modal) return;

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      cfgUrl.value = localStorage.getItem('supabase_url') || import.meta.env.VITE_SUPABASE_URL || '';
      cfgKey.value = localStorage.getItem('supabase_key') || import.meta.env.VITE_SUPABASE_ANON_KEY || '';
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    });
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = cfgUrl.value.trim();
      const key = cfgKey.value.trim();
      if (url && key) {
        localStorage.setItem('supabase_url', url);
        localStorage.setItem('supabase_key', key);
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        initSupabaseClient();
      }
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      localStorage.removeItem('supabase_url');
      localStorage.removeItem('supabase_key');
      cfgUrl.value = import.meta.env.VITE_SUPABASE_URL || '';
      cfgKey.value = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
      initSupabaseClient();
    });
  }
}

// ----------------------------------------------------------------------------
// CSV EXPORT
// ----------------------------------------------------------------------------
function exportHistoryToCSV() {
  if (state.historyData.length === 0) {
    alert('No telemetry logs available to export.');
    return;
  }

  const headers = ['ID', 'Timestamp_UTC', 'Flame_Intensity_Percent', 'Fire_Detected', 'Status'];
  const rows = state.historyData.map((r) => [
    r.id,
    r.created_at,
    r.distance_cm !== null ? r.distance_cm : 0,
    r.detected ? 'TRUE' : 'FALSE',
    `"${r.sensor_status || (r.detected ? 'Fire Alert' : 'Safe')}"`,
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `fire_telemetry_logs_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
function updateSyncStatus(text, color) {
  const syncLabel = document.getElementById('last-sync-time');
  const dbBadge = document.getElementById('db-status-badge');
  const nowStr = new Date().toLocaleTimeString();

  if (syncLabel) syncLabel.textContent = `${nowStr} (${text})`;
  if (dbBadge) {
    dbBadge.textContent = text;
    dbBadge.className = `text-${color}-400 font-medium`;
  }
}

function showBanner(message, type = 'info') {
  const banner = document.getElementById('status-banner');
  const content = document.getElementById('status-banner-content');
  if (!banner || !content) return;

  const bgClasses = {
    error: 'bg-rose-950/80 border-rose-800 text-rose-200',
    warning: 'bg-amber-950/80 border-amber-800 text-amber-200',
    success: 'bg-emerald-950/80 border-emerald-800 text-emerald-200',
    info: 'bg-slate-900 border-slate-800 text-slate-200',
  };

  banner.className = `px-6 py-3 text-xs font-semibold border-b flex items-center justify-between ${bgClasses[type] || bgClasses.info}`;
  content.innerHTML = `<span>${message}</span>`;
  banner.classList.remove('hidden');

  const closeBtn = document.getElementById('close-banner-btn');
  if (closeBtn) {
    closeBtn.onclick = () => banner.classList.add('hidden');
  }
}

function formatLocalTimestamp(isoString) {
  if (!isoString) return '--:--:--';
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTimeAgo(ms) {
  if (isNaN(ms) || ms < 0) return 'Just now';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'Just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
