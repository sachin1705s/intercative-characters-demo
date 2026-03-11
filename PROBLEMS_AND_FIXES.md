# Build Problems & Fixes — Luna Deploy (odyssey-storybook2)

A record of every significant issue encountered during development and deployment of this project, with root causes and solutions.

---

## 1. HMR Causes Stale WebRTC State (Odyssey SDK)

**Problem:** During development, when Vite's Hot Module Replacement (HMR) updated a file, the `OdysseyService` WebRTC connection from the previous session was still alive in memory. The new module instance would call `startStream()`, but the old stale connection silently blocked it — the stream never started without a full page reload.

**Fix:** Disabled HMR for `App.tsx` by calling `import.meta.hot.decline()` at the top of the file. This forces a full page reload instead of a hot swap whenever the file changes.

```ts
// App.tsx
if (import.meta.hot) {
  (import.meta.hot as any).decline();
}
```

**Lesson:** Any SDK that holds live WebSocket/WebRTC connections (like Odyssey) will break with HMR. Always force full reloads when using such SDKs during development.

---

## 2. Odyssey `onStatusChange('connected')` Fires Multiple Times

**Problem:** Odyssey's `onStatusChange` callback was firing `'connected'` more than once, causing the app to call `startStream()` multiple times for the same slide. This resulted in duplicate or conflicting stream start requests.

**Fix:** Added a guard using `streamingSlideIdRef` to track which slide's stream is currently active. The effect skips re-starting if the slide ID matches and the state is already `'streaming'` or `'starting'`.

```ts
if (streamingSlideIdRef.current === slide.id &&
    (streamStateRef.current === 'streaming' || streamStateRef.current === 'starting')) return;
```

**Lesson:** Treat third-party SDK event callbacks as potentially firing multiple times. Always guard against duplicate execution with refs or flags.

---

## 3. `better-sqlite3` Fails on Vercel (Read-only Filesystem)

**Problem:** `better-sqlite3` is a native Node.js addon. On Vercel serverless functions, the filesystem is read-only except for `/tmp/`. Attempting to open or write a SQLite file at the project root (`data.sqlite`) caused a runtime error and crashed the server function.

**Fix:**
- Detect Vercel environment via `process.env.VERCEL` and redirect the DB path to `/tmp/data.sqlite`.
- Wrapped the entire DB initialization in a `try/catch` so that if SQLite is unavailable (e.g., native module fails to load), the server degrades gracefully with persistence disabled.

```js
const DB_PATH = process.env.DATABASE_PATH ||
  (process.env.VERCEL ? '/tmp/data.sqlite' : 'data.sqlite');

try {
  db = new Database(DB_PATH);
  // ...
} catch (err) {
  console.warn('[db] SQLite unavailable, persistence disabled:', err.message);
}
```

**Lesson:** `better-sqlite3` requires native compilation and a writable filesystem. On Vercel, always use `/tmp/` and wrap initialization in a try/catch. Note: `/tmp/` data does NOT persist between Vercel invocations.

---

## 4. Rate Limiter Fails Behind Vercel's Proxy (Wrong Client IP)

**Problem:** `express-rate-limit` uses the client's IP address to track requests. Behind Vercel's reverse proxy, the IP visible to Express is the proxy's internal IP, not the real user's IP. This caused rate limiting to either not work (all requests counted as one IP) or block everything.

**Fix:** Set `app.set('trust proxy', 1)` so Express reads the real IP from the `X-Forwarded-For` header set by Vercel's proxy.

```js
app.set('trust proxy', 1);
```

**Lesson:** Any Express app deployed behind a proxy (Vercel, Heroku, Nginx, etc.) needs `trust proxy` set correctly, or IP-based features (rate limiting, logging) will not work as expected.

---

## 5. Helmet's COEP Header Blocks WebRTC

**Problem:** Helmet's default security headers include `Cross-Origin-Embedder-Policy: require-corp`. This header prevents the browser from establishing WebRTC peer connections (used by Odyssey for live video streaming), causing the stream to silently fail or throw CORS-related errors.

**Fix:** Disabled `crossOriginEmbedderPolicy` in the Helmet configuration.

```js
helmet({
  crossOriginEmbedderPolicy: false, // WebRTC needs this off
  // ...
})
```

**Lesson:** Helmet's default COEP setting breaks WebRTC. Always disable it when using any real-time streaming or peer-to-peer technology.

---

## 6. Image URLs With Spaces/Special Characters Break Fetch

**Problem:** Slide image paths like `/images/output (1).png` contain spaces and parentheses. Passing these directly to `fetch()` or as CSS `background-image` URLs caused 404 errors because the URL was not properly encoded.

**Fix:** Applied `encodeURI()` to all image URLs before using them in fetch calls or CSS.

```ts
const slideImageUrl = encodeURI(slide.image);
// and in loadImageFile:
const response = await fetch(encodeURI(url));
```

**Lesson:** Always `encodeURI()` file paths that come from data files (JSON, etc.) before using them in URLs. Spaces and parentheses are valid in filenames but not in raw URLs.

---

## 7. Vercel Serverless Routing — `/api/*` Not Reaching the Server

**Problem:** The Vercel deployment was not routing `/api/` requests to the Express server function. Without explicit rewrites, Vercel treats each file in the `api/` directory as a separate function, but this project uses a single Express app as the entry point.

**Fix:** Added explicit rewrites in `vercel.json` to route all `/api/*` traffic to the single `api/server.js` function, and configured function memory/timeout limits.

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/server" }
  ],
  "functions": {
    "api/server.js": {
      "memory": 512,
      "maxDuration": 30
    }
  }
}
```

**Lesson:** When using a single Express app as a Vercel function (instead of individual route files), always add `rewrites` in `vercel.json` to direct all API traffic to that single entry point.

---

## 8. `better-sqlite3` Native Module Not Available in Vercel Serverless

**Problem:** `better-sqlite3` requires a native compiled binary (`.node` file). Vercel's serverless runtime does not support arbitrary native addons — the binary must match the Lambda runtime architecture (Amazon Linux x86_64 or ARM). Local Windows/macOS builds produce incompatible binaries.

**Mitigation:** Graceful fallback in the database initialization (see Problem 3). When `better-sqlite3` fails to load, the server continues running without database persistence.

**Lesson:** Avoid native Node.js addons (`better-sqlite3`, `sharp`, `canvas`, etc.) in Vercel serverless functions unless you explicitly rebuild them for the target runtime. Consider using a managed database (e.g., Vercel KV, PlanetScale, Supabase) instead.

---

## 9. Gemini API 429 Rate Limiting on Gesture Vision

**Problem:** The `/api/gesture-vision` endpoint calls the Gemini API on every camera frame capture (every ~600ms). Under active use (especially with gestures enabled), this quickly hit Gemini's free-tier rate limits, returning 429 errors and breaking gesture detection.

**Fix:**
- Added a server-side cooldown (`GEMINI_GESTURE_COOLDOWN_MS = 500ms`) so the client doesn't send frames too frequently.
- On 429 responses, the server returns a `retryAfterMs` value and the client backs off using `visionRetryAtRef`.
- Added a separate `aiLimiter` (40 req/min) rate limit specifically for AI endpoints.

```ts
if (response.status === 429) {
  const data = await response.json();
  visionRetryAtRef.current = Date.now() + (data.retryAfterMs ?? 10000);
  return;
}
```

**Lesson:** When polling an AI API from camera frames, always implement client-side cooldowns, server-side rate limits, and exponential backoff on 429 errors.

---

## 10. Stale `streamState` Inside Callbacks (Closure Capture Problem)

**Problem:** React state (like `streamState`) captured inside `useEffect` callbacks or event handlers becomes stale — the closure holds the value from the render cycle when the effect ran, not the current value. This caused conditions like "is currently streaming?" to return wrong answers inside async callbacks.

**Fix:** Used a `streamStateRef` that mirrors `streamState` and is updated on every render. Refs are always up-to-date inside closures.

```ts
const streamStateRef = useRef<StreamState>('idle');
streamStateRef.current = streamState; // always current
```

**Lesson:** Never read React state from inside async callbacks, timers, or WebRTC event handlers. Mirror state to a `useRef` and read the ref instead.

---

## 11. `@mediapipe/tasks-vision` Replaced by Gemini Vision API

**Problem:** The original plan included using MediaPipe's hand tracking (`@mediapipe/tasks-vision`) directly in the browser for gesture detection. This had multiple issues:
- Large WASM bundle size affecting load times.
- Complex setup for model loading, hand landmark processing, and gesture classification.
- Inconsistent cross-browser WASM support.

**Fix:** Replaced local MediaPipe inference with server-side Gemini Vision API calls. The browser captures a frame from the camera, sends it as a base64 JPEG to `/api/gesture-vision`, and Gemini classifies the gesture. This is simpler, more accurate, and requires no WASM.

**Note:** `@mediapipe/tasks-vision` is still listed in `package.json` but is no longer used in the code. It can be removed.

**Lesson:** Browser-side ML inference (WASM models) adds significant complexity and bundle size. For low-frequency tasks like gesture detection every 600ms, server-side API calls are simpler and often more accurate.

---

## 12. Vite Dev Server Port vs Express Port Mismatch

**Problem:** Vite dev server runs on port 5173 (default) while Express runs on port 8787. API calls from the frontend (`fetch('/api/...')`) go to the Vite server but need to reach Express.

**Fix:** Configured Vite's proxy in `vite.config.ts` to forward all `/api/*` requests to `localhost:8787`.

```ts
server: {
  proxy: {
    '/api': 'http://localhost:8787'
  }
}
```

**Lesson:** Always configure Vite's proxy when running a separate API server in development. This also means the production Vercel deployment (which handles routing via `vercel.json`) mirrors the dev setup correctly.

---

## 13. Port 8787 Already in Use on Restart

**Problem:** When the Express server crashes or is killed improperly, the port 8787 can remain in use on Windows. Restarting the dev server then fails with `EADDRINUSE`.

**Fix:** Added an explicit `EADDRINUSE` error handler in the server that prints a clear message.

```js
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${port} is already in use. Kill the existing process and try again.`);
  }
  process.exit(1);
});
```

**To resolve manually on Windows:**
```bash
netstat -ano | findstr :8787
taskkill /PID <PID> /F
```

**Lesson:** Always handle `EADDRINUSE` explicitly. On Windows, processes holding ports aren't always cleaned up automatically.

---

## 14. Moderation Failures (Odyssey) Should Not Surface as Errors

**Problem:** Odyssey can reject a stream or interact request due to content moderation (`moderation_failed`). Initially, these were surfaced to the user as red error banners, which was confusing — it looked like a technical failure rather than a content policy event.

**Fix:** Filtered out `moderation_failed` from the error display. The stream ends silently (or with a neutral status) when moderation triggers.

```ts
onStreamError: (reason, message) => {
  if (reason === 'moderation_failed') { setError(null); return; }
  setError(`${reason}: ${message}`);
},
onError: (err) => {
  if (err.message?.includes('moderation_failed')) { setError(null); return; }
  setError(err.message);
},
```

**Lesson:** Treat content moderation rejections as a normal flow event, not an error. Don't alarm users with technical-looking error messages for policy-driven outcomes.

---

## Summary Table

| # | Problem | Root Cause | Fix |
|---|---------|-----------|-----|
| 1 | Stale WebRTC after HMR | Vite HMR doesn't reset SDK state | `import.meta.hot.decline()` |
| 2 | Duplicate `onStatusChange('connected')` | Odyssey SDK fires event multiple times | Guard with `streamingSlideIdRef` |
| 3 | SQLite fails on Vercel | Read-only filesystem, wrong path | Use `/tmp/data.sqlite`, try/catch fallback |
| 4 | Rate limiter wrong IP | Reverse proxy hides real IP | `app.set('trust proxy', 1)` |
| 5 | WebRTC blocked by COEP | Helmet's default headers | `crossOriginEmbedderPolicy: false` |
| 6 | Image 404 with spaces in filename | Unencoded URL characters | `encodeURI()` on all image paths |
| 7 | `/api/*` 404 on Vercel | Missing rewrite rules | Add `rewrites` in `vercel.json` |
| 8 | Native addon incompatible with Vercel | Platform mismatch | Graceful fallback, avoid native addons |
| 9 | Gemini 429 on gesture vision | Too many API calls per second | Client cooldown + server rate limit + backoff |
| 10 | Stale state in callbacks | React closure captures old state | Mirror state to `useRef` |
| 11 | MediaPipe too complex | WASM bundle, browser compat | Replaced with Gemini Vision API |
| 12 | Frontend can't reach API in dev | Port mismatch | Vite proxy config |
| 13 | Port 8787 already in use | Process not cleaned up on Windows | `EADDRINUSE` handler + manual kill |
| 14 | Moderation errors shown as bugs | No special-case handling | Filter `moderation_failed` from error UI |
