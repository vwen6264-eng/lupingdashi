(function() {
  if (window.__screenMasterInjected) return;
  window.__screenMasterInjected = true;

  let lastMove = 0;
  window.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMove < 30) return;
    lastMove = now;
    chrome.runtime.sendMessage({
      type: 'MOUSE_EVENT',
      payload: {
        eventType: 'move',
        nx: e.clientX / window.innerWidth,
        ny: e.clientY / window.innerHeight,
        clientX: e.clientX,
        clientY: e.clientY
      }
    }).catch(() => {});
  }, { passive: true });

  window.addEventListener('mousedown', (e) => {
    chrome.runtime.sendMessage({
      type: 'MOUSE_EVENT',
      payload: {
        eventType: 'click',
        nx: e.clientX / window.innerWidth,
        ny: e.clientY / window.innerHeight,
        clientX: e.clientX,
        clientY: e.clientY
      }
    }).catch(() => {});
  }, { passive: true });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SHOW_REGION_SELECTOR') {
      showRegionOverlay(!!msg.cameraEnabled);
      sendResponse({ ok: true });
    }
  });

  function showRegionOverlay(cameraEnabled) {
    const existing = document.getElementById('__sm_region_overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = '__sm_region_overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:2147483647;cursor:crosshair;user-select:none;font-family:system-ui,-apple-system,sans-serif;';

    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#0f172a;color:#f8fafc;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;border:1px solid rgba(99,102,241,0.5);box-shadow:0 10px 25px rgba(0,0,0,0.4);pointer-events:none;';
    tip.textContent = '拖拽鼠标框选自定义录制区域 · 按 ESC 取消';
    overlay.appendChild(tip);

    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px solid #6366f1;background:rgba(99,102,241,0.12);box-shadow:0 0 0 9999px rgba(15,23,42,0.55);display:none;pointer-events:none;';
    overlay.appendChild(box);

    const badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;background:#6366f1;color:#fff;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;display:none;pointer-events:none;';
    overlay.appendChild(badge);

    let startX = 0, startY = 0, dragging = false;

    const onMouseDown = (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      box.style.display = 'block';
      badge.style.display = 'block';
    };

    const onMouseMove = (e) => {
      if (!dragging) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      box.style.width = w + 'px';
      box.style.height = h + 'px';
      badge.style.left = x + 'px';
      badge.style.top = Math.max(8, y - 28) + 'px';
      badge.textContent = `${Math.round(w)} × ${Math.round(h)} px`;
    };

    const onMouseUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      cleanup();

      if (w < 40 || h < 40) return;

      chrome.runtime.sendMessage({
        type: 'REGION_SELECTED',
        cameraEnabled,
        region: {
          nx: x / window.innerWidth,
          ny: y / window.innerHeight,
          nw: w / window.innerWidth,
          nh: h / window.innerHeight,
          pxWidth: Math.round(w),
          pxHeight: Math.round(h)
        }
      });
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') cleanup();
    };

    function cleanup() {
      window.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    }

    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('mousemove', onMouseMove);
    overlay.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
  }
})();
