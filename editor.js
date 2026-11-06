const canvas = document.getElementById('stageCanvas');
const ctx = canvas.getContext('2d');

let totalDuration = 10;
let currentTime = 0;
let isPlaying = true;
let playbackSpeed = 1.0;
let activeTool = 'none';

// 原视频剪辑片段
let videoClips = [
  { id: 'c1', start: 0, end: 10, offset: 0, speed: 1.0 }
];
let selectedClipId = 'c1';

// 缩放动效列表（支持鼠标直接拖拽位置与调节时长）
let zoomEffects = [
  { id: 'z1', start: 1.0, duration: 2.2, scale: 1.85, cx: 0.35, cy: 0.42, is3D: true },
  { id: 'z2', start: 4.8, duration: 2.5, scale: 2.0, cx: 0.68, cy: 0.52, is3D: true }
];
let selectedZoomId = 'z1';

// 标注、聚光灯、马赛克（存储相对于录屏窗口内部的归一化坐标 0~1，确保无论如何缩放移动都能精准贴合原画面的鼠标位置）
let annotations = [
  { id: 'a1', type: 'arrow', nx1: 0.22, ny1: 0.28, nx2: 0.36, ny2: 0.42 },
  { id: 'a2', type: 'circle', nx1: 0.56, ny1: 0.38, nx2: 0.74, ny2: 0.58 }
];

// 鼠标轨迹
let mouseTrail = [];
for (let t = 0; t <= 10; t += 0.2) {
  mouseTrail.push({
    timeOffset: t,
    nx: 0.25 + 0.5 * Math.sin(t * 0.9) * 0.5 + 0.25,
    ny: 0.3 + 0.4 * Math.cos(t * 0.7) * 0.5 + 0.2,
    eventType: (Math.abs(t - 1.2) < 0.1 || Math.abs(t - 5.0) < 0.1) ? 'click' : 'move'
  });
}

// 录屏背景设置（还原第一版 Sonoma 炫彩紫粉渐变壁纸）
let bgSettings = {
  theme: 'gradient-sonoma',
  radius: 18,
  padding: 44
};

// 摄像头画中画
let pipState = {
  show: true,
  x: 760,
  y: 350,
  size: 160,
  dragging: false,
  dragOffsetX: 0,
  dragOffsetY: 0
};

let screenVideo = document.createElement('video');
screenVideo.muted = true;
screenVideo.loop = true;
screenVideo.playsInline = true;
let hasRealScreenVideo = false;
let screenBlobRef = null;

let camVideo = document.createElement('video');
camVideo.muted = true;
camVideo.loop = true;
camVideo.playsInline = true;
let hasRealCamVideo = false;

let regionMeta = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ScreenMasterDB', 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadBlob(key) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function initMedia() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['lastRecordingMeta', 'savedProjectState'], (res) => {
      if (res && res.savedProjectState) {
        try {
          const s = res.savedProjectState;
          if (s.zoomEffects) zoomEffects = s.zoomEffects;
          if (s.videoClips) videoClips = s.videoClips;
          if (s.annotations) annotations = s.annotations;
          if (s.bgSettings) bgSettings = s.bgSettings;
          if (s.pipState) pipState = { ...pipState, ...s.pipState };
        } catch (e) {
          console.warn('恢复工程状态失败:', e);
        }
      }

      if (res && res.lastRecordingMeta) {
        const meta = res.lastRecordingMeta;
        if (meta.duration) {
          totalDuration = Math.max(3, Math.min(300, meta.duration));
          videoClips = [{ id: 'c1', start: 0, end: totalDuration, offset: 0, speed: 1.0 }];
          selectedClipId = 'c1';
        }
        if (meta.region) {
          regionMeta = meta.region;
          document.getElementById('regionBadge').textContent =
            `录制区域：自定义框选 (${meta.region.pxWidth}×${meta.region.pxHeight} px)`;
        }
        if (meta.mouseEvents && meta.mouseEvents.length > 2) {
          mouseTrail = meta.mouseEvents;
          const clicks = meta.mouseEvents.filter(e => e.eventType === 'click');
          if (clicks.length > 0) {
            zoomEffects = clicks.slice(0, 6).map((c, idx) => ({
              id: 'z_auto_' + idx,
              start: Math.max(0, c.timeOffset - 0.2),
              duration: 2.0,
              scale: 1.85,
              cx: c.nx,
              cy: c.ny,
              is3D: true
            }));
            selectedZoomId = zoomEffects[0].id;
          }
        }
      }
      renderTracks();
      syncZoomControls();
    });
  }

  const screenBlob = await loadBlob('latestScreenVideo');
  if (screenBlob && screenBlob.size > 0) {
    screenBlobRef = screenBlob;
    screenVideo.src = URL.createObjectURL(screenBlob);
    screenVideo.onloadedmetadata = () => {
      hasRealScreenVideo = true;
      if (screenVideo.duration && isFinite(screenVideo.duration)) {
        totalDuration = screenVideo.duration;
        videoClips = [{ id: 'c1', start: 0, end: totalDuration, offset: 0, speed: 1.0 }];
      }
      document.getElementById('seekBar').max = totalDuration;
      document.getElementById('zoomStartRange').max = totalDuration;
      screenVideo.play().catch(() => {});
      renderTracks();
    };
  }

  const camBlob = await loadBlob('latestCameraVideo');
  if (camBlob && camBlob.size > 0) {
    camVideo.src = URL.createObjectURL(camBlob);
    camVideo.onloadedmetadata = () => {
      hasRealCamVideo = true;
      camVideo.play().catch(() => {});
    };
  }
}

// 保存工程 & 导出下载
const saveProjectBtn = document.getElementById('saveProjectBtn');
const exportWebmBtn = document.getElementById('exportWebmBtn');
const exportMp4Btn = document.getElementById('exportMp4Btn');
const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2200);
}

saveProjectBtn.addEventListener('click', () => {
  const projectData = {
    zoomEffects,
    videoClips,
    annotations,
    bgSettings,
    pipState: { show: pipState.show, x: pipState.x, y: pipState.y, size: pipState.size },
    savedAt: Date.now()
  };
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ savedProjectState: projectData }, () => {
      showToast('💾 工程与动效时间轴已成功保存！');
    });
  } else {
    localStorage.setItem('savedProjectState', JSON.stringify(projectData));
    showToast('💾 工程已保存到浏览器本地缓存！');
  }
});

exportWebmBtn.addEventListener('click', () => {
  if (screenBlobRef) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(screenBlobRef);
    a.download = `录屏大师_原片_${Date.now()}.webm`;
    a.click();
    showToast('⬇️ 正在下载录屏原视频文件...');
  } else {
    exportCanvasStream(4);
  }
});

exportMp4Btn.addEventListener('click', () => {
  exportCanvasStream(Math.min(totalDuration, 8));
});

function exportCanvasStream(sec) {
  showToast(`🎬 正在离线合成包含 3D 缩放、Sonoma 背景与对齐标注的视频 (${sec}s)...`);
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `录屏大师_合成渲染导出_${Date.now()}.webm`;
    a.click();
    showToast('✅ 合成视频导出完成，已触发浏览器下载！');
  };
  recorder.start();
  currentTime = 0;
  isPlaying = true;
  setTimeout(() => {
    recorder.stop();
  }, sec * 1000);
}

// 录屏背景设置联动
document.getElementById('winRadiusRange').addEventListener('input', (e) => {
  bgSettings.radius = parseInt(e.target.value, 10);
});
document.getElementById('winPaddingRange').addEventListener('input', (e) => {
  bgSettings.padding = parseInt(e.target.value, 10);
});
document.querySelectorAll('.bg-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.bg-item').forEach(b => b.classList.remove('active'));
    item.classList.add('active');
    bgSettings.theme = item.dataset.bg;
  });
});

// 缩放动效控制器
const zoomStartRange = document.getElementById('zoomStartRange');
const zoomStartVal = document.getElementById('zoomStartVal');
const zoomDurRange = document.getElementById('zoomDurRange');
const zoomDurVal = document.getElementById('zoomDurVal');
const zoomScaleRange = document.getElementById('zoomScaleRange');
const zoomScaleVal = document.getElementById('zoomScaleVal');
const selectedZoomLabel = document.getElementById('selectedZoomLabel');

function syncZoomControls() {
  const z = zoomEffects.find(item => item.id === selectedZoomId);
  if (!z) {
    selectedZoomLabel.textContent = '当前未选中缩放动效段';
    return;
  }
  selectedZoomLabel.textContent = `当前选中：缩放动效 (${z.start.toFixed(1)}s 起)`;
  zoomStartRange.value = z.start;
  zoomStartVal.textContent = z.start.toFixed(1);
  zoomDurRange.value = z.duration;
  zoomDurVal.textContent = z.duration.toFixed(1);
  zoomScaleRange.value = z.scale;
  zoomScaleVal.textContent = z.scale.toFixed(1);
}

zoomStartRange.addEventListener('input', () => {
  const z = zoomEffects.find(item => item.id === selectedZoomId);
  if (z) {
    z.start = parseFloat(zoomStartRange.value);
    zoomStartVal.textContent = z.start.toFixed(1);
    renderTracks();
  }
});
zoomDurRange.addEventListener('input', () => {
  const z = zoomEffects.find(item => item.id === selectedZoomId);
  if (z) {
    z.duration = parseFloat(zoomDurRange.value);
    zoomDurVal.textContent = z.duration.toFixed(1);
    renderTracks();
  }
});
zoomScaleRange.addEventListener('input', () => {
  const z = zoomEffects.find(item => item.id === selectedZoomId);
  if (z) {
    z.scale = parseFloat(zoomScaleRange.value);
    zoomScaleVal.textContent = z.scale.toFixed(1);
    renderTracks();
  }
});

document.getElementById('addZoomBtn').addEventListener('click', () => {
  const newId = 'z_' + Date.now();
  zoomEffects.push({
    id: newId,
    start: Math.max(0, Math.min(totalDuration - 1.5, currentTime)),
    duration: 2.0,
    scale: 1.85,
    cx: 0.5,
    cy: 0.5,
    is3D: true
  });
  selectedZoomId = newId;
  renderTracks();
  syncZoomControls();
  showToast('➕ 已插入新的缩放动效（可直接在下方轨道拖拽调节）！');
});

document.getElementById('deleteZoomBtn').addEventListener('click', () => {
  if (!selectedZoomId) return;
  zoomEffects = zoomEffects.filter(z => z.id !== selectedZoomId);
  selectedZoomId = zoomEffects[0] ? zoomEffects[0].id : null;
  renderTracks();
  syncZoomControls();
  showToast('🗑 已删除选中的缩放动效！');
});

// 原视频剪辑轨操作（分割、选择、删除、变速）
const splitClipBtn = document.getElementById('splitClipBtn');
const delClipBtn = document.getElementById('delClipBtn');

splitClipBtn.addEventListener('click', () => {
  const clipIndex = videoClips.findIndex(c => currentTime > c.start + 0.2 && currentTime < c.end - 0.2);
  if (clipIndex === -1) {
    showToast('⚠️ 当前播放位置无法分割，请将指针移动到片段中间！');
    return;
  }
  const old = videoClips[clipIndex];
  const first = { id: 'c_' + Date.now() + '_1', start: old.start, end: currentTime, offset: old.offset, speed: old.speed };
  const second = { id: 'c_' + Date.now() + '_2', start: currentTime, end: old.end, offset: old.offset + (currentTime - old.start), speed: old.speed };
  videoClips.splice(clipIndex, 1, first, second);
  selectedClipId = second.id;
  renderTracks();
  showToast('✂️ 原视频已在播放头位置成功分割为两段！');
});

delClipBtn.addEventListener('click', () => {
  if (videoClips.length <= 1) {
    showToast('⚠️ 至少需要保留一段原视频片段！');
    return;
  }
  videoClips = videoClips.filter(c => c.id !== selectedClipId);
  selectedClipId = videoClips[0] ? videoClips[0].id : null;
  renderTracks();
  showToast('🗑 已删除当前选中的原视频片段！');
});

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    playbackSpeed = parseFloat(btn.dataset.speed);
    if (screenVideo) screenVideo.playbackRate = playbackSpeed;
    const clip = videoClips.find(c => c.id === selectedClipId);
    if (clip) clip.speed = playbackSpeed;
    showToast(`⚡ 原片倍速已切换至 ${playbackSpeed}x`);
  });
});

// 核心功能点2修复：实现动效轨色块直接拖动位置、拖拽边缘调整持续时间！
let trackDragState = null;

function renderTracks() {
  const zTrack = document.getElementById('zoomTrack');
  zTrack.querySelectorAll('.zoom-block').forEach(el => el.remove());

  zoomEffects.forEach(z => {
    const el = document.createElement('div');
    el.className = 'zoom-block' + (z.id === selectedZoomId ? ' selected' : '');
    const leftPct = Math.min(95, Math.max(0, (z.start / totalDuration) * 100));
    const widthPct = Math.min(100 - leftPct, Math.max(5, (z.duration / totalDuration) * 100));
    el.style.left = leftPct + '%';
    el.style.width = widthPct + '%';

    // 左调节手柄
    const handleL = document.createElement('div');
    handleL.className = 'resize-handle left';
    handleL.title = '向左拖动延长开始时间';
    el.appendChild(handleL);

    // 中间文本
    const label = document.createElement('span');
    label.style.pointerEvents = 'none';
    label.textContent = `🔍 ${z.scale.toFixed(1)}x (${z.duration.toFixed(1)}s)`;
    el.appendChild(label);

    // 右调节手柄
    const handleR = document.createElement('div');
    handleR.className = 'resize-handle right';
    handleR.title = '向右拖动延长持续时间';
    el.appendChild(handleR);

    // 拖动主体移动位置
    el.addEventListener('mousedown', (e) => {
      if (e.target === handleL || e.target === handleR) return;
      e.stopPropagation();
      selectedZoomId = z.id;
      currentTime = z.start;
      syncZoomControls();
      renderTracks();

      const trackRect = zTrack.getBoundingClientRect();
      trackDragState = {
        type: 'move',
        zoomId: z.id,
        startX: e.clientX,
        origStart: z.start,
        duration: z.duration,
        trackWidth: trackRect.width
      };
    });

    // 拖拽手柄改变时长
    handleL.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      selectedZoomId = z.id;
      const trackRect = zTrack.getBoundingClientRect();
      trackDragState = {
        type: 'resize-left',
        zoomId: z.id,
        startX: e.clientX,
        origStart: z.start,
        origDur: z.duration,
        trackWidth: trackRect.width
      };
    });

    handleR.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      selectedZoomId = z.id;
      const trackRect = zTrack.getBoundingClientRect();
      trackDragState = {
        type: 'resize-right',
        zoomId: z.id,
        startX: e.clientX,
        origStart: z.start,
        origDur: z.duration,
        trackWidth: trackRect.width
      };
    });

    zTrack.appendChild(el);
  });

  // 原片剪辑轨
  const vTrack = document.getElementById('videoTrack');
  vTrack.querySelectorAll('.clip-block').forEach(el => el.remove());
  videoClips.forEach((c, idx) => {
    const el = document.createElement('div');
    el.className = 'clip-block' + (c.id === selectedClipId ? ' selected' : '');
    const leftPct = Math.min(95, Math.max(0, (c.start / totalDuration) * 100));
    const widthPct = Math.min(100 - leftPct, Math.max(4, ((c.end - c.start) / totalDuration) * 100));
    el.style.left = leftPct + '%';
    el.style.width = widthPct + '%';
    el.textContent = `片段 #${idx + 1} (${(c.end - c.start).toFixed(1)}s · ${c.speed || 1.0}x)`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedClipId = c.id;
      renderTracks();
      document.getElementById('clipInfo').textContent = `片段 ${idx + 1}/${videoClips.length}`;
    });
    vTrack.appendChild(el);
  });
}

// 监听全局鼠标拖拽动效色块
window.addEventListener('mousemove', (e) => {
  if (!trackDragState) return;
  const z = zoomEffects.find(item => item.id === trackDragState.zoomId);
  if (!z) return;

  const dx = e.clientX - trackDragState.startX;
  const dt = (dx / trackDragState.trackWidth) * totalDuration;

  if (trackDragState.type === 'move') {
    z.start = Math.max(0, Math.min(totalDuration - z.duration, trackDragState.origStart + dt));
    currentTime = z.start;
  } else if (trackDragState.type === 'resize-left') {
    const newStart = Math.max(0, Math.min(trackDragState.origStart + trackDragState.origDur - 0.4, trackDragState.origStart + dt));
    const newDur = (trackDragState.origStart + trackDragState.origDur) - newStart;
    z.start = newStart;
    z.duration = Math.max(0.4, newDur);
  } else if (trackDragState.type === 'resize-right') {
    z.duration = Math.max(0.4, Math.min(totalDuration - z.start, trackDragState.origDur + dt));
  }

  syncZoomControls();
  renderTracks();
});

window.addEventListener('mouseup', () => {
  if (trackDragState) {
    trackDragState = null;
    showToast('✨ 动效时间轴位置/时长已调整更新！');
  }
});

// 标注与画布交互（核心功能点4修复：精准对齐缩放与偏移坐标）
const toolBtns = document.querySelectorAll('.tool-btn');
toolBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    toolBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTool = btn.dataset.tool;
  });
});

function renderAnnotationList() {
  const container = document.getElementById('annotationList');
  container.innerHTML = '';
  const nameMap = { arrow: '↗️ 箭头标注', circle: '⭕ 画圈强调', spotlight: '🔦 聚光灯突出', mosaic: '🟦 马赛克遮罩' };
  annotations.forEach(a => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<span>${nameMap[a.type] || a.type}</span>`;
    const del = document.createElement('button');
    del.className = 'btn';
    del.style.padding = '2px 6px';
    del.style.fontSize = '10px';
    del.textContent = '删除';
    del.onclick = () => {
      annotations = annotations.filter(item => item.id !== a.id);
      renderAnnotationList();
    };
    item.appendChild(del);
    container.appendChild(item);
  });
}

document.getElementById('clearShapesBtn').addEventListener('click', () => {
  annotations = [];
  renderAnnotationList();
});

// 坐标转换计算辅助函数：将画布点击坐标反推换算为录屏视窗内部的归一化坐标 (0~1)
function getScreenWindowCoords(canvasX, canvasY, currentScale, currentFocusX, currentFocusY) {
  const pad = bgSettings.padding;
  const winW = canvas.width - pad * 2;
  const winH = canvas.height - pad * 2;

  const cx = currentFocusX * canvas.width;
  const cy = currentFocusY * canvas.height;

  // 逆矩阵变换
  const unscaledX = (canvasX - canvas.width / 2) / currentScale + cx;
  const unscaledY = (canvasY - canvas.height / 2) / currentScale + cy;

  const nx = (unscaledX - pad) / winW;
  const ny = (unscaledY - pad) / winH;
  return { nx, ny };
}

let drawingShape = null;

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

let latestRenderTransform = { scale: 1.0, focusX: 0.5, focusY: 0.5 };

canvas.addEventListener('mousedown', (e) => {
  const pos = getCanvasCoords(e);
  if (activeTool === 'none' && pipState.show) {
    const dist = Math.hypot(pos.x - (pipState.x + pipState.size / 2), pos.y - (pipState.y + pipState.size / 2));
    if (dist <= pipState.size / 2) {
      pipState.dragging = true;
      pipState.dragOffsetX = pos.x - pipState.x;
      pipState.dragOffsetY = pos.y - pipState.y;
      return;
    }
  }

  if (activeTool !== 'none') {
    const { nx, ny } = getScreenWindowCoords(pos.x, pos.y, latestRenderTransform.scale, latestRenderTransform.focusX, latestRenderTransform.focusY);
    drawingShape = {
      id: 'a_' + Date.now(),
      type: activeTool,
      nx1: nx,
      ny1: ny,
      nx2: nx + 0.02,
      ny2: ny + 0.02
    };
    annotations.push(drawingShape);
  }
});

canvas.addEventListener('mousemove', (e) => {
  const pos = getCanvasCoords(e);
  if (pipState.dragging) {
    pipState.x = Math.max(12, Math.min(canvas.width - pipState.size - 12, pos.x - pipState.dragOffsetX));
    pipState.y = Math.max(12, Math.min(canvas.height - pipState.size - 12, pos.y - pipState.dragOffsetY));
    return;
  }
  if (drawingShape) {
    const { nx, ny } = getScreenWindowCoords(pos.x, pos.y, latestRenderTransform.scale, latestRenderTransform.focusX, latestRenderTransform.focusY);
    drawingShape.nx2 = nx;
    drawingShape.ny2 = ny;
  }
});

window.addEventListener('mouseup', () => {
  pipState.dragging = false;
  if (drawingShape) {
    drawingShape = null;
    renderAnnotationList();
  }
});

// 人像小窗避让
document.getElementById('showPipToggle').addEventListener('change', (e) => {
  pipState.show = e.target.checked;
});
document.getElementById('pipSizeRange').addEventListener('input', (e) => {
  pipState.size = parseInt(e.target.value, 10);
});
document.getElementById('pipCornerSelect').addEventListener('change', (e) => {
  const val = e.target.value;
  const pad = 28;
  if (val === 'br') { pipState.x = canvas.width - pipState.size - pad; pipState.y = canvas.height - pipState.size - pad; }
  if (val === 'bl') { pipState.x = pad; pipState.y = canvas.height - pipState.size - pad; }
  if (val === 'tr') { pipState.x = canvas.width - pipState.size - pad; pipState.y = pad; }
  if (val === 'tl') { pipState.x = pad; pipState.y = pad; }
});

// 播放与进度条控制
const playPauseBtn = document.getElementById('playPauseBtn');
const seekBar = document.getElementById('seekBar');
const timeDisplay = document.getElementById('timeDisplay');

playPauseBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  playPauseBtn.textContent = isPlaying ? '⏸ 暂停' : '▶ 播放';
  if (hasRealScreenVideo) {
    if (isPlaying) screenVideo.play().catch(()=>{});
    else screenVideo.pause();
  }
});

seekBar.addEventListener('input', (e) => {
  currentTime = parseFloat(e.target.value);
  if (hasRealScreenVideo) screenVideo.currentTime = currentTime;
});

function drawMosaicRect(ctx, x, y, w, h) {
  const rx = Math.min(x, x + w);
  const ry = Math.min(y, y + h);
  const rw = Math.abs(w);
  const rh = Math.abs(h);
  const tile = 14;
  for (let py = ry; py < ry + rh; py += tile) {
    for (let px = rx; px < rx + rw; px += tile) {
      const shade = ((Math.floor(px / tile) + Math.floor(py / tile)) % 2 === 0) ? '#334155' : '#64748b';
      ctx.fillStyle = shade;
      ctx.fillRect(px, py, Math.min(tile, rx + rw - px), Math.min(tile, ry + rh - py));
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(rx, ry, rw, rh);
}

function drawArrow(ctx, x1, y1, x2, y2) {
  const headlen = 16;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = '#f43f5e';
  ctx.fillStyle = '#f43f5e';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headlen * Math.cos(angle - Math.PI / 6), y2 - headlen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headlen * Math.cos(angle + Math.PI / 6), y2 - headlen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

let lastTick = performance.now();

function renderLoop(now) {
  const dt = ((now - lastTick) / 1000) * playbackSpeed;
  lastTick = now;

  if (isPlaying) {
    currentTime += dt;
    if (currentTime > totalDuration) {
      currentTime = 0;
      if (hasRealScreenVideo) screenVideo.currentTime = 0;
    }
    seekBar.value = currentTime;
  }
  timeDisplay.textContent = `${currentTime.toFixed(1)}s / ${totalDuration.toFixed(1)}s`;

  // 计算当前激活的缩放动效
  const activeZoom = zoomEffects.find(z => currentTime >= z.start && currentTime <= z.start + z.duration);
  let scale = 1.0;
  let focusX = 0.5;
  let focusY = 0.5;
  let tiltDeg = 0;

  const enable3D = document.getElementById('enable3DToggle').checked;
  const maxTilt = parseFloat(document.getElementById('tiltRange').value);

  if (activeZoom) {
    const progress = (currentTime - activeZoom.start) / activeZoom.duration;
    const ease = progress < 0.2 ? (progress / 0.2) : (progress > 0.8 ? (1 - progress) / 0.2 : 1);
    scale = 1 + (activeZoom.scale - 1) * Math.max(0, Math.min(1, ease));
    focusX = activeZoom.cx;
    focusY = activeZoom.cy;
    if (enable3D) {
      tiltDeg = maxTilt * Math.max(0, Math.min(1, ease));
    }
  }

  latestRenderTransform = { scale, focusX, focusY };

  // 3D 空间变换透视应用
  if (enable3D && tiltDeg > 0.2) {
    const rotY = ((0.5 - focusX) * tiltDeg * 1.4).toFixed(2);
    const rotX = ((focusY - 0.5) * tiltDeg * 1.1).toFixed(2);
    canvas.style.transform = `perspective(1100px) rotateY(${rotY}deg) rotateX(${rotX}deg)`;
  } else {
    canvas.style.transform = 'perspective(1100px) rotateY(0deg) rotateX(0deg)';
  }

  // 核心功能点3修复：100%还原第一版色彩鲜明的 macOS 渐变壁纸
  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  if (bgSettings.theme === 'gradient-sonoma') {
    grad.addColorStop(0, '#4f46e5');
    grad.addColorStop(0.4, '#7c3aed');
    grad.addColorStop(1, '#db2777');
  } else if (bgSettings.theme === 'gradient-ventura') {
    grad.addColorStop(0, '#ea580c');
    grad.addColorStop(0.5, '#f43f5e');
    grad.addColorStop(1, '#e11d48');
  } else if (bgSettings.theme === 'gradient-monterey') {
    grad.addColorStop(0, '#0284c7');
    grad.addColorStop(0.5, '#0d9488');
    grad.addColorStop(1, '#1e1b4b');
  } else {
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(0.6, '#1e293b');
    grad.addColorStop(1, '#334155');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  const cx = focusX * canvas.width;
  const cy = focusY * canvas.height;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  const pad = bgSettings.padding;
  const winW = canvas.width - pad * 2;
  const winH = canvas.height - pad * 2;
  const rad = bgSettings.radius;

  // 录屏窗口阴影与圆角底框
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 30;
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(pad, pad, winW, winH, rad);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  const currentClip = videoClips.find(c => currentTime >= c.start && currentTime <= c.end);

  if (currentClip) {
    if (hasRealScreenVideo && screenVideo.readyState >= 2) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(pad, pad, winW, winH, rad);
      ctx.clip();
      if (regionMeta) {
        const sx = regionMeta.nx * screenVideo.videoWidth;
        const sy = regionMeta.ny * screenVideo.videoHeight;
        const sw = regionMeta.nw * screenVideo.videoWidth;
        const sh = regionMeta.nh * screenVideo.videoHeight;
        ctx.drawImage(screenVideo, sx, sy, sw, sh, pad, pad, winW, winH);
      } else {
        ctx.drawImage(screenVideo, pad, pad, winW, winH);
      }
      ctx.restore();
    } else {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(pad + 20, pad + 40, 220, winH - 60);
      ctx.fillStyle = '#334155';
      ctx.fillRect(pad + 260, pad + 40, winW - 280, 140);
      ctx.fillStyle = '#6366f1';
      ctx.fillRect(pad + 280, pad + 64, 200, 36);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('录屏大师 · 3D缩放与常规剪辑', pad + 292, pad + 88);

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(pad + 260, pad + 200, winW - 280, 190);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px monospace';
      ctx.fillText('机密数据区: 0x8821-4921 (可用马赛克工具进行遮挡)', pad + 280, pad + 245);
      ctx.fillText('核心指标数据: 增长 +240% (可用画圈与箭头标注)', pad + 280, pad + 285);
    }
  } else {
    ctx.fillStyle = '#020617';
    ctx.beginPath();
    ctx.roundRect(pad, pad, winW, winH, rad);
    ctx.fill();
    ctx.fillStyle = '#64748b';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('（该片段已被剪除）', canvas.width / 2, canvas.height / 2);
    ctx.textAlign = 'start';
  }

  // 聚光灯遮罩（在主画面坐标系内）
  const spotlights = annotations.filter(a => a.type === 'spotlight');
  if (spotlights.length > 0) {
    ctx.save();
    ctx.fillStyle = 'rgba(2, 6, 23, 0.72)';
    ctx.beginPath();
    ctx.rect(pad, pad, winW, winH);
    spotlights.forEach(s => {
      const p1x = pad + s.nx1 * winW;
      const p1y = pad + s.ny1 * winH;
      const p2x = pad + s.nx2 * winW;
      const p2y = pad + s.ny2 * winH;
      const r = Math.max(30, Math.hypot(p2x - p1x, p2y - p1y));
      ctx.moveTo(p1x + r, p1y);
      ctx.arc(p1x, p1y, r, 0, Math.PI * 2, true);
    });
    ctx.fill('evenodd');
    ctx.restore();
  }

  // 标注绘制（核心功能点4修复：严格贴合主画面像素，与鼠标点击位置100%对齐）
  annotations.forEach(a => {
    const x1 = pad + a.nx1 * winW;
    const y1 = pad + a.ny1 * winH;
    const x2 = pad + a.nx2 * winW;
    const y2 = pad + a.ny2 * winH;

    if (a.type === 'mosaic') {
      drawMosaicRect(ctx, x1, y1, x2 - x1, y2 - y1);
    } else if (a.type === 'arrow') {
      drawArrow(ctx, x1, y1, x2, y2);
    } else if (a.type === 'circle') {
      const rx = (x1 + x2) / 2;
      const ry = (y1 + y2) / 2;
      const rw = Math.max(12, Math.abs(x2 - x1) / 2);
      const rh = Math.max(12, Math.abs(y2 - y1) / 2);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(rx, ry, rw, rh, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  // 鼠标与点击特效（核心功能点1修复：单鼠标控制）
  const cursorMode = document.getElementById('cursorModeSelect').value;

  if (cursorMode !== 'hide_all') {
    const curEvt = mouseTrail.reduce((prev, curr) =>
      Math.abs(curr.timeOffset - currentTime) < Math.abs(prev.timeOffset - currentTime) ? curr : prev
    , mouseTrail[0]);

    if (curEvt) {
      const mx = pad + curEvt.nx * winW;
      const my = pad + curEvt.ny * winH;

      const clickEffect = document.getElementById('clickEffectSelect').value;
      mouseTrail.filter(e => e.eventType === 'click' && currentTime >= e.timeOffset && currentTime - e.timeOffset < 0.7).forEach(c => {
        const p = (currentTime - c.timeOffset) / 0.7;
        const cxPos = pad + c.nx * winW;
        const cyPos = pad + c.ny * winH;
        ctx.save();
        if (clickEffect === 'ripple') {
          ctx.strokeStyle = `rgba(99, 102, 241, ${1 - p})`;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(cxPos, cyPos, 10 + p * 42, 0, Math.PI * 2);
          ctx.stroke();
        } else if (clickEffect === 'pulse') {
          ctx.fillStyle = `rgba(244, 63, 94, ${0.55 * (1 - p)})`;
          ctx.beginPath();
          ctx.arc(cxPos, cyPos, 8 + p * 35, 0, Math.PI * 2);
          ctx.fill();
        } else {
          for (let i = 0; i < 6; i++) {
            const ang = (Math.PI * 2 * i) / 6;
            ctx.fillStyle = `rgba(250, 204, 21, ${1 - p})`;
            ctx.beginPath();
            ctx.arc(cxPos + Math.cos(ang) * p * 36, cyPos + Math.sin(ang) * p * 36, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      });

      const cursorStyle = document.getElementById('cursorStyleSelect').value;
      ctx.save();
      ctx.translate(mx, my);
      if (cursorStyle === 'arrow') {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 22);
        ctx.lineTo(6, 17);
        ctx.lineTo(12, 26);
        ctx.lineTo(15, 24);
        ctx.lineTo(9, 15);
        ctx.lineTo(17, 15);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (cursorStyle === 'hand') {
        ctx.font = '24px sans-serif';
        ctx.fillText('👆', -8, 18);
      } else if (cursorStyle === 'paw') {
        ctx.font = '24px sans-serif';
        ctx.fillText('🐾', -10, 14);
      } else if (cursorStyle === 'neon') {
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#f43f5e';
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  ctx.restore();

  // 双路人像小窗（始终在最上层自由避让）
  if (pipState.show) {
    ctx.save();
    const r = pipState.size / 2;
    const centerX = pipState.x + r;
    const centerY = pipState.y + r;

    ctx.beginPath();
    ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
    ctx.clip();

    if (hasRealCamVideo && camVideo.readyState >= 2) {
      ctx.drawImage(camVideo, pipState.x, pipState.y, pipState.size, pipState.size);
    } else {
      const pGrad = ctx.createLinearGradient(pipState.x, pipState.y, pipState.x + pipState.size, pipState.y + pipState.size);
      pGrad.addColorStop(0, '#312e81');
      pGrad.addColorStop(1, '#1e293b');
      ctx.fillStyle = pGrad;
      ctx.fillRect(pipState.x, pipState.y, pipState.size, pipState.size);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🧑‍💻 人像讲解窗口', centerX, centerY - 4);
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('(可自由拖拽避让)', centerX, centerY + 14);
    }
    ctx.restore();

    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  requestAnimationFrame(renderLoop);
}

renderTracks();
syncZoomControls();
renderAnnotationList();
initMedia();
requestAnimationFrame(renderLoop);
