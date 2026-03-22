import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import type { ConnectionStatus } from '@odysseyml/odyssey';
import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import { AtomsClient } from 'atoms-client-sdk';
import charactersData from './data/characters.json';
import { OdysseyService, loadImageFile, type StreamState } from './lib/odyssey';
import './App.css';

interface Character {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  image: string;
  prompt: string;
  cta: string;
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

const characters = (charactersData as { characters: Character[] }).characters;
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
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(characters[0]?.id ?? null);
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
  const [characterSources, setCharacterSources] = useState<{ title: string; url: string }[]>([]);
  const [characterError, setCharacterError] = useState<string | null>(null);
  const [characterHistory, setCharacterHistory] = useState<Record<string, Array<{ role: 'user' | 'assistant'; content: string }>>>({});
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
  void voiceError;
  void lastVoiceIntent;
  void lastVoiceEvent;
  void lastVoicePrompt;
  void lastVoiceActionAt;
  void lastVoiceSource;
  void lastVoiceHint;
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
  const retryStreamRef = useRef<(() => Promise<void>) | null>(null);
  const moderationRetryCountRef = useRef(0);
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
  const [clonedVoiceId, setClonedVoiceId] = useState<string | null>(null);
  const [voiceCloneStatus, setVoiceCloneStatus] = useState<'idle' | 'recording' | 'uploading' | 'ready' | 'error'>('idle');
  const [voiceCloneError, setVoiceCloneError] = useState<string | null>(null);
  const [voiceCloneDuration, setVoiceCloneDuration] = useState(0);
  const [showVoiceClone, setShowVoiceClone] = useState(false);
  const [streamNeedsGesture, setStreamNeedsGesture] = useState(false);
  const voiceCloneRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceCloneStreamRef = useRef<MediaStream | null>(null);
  const voiceCloneChunksRef = useRef<Blob[]>([]);
  const voiceCloneStartRef = useRef<number>(0);
  const voiceCloneDurationTimerRef = useRef<number | null>(null);

  const selectedCharacter = characters.find((item) => item.id === selectedCharacterId) ?? characters[0];
  const slide = selectedCharacter;
  const slideImageUrl = encodeURI(slide?.image ?? '');
  const isUploadSlide = false;
  const isCharacterSlide = true;
  const VOICE_AGENT_ID_BY_SLIDE: Record<string, { id: string; label: string }> = {
    'circus-lion': { id: '', label: 'Circus Lion' },
    'einstein': { id: '', label: 'Albert Einstein' }
  };
  const activeVoiceAgent = slide ? VOICE_AGENT_ID_BY_SLIDE[slide.id] : null;
  const isVoiceAgentSlide = Boolean(activeVoiceAgent);
  const activeCharacterName = slide?.title ?? 'Character';
  const activeCharacterHistory = slide ? characterHistory[slide.id] ?? [] : [];
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
    slideCtaRef.current = slide?.cta || 'Animate it';
  }, [slide?.cta]);


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
          const attach = () => {
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              videoRef.current.play()
                .then(() => setStreamNeedsGesture(false))
                .catch((e) => {
                  console.warn('[odyssey] video.play failed:', e);
                  setStreamNeedsGesture(true);
                });
            } else {
              setTimeout(attach, 100);
            }
          };
          attach();
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
            if (moderationRetryCountRef.current < 3 && retryStreamRef.current) {
              moderationRetryCountRef.current++;
              console.log(`[odyssey] moderation_failed — retrying (attempt ${moderationRetryCountRef.current})`);
              setStreamState('starting');
              const retry = retryStreamRef.current;
              setTimeout(() => {
                retry().catch(() => {
                  setStreamState('error');
                  setIsStreamingReady(false);
                });
              }, 1000);
            } else {
              setError(null);
            }
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
    moderationRetryCountRef.current = 0;
    setStreamState('starting');
    setIsStreamingReady(false);
    setError(null);

    const run = async () => {
      await service.endStream().catch(() => undefined);
      if (isUploadSlide) {
        retryStreamRef.current = null;
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
      const streamOptions = { prompt: slide.prompt, image: file, portrait: slide.id === 'characters-sudharshan' };
      retryStreamRef.current = async () => {
        await service.startStream(streamOptions);
      };
      console.log('[odyssey] calling startStream — slide:', slide.id, '| prompt:', slide.prompt?.slice(0, 60));
      await service.startStream(streamOptions);
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
  }, [connectionStatus, showLanding, selectedCharacterId, slide.id, slide.image, slide.prompt, isUploadSlide]);


  useEffect(() => {
    const preload = async (target: Character) => {
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
    if (slide) {
      preload(slide);
    }
  }, [slide, slideImageUrl]);

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

  const handleStartStreamPlayback = async () => {
    if (!videoRef.current) return;
    try {
      await videoRef.current.play();
      setStreamNeedsGesture(false);
    } catch (err) {
      console.warn('[odyssey] manual play failed:', err);
      setStreamNeedsGesture(true);
    }
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
      await client.startSession({ accessToken, mode: 'webcall', host, sampleRate: 48000 });
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
  void startVoiceAgent;

  const stopCharacterRecording = () => {
    if (!isCharacterRecording) {
      return;
    }
    characterRecorderRef.current?.stop();
  };

  const VOICE_BY_SLIDE_ID: Record<string, string> = {};

  const playCharacterTTS = async (text: string, slideId?: string) => {
    if (!ttsAudioCtxRef.current) {
      ttsAudioCtxRef.current = new AudioContext();
    }
    const ctx = ttsAudioCtxRef.current;
    console.log('[tts] playCharacterTTS called, text:', text.slice(0, 80));
    console.log('[tts] AudioContext state:', ctx ? ctx.state : 'null (no ctx)');
    if (!ctx) return;
    try {
      await ctx.resume();
      console.log('[tts] AudioContext resumed, state:', ctx.state);
      const slideVoiceId = slideId ? VOICE_BY_SLIDE_ID[slideId] : '';
      const resolvedVoiceId = slideVoiceId || clonedVoiceId;
      const ttsRes = await fetch('/api/character/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, character: activeCharacterName, ...(resolvedVoiceId ? { voiceId: resolvedVoiceId } : {}) })
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
      try {
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        console.log('[tts] decoded audio duration:', decoded.duration.toFixed(2), 's');
        const source = ctx.createBufferSource();
        source.buffer = decoded;
        source.connect(ctx.destination);
        source.start();
        console.log('[tts] audio playback started');
      } catch (err) {
        console.warn('[tts] decodeAudioData failed, falling back to HTMLAudioElement', err);
        const mime = ttsRes.headers.get('content-type') || 'audio/wav';
        const blob = new Blob([arrayBuffer], { type: mime });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        try {
          await audio.play();
          console.log('[tts] fallback audio playback started');
        } catch (playErr) {
          console.error('[tts] fallback audio play failed', playErr);
          setCharacterError('Audio playback was blocked. Click the page once, then try again.');
        }
      }
    } catch (err) {
      console.error('[tts] error', err);
      setCharacterError('TTS failed to play audio. Check the console for details.');
    }
  };

  const runCharacterInteraction = async (userText: string, slideId: string, characterName: string) => {
    const history = (characterHistory[slideId] ?? []).slice(-6);
    const SEARCH_TRIGGERS = [
      'today', 'current', 'latest', 'recent', 'news', 'now',
      'price', 'stock', 'weather', 'who is', 'what is', 'when did',
      'score', 'happened', '2024', '2025', '2026',
    ];
    const enableSearch = SEARCH_TRIGGERS.some((kw) => userText.toLowerCase().includes(kw));
    const chatResponse = await fetch('/api/character/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userText, history, character: characterName, enableSearch })
    });
    if (!chatResponse.ok) throw new Error('Character response failed');

    const chatData = await chatResponse.json() as { reply?: string; action?: string; objects?: string[]; sources?: { title: string; url: string }[] };
    const reply = String(chatData.reply ?? '').trim() || 'Hmm, fascinating.';
    const trimmedReply = reply.split(/\s+/).slice(0, 40).join(' ');
    const action = String(chatData.action ?? '').trim() || 'nod thoughtfully and gesture gently';
    const objects = Array.isArray(chatData.objects) ? chatData.objects.filter(Boolean).slice(0, 3) : [];

    setCharacterReply(trimmedReply);
    setCharacterSources(Array.isArray(chatData.sources) ? chatData.sources : []);
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
    playCharacterTTS(trimmedReply, slideId);
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

  // ─── Voice Cloning ─────────────────────────────────────────────────────────

  const submitVoiceClone = async (blob: Blob, mimeType: string) => {
    setVoiceCloneStatus('uploading');
    setVoiceCloneError(null);
    try {
      const formData = new FormData();
      const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp') ? 'mp3' : 'webm';
      formData.append('audio', blob, `voice_sample.${ext}`);
      formData.append('name', `my-voice-${Date.now()}`);
      const res = await fetch('/api/voice-clone', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed.' })) as { error?: string };
        throw new Error(err.error ?? 'Voice clone failed.');
      }
      const data = await res.json() as { voiceId: string };
      setClonedVoiceId(data.voiceId);
      setVoiceCloneStatus('ready');
    } catch (err) {
      setVoiceCloneError(err instanceof Error ? err.message : 'Voice clone failed.');
      setVoiceCloneStatus('error');
    }
  };

  const stopVoiceCloneRecording = () => {
    if (voiceCloneRecorderRef.current?.state === 'recording') {
      voiceCloneRecorderRef.current.stop();
    }
    if (voiceCloneDurationTimerRef.current) {
      window.clearInterval(voiceCloneDurationTimerRef.current);
      voiceCloneDurationTimerRef.current = null;
    }
  };

  const startVoiceCloneRecording = async () => {
    if (voiceCloneStatus === 'recording') {
      stopVoiceCloneRecording();
      return;
    }
    setVoiceCloneError(null);
    setVoiceCloneDuration(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 44100, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      voiceCloneStreamRef.current = stream;
      voiceCloneChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')
        ? 'audio/webm;codecs=pcm'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      voiceCloneRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) voiceCloneChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        voiceCloneStreamRef.current?.getTracks().forEach((t) => t.stop());
        voiceCloneStreamRef.current = null;
        if (voiceCloneDurationTimerRef.current) {
          window.clearInterval(voiceCloneDurationTimerRef.current);
          voiceCloneDurationTimerRef.current = null;
        }
        const blob = new Blob(voiceCloneChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        voiceCloneChunksRef.current = [];
        const duration = (Date.now() - voiceCloneStartRef.current) / 1000;
        if (duration < 10) {
          setVoiceCloneError(`Recording too short (${duration.toFixed(1)}s). Please record at least 10 seconds.`);
          setVoiceCloneStatus('error');
          return;
        }
        submitVoiceClone(blob, recorder.mimeType || 'audio/webm');
      };

      voiceCloneStartRef.current = Date.now();
      recorder.start();
      setVoiceCloneStatus('recording');
      voiceCloneDurationTimerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - voiceCloneStartRef.current) / 1000);
        setVoiceCloneDuration(elapsed);
        // Auto-stop at 15 seconds (SDK maximum)
        if (elapsed >= 15) {
          if (voiceCloneRecorderRef.current?.state === 'recording') {
            voiceCloneRecorderRef.current.stop();
          }
        }
      }, 500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('NotFoundError')) {
        setVoiceCloneError('No microphone found. Please connect a mic or use "Upload audio" instead.');
      } else if (msg.includes('Permission') || msg.includes('NotAllowed')) {
        setVoiceCloneError('Microphone access denied. Allow mic access in your browser settings.');
      } else {
        setVoiceCloneError(msg || 'Microphone access blocked.');
      }
      setVoiceCloneStatus('error');
    }
  };

  const handleVoiceCloneFile = (file: File) => {
    const supported = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg'];
    if (!supported.includes(file.type)) {
      setVoiceCloneError('Unsupported format. Please upload a WAV, MP3, WebM, or OGG file (not M4A/AAC).');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setVoiceCloneError('File too large (max 50MB).');
      return;
    }
    setVoiceCloneError(null);
    submitVoiceClone(file, file.type);
  };

  // ───────────────────────────────────────────────────────────────────────────

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

  const handleSelectCharacter = (id: string) => {
    setSelectedCharacterId(id);
    setShowLanding(false);
  };

  if (showLanding) {
    return (
      <div className="app landing-shell">
        <div className="landing-hero">
          <div className="landing-hero-bg" aria-hidden />
          <header className="landing-topbar">
            <div className="brand">
              <span className="brand-mark">Interact Studio</span>
            </div>
            <div className="landing-actions">
              <button className="btn ghost" onClick={() => { setSelectedCharacterId(null); setShowLanding(false); }}>About us</button>
              <a className="btn primary" href="mailto:sachin.37.73.17@gmail.com">Get in touch</a>
            </div>
          </header>

          <section className="landing-intro">
            <p className="eyebrow">Interactive media</p>
            <h1 className="hero-title">Talk to characters</h1>
            <p className="landing-subtitle">
              Watch the world respond in real time.
            </p>
          </section>
        </div>

        <main className="landing-body">
          <section className="landing-section">
            <div className="landing-section-header">
              <div>
                <h2>Characters</h2>
              </div>
            </div>
            <div className="card-grid">
              {characters.map((character) => (
                <button
                  key={character.id}
                  className={`character-card ${selectedCharacterId === character.id ? 'active' : ''}`}
                  onClick={() => handleSelectCharacter(character.id)}
                >
                  <div
                    className="character-card-media"
                    style={{ backgroundImage: `url("${encodeURI(character.image)}")` }}
                    aria-hidden
                  />
                  <div className="character-card-body">
                    <span className="card-tag">Live</span>
                    <h3>{character.title}</h3>
                    <p>{character.body}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
          <footer className="landing-footer">
            <div className="landing-footer-title">Interact Studio</div>
            <div className="landing-footer-links">
              <span>Join our community:</span>
              <a href="https://discord.gg/bSx4Vhyc" target="_blank" rel="noreferrer">Discord</a>
              <span className="footer-sep">|</span>
              <a href="#" className="footer-muted">X</a>
            </div>
            <div className="landing-footer-line" />
          </footer>
        </main>
      </div>
    );
  }

  if (!showLanding && !selectedCharacterId) {
    return (
      <div className="app landing-shell about-page">
        <div className="landing-hero">
          <div className="landing-hero-bg" aria-hidden />
          <header className="landing-topbar">
            <div className="brand">
              <span className="brand-mark">Interact Studio</span>
            </div>
            <div className="landing-actions">
              <button className="btn ghost" onClick={() => setShowLanding(true)}>Back</button>
              <a className="btn primary" href="mailto:sachin.37.73.17@gmail.com">Get in touch</a>
            </div>
          </header>
          <section className="landing-intro">
            <p className="eyebrow">About us</p>
            <h1 className="hero-title">We build worlds that listen.</h1>
            <p className="landing-subtitle">
              Interact Studio is an experiment in live storytelling. We blend world models,
              generative media, and voice to create characters that feel present, responsive,
              and emotionally expressive. Our goal is simple: make conversation move the world.
            </p>
          </section>
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
                <button
                  className={`btn ghost ${clonedVoiceId ? 'active' : ''}`}
                  onClick={() => { setShowVoiceClone((p) => !p); setSettingsOpen(false); }}
                >
                  {clonedVoiceId ? 'Voice cloned ✓' : 'Clone voice'}
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
                  {characterSources.length > 0 && (
                    <div className="chat-sources">
                      {characterSources.map((s, i) => (
                        <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="chat-source-link">{s.title}</a>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}

        <main className="slide-shell" />

        <footer className="story-bar">
          <div className="story-text">
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
            {streamNeedsGesture ? (
              <button className="btn accent" onClick={handleStartStreamPlayback}>
                Start stream
              </button>
            ) : null}
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
        </div>
      </footer>
      </div>

      <video ref={cameraRef} className="camera-feed" playsInline muted />

      <canvas ref={canvasRef} className="camera-feed" />

      {showVoiceClone ? (
        <div className="voice-clone-panel">
          <div className="voice-clone-inner">
            <div className="voice-clone-header">
              <span>Clone Your Voice</span>
              <button className="btn ghost voice-clone-close" onClick={() => setShowVoiceClone(false)}>✕</button>
            </div>
            <p className="voice-clone-hint">
              Record or upload between <strong>10–15 seconds</strong> of your voice.
              It will be used to power the character TTS.
            </p>

            {clonedVoiceId ? (
              <div className="voice-clone-success">
                Voice cloned! Your voice is now active for TTS.
                <button
                  className="btn ghost"
                  style={{ marginTop: 8 }}
                  onClick={() => { setClonedVoiceId(null); setVoiceCloneStatus('idle'); setVoiceCloneDuration(0); }}
                >
                  Remove clone
                </button>
              </div>
            ) : (
              <>
                <div className="voice-clone-actions">
                  <button
                    className={`btn accent ${voiceCloneStatus === 'recording' ? 'active' : ''}`}
                    onClick={startVoiceCloneRecording}
                    disabled={voiceCloneStatus === 'uploading'}
                  >
                    {voiceCloneStatus === 'recording'
                      ? `Stop (${voiceCloneDuration}s)`
                      : voiceCloneStatus === 'uploading'
                        ? 'Processing...'
                        : 'Record voice'}
                  </button>
                  <label className="upload-pill">
                    <input
                      type="file"
                      accept="audio/wav,audio/mp3,audio/mpeg,audio/webm,audio/ogg,.wav,.mp3,.webm,.ogg"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVoiceCloneFile(f); e.target.value = ''; }}
                      disabled={voiceCloneStatus === 'recording' || voiceCloneStatus === 'uploading'}
                    />
                    <span>Upload audio</span>
                  </label>
                </div>
                {voiceCloneStatus === 'recording' && (
                  <div className="voice-clone-timer">
                    {voiceCloneDuration < 10
                      ? `Keep recording… ${10 - voiceCloneDuration}s to minimum`
                      : voiceCloneDuration < 15
                        ? `${voiceCloneDuration}s — tap Stop (auto-stops at 15s)`
                        : 'Finalising…'}
                  </div>
                )}
              </>
            )}

            {voiceCloneError ? <div className="voice-clone-error">{voiceCloneError}</div> : null}
          </div>
        </div>
      ) : null}
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
