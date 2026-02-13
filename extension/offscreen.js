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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.action === 'startCapture') {
    startCapture(message.deepgramKey)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.action === 'stopCapture') {
    stopCapture().then(result => {
      sendResponse(result);
    });
    return true;
  }
});

async function startCapture(deepgramKey) {
  // Use getDisplayMedia to capture tab audio — Chrome shows a tab picker.
  // This avoids tabCapture.getMediaStreamId() which requires activeTab invocation
  // that expires in side panel contexts.
  tabStream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true // Required by getDisplayMedia spec; we only use the audio track
  });
  console.log('[Voxly Offscreen] Got display media stream, audio tracks:', tabStream.getAudioTracks().length);

  // Create AudioContext at default sample rate (avoids resampling issues)
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  const sampleRate = audioContext.sampleRate;
  console.log('[Voxly Offscreen] AudioContext sampleRate:', sampleRate, 'state:', audioContext.state);

  // Open WebSocket to Deepgram and wait for connection
  const wsUrl = `${DEEPGRAM_WS_URL}?model=nova-2&interim_results=true&diarize=true&encoding=linear16&sample_rate=${sampleRate}`;
  socket = new WebSocket(wsUrl, ['token', deepgramKey]);
  segments = [];

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Deepgram WebSocket timed out')), 10000);
    socket.onopen = () => {
      clearTimeout(timeout);
      console.log('[Voxly Offscreen] Deepgram WebSocket connected');
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Deepgram WebSocket connection failed'));
    };
  });

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'Results') {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript && data.is_final) {
        const segment = {
          text: transcript,
          start: data.start,
          end: data.start + data.duration
        };
        segments.push(segment);
        // Send to side panel
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'realtimeSegment',
          segment,
          allSegments: segments
        });
      } else if (transcript) {
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'realtimeInterim',
          text: transcript
        });
      }
    }
  };

  socket.onerror = (e) => {
    console.error('[Voxly Offscreen] WebSocket error:', e);
  };

  socket.onclose = (event) => {
    console.log(`[Voxly Offscreen] WebSocket closed — code: ${event.code}, reason: "${event.reason}"`);
  };

  // Set up audio pipeline: MediaStreamSource → GainNode → ScriptProcessor → WebSocket
  const mixer = audioContext.createGain();
  mixer.gain.value = 1.0;

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(mixer);

  processor = audioContext.createScriptProcessor(4096, 1, 1);

  let frameCount = 0;
  processor.onaudioprocess = (e) => {
    if (socket?.readyState === WebSocket.OPEN) {
      const float32 = e.inputBuffer.getChannelData(0);

      // Monitor amplitude
      if (frameCount < 5 || frameCount % 200 === 0) {
        let maxAmp = 0;
        for (let i = 0; i < float32.length; i++) {
          const abs = Math.abs(float32[i]);
          if (abs > maxAmp) maxAmp = abs;
        }
        console.log(`[Voxly Offscreen] Frame ${frameCount}: maxAmp=${maxAmp.toFixed(6)}${maxAmp < 0.001 ? ' ⚠️ SILENCE' : ' ✓'}`);
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

  console.log('[Voxly Offscreen] Audio pipeline started');
}

async function stopCapture() {
  // Stop audio processing
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

  console.log(`[Voxly Offscreen] Capture stopped — ${segments.length} segments`);

  const result = { segments: [...segments] };
  segments = [];
  return result;
}
