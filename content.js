(() => {
  if (window.__videoToSlidesV31Loaded) return;
  window.__videoToSlidesV31Loaded = true;

  const isTopFrame = (window === window.top);

  // =========================================================================
  // 1. HD VIDEO ENGINE & PERCEPTUAL SLIDE DETECTOR (v3.0)
  // =========================================================================
  let autoDetectTimer = null;
  let lastSavedThumb = null;
  let prevTickThumb = null;
  let sensitivityLevel = 2; // 1 = Low, 2 = Med, 3 = High
  let lastUrl = window.location.href;

  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = 96;
  diffCanvas.height = 54;
  const diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true });

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getPrimaryVideo() {
    const ytMain = document.querySelector('video.html5-main-video');
    if (ytMain && ytMain.videoWidth > 0 && ytMain.readyState >= 1) {
      return ytMain;
    }

    const videos = Array.from(document.querySelectorAll('video'))
      .filter(v => v.videoWidth > 0 && v.readyState >= 1);
    if (!videos.length) return null;

    return videos.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return (rectB.width * rectB.height) - (rectA.width * rectA.height);
    })[0];
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function parseTimestamp(str) {
    const parts = String(str || '').trim().split(':').map(Number);
    if (!parts.length || parts.some(n => isNaN(n) || n < 0)) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function getThumbnailData(video) {
    try {
      diffCtx.drawImage(video, 0, 0, 96, 54);
      return diffCtx.getImageData(0, 0, 96, 54).data;
    } catch (_) {
      return null;
    }
  }

  function computeFrameDiff(bufA, bufB) {
    if (!bufA || !bufB) return 100;
    let changedPixels = 0;
    let totalDiff = 0;
    const pixelCount = bufA.length / 4;

    for (let i = 0; i < bufA.length; i += 4) {
      const dr = Math.abs(bufA[i] - bufB[i]);
      const dg = Math.abs(bufA[i + 1] - bufB[i + 1]);
      const db = Math.abs(bufA[i + 2] - bufB[i + 2]);
      const pixelDelta = (dr + dg + db) / 3;
      totalDiff += pixelDelta;
      if (pixelDelta > 18) changedPixels++;
    }

    const meanDiffPct = (totalDiff / (pixelCount * 255)) * 100;
    const changedAreaPct = (changedPixels / pixelCount) * 100;
    return (meanDiffPct * 0.6) + (changedAreaPct * 0.4);
  }

  function getThresholds() {
    if (sensitivityLevel === 1) return { slideDiff: 11.0, motionMax: 2.2 };
    if (sensitivityLevel === 3) return { slideDiff: 2.8, motionMax: 1.8 };
    return { slideDiff: 5.5, motionMax: 2.0 };
  }

  function getLectureTitle() {
    if (!isTopFrame) return 'Lecture Video';
    const ytHeading = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    const raw = (ytHeading?.textContent || document.title || 'Lecture Video')
      .replace(/\s*-\s*YouTube$/i, '')
      .trim();
    return raw || 'Lecture Video';
  }

  async function captureHDFrame(video) {
    if (!video || !video.videoWidth) {
      throw new Error('No loaded video found. Start playing the video first.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    } catch (_) {
      throw new Error('Browser security blocked frame capture on this DRM/cross-origin stream.');
    }

    lastSavedThumb = getThumbnailData(video);

    const slide = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: video.currentTime,
      formattedTime: formatTime(video.currentTime),
      title: getLectureTitle(),
      width: canvas.width,
      height: canvas.height,
      image: dataUrl
    };

    const { slides = [] } = await chrome.storage.local.get('slides');
    slides.push(slide);
    await chrome.storage.local.set({ slides });
    return slide;
  }

  function captureAtTimestamp(targetSeconds) {
    return new Promise((resolve, reject) => {
      const video = getPrimaryVideo();
      if (!video) return reject(new Error('No video found on this page.'));

      const clamped = Math.max(0, Math.min(targetSeconds, video.duration || targetSeconds));

      const grab = () => {
        requestAnimationFrame(async () => {
          try {
            const slide = await captureHDFrame(video);
            resolve(slide);
          } catch (err) {
            reject(err);
          }
        });
      };

      if (Math.abs(video.currentTime - clamped) < 0.08) {
        grab();
      } else {
        video.addEventListener('seeked', grab, { once: true });
        video.currentTime = clamped;
      }
    });
  }

  async function startAutoDetect() {
    if (autoDetectTimer) return true;
    const video = getPrimaryVideo();
    if (!video) return false;

    await captureHDFrame(video);
    prevTickThumb = getThumbnailData(video);

    autoDetectTimer = setInterval(async () => {
      // Reset baseline when YouTube navigates to a new video in SPA mode
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        lastSavedThumb = null;
        prevTickThumb = null;
      }

      const activeVideo = getPrimaryVideo();
      if (!activeVideo || activeVideo.paused || activeVideo.ended) return;

      const currentThumb = getThumbnailData(activeVideo);
      if (!currentThumb) return;

      const diffFromSaved = computeFrameDiff(currentThumb, lastSavedThumb);
      const diffFromPrevTick = computeFrameDiff(currentThumb, prevTickThumb);
      const { slideDiff, motionMax } = getThresholds();

      if (diffFromSaved >= slideDiff && diffFromPrevTick <= motionMax) {
        await captureHDFrame(activeVideo);
      }
      prevTickThumb = currentThumb;
    }, 1000);

    return true;
  }

  function stopAutoDetect() {
    if (autoDetectTimer) {
      clearInterval(autoDetectTimer);
      autoDetectTimer = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'TOGGLE_OVERLAY' && isTopFrame) {
      toggleOverlayUI(msg.forceShow);
      sendResponse({ ok: true });
      return false;
    }

    const video = getPrimaryVideo();
    if (!video) return false;

    if (msg.action === 'V2S_SNAP_NOW') {
      captureHDFrame(video)
        .then(slide => sendResponse({ ok: true, slide }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (msg.action === 'V2S_SNAP_AT') {
      captureAtTimestamp(msg.seconds)
        .then(slide => sendResponse({ ok: true, slide }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (msg.action === 'V2S_SET_AUTO') {
      if (msg.enabled) {
        startAutoDetect().then(started => sendResponse({ ok: started, isRunning: Boolean(autoDetectTimer) }));
      } else {
        stopAutoDetect();
        sendResponse({ ok: true, isRunning: false });
      }
      return true;
    }

    if (msg.action === 'V2S_SET_SENSITIVITY') {
      sensitivityLevel = Number(msg.level) || 2;
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  // =========================================================================
  // 2. FLOATING SHADOW-DOM OVERLAY UI (v3.0 with Fullscreen Slide Lightbox)
  // =========================================================================
  if (!isTopFrame) return;

  let hostEl = null;
  let shadow = null;
  let selectedIds = new Set();
  let isAutoRunning = false;
  let isMinimized = false;

  async function dispatchVideoCommand(payload) {
    const localVideo = getPrimaryVideo();
    if (localVideo) {
      if (payload.action === 'V2S_SNAP_NOW') {
        const slide = await captureHDFrame(localVideo);
        return { ok: true, slide };
      }
      if (payload.action === 'V2S_SNAP_AT') {
        const slide = await captureAtTimestamp(payload.seconds);
        return { ok: true, slide };
      }
      if (payload.action === 'V2S_SET_AUTO') {
        if (payload.enabled) {
          const started = await startAutoDetect();
          return { ok: started, isRunning: Boolean(autoDetectTimer) };
        } else {
          stopAutoDetect();
          return { ok: true, isRunning: false };
        }
      }
      if (payload.action === 'V2S_SET_SENSITIVITY') {
        sensitivityLevel = Number(payload.level) || 2;
        return { ok: true };
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      chrome.runtime.sendMessage(payload, (res) => {
        if (!settled && res) {
          settled = true;
          resolve(res);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: 'No active video found on this page.' });
        }
      }, 1500);
    });
  }

  function createOverlayUI() {
    if (hostEl) return;

    hostEl = document.createElement('div');
    hostEl.id = 'v2s-floating-host';
    Object.assign(hostEl.style, {
      position: 'fixed',
      top: '76px',
      right: '24px',
      zIndex: '2147483647',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    });

    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; user-select: none; }
        .panel {
          width: 350px;
          background: radial-gradient(circle at top left, #1c1936 0%, #11111e 65%, #0d0d17 100%);
          border: 1px solid rgba(139, 92, 246, 0.28);
          border-radius: 18px;
          box-shadow: 0 22px 50px rgba(0, 0, 0, 0.68), 0 0 0 1px rgba(255,255,255,0.04) inset;
          color: #f8fafc;
          padding: 16px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: grab;
          margin-bottom: 14px;
        }
        .header:active { cursor: grabbing; }
        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
          font-weight: 700;
          font-size: 16px;
          letter-spacing: -0.2px;
        }
        .ver-pill {
          font-size: 10px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 6px;
          background: rgba(56, 189, 248, 0.16);
          color: #38bdf8;
        }
        .logo-badge {
          width: 30px;
          height: 30px;
          border-radius: 8px;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(239, 68, 68, 0.35);
        }
        .logo-badge img { width: 100%; height: 100%; object-fit: contain; display: block; }
        .win-btns { display: flex; align-items: center; gap: 6px; }
        .win-btn {
          background: transparent;
          border: none;
          color: #94a3b8;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 15px;
        }
        .win-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
        .detection-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 14px;
        }
        .det-label {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.9px;
          color: #64748b;
        }
        input[type="range"] {
          -webkit-appearance: none;
          flex: 1;
          height: 4px;
          border-radius: 4px;
          background: linear-gradient(90deg, #22d3ee 0%, #22d3ee 50%, #334155 50%, #334155 100%);
          outline: none;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #22d3ee;
          box-shadow: 0 0 12px rgba(34, 211, 238, 0.8);
          cursor: pointer;
        }
        .det-val {
          font-size: 13px;
          font-weight: 700;
          color: #a5b4fc;
          min-width: 32px;
          text-align: right;
        }
        .primary-actions {
          display: flex;
          gap: 10px;
          margin-bottom: 10px;
        }
        .btn-start {
          flex: 1.65;
          height: 44px;
          border: none;
          border-radius: 13px;
          background: linear-gradient(135deg, #38bdf8 0%, #818cf8 55%, #a855f7 100%);
          color: #fff;
          font-weight: 700;
          font-size: 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          box-shadow: 0 8px 20px rgba(99, 102, 241, 0.35);
        }
        .btn-start:hover { filter: brightness(1.08); }
        .btn-start.running {
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          box-shadow: 0 8px 20px rgba(16, 185, 129, 0.35);
        }
        .btn-snap {
          flex: 1;
          height: 44px;
          border: 1px solid rgba(34, 211, 238, 0.28);
          border-radius: 13px;
          background: rgba(15, 23, 42, 0.65);
          color: #22d3ee;
          font-weight: 700;
          font-size: 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
        }
        .btn-snap:hover { background: rgba(34, 211, 238, 0.12); }
        .timestamp-row {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
        }
        .ts-input {
          flex: 1;
          height: 34px;
          border-radius: 9px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(15, 23, 42, 0.7);
          color: #f8fafc;
          padding: 0 10px;
          font-size: 12px;
          outline: none;
          user-select: text;
        }
        .ts-input:focus { border-color: #38bdf8; }
        .btn-ts {
          height: 34px;
          padding: 0 12px;
          border-radius: 9px;
          border: 1px solid rgba(129, 140, 248, 0.3);
          background: rgba(129, 140, 248, 0.14);
          color: #c7d2fe;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .btn-ts:hover { background: rgba(129, 140, 248, 0.25); }
        .gallery-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
          font-size: 13px;
        }
        .captured-count {
          font-weight: 700;
          background: linear-gradient(90deg, #22d3ee, #a855f7);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .select-all {
          color: #94a3b8;
          text-decoration: underline;
          cursor: pointer;
          font-size: 12px;
        }
        .select-all:hover { color: #e2e8f0; }
        .grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          max-height: 210px;
          overflow-y: auto;
          margin-bottom: 12px;
          padding-right: 2px;
        }
        .grid::-webkit-scrollbar { width: 4px; }
        .grid::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
        .empty-state {
          grid-column: 1 / -1;
          text-align: center;
          padding: 18px 10px;
          font-size: 12px;
          line-height: 1.45;
          color: #64748b;
          border: 1px dashed rgba(255,255,255,0.08);
          border-radius: 10px;
        }
        .thumb {
          position: relative;
          border-radius: 10px;
          overflow: hidden;
          aspect-ratio: 16 / 9;
          border: 2px solid transparent;
          cursor: pointer;
          background: #0f172a;
        }
        .thumb.selected { border-color: #38bdf8; }
        .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .chk {
          position: absolute;
          top: 5px;
          left: 5px;
          width: 16px;
          height: 16px;
          border-radius: 4px;
          background: rgba(15, 23, 42, 0.72);
          border: 1px solid rgba(255, 255, 255, 0.35);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          color: #fff;
        }
        .thumb.selected .chk {
          background: #38bdf8;
          border-color: #38bdf8;
          color: #0f172a;
          font-weight: 800;
        }
        .zoom-btn {
          position: absolute;
          top: 4px;
          right: 4px;
          width: 18px;
          height: 18px;
          border-radius: 4px;
          border: none;
          background: rgba(15, 23, 42, 0.78);
          color: #e2e8f0;
          font-size: 10px;
          cursor: pointer;
          display: none;
          align-items: center;
          justify-content: center;
        }
        .thumb:hover .zoom-btn { display: flex; }
        .time-pill {
          position: absolute;
          bottom: 4px;
          left: 4px;
          background: rgba(15, 23, 42, 0.85);
          color: #f8fafc;
          font-size: 10px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 5px;
        }
        .bottom-row {
          display: flex;
          gap: 10px;
          margin-bottom: 10px;
        }
        .btn-delete {
          flex: 1;
          height: 40px;
          border-radius: 11px;
          border: 1px solid rgba(244, 63, 94, 0.35);
          background: rgba(244, 63, 94, 0.08);
          color: #fb7185;
          font-weight: 700;
          font-size: 13px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .btn-delete:hover { background: rgba(244, 63, 94, 0.18); }
        .export-wrap { flex: 1.25; position: relative; }
        .btn-export {
          width: 100%;
          height: 40px;
          border: none;
          border-radius: 11px;
          background: linear-gradient(135deg, #38bdf8 0%, #818cf8 55%, #a855f7 100%);
          color: #fff;
          font-weight: 700;
          font-size: 13px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .btn-export:hover { filter: brightness(1.08); }
        .export-menu {
          position: absolute;
          bottom: 46px;
          right: 0;
          width: 160px;
          background: #1e1b38;
          border: 1px solid rgba(139, 92, 246, 0.35);
          border-radius: 10px;
          padding: 4px;
          display: none;
          flex-direction: column;
          box-shadow: 0 10px 25px rgba(0,0,0,0.6);
          z-index: 10;
        }
        .export-menu.open { display: flex; }
        .export-opt {
          background: transparent;
          border: none;
          color: #f8fafc;
          text-align: left;
          padding: 8px 10px;
          font-size: 12px;
          font-weight: 600;
          border-radius: 7px;
          cursor: pointer;
        }
        .export-opt:hover { background: rgba(56, 189, 248, 0.18); }
        .btn-clear {
          width: 100%;
          height: 36px;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
          color: #94a3b8;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .btn-clear:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
        .status-bar {
          margin-top: 8px;
          font-size: 11px;
          color: #38bdf8;
          min-height: 15px;
          text-align: center;
        }
        .body-wrap.hidden { display: none; }

        /* Full-resolution slide preview modal */
        .lightbox {
          position: fixed;
          inset: 0;
          background: rgba(5, 8, 20, 0.88);
          display: none;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          gap: 12px;
          padding: 24px;
          z-index: 2147483647;
        }
        .lightbox.open { display: flex; }
        .lightbox img {
          max-width: 90vw;
          max-height: 80vh;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.18);
          box-shadow: 0 20px 60px rgba(0,0,0,0.8);
        }
        .lightbox-bar {
          display: flex;
          align-items: center;
          gap: 16px;
          color: #e2e8f0;
          font-size: 13px;
        }
        .lightbox-close {
          padding: 6px 14px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.2);
          background: #1e293b;
          color: #fff;
          cursor: pointer;
          font-weight: 600;
        }
      </style>

      <div class="panel" id="panel">
        <div class="header" id="dragHeader">
          <div class="brand">
            <div class="logo-badge">
              <img src="data:image/png;base64,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" alt="Video to Slides" />
            </div>
            <span>Video to Slides</span>
            <span class="ver-pill">v3.1</span>
          </div>
          <div class="win-btns">
            <button class="win-btn" id="minBtn" title="Minimize">—</button>
            <button class="win-btn" id="closeBtn" title="Close">✕</button>
          </div>
        </div>

        <div class="body-wrap" id="bodyWrap">
          <div class="detection-row">
            <span class="det-label">DETECTION</span>
            <input type="range" id="sensSlider" min="1" max="3" step="1" value="2" />
            <span class="det-val" id="sensLabel">Med</span>
          </div>

          <div class="primary-actions">
            <button class="btn-start" id="startBtn">▶ Start Capture</button>
            <button class="btn-snap" id="snapBtn" title="Shortcut: Alt + S">◉ Snap</button>
          </div>

          <div class="timestamp-row">
            <input class="ts-input" id="tsInput" type="text" placeholder="Timestamp Y (e.g. 04:25 or 22:03)" />
            <button class="btn-ts" id="snapAtBtn">Snap at Y</button>
          </div>

          <div class="gallery-header">
            <span class="captured-count" id="countText">0 slides captured</span>
            <span class="select-all" id="selectAllBtn">Select All</span>
          </div>

          <div class="grid" id="grid"></div>

          <div class="bottom-row">
            <button class="btn-delete" id="deleteBtn">🗑 Delete</button>
            <div class="export-wrap">
              <div class="export-menu" id="exportMenu">
                <button class="export-opt" id="expPdf">📄 Export as PDF</button>
                <button class="export-opt" id="expHtml">🌐 Export as HTML</button>
              </div>
              <button class="btn-export" id="exportBtn">⬇ Export</button>
            </div>
          </div>

          <button class="btn-clear" id="clearAllBtn">Clear All</button>
          <div class="status-bar" id="statusBar"></div>
        </div>
      </div>

      <div class="lightbox" id="lightbox">
        <img id="lightboxImg" src="" alt="Slide Preview" />
        <div class="lightbox-bar">
          <span id="lightboxMeta"></span>
          <button class="lightbox-close" id="lightboxClose">Close Preview</button>
        </div>
      </div>
    `;

    document.documentElement.appendChild(hostEl);
    bindUIEvents();
    renderSlides();
  }

  function setStatus(text, isError = false) {
    const el = shadow.getElementById('statusBar');
    el.style.color = isError ? '#fb7185' : '#38bdf8';
    el.textContent = text;
  }

  async function renderSlides() {
    if (!shadow) return;
    const { slides = [] } = await chrome.storage.local.get('slides');
    const countText = shadow.getElementById('countText');
    const grid = shadow.getElementById('grid');

    countText.textContent = `${slides.length} slide${slides.length === 1 ? '' : 's'} captured`;
    grid.innerHTML = '';

    if (!slides.length) {
      grid.innerHTML = `<div class="empty-state">Click <b>Start Capture</b> for auto slide detection or <b>Snap</b> (Alt+S) anytime.</div>`;
      return;
    }

    slides.forEach((slide, idx) => {
      const card = document.createElement('div');
      card.className = 'thumb' + (selectedIds.has(slide.id) ? ' selected' : '');
      card.innerHTML = `
        <img src="${slide.image}" alt="Slide ${idx + 1}" />
        <div class="chk">${selectedIds.has(slide.id) ? '✓' : ''}</div>
        <button class="zoom-btn" title="Preview HD Slide">⤢</button>
        <div class="time-pill">${slide.formattedTime}</div>
      `;

      card.querySelector('.zoom-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        shadow.getElementById('lightboxImg').src = slide.image;
        shadow.getElementById('lightboxMeta').textContent =
          `Slide #${idx + 1} • ${slide.formattedTime} • ${slide.width}×${slide.height}px`;
        shadow.getElementById('lightbox').classList.add('open');
      });

      card.addEventListener('click', () => {
        if (selectedIds.has(slide.id)) {
          selectedIds.delete(slide.id);
        } else {
          selectedIds.add(slide.id);
        }
        renderSlides();
      });

      grid.appendChild(card);
    });
  }

  function bindUIEvents() {
    const header = shadow.getElementById('dragHeader');
    let isDragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      const rect = hostEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      hostEl.style.right = 'auto';
      hostEl.style.left = `${origLeft}px`;
      hostEl.style.top = `${origTop}px`;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      hostEl.style.left = `${Math.max(0, origLeft + dx)}px`;
      hostEl.style.top = `${Math.max(0, origTop + dy)}px`;
    });

    window.addEventListener('mouseup', () => { isDragging = false; });

    // Lightbox close
    const lightbox = shadow.getElementById('lightbox');
    shadow.getElementById('lightboxClose').addEventListener('click', () => lightbox.classList.remove('open'));
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) lightbox.classList.remove('open');
    });

    // Keyboard shortcut Alt+S to snap when panel is open
    window.addEventListener('keydown', (e) => {
      if (hostEl && hostEl.style.display !== 'none' && e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        shadow.getElementById('snapBtn').click();
      }
    });

    shadow.getElementById('minBtn').addEventListener('click', () => {
      isMinimized = !isMinimized;
      shadow.getElementById('bodyWrap').classList.toggle('hidden', isMinimized);
      shadow.getElementById('minBtn').textContent = isMinimized ? '+' : '—';
    });

    shadow.getElementById('closeBtn').addEventListener('click', () => {
      hostEl.style.display = 'none';
    });

    const slider = shadow.getElementById('sensSlider');
    const sensLabel = shadow.getElementById('sensLabel');
    slider.addEventListener('input', async () => {
      const val = Number(slider.value);
      const pct = ((val - 1) / 2) * 100;
      slider.style.background = `linear-gradient(90deg, #22d3ee 0%, #22d3ee ${pct}%, #334155 ${pct}%, #334155 100%)`;
      sensLabel.textContent = val === 1 ? 'Low' : val === 3 ? 'High' : 'Med';
      await dispatchVideoCommand({ action: 'V2S_SET_SENSITIVITY', level: val });
    });

    const startBtn = shadow.getElementById('startBtn');
    startBtn.addEventListener('click', async () => {
      const nextState = !isAutoRunning;
      setStatus(nextState ? 'Starting smart slide detection...' : 'Stopping...');
      const res = await dispatchVideoCommand({ action: 'V2S_SET_AUTO', enabled: nextState });
      if (!res?.ok) {
        setStatus(res?.error || 'Could not detect active video.', true);
        return;
      }
      isAutoRunning = res.isRunning;
      startBtn.textContent = isAutoRunning ? '⏸ Pause Capture' : '▶ Start Capture';
      startBtn.classList.toggle('running', isAutoRunning);
      setStatus(isAutoRunning ? 'Auto-detecting slides as video plays...' : 'Auto-capture paused.');
    });

    shadow.getElementById('snapBtn').addEventListener('click', async () => {
      setStatus('Snapping current frame...');
      const res = await dispatchVideoCommand({ action: 'V2S_SNAP_NOW' });
      if (!res?.ok) {
        setStatus(res?.error || 'Snap failed.', true);
        return;
      }
      setStatus(`Snapped slide at ${res.slide.formattedTime}`);
    });

    shadow.getElementById('snapAtBtn').addEventListener('click', async () => {
      const raw = shadow.getElementById('tsInput').value;
      const secs = parseTimestamp(raw);
      if (secs === null) {
        setStatus('Enter valid time like 04:25 or 22:03', true);
        return;
      }
      setStatus(`Jumping to ${raw}...`);
      const res = await dispatchVideoCommand({ action: 'V2S_SNAP_AT', seconds: secs });
      if (!res?.ok) {
        setStatus(res?.error || 'Timestamp snap failed.', true);
        return;
      }
      setStatus(`Snapped at ${res.slide.formattedTime}`);
    });

    shadow.getElementById('selectAllBtn').addEventListener('click', async () => {
      const { slides = [] } = await chrome.storage.local.get('slides');
      if (selectedIds.size === slides.length) {
        selectedIds.clear();
      } else {
        slides.forEach(s => selectedIds.add(s.id));
      }
      renderSlides();
    });

    shadow.getElementById('deleteBtn').addEventListener('click', async () => {
      if (!selectedIds.size) {
        setStatus('Click slides to select them before deleting.', true);
        return;
      }
      const { slides = [] } = await chrome.storage.local.get('slides');
      const remaining = slides.filter(s => !selectedIds.has(s.id));
      selectedIds.clear();
      await chrome.storage.local.set({ slides: remaining });
      setStatus('Deleted selected slides.');
    });

    const exportMenu = shadow.getElementById('exportMenu');
    shadow.getElementById('exportBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });
    shadow.addEventListener('click', () => exportMenu.classList.remove('open'));

    shadow.getElementById('expPdf').addEventListener('click', async () => {
      const { slides = [] } = await chrome.storage.local.get('slides');
      const target = selectedIds.size ? slides.filter(s => selectedIds.has(s.id)) : slides;
      if (!target.length) return setStatus('No slides to export.', true);

      setStatus(`Generating PDF (${target.length} slides)...`);
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'landscape', unit: 'px', format: [1280, 720] });
      target.forEach((s, i) => {
        if (i > 0) doc.addPage([1280, 720], 'landscape');
        doc.addImage(s.image, 'JPEG', 0, 0, 1280, 720);
      });
      const safeTitle = (target[0].title || 'lecture_slides').replace(/[^a-z0-9]/gi, '_').toLowerCase();
      doc.save(`${safeTitle}.pdf`);
      setStatus('PDF downloaded!');
    });

    shadow.getElementById('expHtml').addEventListener('click', async () => {
      const { slides = [] } = await chrome.storage.local.get('slides');
      const target = selectedIds.size ? slides.filter(s => selectedIds.has(s.id)) : slides;
      if (!target.length) return setStatus('No slides to export.', true);

      const safeTitle = escapeHtml(target[0].title || 'Lecture Slides');
      const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${safeTitle}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; max-width: 1100px; margin: 0 auto; padding: 24px; }
  h1 { border-bottom: 1px solid #334155; padding-bottom: 12px; }
  .slide { background: #1e293b; margin-bottom: 28px; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
  .slide img { width: 100%; display: block; }
  .meta { padding: 12px 16px; display: flex; justify-content: space-between; font-size: 14px; color: #94a3b8; }
  @media print { body { background: #fff; color: #000; } .slide { break-inside: avoid; box-shadow: none; border: 1px solid #ccc; } }
</style>
</head>
<body>
  <h1>${safeTitle}</h1>
  ${target.map((s, i) => `
    <div class="slide">
      <img src="${s.image}" alt="Slide ${i + 1}" />
      <div class="meta"><strong>Slide ${i + 1}</strong><span>Timestamp: ${escapeHtml(s.formattedTime)} • Resolution: ${s.width}x${s.height}</span></div>
    </div>
  `).join('')}
</body>
</html>`;

      const blob = new Blob([htmlContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(target[0].title || 'lecture_slides').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus('HTML deck downloaded!');
    });

    shadow.getElementById('clearAllBtn').addEventListener('click', async () => {
      selectedIds.clear();
      await chrome.storage.local.set({ slides: [] });
      setStatus('All slides cleared.');
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.slides) {
        renderSlides();
      }
    });
  }

  function toggleOverlayUI(forceShow = false) {
    if (!hostEl) {
      createOverlayUI();
      return;
    }
    if (forceShow || hostEl.style.display === 'none') {
      hostEl.style.display = 'block';
      renderSlides();
    } else {
      hostEl.style.display = 'none';
    }
  }
})();
