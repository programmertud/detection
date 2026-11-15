/**
 * ============================================================================
 * PEOPLE DETECTION AND MONITORING SYSTEM - DASHBOARD CONTROLLER
 * ============================================================================
 * Framework: Vanilla JavaScript (ES Modules) + Vite
 * Database:  Supabase Client (PostgreSQL + Realtime WebSocket)
 * Icons:     Lucide Icons
 * ============================================================================
 */

import { createClient } from '@supabase/supabase-js';
import { createIcons, icons } from 'lucide';

// ----------------------------------------------------------------------------
// APPLICATION CONFIGURATION & STATE
// ----------------------------------------------------------------------------
const CONFIG = {
  POLL_INTERVAL_MS: 2000,       // Polling frequency matching ESP32 upload rate
  STALE_THRESHOLD_MS: 6500,     // Packet age after which hardware is considered offline
  DEFAULT_THRESHOLD_CM: 50.0,   // Academic default distance threshold
  RADAR_MAX_RANGE_CM: 300.0,    // Visual radar max boundary in cm
};

// Global reactive state
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
  detectionThreshold: parseFloat(localStorage.getItem('detection_threshold') || CONFIG.DEFAULT_THRESHOLD_CM),
  audioAlertEnabled: localStorage.getItem('audio_alert_enabled') === 'true',
  lastStateAlerted: null,
  pollTimer: null,
  staleCheckTimer: null,
  activeSection: 'overview',
};

// Web Audio API context for zero-asset laboratory chime
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
  // Support both Vite build-time environment variables and browser runtime overrides
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
      showBanner('Connected to Supabase. Monitoring hardware telemetry...', 'success');
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
    showBanner('Supabase credentials missing or using placeholders. Click "API Config" in the sidebar to configure.', 'warning');
    renderEmptyState();
  }
}

// ----------------------------------------------------------------------------
// REALTIME SUBSCRIPTION
// ----------------------------------------------------------------------------
function setupRealtimeSubscription() {
  if (!state.supabase) return;

  try {
    const channel = state.supabase
      .channel('public:detection_readings')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'detection_readings' },
        (payload) => {
          // Immediately process real-time packet delivered via WebSocket
          handleIncomingReading(payload.new);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          state.isRealtimeConnected = true;
          const badge = document.getElementById('db-status-badge');
          if (badge) badge.textContent = 'Realtime + Poll (2s)';
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          state.isRealtimeConnected = false;
          const badge = document.getElementById('db-status-badge');
          if (badge) badge.textContent = 'Polling Active (2s)';
        }
      });
  } catch (err) {
    console.warn('[Realtime Setup Warning]', err);
  }
}

// ----------------------------------------------------------------------------
// DATA FETCHING & SYNCHRONIZATION
// ----------------------------------------------------------------------------
function startSyncLoops() {
  // 1. Regular 2-second telemetry polling loop (guarantees update if WebSocket is interrupted)
  state.pollTimer = setInterval(() => {
    if (state.isConfigured && state.supabase) {
      fetchLatestTelemetry();
      if (state.activeSection === 'history') {
        fetchHistoryData(false);
      }
    }
  }, CONFIG.POLL_INTERVAL_MS);

  // 2. High-frequency freshness/stale watchdog check (runs every 1 second)
  state.staleCheckTimer = setInterval(() => {
    evaluateSensorFreshness();
  }, 1000);
}

async function fetchLatestTelemetry() {
  if (!state.supabase) return;

  try {
    // Fetch latest record from detection_readings
    const { data, error } = await state.supabase
      .from('detection_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;

    if (data && data.length > 0) {
      handleIncomingReading(data[0]);
    } else {
      renderEmptyState();
    }

    // Fetch total logged count
    const { count, error: countErr } = await state.supabase
      .from('detection_readings')
      .select('*', { count: 'exact', head: true });

    if (!countErr && count !== null) {
      state.totalReadingsCount = count;
      const countEl = document.getElementById('kpi-readings-count');
      if (countEl) countEl.textContent = count.toLocaleString();
    }

    const lastSyncEl = document.getElementById('last-sync-time');
    if (lastSyncEl) {
      lastSyncEl.textContent = new Date().toLocaleTimeString();
    }
  } catch (err) {
    console.error('[Telemetry Fetch Error]', err);
    updateSyncStatus('Sync Error', 'red');
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
            <div class="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
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

    // Apply state filter if chosen
    if (state.historyFilter === 'DETECTED') {
      query = query.eq('detected', true);
    } else if (state.historyFilter === 'CLEAR') {
      query = query.eq('sensor_status', 'Clear');
    } else if (state.historyFilter === 'NO_READING') {
      query = query.eq('sensor_status', 'No Reading');
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
            Unable to retrieve historical logs: ${err.message}
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

  // Render all dashboard components with actual hardware reading
  renderOverviewCard(reading);
  renderRadarVisualizer(reading);
  renderDetectionMonitor(reading);

  // Trigger audio alert on positive edge transition (Clear -> Detected)
  if (isNewer && reading.detected && state.lastStateAlerted !== 'Detected') {
    triggerAlertChime();
  }
  if (isNewer) {
    state.lastStateAlerted = reading.detected ? 'Detected' : reading.sensor_status;
  }

  // Refresh hardware online indicator
  evaluateSensorFreshness();

  // If new record and currently on history tab, insert into table
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
    // Sensor has stopped reporting or Wi-Fi dropped
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

  const status = reading.sensor_status;
  const isDetected = reading.detected;
  const dist = reading.distance_cm !== null ? parseFloat(reading.distance_cm) : null;

  if (isDetected) {
    statusVal.textContent = 'Person Detected';
    statusVal.className = 'text-2xl font-bold text-emerald-400 tracking-tight flex items-center gap-2';
    statusSub.textContent = `Within ${state.detectionThreshold.toFixed(1)} cm threshold`;
    statusAccent.className = 'absolute bottom-0 left-0 right-0 h-1 bg-emerald-500';
    if (iconWrap) {
      iconWrap.className = 'w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400';
    }
  } else if (status === 'Clear') {
    statusVal.textContent = 'Area Clear';
    statusVal.className = 'text-2xl font-bold text-blue-400 tracking-tight flex items-center gap-2';
    statusSub.textContent = `Beyond ${state.detectionThreshold.toFixed(1)} cm boundary`;
    statusAccent.className = 'absolute bottom-0 left-0 right-0 h-1 bg-blue-500';
    if (iconWrap) {
      iconWrap.className = 'w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400';
    }
  } else {
    statusVal.textContent = 'No Reading';
    statusVal.className = 'text-2xl font-bold text-amber-400 tracking-tight flex items-center gap-2';
    statusSub.textContent = 'Acoustic timeout / Out of range';
    statusAccent.className = 'absolute bottom-0 left-0 right-0 h-1 bg-amber-500';
    if (iconWrap) {
      iconWrap.className = 'w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400';
    }
  }

  // Distance display
  if (dist !== null && !isNaN(dist) && dist >= 0) {
    distVal.textContent = dist.toFixed(1);
    const pct = Math.min(Math.max((dist / 400) * 100, 0), 100);
    distBar.style.width = `${pct}%`;
    distBar.className = isDetected ? 'bg-emerald-500 h-full transition-all duration-300' : 'bg-blue-500 h-full transition-all duration-300';
  } else {
    distVal.textContent = '--.-';
    distBar.style.width = '0%';
  }
}

function renderRadarVisualizer(reading) {
  const blip = document.getElementById('radar-blip');
  const blipTag = document.getElementById('radar-blip-tag');
  const blipDot = document.getElementById('radar-blip-dot');
  const blipPing = document.getElementById('radar-blip-ping');
  const statusLabel = document.getElementById('radar-status-label');
  const distLabel = document.getElementById('radar-distance-label');
  const threshLabel = document.getElementById('radar-threshold-label');
  const threshRing = document.getElementById('radar-threshold-ring');

  if (threshLabel) threshLabel.textContent = `${state.detectionThreshold.toFixed(1)} cm`;

  // Scale threshold circle dynamically
  if (threshRing) {
    const scale = Math.min(Math.max(state.detectionThreshold / CONFIG.RADAR_MAX_RANGE_CM, 0.1), 1.0);
    const sizePx = 280 * scale;
    threshRing.style.width = `${sizePx}px`;
    threshRing.style.height = `${sizePx}px`;
  }

  const dist = reading.distance_cm !== null ? parseFloat(reading.distance_cm) : null;
  const isDetected = reading.detected;

  if (statusLabel) statusLabel.textContent = reading.sensor_status;
  if (distLabel) distLabel.textContent = dist !== null ? `${dist.toFixed(1)} cm` : 'N/A';

  if (blip && dist !== null && dist > 0 && dist <= CONFIG.RADAR_MAX_RANGE_CM) {
    // Calculate radial distance (from center 50%, 50%)
    const fraction = dist / CONFIG.RADAR_MAX_RANGE_CM;
    const offsetPx = 130 * fraction; // Max radius ~130px

    // Render blip along an upper angle (45 degrees) for intuitive acoustic sonar viewing
    const angleRad = -Math.PI / 4;
    const x = Math.cos(angleRad) * offsetPx;
    const y = Math.sin(angleRad) * offsetPx;

    blip.style.left = `calc(50% + ${x}px)`;
    blip.style.top = `calc(50% + ${y}px)`;
    blip.style.opacity = '1';

    if (blipTag) blipTag.textContent = `${dist.toFixed(1)} cm`;

    if (isDetected) {
      if (blipDot) blipDot.className = 'w-3.5 h-3.5 rounded-full bg-emerald-500 border border-white shadow-lg';
      if (blipPing) blipPing.className = 'absolute w-6 h-6 rounded-full bg-emerald-500/50 animate-ping';
    } else {
      if (blipDot) blipDot.className = 'w-3.5 h-3.5 rounded-full bg-blue-500 border border-white shadow-lg';
      if (blipPing) blipPing.className = 'absolute w-6 h-6 rounded-full bg-blue-500/40 animate-ping';
    }
  } else if (blip) {
    blip.style.opacity = '0';
  }
}

function renderDetectionMonitor(reading) {
  const heroRing = document.getElementById('monitor-hero-ring');
  const heroStatus = document.getElementById('monitor-hero-status');
  const heroDist = document.getElementById('monitor-hero-distance');
  const heroIcon = document.getElementById('monitor-state-icon');

  const badgeDetected = document.getElementById('badge-detected');
  const badgeClear = document.getElementById('badge-clear');
  const badgeNoReading = document.getElementById('badge-noreading');

  const barDistVal = document.getElementById('bar-dist-val');
  const distFill = document.getElementById('distance-progress-fill');

  const dist = reading.distance_cm !== null ? parseFloat(reading.distance_cm) : null;
  const isDetected = reading.detected;
  const status = reading.sensor_status;

  // Reset active classes
  badgeDetected.className = 'px-3 py-1 rounded-full text-xs font-medium bg-slate-800/60 text-slate-500 border border-slate-700/50 flex items-center gap-1.5 transition-all';
  badgeClear.className = 'px-3 py-1 rounded-full text-xs font-medium bg-slate-800/60 text-slate-500 border border-slate-700/50 flex items-center gap-1.5 transition-all';
  badgeNoReading.className = 'px-3 py-1 rounded-full text-xs font-medium bg-slate-800/60 text-slate-500 border border-slate-700/50 flex items-center gap-1.5 transition-all';

  if (isDetected) {
    heroRing.className = 'relative w-52 h-52 sm:w-64 sm:h-64 rounded-full border-4 flex flex-col items-center justify-center text-center transition-all duration-500 shadow-2xl state-detected';
    heroStatus.textContent = 'Person Detected';
    heroStatus.className = 'text-xl sm:text-2xl font-extrabold tracking-tight text-emerald-400 uppercase px-4';
    heroIcon.innerHTML = `<i data-lucide="user-check" class="w-12 h-12 text-emerald-400"></i>`;
    badgeDetected.className = 'px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-1.5 transition-all badge-active-detected';
  } else if (status === 'Clear') {
    heroRing.className = 'relative w-52 h-52 sm:w-64 sm:h-64 rounded-full border-4 flex flex-col items-center justify-center text-center transition-all duration-500 shadow-2xl state-clear';
    heroStatus.textContent = 'Area Clear';
    heroStatus.className = 'text-xl sm:text-2xl font-extrabold tracking-tight text-blue-400 uppercase px-4';
    heroIcon.innerHTML = `<i data-lucide="shield-check" class="w-12 h-12 text-blue-400"></i>`;
    badgeClear.className = 'px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-1.5 transition-all badge-active-clear';
  } else {
    heroRing.className = 'relative w-52 h-52 sm:w-64 sm:h-64 rounded-full border-4 flex flex-col items-center justify-center text-center transition-all duration-500 shadow-2xl state-noreading';
    heroStatus.textContent = 'No Reading';
    heroStatus.className = 'text-xl sm:text-2xl font-extrabold tracking-tight text-amber-400 uppercase px-4';
    heroIcon.innerHTML = `<i data-lucide="alert-triangle" class="w-12 h-12 text-amber-400"></i>`;
    badgeNoReading.className = 'px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-1.5 transition-all badge-active-noreading';
  }

  // Distance value update
  if (dist !== null && !isNaN(dist) && dist >= 0) {
    heroDist.textContent = dist.toFixed(1);
    barDistVal.textContent = dist.toFixed(1);

    const barPct = Math.min(Math.max((dist / 400) * 100, 0), 100);
    distFill.style.width = `${barPct}%`;
    distFill.className = isDetected ? 'h-full bg-emerald-500 transition-all duration-300' : 'h-full bg-blue-500 transition-all duration-300';
  } else {
    heroDist.textContent = '--.-';
    barDistVal.textContent = 'N/A';
    distFill.style.width = '0%';
  }

  // Re-render Lucide icons dynamically injected
  initIcons();
}

// ----------------------------------------------------------------------------
// VIEW RENDERING: HISTORY TABLE
// ----------------------------------------------------------------------------
function renderHistoryTable() {
  const tbody = document.getElementById('history-table-body');
  const countLabel = document.getElementById('history-pagination-info');
  if (!tbody) return;

  if (state.historyData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-10 text-center text-slate-500 font-sans">
          <div class="flex flex-col items-center justify-center gap-2">
            <i data-lucide="inbox" class="w-8 h-8 text-slate-600"></i>
            <span class="font-medium text-slate-400">No historical records found for this filter.</span>
            <span class="text-xs text-slate-500">Ensure the ESP32 is powered and actively uploading data.</span>
          </div>
        </td>
      </tr>
    `;
    if (countLabel) countLabel.textContent = 'Showing 0 records';
    initIcons();
    return;
  }

  let rowsHtml = '';
  state.historyData.forEach((row) => {
    const isDetected = row.detected;
    const status = row.sensor_status;
    const dist = row.distance_cm !== null ? `${parseFloat(row.distance_cm).toFixed(1)} cm` : 'Invalid';
    
    const timestamp = new Date(row.created_at);
    const dateFormatted = timestamp.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timeFormatted = timestamp.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const ageFormatted = formatTimeAgo(Date.now() - timestamp.getTime());

    let pillHtml = '';
    if (isDetected) {
      pillHtml = `<span class="status-pill status-pill-detected"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Detected</span>`;
    } else if (status === 'Clear') {
      pillHtml = `<span class="status-pill status-pill-clear"><span class="w-1.5 h-1.5 rounded-full bg-blue-400"></span> Clear</span>`;
    } else {
      pillHtml = `<span class="status-pill status-pill-noreading"><span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> No Reading</span>`;
    }

    rowsHtml += `
      <tr class="hover:bg-slate-800/40 transition-colors">
        <td class="py-3 px-4 text-slate-400">#${row.id}</td>
        <td class="py-3 px-4 text-slate-200">
          <span class="font-sans font-medium">${timeFormatted}</span>
          <span class="text-[11px] text-slate-500 block font-sans">${dateFormatted}</span>
        </td>
        <td class="py-3 px-4 text-white font-semibold">${dist}</td>
        <td class="py-3 px-4">${pillHtml}</td>
        <td class="py-3 px-4 text-slate-300 font-sans">${status}</td>
        <td class="py-3 px-4 text-right text-slate-400 font-sans text-[11px]">${ageFormatted}</td>
      </tr>
    `;
  });

  tbody.innerHTML = rowsHtml;
  if (countLabel) {
    countLabel.textContent = `Showing ${state.historyData.length} most recent records`;
  }
}

function renderEmptyState() {
  const statusVal = document.getElementById('kpi-status-value');
  const statusSub = document.getElementById('kpi-status-sub');
  const distVal = document.getElementById('kpi-distance-value');
  const heroStatus = document.getElementById('monitor-hero-status');
  const heroDist = document.getElementById('monitor-hero-distance');

  if (statusVal) statusVal.textContent = 'Awaiting Sensor';
  if (statusSub) statusSub.textContent = 'No telemetry packets in database';
  if (distVal) distVal.textContent = '--.-';
  if (heroStatus) heroStatus.textContent = 'Standby';
  if (heroDist) heroDist.textContent = '--.-';
}

// ----------------------------------------------------------------------------
// USER CONTROLS, NAVIGATION & SETTINGS
// ----------------------------------------------------------------------------
function setupNavigation() {
  const navButtons = document.querySelectorAll('.nav-item');
  const sections = {
    overview: document.getElementById('section-overview'),
    monitor: document.getElementById('section-monitor'),
    history: document.getElementById('section-history'),
    system: document.getElementById('section-system'),
  };

  const titles = {
    overview: 'System Overview',
    monitor: 'Detection Monitor',
    history: 'Detection History',
    system: 'System Information',
  };

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.section;
      state.activeSection = target;

      // Update button styles
      navButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      // Update active section visibility
      Object.keys(sections).forEach((key) => {
        if (sections[key]) {
          if (key === target) {
            sections[key].classList.remove('hidden');
          } else {
            sections[key].classList.add('hidden');
          }
        }
      });

      // Update header title
      const titleEl = document.getElementById('current-section-title');
      if (titleEl) titleEl.textContent = titles[target] || 'Dashboard';

      // Load specific tab data if switching
      if (target === 'history') {
        fetchHistoryData();
      }

      // Close mobile drawer if opened
      closeMobileMenu();
    });
  });

  // Mobile drawer toggle
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('backdrop');

  if (mobileMenuBtn && sidebar && backdrop) {
    mobileMenuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('-translate-x-full');
      backdrop.classList.toggle('hidden');
    });

    backdrop.addEventListener('click', closeMobileMenu);
  }

  function closeMobileMenu() {
    if (sidebar) sidebar.classList.add('-translate-x-full');
    if (backdrop) backdrop.classList.add('hidden');
  }
}

function setupControls() {
  // Manual refresh button
  const refreshBtn = document.getElementById('manual-refresh-btn');
  const refreshIcon = document.getElementById('refresh-icon');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      if (refreshIcon) refreshIcon.classList.add('animate-spin');
      await fetchLatestTelemetry();
      await fetchHistoryData(false);
      setTimeout(() => {
        if (refreshIcon) refreshIcon.classList.remove('animate-spin');
      }, 600);
    });
  }

  // Threshold slider & input synchronization
  const slider = document.getElementById('threshold-slider');
  const input = document.getElementById('threshold-input');
  const marker = document.getElementById('distance-threshold-marker');
  const barThreshVal = document.getElementById('bar-thresh-val');
  const threshPosLabel = document.getElementById('thresh-pos-label');

  function updateThreshold(val) {
    val = Math.max(5, Math.min(400, parseFloat(val) || CONFIG.DEFAULT_THRESHOLD_CM));
    state.detectionThreshold = val;
    localStorage.setItem('detection_threshold', val.toString());

    if (slider) slider.value = val;
    if (input) input.value = val;
    if (barThreshVal) barThreshVal.textContent = val.toFixed(1);
    if (threshPosLabel) threshPosLabel.textContent = `Threshold (${val.toFixed(0)} cm)`;

    // Reposition threshold target indicator in the comparison bar
    if (marker) {
      const pct = Math.min((val / 400) * 100, 100);
      marker.style.left = `${pct}%`;
    }

    // Refresh current radar visualization
    if (state.latestReading) {
      renderRadarVisualizer(state.latestReading);
      renderOverviewCard(state.latestReading);
    }
  }

  if (slider) {
    slider.value = state.detectionThreshold;
    slider.addEventListener('input', (e) => updateThreshold(e.target.value));
  }

  if (input) {
    input.value = state.detectionThreshold;
    input.addEventListener('change', (e) => updateThreshold(e.target.value));
  }

  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.val;
      if (val) updateThreshold(val);
    });
  });

  // Initialize threshold marker position
  updateThreshold(state.detectionThreshold);

  // History controls (limit, filter, export)
  const limitSelect = document.getElementById('history-limit-select');
  if (limitSelect) {
    limitSelect.addEventListener('change', (e) => {
      state.historyLimit = parseInt(e.target.value, 10);
      fetchHistoryData();
    });
  }

  const filterSelect = document.getElementById('history-filter-select');
  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      state.historyFilter = e.target.value;
      fetchHistoryData();
    });
  }

  const exportBtn = document.getElementById('export-csv-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportHistoryToCSV);
  }

  // Config modal controls
  setupConfigModal();
}

// ----------------------------------------------------------------------------
// CREDENTIALS MODAL
// ----------------------------------------------------------------------------
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
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
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
      modal.classList.add('hidden');
      initSupabaseClient();
    });
  }
}

// ----------------------------------------------------------------------------
// AUDIO ALERT (SYNTHESIZED CHIME)
// ----------------------------------------------------------------------------
function setupAudioAlert() {
  const audioBtn = document.getElementById('audio-alert-btn');
  const audioText = document.getElementById('audio-alert-text');
  const toggleSwitch = document.getElementById('audio-toggle-switch');
  const testBtn = document.getElementById('test-audio-btn');

  function setAudioState(enabled) {
    state.audioAlertEnabled = enabled;
    localStorage.setItem('audio_alert_enabled', enabled.toString());
    if (audioText) audioText.textContent = enabled ? 'Sound: ON' : 'Sound: OFF';
    if (audioBtn) {
      audioBtn.className = enabled
        ? 'px-3 py-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-400 text-xs font-medium flex items-center gap-1.5 transition-colors'
        : 'px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white text-xs font-medium flex items-center gap-1.5 transition-colors';
    }
    if (toggleSwitch) toggleSwitch.checked = enabled;
  }

  setAudioState(state.audioAlertEnabled);

  if (audioBtn) {
    audioBtn.addEventListener('click', () => setAudioState(!state.audioAlertEnabled));
  }

  if (toggleSwitch) {
    toggleSwitch.addEventListener('change', (e) => setAudioState(e.target.checked));
  }

  if (testBtn) {
    testBtn.addEventListener('click', () => {
      triggerAlertChime(true);
    });
  }
}

function triggerAlertChime(forcePlay = false) {
  if (!state.audioAlertEnabled && !forcePlay) return;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    // Dual chime tone: 880 Hz (A5) -> 1046.5 Hz (C6)
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, now);
    osc1.frequency.exponentialRampToValueAtTime(1046.5, now + 0.15);

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(440, now);

    gainNode.gain.setValueAtTime(0.001, now);
    gainNode.gain.linearRampToValueAtTime(0.2, now + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.45);
    osc2.stop(now + 0.45);
  } catch (err) {
    console.warn('[Audio Alert Error]', err);
  }
}

// ----------------------------------------------------------------------------
// CSV EXPORT UTILITY
// ----------------------------------------------------------------------------
function exportHistoryToCSV() {
  if (!state.historyData || state.historyData.length === 0) {
    alert('No detection records available to export.');
    return;
  }

  const headers = ['ID', 'Timestamp_UTC', 'Timestamp_Local', 'Distance_CM', 'Detected', 'Sensor_Status'];
  const rows = state.historyData.map((r) => [
    r.id,
    r.created_at,
    `"${new Date(r.created_at).toLocaleString()}"`,
    r.distance_cm !== null ? r.distance_cm : '',
    r.detected ? 'TRUE' : 'FALSE',
    `"${r.sensor_status}"`,
  ]);

  const csvContent = [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `people_detection_log_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ----------------------------------------------------------------------------
// HELPER UTILITIES
// ----------------------------------------------------------------------------
function formatTimeAgo(ms) {
  if (ms < 0) return 'Just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  return `${hours}h ago`;
}

function updateSyncStatus(text, color) {
  const badge = document.getElementById('db-status-badge');
  if (badge) {
    badge.textContent = text;
    badge.className = `font-medium text-${color}-400`;
  }
}

function showBanner(message, type = 'info') {
  const banner = document.getElementById('status-banner');
  const content = document.getElementById('status-banner-content');
  const closeBtn = document.getElementById('close-banner-btn');
  if (!banner || !content) return;

  const typeStyles = {
    info: 'bg-blue-950/80 border-blue-800 text-blue-200',
    success: 'bg-emerald-950/80 border-emerald-800 text-emerald-200',
    warning: 'bg-amber-950/80 border-amber-800 text-amber-200',
    error: 'bg-rose-950/80 border-rose-800 text-rose-200',
  };

  banner.className = `px-6 py-2.5 text-xs font-medium border-b flex items-center justify-between ${typeStyles[type] || typeStyles.info}`;
  content.innerHTML = `<span>${message}</span>`;
  banner.classList.remove('hidden');

  if (closeBtn) {
    closeBtn.onclick = () => banner.classList.add('hidden');
  }
}
