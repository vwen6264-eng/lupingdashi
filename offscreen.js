let mediaRecorder = null;
let camRecorder = null;
let activeStreams = [];
let playbackContext = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ScreenMasterDB', 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveBlob(key, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START') {
    startCapture(msg).then(sendResponse);
    return true;
  } else if (msg.type === 'OFFSCREEN_STOP') {
    stopCapture().then(() => sendResponse({ ok: true }), err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function startCapture({ streamId, mode, cameraEnabled, microphoneEnabled, micVolume = 1, screenVolume = 1 }) {
  try {
    let screenStream = null;
    if (streamId && (mode === 'tab' || mode === 'region')) {
      screenStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
            maxWidth: 3840,
            maxHeight: 2160,
            maxFrameRate: 30
          }
        }
      });
    } else {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true
      });
    }

    activeStreams.push(screenStream);
    let recordingStream = screenStream;
    if (microphoneEnabled || screenStream.getAudioTracks().length) {
      let micStream;
      if (microphoneEnabled) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (err) {
        throw new Error('无法使用麦克风，请检查连接、系统权限和浏览器权限：' + err.message);
      }
      activeStreams.push(micStream);
      }
      playbackContext = new AudioContext();
      if (playbackContext.state !== 'running') await playbackContext.resume();
      if (playbackContext.state !== 'running') throw new Error('音频混音未能启动，请检查浏览器音频权限');
      const mixedAudio = playbackContext.createMediaStreamDestination();
      if (micStream) {
        const gain = playbackContext.createGain();
        gain.gain.value = micVolume;
        playbackContext.createMediaStreamSource(micStream).connect(gain).connect(mixedAudio);
      }
      if (screenStream.getAudioTracks().length) {
        const screenAudio = playbackContext.createMediaStreamSource(screenStream);
        const gain = playbackContext.createGain();
        gain.gain.value = screenVolume;
        screenAudio.connect(gain).connect(mixedAudio);
        if (mode !== 'screen') screenAudio.connect(playbackContext.destination);
      }
      recordingStream = new MediaStream([...screenStream.getVideoTracks(), ...mixedAudio.stream.getAudioTracks()]);
    }
    const chunks = [];
    mediaRecorder = new MediaRecorder(recordingStream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 12000000, audioBitsPerSecond: 192000 });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        chrome.runtime.sendMessage({ type: 'CHUNK_SAVED', count: chunks.length }).catch(() => {});
      }
    };
    mediaRecorder.saved = new Promise((resolve, reject) => {
      mediaRecorder.onstop = () => saveBlob('latestScreenVideo', new Blob(chunks, { type: 'video/webm' })).then(resolve, reject);
      mediaRecorder.onerror = event => reject(event.error || new Error('录制失败'));
    });
    mediaRecorder.start(500);
    const startTime = Date.now();
    

    if (cameraEnabled) {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        activeStreams.push(camStream);
        const camChunks = [];
        camRecorder = new MediaRecorder(camStream, { mimeType: 'video/webm;codecs=vp8' });
        camRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) camChunks.push(e.data);
        };
        camRecorder.saved = new Promise((resolve, reject) => {
          camRecorder.onstop = () => saveBlob('latestCameraVideo', new Blob(camChunks, { type: 'video/webm' })).then(resolve, reject);
          camRecorder.onerror = event => reject(event.error || new Error('摄像头录制失败'));
        });
        camRecorder.start(500);
      } catch (camErr) {
        console.warn('未检测到外接摄像头，可改用手机拍摄导入剪映拼合:', camErr);
      }
    }
    return { ok: true, startTime };
  } catch (err) {
    console.error('录制启动失败:', err);
    await stopCapture().catch(() => {});
    return { ok: false, error: err.message };
  }
}

async function stopCapture() {
  const pending = [];
  if (mediaRecorder?.saved) {
    pending.push(mediaRecorder.saved);
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }
  if (camRecorder?.saved) {
    pending.push(camRecorder.saved);
    if (camRecorder.state !== 'inactive') camRecorder.stop();
  }
  try {
    await Promise.all(pending);
  } finally {
    activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
    activeStreams = [];
    if (playbackContext) {
      await playbackContext.close();
      playbackContext = null;
    }
    mediaRecorder = null;
    camRecorder = null;
  }
}
