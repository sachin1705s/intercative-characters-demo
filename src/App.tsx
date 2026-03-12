import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import type { ConnectionStatus } from '@odysseyml/odyssey';
import slidesData from './data/slides.json';
import { OdysseyService, loadImageFile, type StreamState } from './lib/odyssey';
import './App.css';

interface Slide {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  image: string;
  prompt: string;
  cta: string;
}

interface Story {
  id: string;
  title: string;
  subtitle: string;
  poster: string;
  slides: Slide[];
}

type GestureLabel = 'hello' | 'thumbs_up' | 'victory' | 'namaste';

type SpeechRecognitionResultEvent = Event & {
  results: {
    [index: number]: {
      isFinal: boolean;
      0: { transcript: string };
    };
    length: number;
  };
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const stories = (slidesData as { stories: Story[] }).stories;
const STORAGE_KEY = 'odyssey_api_key';
const GESTURE_DELAY_MS = 600;
const GEMINI_GESTURE_COOLDOWN_MS = 500;
const VISION_POLL_MS = 600;

const GESTURE_PROMPTS: Record<GestureLabel, string> = {
  hello: 'do hello',
  thumbs_up: 'do thumbs up',
  victory: 'do victory sign',
  namaste: 'do namaste'
};

const safeStorage = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  }
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const win = window as typeof window & {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function App() {
  const [apiKey, setApiKey] = useState<string | undefined>(undefined);
  const [keyLoading, setKeyLoading] = useState(true);
  const [keyInput, setKeyInput] = useState('');
  const [showLanding, setShowLanding] = useState(true);
  const [selectedStory, setSelectedStory] = useState<string | null>(stories[0]?.id ?? null);
  const [index, setIndex] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isStreamingReady, setIsStreamingReady] = useState(false);
  const [speechText, setSpeechText] = useState('');
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isListeningBrowser, setIsListeningBrowser] = useState(false);
  const [textPrompt, setTextPrompt] = useState('');
  const [uploadImage, setUploadImage] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gestureStatus, setGestureStatus] = useState('');
  const [gestureLatency, setGestureLatency] = useState<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const odysseyStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<HTMLVideoElement | null>(null);
  const serviceRef = useRef<OdysseyService | null>(null);
  const requestIdRef = useRef(0);
  const detectFrameRef = useRef<number | null>(null);
  const imageCacheRef = useRef<Map<string, File>>(new Map());
  const pendingGestureRef = useRef<GestureLabel | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const lastGeminiAtRef = useRef(0);
  const lastVisionCheckRef = useRef(0);
  const visionInFlightRef = useRef(false);
  const visionRetryAtRef = useRef(0);
  const lastCaptureAtRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gestureSessionRef = useRef(0);

  const activeStory = stories.find((story) => story.id === selectedStory) ?? stories[0];
  const slides = activeStory?.slides ?? [];
  const slide = slides[index];
  const slideImageUrl = encodeURI(slide.image);
  const landingPosterUrl = encodeURI(activeStory?.poster ?? '/images/output (1).png');
  const slideCount = slides.length;
  const isUploadSlide = slide.id === 'make-your-magic';


  useEffect(() => {
    // Try fetching the key from the backend first (production)
    fetch('/api/odyssey/token')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.apiKey) {
          setApiKey(data.apiKey);
          return;
        }
        // Fall back to localStorage (dev / manual entry)
        const storedKey = safeStorage.get(STORAGE_KEY);
        if (storedKey) setApiKey(storedKey);
      })
      .catch(() => {
        const storedKey = safeStorage.get(STORAGE_KEY);
        if (storedKey) setApiKey(storedKey);
      })
      .finally(() => setKeyLoading(false));
  }, []);

  useEffect(() => {
    if (!apiKey) {
      setError('Missing Odyssey API key. Add it in the overlay or set ODYSSEY_API_KEY in your environment.');
      return;
    }

    const service = new OdysseyService(apiKey);
    serviceRef.current = service;

    service
      .connect({
        onConnected: (stream) => {
          odysseyStreamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => undefined);
          }
        },
        onStatusChange: (status) => {
          setConnectionStatus(status);
        },
        onStreamStarted: () => {
          setStreamState('streaming');
          setIsStreamingReady(true);
          if (pendingGestureRef.current) {
            const prompt = GESTURE_PROMPTS[pendingGestureRef.current];
            pendingGestureRef.current = null;
            handleInteract(prompt);
          }
        },
        onStreamEnded: () => {
          setStreamState('ended');
          setIsStreamingReady(false);
        },
        onStreamError: (reason, message) => {
          setStreamState('error');
          setIsStreamingReady(false);
          if (reason === 'moderation_failed') {
            setError(null);
            return;
          }
          setError(`${reason}: ${message}`);
        },
        onError: (err) => {
          setStreamState('error');
          setIsStreamingReady(false);
          if (err.message?.includes('moderation_failed')) {
            setError(null);
            return;
          }
          setError(err.message);
        }
      })
      .catch((err) => {
        setStreamState('error');
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      service
        .endStream()
        .catch(() => undefined)
        .finally(() => {
          service.disconnect().catch(() => undefined);
        });
    };
  }, [apiKey]);

  useEffect(() => {
    const service = serviceRef.current;
    if (!service || connectionStatus !== 'connected' || showLanding) {
      return;
    }

    const requestId = ++requestIdRef.current;
    setStreamState('starting');
    setIsStreamingReady(false);
    setError(null);

    const run = async () => {
      await service.endStream().catch(() => undefined);
      if (isUploadSlide) {
        setStreamState('idle');
        return;
      }
      const cached = imageCacheRef.current.get(slide.id);
      const file = cached ?? (await loadImageFile(slide.image, `${slide.id}.png`));
      if (!cached) {
        imageCacheRef.current.set(slide.id, file);
      }
      if (requestIdRef.current !== requestId) {
        return;
      }
      await service.startStream({ prompt: slide.prompt, image: file, portrait: false });
    };

    run().catch((err) => {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setStreamState('error');
      setIsStreamingReady(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [connectionStatus, showLanding, index, slide.id, slide.image, slide.prompt, isUploadSlide]);


  useEffect(() => {
    const preload = async (target: Slide) => {
      if (imageCacheRef.current.has(target.id)) {
        return;
      }
      try {
        const file = await loadImageFile(target.image, `${target.id}.png`);
        imageCacheRef.current.set(target.id, file);
      } catch {
        // ignore preload errors
      }
    };
    preload(slide);
    const nextSlide = slides[(index + 1) % slideCount];
    if (nextSlide) {
      preload(nextSlide);
    }
  }, [index, slide, slideCount, slideImageUrl]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      recognitionRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (detectFrameRef.current) {
        cancelAnimationFrame(detectFrameRef.current);
      }
      cameraRef.current?.srcObject && (cameraRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
    };
  }, []);

  // If the Odyssey stream connected while the landing page was showing (video element
  // didn't exist yet), attach the stream now that the story view is rendered.
  useEffect(() => {
    if (!showLanding && odysseyStreamRef.current && videoRef.current) {
      if (!videoRef.current.srcObject) {
        videoRef.current.srcObject = odysseyStreamRef.current;
        videoRef.current.play().catch(() => undefined);
      }
    }
  }, [showLanding]);

  const pttActiveRef = useRef(false);
  const pttStartRef = useRef<() => void>(() => {});
  const pttStopRef = useRef<() => void>(() => {});

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.code === 'Space' && e.ctrlKey && !pttActiveRef.current) {
        e.preventDefault();
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur();
        pttActiveRef.current = true;
        pttStartRef.current();
      }
    };

    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if ((e.code === 'Space' || e.code === 'ControlLeft' || e.code === 'ControlRight') && pttActiveRef.current) {
        e.preventDefault();
        pttActiveRef.current = false;
        pttStopRef.current();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, []);

  const handlePrev = () => {
    setIndex((prev) => (prev - 1 + slideCount) % slideCount);
  };

  const handleNext = () => {
    setIndex((prev) => (prev + 1) % slideCount);
  };

  const handleInteract = (promptOverride?: string) => {
    if (!serviceRef.current || !isStreamingReady) {
      return;
    }
    const prompt = (promptOverride ?? slide.cta).trim();
    if (!prompt) {
      return;
    }
    serviceRef.current.interact(prompt).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const startUploadStream = (file: File) => {
    if (!serviceRef.current || connectionStatus !== 'connected') {
      setUploadError('Waiting for connection…');
      return;
    }
    const requestId = ++requestIdRef.current;
    setStreamState('starting');
    setIsStreamingReady(false);
    setError(null);
    serviceRef.current
      .endStream()
      .catch(() => undefined)
      .then(async () => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        await serviceRef.current?.startStream({ prompt: 'animate it', image: file, portrait: false });
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setStreamState('error');
        setIsStreamingReady(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleSaveKey = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setError('Please enter a valid Odyssey API key.');
      return;
    }
    safeStorage.set(STORAGE_KEY, trimmed);
    setApiKey(trimmed);
    setKeyInput('');
    setError(null);
  };

  const handleTextPromptSubmit = () => {
    const prompt = textPrompt.trim();
    if (!prompt) {
      return;
    }
    handleInteract(prompt);
    setTextPrompt('');
  };

  const handleTextPromptKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleTextPromptSubmit();
    }
  };

  const handleUploadChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setUploadImage(null);
      return;
    }
    if (!file.type.startsWith('image/')) {
      setUploadError('Please select an image file.');
      setUploadImage(null);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('Image is too large (max 25MB).');
      setUploadImage(null);
      return;
    }
    setUploadError(null);
    setUploadImage(file);
    if (isUploadSlide && connectionStatus === 'connected') {
      startUploadStream(file);
    }
  };

  useEffect(() => {
    if (!isUploadSlide || !uploadImage || connectionStatus !== 'connected') {
      return;
    }
    setUploadError(null);
    startUploadStream(uploadImage);
  }, [isUploadSlide, uploadImage, connectionStatus]);

  const startBackendRecording = async () => {
    if (isRecording || isTranscribing) {
      return;
    }
    setSpeechError(null);
    setSpeechText('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        setIsTranscribing(true);

        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioChunksRef.current = [];

        try {
          const form = new FormData();
          form.append('audio', blob, 'wish.webm');

          const response = await fetch('/api/stt', {
            method: 'POST',
            body: form
          });

          if (!response.ok) {
            throw new Error('Transcription failed');
          }

          const data = (await response.json()) as { text?: string };
          const transcript = (data.text ?? '').trim();
          if (transcript) {
            setSpeechText(transcript);
            handleInteract(transcript);
          } else {
            setSpeechError('We did not hear anything. Try again.');
          }
        } catch (err) {
          const browserStarted = startBrowserSTT();
          if (!browserStarted) {
            setSpeechError('Transcription failed. Try again.');
          }
        } finally {
          setIsTranscribing(false);
          mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }
      };

      setIsRecording(true);
      recorder.start();
    } catch (err) {
      const browserStarted = startBrowserSTT();
      if (!browserStarted) {
        setSpeechError('Microphone access was blocked.');
      }
    }
  };

  const startBrowserSTT = () => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      return false;
    }
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal && transcript) {
        setSpeechText(transcript);
        handleInteract(transcript);
      }
    };

    recognition.onerror = () => {
      setSpeechError('Browser speech failed.');
      setIsListeningBrowser(false);
    };

    recognition.onend = () => {
      setIsListeningBrowser(false);
    };

    recognitionRef.current = recognition;
    setSpeechText('');
    setIsListeningBrowser(true);
    recognition.start();
    return true;
  };

  const scheduleGesturePrompt = (label: GestureLabel) => {
    pendingGestureRef.current = label;
    if (pendingTimerRef.current) {
      window.clearTimeout(pendingTimerRef.current);
    }
    pendingTimerRef.current = window.setTimeout(() => {
      if (pendingGestureRef.current !== label) {
        return;
      }
      setGestureStatus(`Gesture: ${label}`);
      if (isStreamingReady) {
        const prompt = GESTURE_PROMPTS[label];
        pendingGestureRef.current = null;
        handleInteract(prompt);
      }
    }, GESTURE_DELAY_MS);
  };

  const handleSpeakWish = () => {
    if (isTranscribing) {
      return;
    }
    if (isRecording) {
      stopRecording();
      return;
    }
    if (isListeningBrowser) {
      recognitionRef.current?.stop();
      setIsListeningBrowser(false);
      return;
    }
    setSpeechError(null);
    startBackendRecording();
  };

  const classifyGestureFromFrame = async (dataUrl: string) => {
    const now = Date.now();
    if (visionInFlightRef.current) {
      return;
    }
    if (now < visionRetryAtRef.current) {
      return;
    }
    if (now - lastGeminiAtRef.current < GEMINI_GESTURE_COOLDOWN_MS) {
      return;
    }
    visionInFlightRef.current = true;
    lastGeminiAtRef.current = now;

    const [meta, base64] = dataUrl.split(',');
    const mimeMatch = /data:(.*?);base64/.exec(meta);
    const mimeType = mimeMatch?.[1] ?? 'image/jpeg';

    try {
      const response = await fetch('/api/gesture-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, mimeType })
      });

      if (response.status === 429) {
        const data = (await response.json()) as { retryAfterMs?: number };
        visionRetryAtRef.current = Date.now() + (data.retryAfterMs ?? 10000);
        return;
      }
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as { label?: string };
      const label = data.label as GestureLabel | undefined;
      if (label && GESTURE_PROMPTS[label]) {
        const latency = Date.now() - lastCaptureAtRef.current;
        setGestureLatency(latency);
        scheduleGesturePrompt(label);
      } else {
        setGestureStatus('Gesture: none');
      }
    } catch {
      // ignore
    } finally {
      visionInFlightRef.current = false;
    }
  };

  const startGestureLoop = () => {
    const camera = cameraRef.current;
    if (!camera) {
      return;
    }

    const detect = () => {
      if (!cameraRef.current) {
        return;
      }
      const now = performance.now();
      if (now - lastVisionCheckRef.current >= VISION_POLL_MS) {
        lastVisionCheckRef.current = now;
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const width = camera.videoWidth || 320;
            const height = camera.videoHeight || 240;
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(camera, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            if (isStreamingReady) {
              lastCaptureAtRef.current = Date.now();
              classifyGestureFromFrame(dataUrl);
            }
          }
        }
      }
      detectFrameRef.current = requestAnimationFrame(detect);
    };

    detectFrameRef.current = requestAnimationFrame(detect);
  };

  const enableGestures = async () => {
    if (gesturesEnabled) {
      return;
    }
    try {
      const sessionId = ++gestureSessionRef.current;
      setGestureStatus('Starting camera...');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      if (sessionId !== gestureSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (cameraRef.current) {
        cameraRef.current.srcObject = stream;
        await cameraRef.current.play();
      }
      setGesturesEnabled(true);
      setGestureStatus('Gesture detection on');
      startGestureLoop();
    } catch (err) {
      setGestureStatus('Gesture setup failed');
    }
  };

  const disableGestures = () => {
    gestureSessionRef.current += 1;
    setGesturesEnabled(false);
    setGestureStatus('');
    setGestureLatency(null);
    pendingGestureRef.current = null;
    if (pendingTimerRef.current) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (detectFrameRef.current) {
      cancelAnimationFrame(detectFrameRef.current);
      detectFrameRef.current = null;
    }
    if (cameraRef.current?.srcObject) {
      cameraRef.current.pause();
      (cameraRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      cameraRef.current.srcObject = null;
    }
  };

  const stopRecording = () => {
    if (!isRecording) {
      return;
    }
    mediaRecorderRef.current?.stop();
  };

  // Keep PTT refs pointing to latest function instances to avoid stale closures
  pttStartRef.current = () => {
    setSpeechError(null);
    startBackendRecording();
  };
  pttStopRef.current = () => {
    recognitionRef.current?.stop();
    setIsListeningBrowser(false);
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  const showKeyOverlay = !keyLoading && !apiKey;

  const handleSelectStory = (id: string) => {
    setSelectedStory(id);
  };

  const handleStartStory = () => {
    if (!selectedStory && stories[0]?.id) {
      setSelectedStory(stories[0].id);
    }
    setIndex(0);
    setShowLanding(false);
  };

  if (showLanding) {
    return (
      <div className="app">
        <div className="video-layer">
          <div
            className="background-fallback landing-bg"
            style={{ backgroundImage: `url("${landingPosterUrl}")` }}
            aria-hidden
          />
          <div className="video-overlay" />
        </div>
        <div className="landing">
          <div className="landing-header">
            <p className="eyebrow">Story Archives</p>
            <h1 className="app-title">Live Through Stories</h1>
            <p className="landing-subtitle">
              Interactive storylines, cinematic scenes, and live reactions. Step into a tale and shape what happens next.
            </p>
            <div className="landing-search">
              <div className="search-line" />
              <span className="search-label">Interactive storylines</span>
            </div>
          </div>
          <div className="poster-grid">
            {stories.map((story) => (
              <button
                key={story.id}
                className={`poster-card ${selectedStory === story.id ? 'active' : ''}`}
                onClick={() => handleSelectStory(story.id)}
              >
                <img src={encodeURI(story.poster)} alt={`${story.title} poster`} />
                <div className="poster-info">
                  <span>{story.title}</span>
                </div>
              </button>
            ))}
          </div>
          {selectedStory ? (
            <div className="landing-cta">
              <button className="btn primary" onClick={handleStartStory}>
                Start Story
              </button>
            </div>
          ) : null}
          <div className="landing-footer">
            <span className="search-label">Powered by Odyssey</span>
          </div>
        </div>
        {showKeyOverlay ? (
          <div className="key-overlay" role="dialog" aria-modal="true">
            <div className="key-card">
              <h2>Enter Odyssey API Key</h2>
              <p>We store it locally in your browser for this device.</p>
              <div className="key-input">
                <input
                  type="password"
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  placeholder="ody_..."
                  autoComplete="off"
                />
                <button className="btn primary" onClick={handleSaveKey}>
                  Save & Connect
                </button>
              </div>
              <p className="key-hint">Key is loaded automatically from the server in production.</p>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="video-layer">
        <div
          className="background-fallback"
          style={{ backgroundImage: `url("${slideImageUrl}")` }}
          aria-hidden
        />
        <div
          className={`stream-placeholder ${streamState === 'streaming' ? 'hidden' : ''}`}
          style={{ backgroundImage: `url("${slideImageUrl}")` }}
          aria-hidden
        />
        <video
          ref={videoRef}
          className={`video-element ${streamState === 'streaming' ? '' : 'is-hidden'}`}
          autoPlay
          playsInline
          muted
        />
        <div className="video-overlay" />
      </div>

      <div className="ui">
        <header className="top-bar">
          <button className="btn ghost back-to-landing" onClick={() => setShowLanding(true)}>
            Back
          </button>
          <div className="settings">
            <button className="btn ghost" onClick={() => setSettingsOpen((prev) => !prev)}>
              Settings
            </button>
            {settingsOpen ? (
              <div className="settings-menu">
                <button
                  className={`btn ghost ${gesturesEnabled ? 'active' : ''}`}
                  onClick={gesturesEnabled ? disableGestures : enableGestures}
                >
                  {gesturesEnabled ? 'Gestures on' : 'Gestures off'}
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <main className="slide-shell" />

        <footer className="story-bar">
          <div className="story-text">
            <span className="story-index">
              {String(index + 1).padStart(2, '0')} / {String(slideCount).padStart(2, '0')}
            </span>
            <p>{slide.body}</p>
            {speechText ? <div className="speech-preview">Heard: “{speechText}”</div> : null}
            {speechError ? <div className="speech-preview speech-error">{speechError}</div> : null}
            {gestureStatus ? <div className="speech-preview">{gestureStatus}</div> : null}
            {gestureLatency !== null ? (
              <div className="speech-preview">Gesture latency: {gestureLatency}ms + 600ms delay</div>
            ) : null}
            {uploadError ? <div className="speech-preview speech-error">{uploadError}</div> : null}
            {error ? <div className="error-box">{error}</div> : null}
          </div>
          <div className="story-actions">
            {isUploadSlide ? (
              <label className="upload-pill">
                <input type="file" accept="image/*" onChange={handleUploadChange} />
                <span>{uploadImage ? uploadImage.name : 'Upload image'}</span>
              </label>
            ) : null}
            <div className="prompt-input">
              <input
                type="text"
                value={textPrompt}
                onChange={(event) => setTextPrompt(event.target.value)}
                onKeyDown={handleTextPromptKeyDown}
                placeholder="Type a wish..."
                disabled={!isStreamingReady}
              />
              <button className="btn ghost" onClick={handleTextPromptSubmit} disabled={!isStreamingReady}>
                Send
              </button>
              <button className="btn ghost" onClick={handleSpeakWish} disabled={!isStreamingReady}>
                {isRecording || isListeningBrowser ? 'Stop' : isTranscribing ? '...' : 'Speak'}
              </button>
            </div>
            <button className="btn ghost" onClick={handlePrev}>
              Back
            </button>
            <button className="btn primary" onClick={handleNext}>
              Next
            </button>
          </div>
        </footer>
      </div>

      <video ref={cameraRef} className="camera-feed" playsInline muted />

      {showKeyOverlay ? (
        <div className="key-overlay" role="dialog" aria-modal="true">
          <div className="key-card">
            <h2>Enter Odyssey API Key</h2>
            <p>We store it locally in your browser for this device.</p>
            <div className="key-input">
              <input
                type="password"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                placeholder="ody_..."
                autoComplete="off"
              />
              <button className="btn primary" onClick={handleSaveKey}>
                Save & Connect
              </button>
            </div>
            <p className="key-hint">Key is loaded automatically from the server in production.</p>
          </div>
        </div>
      ) : null}
      <canvas ref={canvasRef} className="camera-feed" />
    </div>
  );
}

function AppWithAnalytics() {
  return (
    <>
      <App />
      <Analytics />
      <SpeedInsights />
    </>
  );
}

export default AppWithAnalytics;
