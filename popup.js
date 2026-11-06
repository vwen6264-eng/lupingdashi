let selectedMode = 'tab';
let timerInterval = null;

const modeBtns = document.querySelectorAll('.mode-btn');
const camToggle = document.getElementById('camToggle');
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

startBtn.addEventListener('click', () => {
  if (selectedMode === 'region') {
    chrome.runtime.sendMessage({
      type: 'START_REGION_SELECT',
      cameraEnabled: camToggle.checked
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
    cameraEnabled: camToggle.checked
  }, (res) => {
    if (res && res.ok) {
      renderState(res.state);
    }
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, () => {
    window.close();
  });
});

openEditorBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
});
