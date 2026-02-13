// Voxly - Offscreen Audio Capture
// Handles tab audio capture and Deepgram WebSocket streaming in an offscreen
// document. Required because Chrome side panels cannot properly receive
// getDisplayMedia/tabCapture audio data (delivers silence).

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

let audioContext = null;
let processor = null;
let socket = null;
let segments = [];
let tabStream = null;

// Relay logs to background/sidepanel so they're visible in the SW console
// (offscreen document has its own invisible console)
function log(msg) {
  console.log(msg);
  chrome.runtime.sendMessage({ action: 'offscreenLog', msg }).catch(() => {});
}

// Signal to background that we're loaded and ready to receive messages
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
  // Get tab audio using stream ID from background
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });
  const audioTracks = tabStream.getAudioTracks();
  log(`[Voxly Offscreen] Got tab audio stream — ${audioTracks.length} audio tracks, enabled=${audioTracks[0]?.enabled}, readyState=${audioTracks[0]?.readyState}`);

  // Create AudioContext at default sample rate
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  const sampleRate = audioContext.sampleRate;
  log(`[Voxly Offscreen] AudioContext sampleRate=${sampleRate} state=${audioContext.state}`);

  // Open WebSocket to Deepgram
  const wsUrl = `${DEEPGRAM_WS_URL}?model=nova-2&interim_results=true&diarize=true&encoding=linear16&sample_rate=${sampleRate}`;
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

  // Log ALL Deepgram messages for diagnostics
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // Log every message type
    if (data.type === 'Results') {
      const transcript = data.channel?.alternatives?.[0]?.transcript || '';
      log(`[Voxly Offscreen] Deepgram Result: is_final=${data.is_final} speech_final=${data.speech_final} text="${transcript.substring(0, 80)}"`);

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
      // Log Metadata, UtteranceEnd, etc.
      log(`[Voxly Offscreen] Deepgram msg type=${data.type}`);
    }
  };

  socket.onerror = (e) => {
    log('[Voxly Offscreen] WebSocket error');
  };

  socket.onclose = (event) => {
    log(`[Voxly Offscreen] WebSocket closed — code=${event.code} reason="${event.reason}"`);
  };

  // Audio pipeline: MediaStreamSource → GainNode → ScriptProcessor → WebSocket
  const mixer = audioContext.createGain();
  mixer.gain.value = 1.0;

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(mixer);

  processor = audioContext.createScriptProcessor(4096, 1, 1);

  let frameCount = 0;
  processor.onaudioprocess = (e) => {
    if (socket?.readyState === WebSocket.OPEN) {
      const float32 = e.inputBuffer.getChannelData(0);

      // Log amplitude for first 5 frames and every 100th frame — relayed to SW console
      if (frameCount < 5 || frameCount % 100 === 0) {
        let maxAmp = 0;
        for (let i = 0; i < float32.length; i++) {
          const abs = Math.abs(float32[i]);
          if (abs > maxAmp) maxAmp = abs;
        }
        log(`[Voxly Offscreen] Frame ${frameCount}: maxAmp=${maxAmp.toFixed(6)}${maxAmp < 0.001 ? ' SILENCE' : ' OK'}`);
      }

      // Convert float32 to int16 PCM
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      socket.send(int16.buffer);
      frameCount++;
    }
  };

  mixer.connect(processor);
  processor.connect(audioContext.destination);

  log('[Voxly Offscreen] Audio pipeline started');
}

async function stopCapture() {
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (tabStream) {
    tabStream.getTracks().forEach(t => t.stop());
    tabStream = null;
  }

  // Signal end of audio to Deepgram and wait for final results
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(new ArrayBuffer(0));
    await new Promise(resolve => setTimeout(resolve, 1500));
    socket.close();
  }
  socket = null;

  log(`[Voxly Offscreen] Capture stopped — ${segments.length} segments`);

  const result = { segments: [...segments] };
  segments = [];
  return result;
}
