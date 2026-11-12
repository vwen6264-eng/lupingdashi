document.getElementById('allow').addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    status.textContent = '麦克风授权成功。请返回扩展弹窗开始录制。';
  } catch (err) {
    status.textContent = '无法使用麦克风：' + err.message + '。请检查设备连接、系统权限和浏览器的网站设置后重试。';
  }
});
