const editor = document.getElementById('editor');
const reader = document.getElementById('reader');
const playBtn = document.getElementById('playBtn');
const editBtn = document.getElementById('editBtn');
const speed = document.getElementById('speed');
const fontSize = document.getElementById('fontSize');
const speedValue = document.getElementById('speedValue');
const fontSizeValue = document.getElementById('fontSizeValue');
const app = document.getElementById('app');
const pinBtn = document.getElementById('pinBtn');
const hint = document.getElementById('hint');
let pipWindow = null;
let frameWindow = window;
let frameId = null;
let playing = false;
let lastFrame = null;
let scrollPosition = 0;
let saveTimer;

chrome.storage.local.get('prompterSettings', ({ prompterSettings }) => {
  if (!prompterSettings) return;
  editor.value = prompterSettings.text || '';
  speed.value = prompterSettings.speed ?? 35;
  fontSize.value = prompterSettings.fontSize ?? 32;
  updateSettings();
});

function updateSettings() {
  speedValue.textContent = speed.value;
  fontSizeValue.textContent = fontSize.value;
  reader.style.fontSize = fontSize.value + 'px';
}

function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({
    prompterSettings: { text: editor.value, speed: speed.value, fontSize: fontSize.value }
  }), 300);
}

for (const input of [editor, speed, fontSize]) {
  input.addEventListener('input', () => { updateSettings(); saveSettings(); });
}

function setPlaying(value) {
  if (frameId !== null) frameWindow.cancelAnimationFrame(frameId);
  frameId = null;
  playing = value;
  lastFrame = null;
  playBtn.textContent = playing ? '暂停' : '继续';
  if (playing) frameId = frameWindow.requestAnimationFrame(tick);
}

function tick(now) {
  if (!playing) return;
  if (lastFrame !== null) {
    scrollPosition += Number(speed.value) * (now - lastFrame) / 1000;
    reader.scrollTop = scrollPosition;
    if (scrollPosition >= reader.scrollHeight - reader.clientHeight) {
      setPlaying(false);
      return;
    }
  }
  lastFrame = now;
  frameId = frameWindow.requestAnimationFrame(tick);
}

playBtn.addEventListener('click', () => {
  if (!editor.classList.contains('hidden')) {
    reader.textContent = editor.value;
    editor.classList.add('hidden');
    reader.classList.remove('hidden');
    reader.scrollTop = 0;
    scrollPosition = 0;
  }
  setPlaying(!playing);
});

editBtn.addEventListener('click', () => {
  setPlaying(false);
  playBtn.textContent = '开始提词';
  reader.classList.add('hidden');
  editor.classList.remove('hidden');
  editor.focus();
});

document.getElementById('resetBtn').addEventListener('click', () => {
  scrollPosition = 0;
  reader.scrollTop = 0;
  lastFrame = null;
});

reader.addEventListener('scroll', () => {
  if (!playing) scrollPosition = reader.scrollTop;
});

function onKeyDown(event) {
  if (event.code === 'Space' && editor.classList.contains('hidden') && event.target.tagName !== 'INPUT') {
    event.preventDefault();
    setPlaying(!playing);
  }
}
document.addEventListener('keydown', onKeyDown);

pinBtn.addEventListener('click', async () => {
  if (pipWindow) {
    pipWindow.close();
    return;
  }
  if (!('documentPictureInPicture' in window)) {
    hint.textContent = '当前浏览器不支持置顶提词器，请使用支持文档画中画的 Chrome。';
    return;
  }
  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({ width: 600, height: 500 });
    const style = pipWindow.document.createElement('style');
    style.textContent = document.querySelector('style').textContent;
    pipWindow.document.head.appendChild(style);
    pipWindow.document.body.appendChild(app);
    pipWindow.document.addEventListener('keydown', onKeyDown);
    if (frameId !== null) frameWindow.cancelAnimationFrame(frameId);
    frameWindow = pipWindow;
    frameId = null;
    lastFrame = null;
    if (playing) frameId = frameWindow.requestAnimationFrame(tick);
    pinBtn.textContent = '退出置顶';
    hint.textContent = '提词器已置顶，可在录制时调整。录制整个屏幕时可能被录入画面。';
    pipWindow.addEventListener('pagehide', () => {
      if (frameId !== null) frameWindow.cancelAnimationFrame(frameId);
      frameId = null;
      document.body.appendChild(app);
      frameWindow = window;
      pipWindow = null;
      lastFrame = null;
      if (playing) frameId = frameWindow.requestAnimationFrame(tick);
      pinBtn.textContent = '置顶提词器';
      hint.textContent = '点击“置顶提词器”，录制时可继续调整；播放时按空格暂停或继续。';
    }, { once: true });
  } catch (err) {
    pipWindow = null;
    hint.textContent = '无法打开置顶窗口：' + err.message;
  }
});
