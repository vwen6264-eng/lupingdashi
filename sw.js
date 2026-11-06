let recordingState = {
  isRecording: false,
  startTime: 0,
  mode: 'tab',
  cameraEnabled: false,
  region: null,
  chunksCount: 0,
  mouseEvents: []
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse(recordingState);
    return true;
  }

  if (msg.type === 'MOUSE_EVENT' && recordingState.isRecording) {
    recordingState.mouseEvents.push({
      ...msg.payload,
      timeOffset: (Date.now() - recordingState.startTime) / 1000
    });
    return true;
  }

  if (msg.type === 'CHUNK_SAVED') {
    recordingState.chunksCount = msg.count;
    return true;
  }

  if (msg.type === 'START_REGION_SELECT') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.id || tab.url.startsWith('chrome://')) {
        sendResponse({ error: '当前页面为 Chrome 系统页，请切换至普通网页后再框选' });
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_REGION_SELECTOR', cameraEnabled: msg.cameraEnabled });
        sendResponse({ ok: true });
      } catch (err) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_REGION_SELECTOR', cameraEnabled: msg.cameraEnabled });
        sendResponse({ ok: true });
      }
    });
    return true;
  }

  if (msg.type === 'REGION_SELECTED') {
    startRecordingFlow({
      mode: 'region',
      region: msg.region,
      cameraEnabled: msg.cameraEnabled,
      tabId: sender.tab ? sender.tab.id : null
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'START_RECORDING') {
    startRecordingFlow({
      mode: msg.mode || 'tab',
      region: msg.region || null,
      cameraEnabled: !!msg.cameraEnabled
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'STOP_RECORDING') {
    stopRecordingFlow().then(sendResponse);
    return true;
  }
});

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
    justification: '录制视频流并保存到 IndexedDB'
  });
}

async function startRecordingFlow({ mode, region, cameraEnabled, tabId }) {
  try {
    await ensureOffscreenDocument();
    let streamId = null;
    let targetTabId = tabId;

    if (!targetTabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) targetTabId = tabs[0].id;
    }

    if (mode === 'tab' || mode === 'region') {
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
      } catch (e) {
        console.warn('tabCapture fallback to displayMedia:', e);
        streamId = null;
      }
    }

    // 在页面注入隐藏原生鼠标光标的样式规则（防止录制时把原鼠标也录进画面导致双鼠标）
    if (targetTabId) {
      chrome.scripting.insertCSS({
        target: { tabId: targetTabId },
        css: '* { cursor: none !important; }'
      }).catch(() => {});
    }

    recordingState = {
      isRecording: true,
      startTime: Date.now(),
      mode,
      cameraEnabled: !!cameraEnabled,
      region: region || null,
      chunksCount: 0,
      mouseEvents: []
    };

    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      streamId,
      mode,
      region,
      cameraEnabled
    });

    return { ok: true, state: recordingState };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function stopRecordingFlow() {
  recordingState.isRecording = false;
  chrome.action.setBadgeText({ text: '' });

  // 恢复页面正常光标
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      chrome.scripting.removeCSS({
        target: { tabId: tabs[0].id },
        css: '* { cursor: none !important; }'
      }).catch(() => {});
    }
  });

  await chrome.storage.local.set({
    lastRecordingMeta: {
      duration: Math.max(1, (Date.now() - recordingState.startTime) / 1000),
      mode: recordingState.mode,
      cameraEnabled: recordingState.cameraEnabled,
      region: recordingState.region,
      mouseEvents: recordingState.mouseEvents,
      timestamp: Date.now()
    }
  });

  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });

  setTimeout(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
  }, 450);

  return { ok: true };
}
