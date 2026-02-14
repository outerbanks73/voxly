// Voxly - Offscreen Audio Capture
// Captures tab audio via MediaRecorder and streams WebM/Opus chunks to
// Deepgram WebSocket. Requests both audio+video from tabCapture (required
// by Chrome on macOS for audio to flow), then records audio-only.
// Routes captured audio back to speakers so the user can still hear the tab.

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

let mediaRecorder = null;
let socket = null;
let segments = [];
let tabStream = null;
let outputAudioContext = null; // Routes tab audio back to speakers

// Relay logs to background/sidepanel console
function log(msg) {
  console.log(msg);
  chrome.runtime.sendMessage({ action: 'offscreenLog', msg }).catch(() => {});
}

// Signal ready
chrome.runtime.sendMessage({ action: 'offscreenReady' });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.action === 'startCapture') {
    startCapture(message.streamId, message.deepgramKey)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        log('[Voxly Offscreen] startCapture ERROR: ' + e.message);
        sendResponse({ error: e.message });
      });
    return true;
  }

  if (message.action === 'stopCapture') {
    stopCapture().then(result => {
      sendResponse(result);
    });
    return true;
  }
});

async function startCapture(streamId, deepgramKey) {
  // Request BOTH audio and video from tabCapture stream.
  // Chrome on macOS can return a valid-looking but silent audio-only stream;
  // including video constraints forces the full capture pipeline to activate.
  // See: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
  tabStream = await navigator.mediaDevices.getUserMedia({
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
  const audioTracks = tabStream.getAudioTracks();
  const videoTracks = tabStream.getVideoTracks();
  log(`[Voxly Offscreen] Got stream — ${audioTracks.length} audio, ${videoTracks.length} video tracks, audio enabled=${audioTracks[0]?.enabled}, readyState=${audioTracks[0]?.readyState}`);

  // Route captured audio back to speakers — getUserMedia with chromeMediaSource:'tab'
  // mutes the tab by default (Chromium issue #40885587). This restores playback.
  outputAudioContext = new AudioContext();
  const source = outputAudioContext.createMediaStreamSource(tabStream);
  source.connect(outputAudioContext.destination);
  log(`[Voxly Offscreen] Audio routed to speakers (AudioContext state=${outputAudioContext.state})`);

  // Create audio-only stream for Deepgram (we don't need the video)
  const audioOnlyStream = new MediaStream(audioTracks);

  // Connect to Deepgram WebSocket — no encoding params, Deepgram auto-detects WebM/Opus
  const wsUrl = `${DEEPGRAM_WS_URL}?model=nova-2&interim_results=true&diarize=true`;
  socket = new WebSocket(wsUrl, ['token', deepgramKey]);
  segments = [];

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Deepgram WebSocket timed out')), 10000);
    socket.onopen = () => {
      clearTimeout(timeout);
      log('[Voxly Offscreen] Deepgram WebSocket connected');
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Deepgram WebSocket connection failed'));
    };
  });

  // Handle Deepgram responses
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'Results') {
      const transcript = data.channel?.alternatives?.[0]?.transcript || '';
      log(`[Voxly Offscreen] Result: is_final=${data.is_final} text="${transcript.substring(0, 80)}"`);

      if (transcript && data.is_final) {
        const segment = {
          text: transcript,
          start: data.start,
          end: data.start + data.duration
        };
        segments.push(segment);
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'realtimeSegment',
          segment,
          allSegments: segments
        }).catch(() => {});
      } else if (transcript) {
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'realtimeInterim',
          text: transcript
        }).catch(() => {});
      }
    } else {
      log(`[Voxly Offscreen] Deepgram msg type=${data.type}`);
    }
  };

  socket.onerror = () => log('[Voxly Offscreen] WebSocket error');
  socket.onclose = (event) => log(`[Voxly Offscreen] WebSocket closed — code=${event.code}`);

  // MediaRecorder on audio-only stream — sends WebM/Opus chunks to Deepgram every 250ms
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  log(`[Voxly Offscreen] MediaRecorder mimeType: ${mimeType}`);

  mediaRecorder = new MediaRecorder(audioOnlyStream, { mimeType });

  let chunkCount = 0;
  mediaRecorder.ondataavailable = async (event) => {
    if (event.data.size > 0 && socket?.readyState === WebSocket.OPEN) {
      const buffer = await event.data.arrayBuffer();
      socket.send(buffer);
      if (chunkCount < 5 || chunkCount % 20 === 0) {
        log(`[Voxly Offscreen] Chunk ${chunkCount}: ${buffer.byteLength} bytes`);
      }
      chunkCount++;
    }
  };

  mediaRecorder.onerror = (e) => log(`[Voxly Offscreen] MediaRecorder error: ${e.error?.message || e}`);

  mediaRecorder.start(250); // 250ms chunks for near-real-time
  log('[Voxly Offscreen] MediaRecorder started — streaming to Deepgram');
}

async function stopCapture() {
  // Stop MediaRecorder
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    // Wait for final ondataavailable to fire
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  mediaRecorder = null;

  // Close audio output routing
  if (outputAudioContext) {
    outputAudioContext.close().catch(() => {});
    outputAudioContext = null;
  }

  // Stop all tracks (audio + video)
  if (tabStream) {
    tabStream.getTracks().forEach(t => t.stop());
    tabStream = null;
  }

  // Signal end and wait for final Deepgram results
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(new ArrayBuffer(0)); // Close signal
    await new Promise(resolve => setTimeout(resolve, 1500));
    socket.close();
  }
  socket = null;

  log(`[Voxly Offscreen] Capture stopped — ${segments.length} segments`);

  const result = { segments: [...segments] };
  segments = [];
  return result;
}
