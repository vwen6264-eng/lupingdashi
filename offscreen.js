let mediaRecorder = null;
let camRecorder = null;
let activeStreams = [];

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') {
    startCapture(msg);
  } else if (msg.type === 'OFFSCREEN_STOP') {
    stopCapture();
  }
});

async function startCapture({ streamId, mode, cameraEnabled }) {
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
            chromeMediaSourceId: streamId
          }
        }
      });
    } else {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'never' // 核心修复：指示浏览器截屏底层不录入系统鼠标光标，只由编辑器自定义光标渲染
        },
        audio: true
      });
    }

    activeStreams.push(screenStream);
    const chunks = [];
    mediaRecorder = new MediaRecorder(screenStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        chrome.runtime.sendMessage({ type: 'CHUNK_SAVED', count: chunks.length }).catch(() => {});
      }
    };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      await saveBlob('latestScreenVideo', blob);
    };
    mediaRecorder.start(500);

    if (cameraEnabled) {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        activeStreams.push(camStream);
        const camChunks = [];
        camRecorder = new MediaRecorder(camStream, { mimeType: 'video/webm;codecs=vp8' });
        camRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) camChunks.push(e.data);
        };
        camRecorder.onstop = async () => {
          const camBlob = new Blob(camChunks, { type: 'video/webm' });
          await saveBlob('latestCameraVideo', camBlob);
        };
        camRecorder.start(500);
      } catch (camErr) {
        console.warn('未检测到外接摄像头，可改用手机拍摄导入剪映拼合:', camErr);
      }
    }
  } catch (err) {
    console.error('录制启动失败:', err);
  }
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (camRecorder && camRecorder.state !== 'inactive') {
    camRecorder.stop();
  }
  activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  activeStreams = [];
}
