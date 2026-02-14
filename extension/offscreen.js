// Voxly - Offscreen Audio Capture
// Two-phase design matching Chrome's official tabcapture-recorder sample:
//   Phase 1 (captureTab): getUserMedia immediately on icon click while stream ID is fresh
//   Phase 2 (startRecording): connect to Deepgram + start MediaRecorder when user clicks Record
// Requests both audio+video from tabCapture (Chrome requires both for audio on macOS).
// Routes captured audio back to speakers so the user can still hear the tab.

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

let mediaRecorder = null;
let socket = null;
let segments = [];
let tabStream = null;
let outputAudioContext = null;
let outputSource = null; // Prevent GC of audio routing node

// Relay logs to background/sidepanel console
function log(msg) {
  console.log(msg);
  chrome.runtime.sendMessage({ action: 'offscreenLog', msg }).catch(() => {});
}

// Signal ready
chrome.runtime.sendMessage({ action: 'offscreenReady' });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.action === 'captureTab') {
    captureTab(message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        log('[Voxly Offscreen] captureTab ERROR: ' + e.message);
        sendResponse({ error: e.message });
      });
    return true;
  }

  if (message.action === 'startRecording') {
    startRecording(message.deepgramKey)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        log('[Voxly Offscreen] startRecording ERROR: ' + e.message);
        sendResponse({ error: e.message });
      });
    return true;
  }

  if (message.action === 'stopRecording') {
    stopRecording().then(result => {
      sendResponse(result);
    });
    return true;
  }
});

// Phase 1: Capture tab stream immediately (called on icon click, stream ID is fresh)
async function captureTab(streamId) {
  // Release any previous capture
  if (tabStream) {
    tabStream.getTracks().forEach(t => t.stop());
    tabStream = null;
  }
  if (outputAudioContext) {
    outputAudioContext.close().catch(() => {});
    outputAudioContext = null;
    outputSource = null;
  }

  // Request BOTH audio and video — audio-only getUserMedia can return a valid-looking
  // but silent stream on Chrome/macOS. Every official Chrome sample includes video.
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
  log(`[Voxly Offscreen] Captured tab — ${audioTracks.length} audio, ${videoTracks.length} video, enabled=${audioTracks[0]?.enabled}, readyState=${audioTracks[0]?.readyState}`);

  // Route captured audio back to speakers — getUserMedia with chromeMediaSource:'tab'
  // mutes the tab by default (Chromium issue #40885587). This restores playback.
  outputAudioContext = new AudioContext();
  outputSource = outputAudioContext.createMediaStreamSource(tabStream);
  outputSource.connect(outputAudioContext.destination);
  log(`[Voxly Offscreen] Audio routed to speakers (state=${outputAudioContext.state})`);
}

// Phase 2: Start streaming to Deepgram (called when user clicks Start Recording)
async function startRecording(deepgramKey) {
  if (!tabStream || tabStream.getAudioTracks().length === 0) {
    throw new Error('No tab audio captured. Click the Voxly icon on the tab you want to record, then try again.');
  }

  const audioTracks = tabStream.getAudioTracks();
  log(`[Voxly Offscreen] Starting recording — audio track enabled=${audioTracks[0]?.enabled}, readyState=${audioTracks[0]?.readyState}`);

  // Create audio-only stream for Deepgram (we don't need video)
  const audioOnlyStream = new MediaStream(audioTracks);

  // Connect to Deepgram WebSocket
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

// Stop recording and release all resources
async function stopRecording() {
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
    outputSource = null;
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

  log(`[Voxly Offscreen] Recording stopped — ${segments.length} segments`);

  const result = { segments: [...segments] };
  segments = [];
  return result;
}
