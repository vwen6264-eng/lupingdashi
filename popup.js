let selectedMode = 'tab';
let timerInterval = null;

const modeBtns = document.querySelectorAll('.mode-btn');
const camToggle = document.getElementById('camToggle');
const micToggle = document.getElementById('micToggle');
for (const id of ['micVolume', 'screenVolume']) {
  const input = document.getElementById(id);
  input.addEventListener('input', () => { document.getElementById(id + 'Value').textContent = input.value + '%'; });
}
function audioLevels() {
  return { micVolume: Number(document.getElementById('micVolume').value) / 100, screenVolume: Number(document.getElementById('screenVolume').value) / 100 };
}
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const openEditorBtn = document.getElementById('openEditorBtn');
const setupView = document.getElementById('setupView');
const recordingView = document.getElementById('recordingView');
const timerText = document.getElementById('timerText');
const modeInfo = document.getElementById('modeInfo');

modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
    if (selectedMode === 'region') {
      startBtn.textContent = '✂️ 框选网页自定义区域';
    } else {
      startBtn.textContent = '🔴 开始录制';
    }
  });
});

function formatSeconds(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function renderState(state) {
  if (state && state.isRecording) {
    setupView.classList.add('hidden');
    recordingView.classList.remove('hidden');
    const modeMap = { tab: '当前标签页', screen: '全屏/窗口', region: '自定义区域' };
    modeInfo.textContent = `模式：${modeMap[state.mode] || '标签页'}`;
    clearInterval(timerInterval);
    const updateTimer = () => {
      const elapsed = Math.max(0, (Date.now() - state.startTime) / 1000);
      timerText.textContent = formatSeconds(elapsed);
    };
    updateTimer();
    timerInterval = setInterval(updateTimer, 500);
  } else {
    setupView.classList.remove('hidden');
    recordingView.classList.add('hidden');
    clearInterval(timerInterval);
  }
}

chrome.runtime.sendMessage({ type: 'GET_STATE' }, renderState);

startBtn.addEventListener('click', async () => {
  if (micToggle.checked) {
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' });
      if (permission.state !== 'granted') {
        chrome.tabs.create({ url: chrome.runtime.getURL('microphone.html') });
        return;
      }
    } catch (err) {
      alert('无法检查麦克风权限：' + err.message);
      return;
    }
  }
  if (selectedMode === 'region') {
    chrome.runtime.sendMessage({
      type: 'START_REGION_SELECT',
      cameraEnabled: camToggle.checked,
      microphoneEnabled: micToggle.checked,
      ...audioLevels()
    }, (res) => {
      if (res && res.error) {
        alert(res.error);
      } else {
        window.close();
      }
    });
    return;
  }

  chrome.runtime.sendMessage({
    type: 'START_RECORDING',
    mode: selectedMode,
    cameraEnabled: camToggle.checked,
    microphoneEnabled: micToggle.checked,
    ...audioLevels()
  }, (res) => {
    if (res && res.ok) {
      renderState(res.state);
    } else {
      alert((res && res.error) || '录制启动失败，请重试。');
    }
  });
});

stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true;
  stopBtn.textContent = '正在保存录制…';
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (res) => {
    if (res?.ok) window.close();
    else {
      alert(res?.error || '保存录制失败，请检查浏览器存储空间。');
      stopBtn.disabled = false;
      renderState({ isRecording: false });
    }
  });
});

openEditorBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
});

document.getElementById('openPrompterBtn').addEventListener('click', () => {
  chrome.windows.create({ url: chrome.runtime.getURL('prompter.html'), type: 'popup', width: 600, height: 500 });
});
