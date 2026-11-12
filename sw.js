let recordingState = {
  isRecording: false,
  startTime: 0,
  mode: 'tab',
  cameraEnabled: false,
  region: null,
  chunksCount: 0,
  mouseEvents: []
};

chrome.commands.onCommand.addListener(command => {
  if (command === 'open-prompter') {
    chrome.windows.create({ url: chrome.runtime.getURL('prompter.html'), type: 'popup', width: 600, height: 500 });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse(recordingState);
    return true;
  }

  if (msg.type === 'MOUSE_EVENT' && recordingState.isRecording && recordingState.mode !== 'screen' && sender.tab?.id === recordingState.tabId) {
    recordingState.mouseEvents.push({
      ...msg.payload,
      timeOffset: Math.max(0, ((msg.payload.recordedAt || Date.now()) - recordingState.startTime) / 1000)
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
        await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_REGION_SELECTOR', cameraEnabled: msg.cameraEnabled, microphoneEnabled: msg.microphoneEnabled, micVolume: msg.micVolume, screenVolume: msg.screenVolume });
        sendResponse({ ok: true });
      } catch (err) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_REGION_SELECTOR', cameraEnabled: msg.cameraEnabled, microphoneEnabled: msg.microphoneEnabled, micVolume: msg.micVolume, screenVolume: msg.screenVolume });
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
      microphoneEnabled: msg.microphoneEnabled,
      micVolume: msg.micVolume, screenVolume: msg.screenVolume,
      tabId: sender.tab ? sender.tab.id : null
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'START_RECORDING') {
    startRecordingFlow({
      mode: msg.mode || 'tab',
      region: msg.region || null,
      cameraEnabled: !!msg.cameraEnabled,
      microphoneEnabled: !!msg.microphoneEnabled,
      micVolume: msg.micVolume, screenVolume: msg.screenVolume
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

async function startRecordingFlow({ mode, region, cameraEnabled, microphoneEnabled, micVolume, screenVolume, tabId }) {
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
        throw new Error('无法录制当前标签页，请切换到普通网页后重试：' + e.message);
      }
    }

    // 扩展重载后，已打开的网页不会自动重新注入内容脚本。
    if (mode !== 'screen' && streamId && targetTabId) {
      try {
        await chrome.tabs.sendMessage(targetTabId, { type: 'PING_CONTENT' });
      } catch {
        try {
          await chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ['content.js'] });
        } catch (err) {
          throw new Error('无法在当前页面采集鼠标轨迹，请切换到普通网页并刷新后重试：' + err.message);
        }
      }
    }

    const result = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START', streamId, mode, cameraEnabled, microphoneEnabled, micVolume, screenVolume
    });
    if (!result || !result.ok) throw new Error((result && result.error) || '录制启动失败');

    // 在页面注入隐藏原生鼠标光标的样式规则（防止录制时把原鼠标也录进画面导致双鼠标）
    if (targetTabId && mode !== 'screen') {
      chrome.scripting.insertCSS({
        target: { tabId: targetTabId },
        css: '* { cursor: none !important; }'
      }).catch(() => {});
    }

    recordingState = {
      isRecording: true,
      startTime: result.startTime,
      mode,
      tabId: targetTabId,
      nativeCursor: mode === 'screen',
      cameraEnabled: !!cameraEnabled,
      microphoneEnabled: !!microphoneEnabled,
      region: region || null,
      chunksCount: 0,
      mouseEvents: []
    };

    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

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
    if (recordingState.tabId) {
      chrome.scripting.removeCSS({
        target: { tabId: recordingState.tabId },
        css: '* { cursor: none !important; }'
      }).catch(() => {});
    }
  });

  await chrome.storage.local.set({
    lastRecordingMeta: {
      duration: Math.max(1, (Date.now() - recordingState.startTime) / 1000),
      mode: recordingState.mode,
      nativeCursor: recordingState.nativeCursor,
      cameraEnabled: recordingState.cameraEnabled,
      region: recordingState.region,
      mouseEvents: recordingState.mouseEvents,
      timestamp: Date.now()
    }
  });

  const result = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
  if (!result || !result.ok) return { ok: false, error: result?.error || '保存录制失败' };
  await chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });

  return { ok: true };
}
