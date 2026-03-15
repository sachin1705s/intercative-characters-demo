import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import type { ConnectionStatus } from '@odysseyml/odyssey';
import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import { AtomsClient } from 'atoms-client-sdk';
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
const GESTURE_DELAY_MS = 600;
const GEMINI_GESTURE_COOLDOWN_MS = 1700;
const VISION_POLL_MS = 1700;
const OBJECT_POLL_MS = 1200;

const GESTURE_PROMPTS: Record<GestureLabel, string> = {
  hello: 'do hello',
  thumbs_up: 'do thumbs up',
  victory: 'do victory sign',
  namaste: 'do namaste'
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
  const [isCharacterRecording, setIsCharacterRecording] = useState(false);
  const [isCharacterThinking, setIsCharacterThinking] = useState(false);
  const [characterReply, setCharacterReply] = useState<string | null>(null);
  const [characterError, setCharacterError] = useState<string | null>(null);
  const [characterHistory, setCharacterHistory] = useState<Record<string, Array<{ role: 'user' | 'assistant'; content: string }>>>({});
  const [midstreamPrompts, setMidstreamPrompts] = useState<string[]>([]);
  const [uploadImage, setUploadImage] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gestureStatus, setGestureStatus] = useState('');
  const [gestureLatency, setGestureLatency] = useState<number | null>(null);
  const [objectDetectionEnabled, setObjectDetectionEnabled] = useState(false);
  const [objectStatus, setObjectStatus] = useState('');
  const [objectLatency, setObjectLatency] = useState<number | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [lastVoiceIntent, setLastVoiceIntent] = useState<string | null>(null);
  const [lastVoiceText, setLastVoiceText] = useState<string | null>(null);
  const [lastVoiceEvent, setLastVoiceEvent] = useState<string | null>(null);
  const [lastVoicePrompt, setLastVoicePrompt] = useState<string | null>(null);
  const [lastVoiceActionAt, setLastVoiceActionAt] = useState<number | null>(null);
  const [lastVoiceSource, setLastVoiceSource] = useState<string | null>(null);
  const [lastVoiceHint, setLastVoiceHint] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const odysseyStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const characterRecorderRef = useRef<MediaRecorder | null>(null);
  const characterStreamRef = useRef<MediaStream | null>(null);
  const characterChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraRef = useRef<HTMLVideoElement | null>(null);
  const serviceRef = useRef<OdysseyService | null>(null);
  const requestIdRef = useRef(0);
  const detectFrameRef = useRef<number | null>(null);
  const objectDetectorRef = useRef<ObjectDetector | null>(null);
  const objectInFlightRef = useRef(false);
  const imageCacheRef = useRef<Map<string, File>>(new Map());
  const pendingGestureRef = useRef<GestureLabel | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const lastGeminiAtRef = useRef(0);
  const lastVisionCheckRef = useRef(0);
  const visionInFlightRef = useRef(false);
  const visionRetryAtRef = useRef(0);
  const lastObjectCheckRef = useRef(0);
  const objectSessionRef = useRef(0);
  const lastCaptureAtRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gestureSessionRef = useRef(0);
  const atomsClientRef = useRef<AtomsClient | null>(null);
  const isStreamingReadyRef = useRef(false);
  const isVoiceAgentSlideRef = useRef(false);
  const lastVoiceActionAtRef = useRef(0);
  const handleInteractRef = useRef<(promptOverride?: string) => void>(() => undefined);
  const voiceAwaitTimerRef = useRef<number | null>(null);
  const ttsAudioCtxRef = useRef<AudioContext | null>(null);

  const activeStory = stories.find((story) => story.id === selectedStory) ?? stories[0];
  const slides = activeStory?.slides ?? [];
  const slide = slides[index];
  const slideImageUrl = encodeURI(slide.image);
  const landingPosterUrl = encodeURI(activeStory?.poster ?? '/images/output (1).png');
  const slideCount = slides.length;
  const isUploadSlide = slide.id === 'make-your-magic';
  const isCharacterSlide = activeStory?.id === 'characters';
  const VOICE_AGENT_ID_BY_SLIDE: Record<string, { id: string; label: string }> = {
    'characters-07': { id: '69b32b5ab57a92ad341f350d', label: 'Circus Lion' },
    'characters-02': { id: '', label: 'Albert Einstein' },
    'characters-sudharshan': { id: '', label: 'Sudharshan Kamath' }
  };
  const activeVoiceAgent = VOICE_AGENT_ID_BY_SLIDE[slide.id];
  const isVoiceAgentSlide = Boolean(activeVoiceAgent);
  const activeCharacterName = isCharacterSlide ? slide.title : 'Character';
  const activeCharacterHistory = characterHistory[slide.id] ?? [];
  const slideCtaRef = useRef('');


  useEffect(() => {
    fetch('/api/odyssey/token')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.apiKey) setApiKey(data.apiKey);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    isStreamingReadyRef.current = isStreamingReady;
  }, [isStreamingReady]);

  useEffect(() => {
    isVoiceAgentSlideRef.current = isVoiceAgentSlide;
    if (!isVoiceAgentSlide && voiceStatus === 'connected') {
      atomsClientRef.current?.stopSession();
      setVoiceStatus('idle');
    }
  }, [isVoiceAgentSlide, voiceStatus]);

  useEffect(() => {
    if (!isStreamingReady && voiceStatus === 'connected') {
      atomsClientRef.current?.stopSession();
      setVoiceStatus('idle');
      setVoiceError('Stream stopped.');
    }
  }, [isStreamingReady, voiceStatus]);

  useEffect(() => {
    if (isCharacterSlide) {
      return;
    }
    if (isCharacterRecording) {
      stopCharacterRecording();
    }
  }, [isCharacterSlide, isCharacterRecording]);

  useEffect(() => {
    if (voiceStatus === 'connected' && isVoiceAgentSlide) {
      return;
    }
    stopVoiceCapture();
  }, [voiceStatus, isVoiceAgentSlide]);

  useEffect(() => {
    if (!isStreamingReady) {
      return;
    }
    const slideId = slide.id;
    const hasRandoms = Boolean(SLIDE_RANDOM_ACTIONS[slideId]?.length || SLIDE_RANDOM_OBJECTS[slideId]?.length);
    if (!hasRandoms) {
      return;
    }

    let cancelled = false;
    const minDelay = 7000;
    const maxDelay = 14000;

    const scheduleNext = () => {
      if (cancelled) return;
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      window.setTimeout(() => {
        if (cancelled || !isStreamingReadyRef.current) return;
        const prompt = getRandomPromptForSlide(slideId);
        if (prompt) {
          handleInteractRef.current(prompt);
        }
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    return () => {
      cancelled = true;
    };
  }, [isStreamingReady, slide.id]);

  useEffect(() => {
    slideCtaRef.current = slide.cta;
  }, [slide.cta]);


  useEffect(() => {
    if (!apiKey) {
      setError('Missing Odyssey API key. Set ODYSSEY_API_KEY in your server environment.');
      return;
    }

    const service = new OdysseyService(apiKey);
    serviceRef.current = service;

    service
      .connect({
        onConnected: (stream) => {
          console.log('[odyssey] onConnected — stream:', stream);
          odysseyStreamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch((e) => console.warn('[odyssey] video.play failed:', e));
          } else {
            console.warn('[odyssey] onConnected but videoRef is null');
          }
        },
        onStatusChange: (status) => {
          console.log('[odyssey] status:', status);
          setConnectionStatus(status);
        },
        onStreamStarted: () => {
          console.log('[odyssey] onStreamStarted');
          setStreamState('streaming');
          setIsStreamingReady(true);
          if (pendingGestureRef.current) {
            const prompt = GESTURE_PROMPTS[pendingGestureRef.current];
            pendingGestureRef.current = null;
            handleInteract(prompt);
          }
        },
        onStreamEnded: () => {
          console.log('[odyssey] onStreamEnded');
          setStreamState('ended');
          setIsStreamingReady(false);
        },
        onStreamError: (reason, message) => {
          console.error('[odyssey] onStreamError:', reason, message);
          setStreamState('error');
          setIsStreamingReady(false);
          const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
          const m = typeof message === 'string' ? message : JSON.stringify(message);
          if (r === 'moderation_failed') {
            setError(null);
            return;
          }
          setError(`${r}: ${m}`);
        },
        onError: (err) => {
          console.error('[odyssey] onError:', err);
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
      console.log('[odyssey] calling startStream — slide:', slide.id, '| prompt:', slide.prompt?.slice(0, 60));
      await service.startStream({ prompt: slide.prompt, image: file, portrait: slide.id === 'characters-sudharshan' });
      console.log('[odyssey] startStream resolved');
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
      characterRecorderRef.current?.stop();
      characterStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      atomsClientRef.current?.stopSession();
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

  const stopCameraStream = () => {
    if (cameraRef.current?.srcObject) {
      (cameraRef.current.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
      cameraRef.current.srcObject = null;
    }
  };

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
    setMidstreamPrompts((prev) => [prompt, ...prev].slice(0, 6));
    serviceRef.current.interact(prompt).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  useEffect(() => {
    handleInteractRef.current = handleInteract;
  }, [handleInteract]);

  const OBJECT_KEYWORDS: Array<{ keywords: string[]; object: string }> = [
    { keywords: ['sword', 'blade'], object: 'a shining sword' },
    { keywords: ['shield'], object: 'a glowing shield' },
    { keywords: ['crown', 'tiara'], object: 'a golden crown' },
    { keywords: ['flower', 'rose', 'bouquet'], object: 'a bright flower' },
    { keywords: ['star', 'stars'], object: 'twinkling stars' },
    { keywords: ['balloon', 'balloons'], object: 'colorful balloons' },
    { keywords: ['book'], object: 'an ancient book' },
    { keywords: ['map'], object: 'a glowing map' },
    { keywords: ['lantern', 'lamp'], object: 'a warm lantern' }
  ];

  const findObjectFromUtterance = (normalized: string) => {
    for (const entry of OBJECT_KEYWORDS) {
      for (const key of entry.keywords) {
        const pattern = new RegExp(`(^|\\b)${key}(\\b|$)`, 'i');
        if (pattern.test(normalized)) {
          return entry.object;
        }
      }
    }
    return null;
  };

  const mapUtteranceToPrompt = (text: string) => {
    const normalized = text.toLowerCase();
    const object = findObjectFromUtterance(normalized);
    if (/(^|\\b)(hello|hi|hey|yo|greetings)(\\b|$)/.test(normalized)) {
      return { prompt: 'do hello', label: 'hello', object };
    }
    if (/(thumbs?\\s*up|like\\sthis)/.test(normalized)) {
      return { prompt: 'do thumbs up', label: 'thumbs up', object };
    }
    if (/(victory|peace\\s*sign|v\\s*sign)/.test(normalized)) {
      return { prompt: 'do victory sign', label: 'victory', object };
    }
    if (/(namaste|namaskar)/.test(normalized)) {
      return { prompt: 'do namaste', label: 'namaste', object };
    }
    if (/(wave|waving)/.test(normalized)) {
      return { prompt: 'do hello', label: 'wave', object };
    }
    if (/(dance|celebrate|celebration)/.test(normalized)) {
      return { prompt: slideCtaRef.current || 'Animate it', label: 'celebrate', object };
    }
    if (object) {
      return { prompt: slideCtaRef.current || 'Animate it', label: `object: ${object}`, object };
    }
    return null;
  };

  const SLIDE_RANDOM_ACTIONS: Record<string, string[]> = {
    'characters-07': [
      'do hello',
      'do thumbs up',
      'do victory sign',
      'do a playful circus trick',
      'roar proudly',
      'say hey and wave'
    ],
    'characters-02': [
      'do hello',
      'do a thoughtful pose',
      'write an equation in the air',
      'do thumbs up'
    ],
    'characters-sudharshan': [
      'do hello',
      'do thumbs up',
      'do a confident wave',
      'do victory sign'
    ]
  };

  const SLIDE_RANDOM_OBJECTS: Record<string, string[]> = {
    'characters-07': [
      'a circus ball',
      'a juggling pin',
      'a rubber chicken'
    ],
    'characters-02': [
      'a chalkboard',
      'a telescope',
      'a swirling galaxy'
    ],
    'characters-sudharshan': [
      'a microphone',
      'a soundwave',
      'a glowing AI chip'
    ]
  };

  const getRandomPromptForSlide = (slideId: string) => {
    const actions = SLIDE_RANDOM_ACTIONS[slideId] ?? [];
    const objects = SLIDE_RANDOM_OBJECTS[slideId] ?? [];
    const action = actions.length ? actions[Math.floor(Math.random() * actions.length)] : null;
    const object = objects.length ? objects[Math.floor(Math.random() * objects.length)] : null;
    if (action && object) {
      return `${action}. Include ${object} in the scene.`;
    }
    if (action) return action;
    if (object) return `Include ${object} in the scene.`;
    return null;
  };

  const handleVoiceTranscript = (data: { text?: string; topic?: string; type?: string; [key: string]: unknown }) => {
    if (!isVoiceAgentSlideRef.current) {
      return;
    }
    const text = String(data?.text ?? '').trim();
    const topic = String(data?.topic ?? '').toLowerCase();
    const payload = { type: data?.type ?? 'transcript', topic: topic || 'unknown', text };
    setLastVoiceEvent(JSON.stringify(payload));
    console.log('[atoms transcript]', data);
    if (!text) return;
    setLastVoiceText(text);
    handleVoiceUtterance(text, 'atoms');
  };

  const extractPossibleUserText = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return null;
    const data = payload as Record<string, unknown>;
    const candidates = [
      data.text,
      data.transcript,
      (data.message as Record<string, unknown> | undefined)?.text,
      (data.user as Record<string, unknown> | undefined)?.text,
      (data.input as Record<string, unknown> | undefined)?.text,
      (data.data as Record<string, unknown> | undefined)?.text,
      (data.payload as Record<string, unknown> | undefined)?.text
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  };

  const getAtomsClient = () => {
    if (atomsClientRef.current) {
      return atomsClientRef.current;
    }
    const client = new AtomsClient();
    client.on('session_started', () => setVoiceStatus('connected'));
    client.on('session_ended', () => setVoiceStatus('idle'));
    client.on('agent_start_talking', () => {
      setVoiceStatus((prev) => (prev === 'connected' ? prev : 'connected'));
    });
    client.on('microphone_permission_error', (data: { error?: string }) => {
      setVoiceError(data?.error || 'Microphone permission error.');
    });
    client.on('microphone_access_failed', (data: { error?: string }) => {
      setVoiceError(data?.error || 'Microphone access failed.');
    });
    client.on('update', (data: unknown) => {
      console.log('[atoms update]', data);
      setLastVoiceEvent(JSON.stringify({ type: 'update', data }));
      const text = extractPossibleUserText(data);
      if (text) {
        setLastVoiceText(text);
        handleVoiceUtterance(text, 'update');
      }
    });
    client.on('metadata', (data: unknown) => {
      console.log('[atoms metadata]', data);
      setLastVoiceEvent(JSON.stringify({ type: 'metadata', data }));
      const text = extractPossibleUserText(data);
      if (text) {
        setLastVoiceText(text);
        handleVoiceUtterance(text, 'metadata');
      }
    });
    client.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setVoiceError(message);
      setVoiceStatus('error');
    });
    client.on('transcript', (data: { text?: string }) => {
      handleVoiceTranscript(data);
    });
    atomsClientRef.current = client;
    return client;
  };

  const handleVoiceUtterance = (text: string, source: string) => {
    const mapped = mapUtteranceToPrompt(text);
    if (!mapped) {
      setLastVoicePrompt('no action (unmapped)');
      setLastVoiceSource(source);
      setLastVoiceHint('Try: hello, thumbs up, victory, namaste, wave');
      return;
    }
    const now = Date.now();
    if (now - lastVoiceActionAtRef.current < 1800) {
      return;
    }
    lastVoiceActionAtRef.current = now;
    setLastVoiceIntent(mapped.label);
    setLastVoiceActionAt(now);
    setLastVoiceSource(source);
    setLastVoiceHint(null);
    if (!isStreamingReadyRef.current) {
      setLastVoicePrompt('stream not ready');
      return;
    }
    const objectPrompt = mapped.object ? ` Include ${mapped.object} in the scene.` : '';
    const fullPrompt = `${mapped.prompt}.${objectPrompt}`.trim();
    setLastVoicePrompt(fullPrompt);
    handleInteractRef.current(fullPrompt);
  };

  const stopVoiceCapture = () => {
    // no-op: using SDK transcripts instead of browser speech
  };

  const startVoiceAgent = async () => {
    if (voiceStatus === 'connecting') {
      return;
    }
    if (voiceStatus === 'connected') {
      atomsClientRef.current?.stopSession();
      setVoiceStatus('idle');
      return;
    }
    if (!isStreamingReadyRef.current) {
      setVoiceError('Start the stream first.');
      return;
    }
    if (!activeVoiceAgent) {
      setVoiceError('No voice agent configured for this slide.');
      return;
    }
    setVoiceError(null);
    setLastVoicePrompt('waiting for transcript');
    setLastVoiceHint('Speak after the call connects.');
    if (voiceAwaitTimerRef.current) {
      window.clearTimeout(voiceAwaitTimerRef.current);
    }
    setVoiceStatus('connecting');
    try {
      const response = await fetch('/api/smallest/webcall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: activeVoiceAgent.id })
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || 'Failed to start voice agent.');
      }
      const data = await response.json();
      const accessToken = String(data?.accessToken ?? data?.raw?.data?.accessToken ?? '');
      const host = String(data?.host ?? data?.raw?.data?.host ?? '');
      if (!accessToken || !host) {
        throw new Error('Missing access token or host.');
      }
      const client = getAtomsClient();
      await client.startSession({ accessToken, mode: 'voice', host, sampleRate: 48000 });
      await client.startAudioPlayback();
      setVoiceStatus('connected');
      voiceAwaitTimerRef.current = window.setTimeout(() => {
        if (!lastVoiceText) {
          setLastVoicePrompt('no transcript received');
          setLastVoiceHint('Check mic permission and Smallest agent transcript settings.');
        }
      }, 5000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setVoiceError(message);
      setVoiceStatus('error');
    }
  };

  const stopCharacterRecording = () => {
    if (!isCharacterRecording) {
      return;
    }
    characterRecorderRef.current?.stop();
  };

  const playCharacterTTS = async (text: string) => {
    const ctx = ttsAudioCtxRef.current;
    console.log('[tts] playCharacterTTS called, text:', text.slice(0, 80));
    console.log('[tts] AudioContext state:', ctx ? ctx.state : 'null (no ctx)');
    if (!ctx) return;
    try {
      await ctx.resume();
      console.log('[tts] AudioContext resumed, state:', ctx.state);
      const ttsRes = await fetch('/api/character/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      console.log('[tts] server response status:', ttsRes.status, ttsRes.statusText);
      console.log('[tts] content-type:', ttsRes.headers.get('content-type'));
      if (!ttsRes.ok) {
        const errBody = await ttsRes.text();
        console.error('[tts] server error body:', errBody);
        return;
      }
      const arrayBuffer = await ttsRes.arrayBuffer();
      console.log('[tts] arrayBuffer size:', arrayBuffer.byteLength, 'bytes');
      if (arrayBuffer.byteLength < 200) {
        const text = new TextDecoder().decode(arrayBuffer);
        console.warn('[tts] suspiciously small buffer — raw content:', text);
      }
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      console.log('[tts] decoded audio duration:', decoded.duration.toFixed(2), 's');
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.start();
      console.log('[tts] audio playback started');
    } catch (err) {
      console.error('[tts] error', err);
    }
  };

  const runCharacterInteraction = async (userText: string, slideId: string, characterName: string) => {
    const history = (characterHistory[slideId] ?? []).slice(-6);
    const chatResponse = await fetch('/api/character/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userText, history, character: characterName })
    });
    if (!chatResponse.ok) throw new Error('Character response failed');

    const chatData = await chatResponse.json() as { reply?: string; action?: string; objects?: string[] };
    const reply = String(chatData.reply ?? '').trim() || 'Hmm, fascinating.';
    const trimmedReply = reply.split(/\s+/).slice(0, 15).join(' ');
    const action = String(chatData.action ?? '').trim() || 'nod thoughtfully and gesture gently';
    const objects = Array.isArray(chatData.objects) ? chatData.objects.filter(Boolean).slice(0, 3) : [];

    setCharacterReply(trimmedReply);
    setCharacterHistory((prev) => ({
      ...prev,
      [slideId]: [
        ...(prev[slideId] ?? []),
        { role: 'user', content: userText },
        { role: 'assistant', content: trimmedReply }
      ]
    }));

    const objectPrompt = objects.length ? ` Include ${objects.join(', ')} in the scene.` : '';
    const streamPrompt = `${action}.${objectPrompt}`.trim();
    handleInteractRef.current(streamPrompt);
    playCharacterTTS(trimmedReply);
  };

  const startCharacterRecording = async () => {
    if (isCharacterRecording || isCharacterThinking) {
      return;
    }
    setCharacterError(null);
    setCharacterReply(null);
    // Unlock AudioContext during user gesture so TTS can play after async awaits
    if (!ttsAudioCtxRef.current) {
      ttsAudioCtxRef.current = new AudioContext();
    } else {
      ttsAudioCtxRef.current.resume();
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const slideId = slide.id;
      const characterName = activeCharacterName;

      characterStreamRef.current = stream;
      characterRecorderRef.current = recorder;
      characterChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          characterChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        setIsCharacterRecording(false);
        setIsCharacterThinking(true);

        const blob = new Blob(characterChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        characterChunksRef.current = [];

        try {
          const form = new FormData();
          form.append('audio', blob, 'character.webm');

          const sttResponse = await fetch('/api/character/stt', {
            method: 'POST',
            body: form
          });

          if (!sttResponse.ok) {
            let detail = '';
            try {
              const raw = await sttResponse.text();
              if (raw) {
                try {
                  const data = JSON.parse(raw);
                  detail = String(data?.details ?? data?.error ?? raw);
                } catch {
                  detail = raw;
                }
              }
            } catch {
              // ignore read errors
            }
            const statusLine = `STT failed (${sttResponse.status})`;
            const message = detail ? `${statusLine}: ${detail}` : statusLine;
            throw new Error(message);
          }

          const sttData = (await sttResponse.json()) as { text?: string };
          const transcript = (sttData.text ?? '').trim();
          if (!transcript) {
            setCharacterError('We did not hear anything. Try again.');
            return;
          }

          await runCharacterInteraction(transcript, slideId, characterName);
        } catch (err) {
          setCharacterError(err instanceof Error ? err.message : 'Character flow failed.');
        } finally {
          setIsCharacterThinking(false);
          characterStreamRef.current?.getTracks().forEach((track) => track.stop());
          characterStreamRef.current = null;
        }
      };

      setIsCharacterRecording(true);
      recorder.start();
    } catch (err) {
      setCharacterError(err instanceof Error ? err.message : 'Microphone access was blocked.');
    }
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

  const handleTextPromptSubmit = () => {
    const prompt = textPrompt.trim();
    if (!prompt) {
      return;
    }
    setTextPrompt('');
    if (isCharacterSlide) {
      if (!ttsAudioCtxRef.current) {
        ttsAudioCtxRef.current = new AudioContext();
      } else {
        ttsAudioCtxRef.current.resume();
      }
      runCharacterInteraction(prompt, slide.id, activeCharacterName).catch(() => {});
    } else {
      handleInteract(prompt);
    }
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
            if (voiceStatus === 'connected' && isVoiceAgentSlideRef.current) {
              setLastVoiceText(transcript);
              handleVoiceUtterance(transcript, 'stt');
            }
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
        setGestureStatus('Gesture: rate limited');
        return;
      }
      if (response.status === 503) {
        setGestureStatus('Gesture: missing Gemini key');
        return;
      }
      if (!response.ok) {
        setGestureStatus(`Gesture: error ${response.status}`);
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

  const ensureObjectDetector = async () => {
    if (objectDetectorRef.current) {
      return objectDetectorRef.current;
    }
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm'
    );
    const detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-assets/efficientdet_lite0.tflite'
      },
      scoreThreshold: 0.5,
      runningMode: 'VIDEO'
    });
    objectDetectorRef.current = detector;
    return detector;
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

  const startObjectLoop = () => {
    const camera = cameraRef.current;
    if (!camera) {
      return;
    }

    const detect = async () => {
      if (!cameraRef.current) {
        return;
      }
      const now = performance.now();
      if (now - lastObjectCheckRef.current >= OBJECT_POLL_MS) {
        lastObjectCheckRef.current = now;
        if (!objectInFlightRef.current) {
          objectInFlightRef.current = true;
          const start = Date.now();
          try {
            const detector = await ensureObjectDetector();
            const results = detector.detectForVideo(cameraRef.current, now);
            const detection = results.detections?.[0];
            const category = detection?.categories?.[0];
            if (category?.categoryName) {
              setObjectStatus(`Object: ${category.categoryName}`);
            } else {
              setObjectStatus('Object: none');
            }
            setObjectLatency(Date.now() - start);
          } catch {
            setObjectStatus('Object detection failed.');
            disableObjectDetection();
          } finally {
            objectInFlightRef.current = false;
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
    if (objectDetectionEnabled) {
      disableObjectDetection();
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
    if (cameraRef.current) {
      cameraRef.current.pause();
    }
    stopCameraStream();
  };

  const enableObjectDetection = async () => {
    if (objectDetectionEnabled) {
      return;
    }
    if (gesturesEnabled) {
      disableGestures();
    }
    try {
      const sessionId = ++objectSessionRef.current;
      setObjectStatus('Starting camera...');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      if (sessionId !== objectSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (cameraRef.current) {
        cameraRef.current.srcObject = stream;
        await cameraRef.current.play();
      }
      setObjectDetectionEnabled(true);
      setObjectStatus('Object detection on');
      startObjectLoop();
    } catch {
      setObjectStatus('Camera permission blocked.');
    }
  };

  const disableObjectDetection = () => {
    objectSessionRef.current += 1;
    setObjectDetectionEnabled(false);
    setObjectStatus('');
    setObjectLatency(null);
    if (detectFrameRef.current) {
      cancelAnimationFrame(detectFrameRef.current);
      detectFrameRef.current = null;
    }
    if (cameraRef.current) {
      cameraRef.current.pause();
    }
    stopCameraStream();
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
                <button
                  className={`btn ghost ${objectDetectionEnabled ? 'active' : ''}`}
                  onClick={objectDetectionEnabled ? disableObjectDetection : enableObjectDetection}
                >
                  {objectDetectionEnabled ? 'Object detection on' : 'Object detection off'}
                </button>
              </div>
            ) : null}
          </div>
        </header>

        {isCharacterSlide ? (
          <aside className="einstein-chat">
            <div className="einstein-chat-header">{activeCharacterName} Chat</div>
            <div className="einstein-chat-body">
              {activeCharacterHistory.slice(-8).map((msg, idx) => (
                <div
                  key={`${msg.role}-${idx}`}
                  className={`einstein-chat-line ${msg.role === 'user' ? 'user' : 'assistant'}`}
                >
                  <span className="einstein-chat-role">{msg.role === 'user' ? 'You' : activeCharacterName}:</span>
                  <span className="einstein-chat-text">{msg.content}</span>
                </div>
              ))}
              {characterReply && !activeCharacterHistory.some((m) => m.content === characterReply) ? (
                <div className="einstein-chat-line assistant">
                  <span className="einstein-chat-role">{activeCharacterName}:</span>
                  <span className="einstein-chat-text">{characterReply}</span>
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}

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
            {objectStatus ? <div className="speech-preview">{objectStatus}</div> : null}
            {objectLatency !== null ? (
              <div className="speech-preview">Object latency: {objectLatency}ms</div>
            ) : null}
            {isCharacterSlide ? (
              <div className="speech-preview">
                {isCharacterRecording
                  ? `${activeCharacterName}: listening...`
                  : isCharacterThinking
                    ? `${activeCharacterName}: thinking...`
                      : `${activeCharacterName}: ready.`}
                {characterReply ? ` “${characterReply}”` : ''}
              </div>
            ) : null}
            {characterError ? <div className="speech-preview speech-error">{characterError}</div> : null}
            {uploadError ? <div className="speech-preview speech-error">{uploadError}</div> : null}
            {error ? <div className="error-box">{error}</div> : null}
          </div>
          <div className="story-actions">
            {isCharacterSlide ? (
              <button
                className="btn accent"
                onClick={isCharacterRecording ? stopCharacterRecording : startCharacterRecording}
                disabled={isCharacterThinking}
              >
                {isCharacterRecording
                  ? 'Stop'
                  : isCharacterThinking
                    ? 'Thinking...'
                      : `Talk to ${activeCharacterName}`}
              </button>
            ) : null}
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
      {isVoiceAgentSlide ? (
        <button
          className={`voice-fab ${voiceStatus === 'connected' ? 'is-live' : ''}`}
          onClick={startVoiceAgent}
          disabled={voiceStatus === 'connecting'}
        >
          <span className="voice-dot" />
          {voiceStatus === 'connected'
            ? 'End call'
            : voiceStatus === 'connecting'
              ? 'Connecting...'
              : `Talk to ${activeVoiceAgent?.label ?? 'agent'}`}
        </button>
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
