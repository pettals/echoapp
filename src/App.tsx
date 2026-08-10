import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  AudioWaveform,
  Check,
  CheckCircle2,
  CircleDot,
  Copy,
  Eye,
  EyeOff,
  FileText,
  History,
  Home,
  Info,
  Keyboard,
  Mail,
  Mic,
  PartyPopper,
  Plus,
  Search,
  Settings as SettingsIcon,
  Square,
  Trash2,
  X,
} from "./components/AureoleIcons";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrent as getCurrentDeepLinks, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  exchangeCodeForSession,
  getFreshSession,
  getSession,
  onAuthStateChange,
  restorePersistedSession,
  sendPasswordReset,
  signInWithGoogle,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  summarizeSession,
  updatePassword,
  type AuthUserSummary,
  type SignUpProfile,
} from "./auth";
import {
  FREE_ENTITLEMENT,
  NO_PRO_PURCHASE_MESSAGE,
  ONLINE_PRO_REQUIRED_MESSAGE,
  clearActiveEntitlementUser,
  confirmCheckoutSession,
  createCheckoutSession,
  loadCachedEntitlement,
  refreshEntitlementFromServer,
  type EntitlementStatus,
} from "./entitlements";
import AudioHudIndicator, { type AudioHudIndicatorState } from "./components/AudioHudIndicator";
import AnimatedOrb from "./components/AnimatedOrb";
import ShortcutCapture from "./components/ShortcutCapture";
import {
  Alert,
  AnimatedIconSwap,
  Button,
  Chip,
  Disclosure,
  IconButton,
  InlineNotice,
  Progress,
} from "./components/ui";
import echoLogoMark from "./assets/app-tray-icon.png";
import "./App.css";

const Settings = lazy(() => import("./components/Settings"));

type AppState = "idle" | "recording" | "processing" | "success" | "copied" | "error";
type ActiveTab = "onboarding" | "dictate" | "notepad" | "history" | "settings";
type AuthStatus =
  | "loading"
  | "signedOut"
  | "signedIn"
  | "emailVerificationPending"
  | "passwordRecovery"
  | "error";
type DesktopPlatform = "macos" | "windows";
type DictationTarget = "external" | "standalone-notepad";
type IndicatorMode =
  | "idle"
  | "recording"
  | "processing"
  | "transcribing"
  | "pasting"
  | "success"
  | "copied"
  | "copied_no_target"
  | "error";
interface IndicatorPayload {
  mode: IndicatorMode;
  transcript?: string;
}
interface IndicatorLiveTranscriptPayload {
  transcript: string;
  targetIconUrl?: string;
  isFinal?: boolean;
}
interface IndicatorTargetPayload {
  targetIconUrl?: string;
}
interface IndicatorHoverPayload {
  expanded: boolean;
  label?: string;
}
export type AppearanceTheme = "system" | "light" | "dark";

export interface AppConfig {
  groq_api_key: string;
  shortcut: string;
  transcription_model: string;
  cleanup_model: string;
  cleanup_enabled: boolean;
  input_device: string | null;
  model_provider: "api" | "local";
  local_model_size: "small" | "medium";
  local_transcription_threads: number | null;
  sounds_enabled: boolean;
  indicator_sound: string;
  success_sound: string;
  onboarding_completed: boolean;
  history_enabled: boolean;
  history_limit: number;
  appearance_theme: AppearanceTheme;
  launch_at_login: boolean;
}

interface SecureSaveStatus {
  state: "verified" | "pending_verification" | "read_failed" | string;
  message: string;
}

interface ConfigSaveResult {
  config: AppConfig;
  secure_storage: SecureSaveStatus;
}

interface HistoryItem {
  id: string;
  text: string;
  created_at: string;
  paste_result: string;
}

interface StructuredAppError {
  code: string;
  message: string;
  retryable?: boolean;
  actionLabel?: string | null;
}

interface PasteTranscriptResult {
  status: string;
  warning?: StructuredAppError | null;
}

interface DictationStats {
  total_words: number;
  dictation_count: number;
  rolling_wpm: number;
  day_streak: number;
  next_milestone: number | null;
  next_milestone_progress: number;
}

function SettingsFallback() {
  return (
    <div className="settings-pane">
      <div className="page-heading page-heading--split">
        <div>
          <h2>Settings</h2>
        </div>
      </div>
      <div className="ui-card lazy-panel-fallback" role="status">
        <span>Preparing Settings</span>
      </div>
    </div>
  );
}

interface DictationStatsUpdate {
  stats: DictationStats;
  crossed_milestones: number[];
}

interface MilestoneCelebration {
  id: number;
  milestone: number;
}

interface NotepadNote {
  id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

interface SetupCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error" | string;
  message: string;
  action_label: string | null;
}

interface SetupStatus {
  ready: boolean;
  checks: SetupCheck[];
}

interface ModelStatus {
  downloaded: boolean;
  downloading: boolean;
  file_size_bytes: number;
  expected_size_bytes: number;
  integrity_checked: boolean;
  integrity_error: string | null;
  model_size: string;
}

interface ShortcutValidation {
  valid: boolean;
  message: string;
}

interface AppShortcutEvent {
  shortcut: string;
  state: "Started" | "Stopping" | "Stopped" | "StartFailed" | "StopFailed" | string;
  sessionId?: number;
  audioPath?: string;
  durationMs?: number;
  error?: StructuredAppError;
}

interface DictationPerformancePayload {
  phase: string;
  provider: string;
  model?: string | null;
  localModelSize?: string | null;
  audioDurationMs?: number | null;
  audioBytes?: number | null;
  speechCheckMs?: number | null;
  speechDetected?: boolean | null;
  modelCacheHit?: boolean | null;
  modelLoadMs?: number | null;
  audioDecodeMs?: number | null;
  inferenceMs?: number | null;
  cloudTranscribeMs?: number | null;
  cleanupMs?: number | null;
  pasteMs?: number | null;
  totalMs: number;
  threadCount?: number | null;
  errorCode?: string | null;
}

const WINDOW_LABEL = (() => {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
})();
const IS_INDICATOR_WINDOW = WINDOW_LABEL === "indicator" || WINDOW_LABEL.startsWith("indicator-");
const IS_PRIMARY_INDICATOR_WINDOW = WINDOW_LABEL === "indicator";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const NO_SPEECH_DETECTED = "NO_SPEECH_DETECTED";
const EMPTY_TRANSCRIPT_MESSAGE =
  "Echo captured audio, but there was not enough speech to transcribe. Hold the shortcut while speaking, then release when done.";
const WORD_MILESTONES = [100, 1_000, 2_000, 5_000, 7_500, 10_000, 20_000, 50_000, 100_000];
const INDICATOR_COMPACT_SIZE = { width: 56, height: 14 };
const INDICATOR_HOVER_SIZE = { width: 264, height: 74 };
const INDICATOR_IDLE_COLLAPSE_RESIZE_DELAY_MS = 680;
const INDICATOR_RECORDING_SIZES = {
  compact: { width: 420, height: 52 },
  short: { width: 420, height: 86 },
  medium: { width: 420, height: 110 },
  long: { width: 420, height: 132 },
};
const INDICATOR_COMPLETE_SIZE = { width: 132, height: 34 };
const INDICATOR_COPY_REVIEW_SIZE = { width: 420, height: 92 };
const INDICATOR_ERROR_SIZE = { width: 240, height: 72 };
const COPY_REVIEW_DURATION_MS = 5000;
const PANEL_TRANSITION = { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] as const };

const MOCK_CONFIG: AppConfig = {
  groq_api_key: "gsk_mock_preview_key",
  shortcut: "CommandOrControl+D",
  transcription_model: "whisper-large-v3-turbo",
  cleanup_model: "llama-3.1-8b-instant",
  cleanup_enabled: true,
  input_device: null,
  model_provider: "api",
  local_model_size: "small",
  local_transcription_threads: null,
  sounds_enabled: true,
  indicator_sound: "tink",
  success_sound: "glass",
  onboarding_completed: false,
  history_enabled: true,
  history_limit: 100,
  appearance_theme: "dark",
  launch_at_login: false,
};

const MOCK_SETUP_STATUS: SetupStatus = {
  ready: false,
  checks: [
    {
      id: "provider",
      label: "Provider",
      status: "ok",
      message: "Groq API key is ready.",
      action_label: null,
    },
    {
      id: "microphone",
      label: "Microphone",
      status: "warning",
      message: "Test your microphone in Input settings.",
      action_label: "Open Settings",
    },
    {
      id: "shortcut",
      label: "Shortcut",
      status: "ok",
      message: "Shortcut format looks valid.",
      action_label: null,
    },
    {
      id: "paste",
      label: "Paste permission",
      status: "warning",
      message: "Enable Accessibility on macOS so Echo can paste automatically.",
      action_label: "Open Accessibility",
    },
  ],
};

const MOCK_STATS: DictationStats = {
  total_words: 230,
  dictation_count: 7,
  rolling_wpm: 69,
  day_streak: 2,
  next_milestone: 1_000,
  next_milestone_progress: 0.23,
};

const MOCK_HISTORY: HistoryItem[] = [
  {
    id: "mock-1",
    text: "Just a quick test.",
    created_at: new Date("2026-05-13T13:55:00").toISOString(),
    paste_result: "pasted",
  },
  {
    id: "mock-2",
    text: "Draft the intro and keep it short.",
    created_at: new Date("2026-05-13T13:57:00").toISOString(),
    paste_result: "copied",
  },
  {
    id: "mock-3",
    text: "Follow up after the meeting with the key decisions.",
    created_at: new Date("2026-05-13T14:04:00").toISOString(),
    paste_result: "pasted",
  },
];

const MOCK_NOTES: NotepadNote[] = [
  {
    id: "note-1",
    body: "# Meeting draft\n\nCapture the launch checklist and paste the polished version into the team doc later.",
    created_at: new Date("2026-05-13T14:12:00").toISOString(),
    updated_at: new Date("2026-05-13T14:18:00").toISOString(),
  },
  {
    id: "note-2",
    body: "Remember to test Notepad dictation with cleanup enabled and disabled.",
    created_at: new Date("2026-05-13T13:46:00").toISOString(),
    updated_at: new Date("2026-05-13T13:51:00").toISOString(),
  },
];

function detectDesktopPlatform(): DesktopPlatform {
  const override =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("platform")
      : null;

  if (override === "windows" || override === "macos") {
    return override;
  }

  const platform =
    typeof navigator !== "undefined"
      ? `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
      : "";

  if (platform.includes("win")) return "windows";
  return "macos";
}

function formatShortcutForPlatform(shortcut: string, platform: DesktopPlatform): string {
  return shortcut
    .split("CommandOrControl")
    .join(platform === "macos" ? "Command" : "Control")
    .split("+")
    .join("+");
}

function isStructuredAppError(error: unknown): error is StructuredAppError {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

function errorCode(error: unknown): string {
  if (isStructuredAppError(error)) return error.code;
  if (typeof error === "string") return error;
  return "";
}

function isEmptyTranscriptError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "empty_speech" ||
    code === "empty_response" ||
    formatErrorMessage(error) === NO_SPEECH_DETECTED
  );
}

function transcriptTextOrThrow(text: string): string {
  const transcript = text.trim();
  if (!transcript) {
    throw {
      code: "empty_response",
      message: EMPTY_TRANSCRIPT_MESSAGE,
      retryable: true,
      actionLabel: null,
    } satisfies StructuredAppError;
  }
  return transcript;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isStructuredAppError(error)) {
    const action = error.actionLabel ? ` ${error.actionLabel}.` : "";
    return `${error.message}${action}`;
  }
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function authUrlParams(url: URL) {
  const params = new URLSearchParams(url.search);
  if (url.hash) {
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    hashParams.forEach((value, key) => {
      if (!params.has(key)) params.set(key, value);
    });
  }
  return params;
}

async function emitIndicatorMode(mode: IndicatorMode, transcript?: string) {
  if (!HAS_TAURI) return;
  await emit("indicator-mode", { mode, transcript });
}

async function emitIndicatorLiveTranscript(transcript: string, isFinal = false) {
  if (!HAS_TAURI) return;
  await emit("indicator-live-transcript", { transcript, isFinal });
}

function listenSafely<T>(
  event: string,
  handler: (event: TauriEvent<T>) => void,
  onError?: (error: unknown) => void
) {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  listen<T>(event, handler)
    .then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    })
    .catch((error) => {
      onError?.(error);
    });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

function logDictationDelivery(
  phase: string,
  details: {
    accepted?: boolean;
    reason?: string;
    sessionId?: number | null;
    state?: string;
    source?: string;
  } = {}
) {
  console.debug("[dictation-delivery]", { phase, ...details });
}

function useResolvedTheme(theme: AppearanceTheme): "light" | "dark" {
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined" || !window.matchMedia) return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemTheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return theme === "system" ? systemTheme : theme;
}

function normalizeTheme(value: string | undefined): AppearanceTheme {
  return value === "light" || value === "dark" || value === "system" ? value : "dark";
}

function getLocalDateKey(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function countDictationWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && /[\p{L}\p{N}]/u.test(word)).length;
}

function formatInsightNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatMilestone(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatDurationMs(value?: number | null): string {
  if (value == null) return "n/a";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function useRecordingLevel(active: boolean): number {
  const [level, setLevel] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const visualLevelRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      visualLevelRef.current = 0;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    pollRef.current = setInterval(async () => {
      if (!HAS_TAURI) return;

      try {
        const nextLevel = await invoke<number>("get_recording_level");
        const target = Math.min(Math.max(nextLevel, 0), 1);
        const next = visualLevelRef.current * 0.58 + target * 0.42;
        visualLevelRef.current = next;
        setLevel(next);
      } catch {
        /* ignore */
      }
    }, 40);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [active]);

  return level;
}

function App() {
  const showHudPreview =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("hudPreview") === "true";
  const showOrbPreview =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("orbPreview") === "true";

  if (showHudPreview) {
    return <HudPreviewScreen />;
  }

  if (showOrbPreview) {
    return <OrbPreviewScreen />;
  }

  if (IS_INDICATOR_WINDOW) {
    return <DockIndicator />;
  }

  if (WINDOW_LABEL === "notepad") {
    return <StandaloneNotepadWindow />;
  }

  return <MainApp />;
}

function mapIndicatorToHudState(mode: IndicatorMode): AudioHudIndicatorState {
  if (mode === "success" || mode === "copied") return "complete";
  if (mode === "copied_no_target") return "copy";
  if (mode === "transcribing" || mode === "pasting") return "processing";
  return mode;
}

function liveTranscriptTier(transcript = ""): keyof typeof INDICATOR_RECORDING_SIZES {
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return "compact";
  if (wordCount <= 16) return "short";
  if (wordCount <= 36) return "medium";
  return "long";
}

function indicatorSizeForMode(mode: IndicatorMode, expanded: boolean, liveTranscript = "") {
  if (mode === "idle") return expanded ? INDICATOR_HOVER_SIZE : INDICATOR_COMPACT_SIZE;
  if (mode === "recording" || mode === "processing" || mode === "transcribing" || mode === "pasting") {
    return INDICATOR_RECORDING_SIZES[liveTranscriptTier(liveTranscript)];
  }
  if (mode === "copied_no_target") return INDICATOR_COPY_REVIEW_SIZE;
  if (mode === "error") return INDICATOR_ERROR_SIZE;
  return INDICATOR_COMPLETE_SIZE;
}

function OrbPreviewScreen() {
  return (
    <main className="orb-preview-screen">
      <section className="orb-preview-stage" aria-label="Animated orb preview">
        <AnimatedOrb className="orb-preview-orb orb-preview-orb--large" size="clamp(154px, 31vmin, 461px)" intensity={1.14} speed={2.1} />
      </section>
    </main>
  );
}

function HudPreviewScreen() {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const previewExpanded =
    params?.get("hudExpanded") === "true";
  const previewStateParam = params?.get("hudState");
  const previewState: AudioHudIndicatorState =
    previewStateParam === "recording" ||
    previewStateParam === "processing" ||
    previewStateParam === "complete" ||
    previewStateParam === "copy" ||
    previewStateParam === "error"
      ? previewStateParam
      : "idle";
  const previewLevel = Math.min(Math.max(Number(params?.get("hudLevel") ?? 0.72), 0), 1);
  const previewTranscript = params?.get("hudTranscript") ?? "";
  const previewIndicatorMode: IndicatorMode =
    previewState === "complete" ? "success" : previewState === "copy" ? "copied_no_target" : previewState;
  const previewFrameSize = indicatorSizeForMode(
    previewIndicatorMode,
    previewState === "idle" && previewExpanded,
    previewTranscript
  );

  return (
    <main className="hud-preview-screen">
      <section className="hud-preview-stage" aria-label="Audio HUD preview">
        <div
          className="hud-preview-frame recording-hud-shell--platform-macos"
          style={{ width: previewFrameSize.width, height: previewFrameSize.height }}
        >
          <AudioHudIndicator
            state={previewState}
            level={previewLevel}
            expanded={previewState === "idle" && previewExpanded}
            copyText="Here is the transcript ready to copy when Echo cannot find the last focused text field."
            liveTranscript={previewTranscript}
            copyCountdownMs={3600}
            errorMessage="Open Echo for the next step."
            completeLabel="Pasted"
            shortcutLabel="Command + D"
            notepadLabel="Notepad"
            onPrimaryAction={() => {}}
            onConfirm={() => {}}
            onNotepadAction={() => {}}
          />
        </div>
      </section>
    </main>
  );
}

function DockIndicator() {
  const [mode, setMode] = useState<IndicatorMode>("idle");
  const [appearanceTheme, setAppearanceTheme] = useState<AppearanceTheme>("dark");
  const [shortcutLabel, setShortcutLabel] = useState(MOCK_CONFIG.shortcut);
  const [copyText, setCopyText] = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [liveTranscriptFinal, setLiveTranscriptFinal] = useState(false);
  const [targetIconUrl, setTargetIconUrl] = useState<string | undefined>();
  const [copyCountdownMs, setCopyCountdownMs] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(expanded);
  const prevRecording = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIndicatorSizeRef = useRef<{ width: number; height: number } | null>(null);
  const platform = detectDesktopPlatform();
  const recording = mode === "recording";
  const hudState = mapIndicatorToHudState(mode);
  const level = useRecordingLevel(recording);
  const resolvedTheme = useResolvedTheme(appearanceTheme);
  const completeLabel = mode === "copied" || mode === "copied_no_target" ? "Copied" : "Pasted";
  const processingLabel =
    mode === "pasting" ? "Pasting" : mode === "transcribing" ? "Transcribing" : undefined;
  const processingPlaceholder =
    mode === "pasting" ? "Pasting" : mode === "transcribing" ? "Transcribing" : undefined;

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    if (mode !== "idle" && expanded) {
      setExpanded(false);
    }
  }, [mode, expanded]);

  useEffect(() => {
    if (!HAS_TAURI || !IS_PRIMARY_INDICATOR_WINDOW) return;
    invoke("set_indicator_hover_tracking_enabled", {
      enabled: platform === "macos" && mode === "idle",
    }).catch(() => {});

    return () => {
      if (platform === "macos") {
        invoke("set_indicator_hover_tracking_enabled", { enabled: false }).catch(() => {});
      }
    };
  }, [mode, platform]);

  useEffect(() => {
    if (!HAS_TAURI || !IS_PRIMARY_INDICATOR_WINDOW) return;

    let cancelled = false;
    const targetSize = indicatorSizeForMode(mode, expanded, liveTranscript);
    const collapsingIdle =
      mode === "idle" &&
      !expanded &&
      lastIndicatorSizeRef.current &&
      Math.abs(lastIndicatorSizeRef.current.width - INDICATOR_HOVER_SIZE.width) < 0.5 &&
      Math.abs(lastIndicatorSizeRef.current.height - INDICATOR_HOVER_SIZE.height) < 0.5;

    const resizeIndicator = async (force = false) => {
      try {
        if (cancelled) return;
        const lastSize = lastIndicatorSizeRef.current;
        if (
          !force &&
          lastSize &&
          Math.abs(lastSize.width - targetSize.width) < 0.5 &&
          Math.abs(lastSize.height - targetSize.height) < 0.5
        ) {
          return;
        }
        await invoke("reposition_indicator", {
          width: targetSize.width,
          height: targetSize.height,
          force,
        });
        lastIndicatorSizeRef.current = targetSize;
      } catch {
        /* preview or hidden window */
      }
    };

    let collapseTimer: ReturnType<typeof setTimeout> | null = null;
    if (collapsingIdle) {
      collapseTimer = setTimeout(() => {
        void resizeIndicator();
      }, INDICATOR_IDLE_COLLAPSE_RESIZE_DELAY_MS);
    } else {
      resizeIndicator();
    }

    const refreshIndicatorPlacement = async () => {
      try {
        if (cancelled) return;
        await invoke("reposition_indicator", {
          width: targetSize.width,
          height: targetSize.height,
          force: false,
        });
      } catch {
        /* preview or hidden window */
      }
    };

    let dockPoll: ReturnType<typeof setInterval> | null = null;
    if (platform === "macos") {
      dockPoll = setInterval(() => {
        void refreshIndicatorPlacement();
      }, 500);
    }

    return () => {
      cancelled = true;
      if (dockPoll) {
        clearInterval(dockPoll);
      }
      if (collapseTimer) {
        clearTimeout(collapseTimer);
      }
    };
  }, [mode, expanded, liveTranscript, platform]);

  useEffect(() => {
    if (!HAS_TAURI || !IS_PRIMARY_INDICATOR_WINDOW) return;
    if (mode !== "idle") return;

    const refreshPosition = async () => {
      try {
        const targetSize = indicatorSizeForMode("idle", expandedRef.current);
        await invoke("reposition_indicator", {
          width: targetSize.width,
          height: targetSize.height,
          force: true,
        });
        lastIndicatorSizeRef.current = targetSize;
      } catch {
        /* ignore */
      }
    };

    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!payload) {
        void refreshPosition();
      }
    });

    void refreshPosition();

    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [mode]);

  useEffect(() => {
    if (!HAS_TAURI) {
      setAppearanceTheme(MOCK_CONFIG.appearance_theme);
      setShortcutLabel(MOCK_CONFIG.shortcut);
      return;
    }
    invoke<AppConfig>("get_config")
      .then((cfg) => {
        setAppearanceTheme(normalizeTheme(cfg.appearance_theme));
        setShortcutLabel(cfg.shortcut || MOCK_CONFIG.shortcut);
      })
      .catch(() => setAppearanceTheme("system"));
  }, []);

  useEffect(() => {
    if (!HAS_TAURI || !IS_PRIMARY_INDICATOR_WINDOW) return;
    invoke("show_idle_indicator")
      .then(() =>
        invoke("reposition_indicator", {
          width: INDICATOR_COMPACT_SIZE.width,
          height: INDICATOR_COMPACT_SIZE.height,
          force: true,
        })
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    let mounted = true;
    const poll = setInterval(async () => {
      if (!mounted) return;
      try {
        const isRec = await invoke<boolean>("is_recording");
        if (isRec) {
          setMode("recording");
        } else {
          setMode((current) => (current === "recording" ? "transcribing" : current));
        }
      } catch {
        /* preview or hidden window */
      }
    }, 150);

    return () => {
      mounted = false;
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    if (!HAS_TAURI) return;

    let unlistenMode: (() => void) | null = null;
    let unlistenTheme: (() => void) | null = null;
    let unlistenShortcut: (() => void) | null = null;
    let unlistenHover: (() => void) | null = null;
    let unlistenLiveTranscript: (() => void) | null = null;
    let unlistenTarget: (() => void) | null = null;

    listen<IndicatorPayload | IndicatorMode>("indicator-mode", (event) => {
      const payload = event.payload;
      const nextMode = typeof payload === "string" ? payload : payload.mode;
      setMode(nextMode);
      setCopyText(typeof payload === "string" ? "" : payload.transcript ?? "");
      if (nextMode === "recording") {
        setLiveTranscript("");
        setLiveTranscriptFinal(false);
      }
      if (nextMode === "idle" || nextMode === "copied_no_target" || nextMode === "error") {
        setLiveTranscript("");
        setLiveTranscriptFinal(false);
      }
    }).then((u) => {
      unlistenMode = u;
    });

    listen<AppearanceTheme>("appearance-theme-changed", (event) => {
      setAppearanceTheme(normalizeTheme(event.payload));
    }).then((u) => {
      unlistenTheme = u;
    });

    listen<string>("shortcut-changed", (event) => {
      setShortcutLabel(event.payload || MOCK_CONFIG.shortcut);
    }).then((u) => {
      unlistenShortcut = u;
    });

    listen<IndicatorHoverPayload>("indicator-hover", (event) => {
      if (
        platform === "macos" &&
        (!event.payload.label || event.payload.label === WINDOW_LABEL)
      ) {
        setExpanded(event.payload.expanded);
      }
    }).then((u) => {
      unlistenHover = u;
    });

    listen<IndicatorLiveTranscriptPayload>("indicator-live-transcript", (event) => {
      setLiveTranscript(event.payload.transcript ?? "");
      setLiveTranscriptFinal(Boolean(event.payload.isFinal));
      if (event.payload.targetIconUrl) {
        setTargetIconUrl(event.payload.targetIconUrl);
      }
    }).then((u) => {
      unlistenLiveTranscript = u;
    });

    listen<IndicatorTargetPayload>("indicator-target", (event) => {
      setTargetIconUrl(event.payload.targetIconUrl);
    }).then((u) => {
      unlistenTarget = u;
    });

    return () => {
      unlistenMode?.();
      unlistenTheme?.();
      unlistenShortcut?.();
      unlistenHover?.();
      unlistenLiveTranscript?.();
      unlistenTarget?.();
    };
  }, [platform]);

  useEffect(() => {
    if (!IS_PRIMARY_INDICATOR_WINDOW) return;
    if (recording && !prevRecording.current) {
      invoke("play_indicator_sound", { kind: "open" }).catch(() => {});
    } else if (!recording && prevRecording.current) {
      invoke("play_indicator_sound", { kind: "close" }).catch(() => {});
    }
    prevRecording.current = recording;
  }, [recording]);

  useEffect(() => {
    if (mode !== "copied_no_target") {
      setCopyCountdownMs(0);
      setCopyText("");
      return;
    }

    const expiresAt = Date.now() + COPY_REVIEW_DURATION_MS;
    const updateCountdown = () => {
      const remaining = Math.max(0, expiresAt - Date.now());
      setCopyCountdownMs(remaining);
      if (remaining <= 0) {
        setMode("idle");
        setCopyText("");
      }
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 100);
    return () => clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }

    if (mode === "idle") {
      return;
    }

    if (mode === "success" || mode === "copied" || mode === "error") {
      hideTimer.current = setTimeout(() => {
        setMode("idle");
      }, mode === "error" ? 6000 : 1600);
    }

    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [mode]);

  const handleStartRecording = useCallback(async () => {
    if (recording) return;
    try {
      await invoke("start_recording_from_indicator");
      setMode("recording");
    } catch {
      setMode("error");
    }
  }, [recording]);

  const handleConfirm = useCallback(
    async () => {
      if (mode === "success" || mode === "copied" || mode === "copied_no_target" || mode === "error") {
        setMode("idle");
        setCopyText("");
        return;
      }

      if (!recording) return;
      try {
        setMode("transcribing");
        await emit("tray-stop-recording");
      } catch {
        /* ignore */
      }
    },
    [mode, recording]
  );

  const handleCancel = useCallback(async () => {
    if (mode === "idle") return;
    try {
      setMode("idle");
      setCopyText("");
      await emit("indicator-cancel-recording");
    } catch {
      /* ignore */
    }
  }, [mode]);

  const handleCopyTranscript = useCallback(async () => {
    if (!copyText) return;
    try {
      await invoke("copy_transcript", { text: copyText });
    } catch {
      try {
        await navigator.clipboard?.writeText(copyText);
      } catch {
        /* ignore */
      }
    }
  }, [copyText]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void handleCancel();
      }

      if (event.key === "Enter") {
        event.preventDefault();
        void handleConfirm();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCancel, handleConfirm]);

  return (
    <div
      className={`window-root window-root--indicator recording-hud-shell recording-hud-shell--${hudState} recording-hud-shell--platform-${platform}`}
      data-theme={resolvedTheme}
      onPointerEnter={() => {
        if (platform !== "macos" && mode === "idle") {
          setExpanded(true);
        }
      }}
      onPointerLeave={() => {
        if (platform !== "macos") {
          setExpanded(false);
        }
      }}
    >
      <AudioHudIndicator
        state={hudState}
        expanded={mode === "idle" && expanded}
        level={level}
        errorMessage="Open Echo for the next step."
        canConfirm={mode === "recording"}
        completeLabel={completeLabel}
        statusLabel={processingLabel}
        livePlaceholder={processingPlaceholder}
        shortcutLabel={shortcutLabel}
        notepadLabel="Notepad"
        copyText={mode === "copied_no_target" ? copyText : ""}
        liveTranscript={liveTranscript}
        liveFinal={liveTranscriptFinal}
        targetIconUrl={targetIconUrl}
        copyCountdownMs={copyCountdownMs}
        onPrimaryAction={mode === "idle" ? handleStartRecording : undefined}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        onCopy={handleCopyTranscript}
        onNotepadAction={() => {
          invoke("show_notepad_window").catch((error) => {
            console.error("Failed to open standalone Notepad from HUD:", error);
          });
        }}
      />
    </div>
  );
}

function MainApp() {
  const platform = detectDesktopPlatform();
  const reduceMotion = useReducedMotion() ?? false;
  const [appState, setAppState] = useState<AppState>("idle");
  const [activeTab, setActiveTab] = useState<ActiveTab>("dictate");
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [stats, setStats] = useState<DictationStats>(MOCK_STATS);
  const [milestoneCelebration, setMilestoneCelebration] = useState<MilestoneCelebration | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [authUser, setAuthUser] = useState<AuthUserSummary | null>(null);
  const [authMessage, setAuthMessage] = useState("");
  const [entitlement, setEntitlement] = useState<EntitlementStatus>(FREE_ENTITLEMENT);
  const [entitlementMessage, setEntitlementMessage] = useState("");
  const [entitlementChecking, setEntitlementChecking] = useState(false);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [shortcutError, setShortcutError] = useState("");
  const [lastPerformance, setLastPerformance] = useState<DictationPerformancePayload[]>([]);
  const [appearancePreview, setAppearancePreview] = useState<AppearanceTheme | null>(null);
  const [onboardingCompletionVisible, setOnboardingCompletionVisible] = useState(false);
  const [onboardingFirstDictationPassed, setOnboardingFirstDictationPassed] = useState(false);
  const [onboardingDictationState, setOnboardingDictationState] = useState<"idle" | "recording" | "processing" | "success" | "error">("idle");
  const [onboardingDictationMessage, setOnboardingDictationMessage] = useState("");
  const contentMainColRef = useRef<HTMLDivElement | null>(null);
  const registeredShortcut = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const shortcutHeldRef = useRef(false);
  const startInFlightRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const activeShortcutSessionIdRef = useRef<number | null>(null);
  const processingSessionIdRef = useRef<number | null>(null);
  const deliveredSessionIdsRef = useRef<Set<number>>(new Set());
  const activeDeliveryAudioPathRef = useRef<string | null>(null);
  const consumedAudioPathsRef = useRef<Set<string>>(new Set());
  const offlineFallbackNoticeRef = useRef("");
  const notepadFocusedRef = useRef(false);
  const dictationTargetRef = useRef<DictationTarget>("external");
  const passwordRecoveryRef = useRef(false);
  const authSessionRef = useRef<Awaited<ReturnType<typeof getSession>>>(null);
  const authCallbackInFlightRef = useRef<Set<string>>(new Set());
  const completedAuthCallbackRef = useRef<Set<string>>(new Set());
  const googleSignInAttemptRef = useRef(0);
  const milestoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onboardingCompletionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDictationResultRef = useRef<string | null>(null);
  const resolvedTheme = useResolvedTheme(appearancePreview ?? config?.appearance_theme ?? "dark");
  const onboardingLocked =
    authStatus !== "signedIn" ||
    !config ||
    onboardingCompletionVisible ||
    activeTab === "onboarding" ||
    config.onboarding_completed === false;

  const setIndicatorMode = useCallback((mode: IndicatorMode, transcript?: string) => {
    emitIndicatorMode(mode, transcript).catch(() => {});
  }, []);

  const getAudioCtx = useCallback((): AudioContext | null => {
    try {
      if (!audioCtxRef.current) {
        const Ctor =
          (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        audioCtxRef.current = new Ctor();
      }
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const playChime = useCallback(async () => {
    if (config && !config.sounds_enabled) return;

    try {
      await invoke("play_chime");
      return;
    } catch (e) {
      console.warn("Native chime failed, falling back to Web Audio:", e);
    }

    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;

    const playTone = (freq: number, start: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.05);
    };

    playTone(1046.5, now, 0.18);
    playTone(1318.51, now + 0.09, 0.28);
  }, [config, getAudioCtx]);

  const loadConfig = useCallback(async () => {
    if (!HAS_TAURI) {
      setConfig(MOCK_CONFIG);
      return MOCK_CONFIG;
    }

    try {
      const cfg = await invoke<AppConfig>("get_config");
      let launchAtLogin = cfg.launch_at_login;
      try {
        launchAtLogin = await invoke<boolean>("get_launch_at_login");
      } catch (e) {
        console.warn("Launch-at-login status unavailable:", e);
      }
        const normalized = {
          ...cfg,
          appearance_theme: normalizeTheme(cfg.appearance_theme),
          local_transcription_threads: cfg.local_transcription_threads ?? null,
          launch_at_login: launchAtLogin,
        };
      setConfig(normalized);
      return normalized;
    } catch (e) {
      console.error("Failed to load config:", e);
      setConfig(MOCK_CONFIG);
      return MOCK_CONFIG;
    }
  }, []);

  const loadSetupStatus = useCallback(async () => {
    if (!HAS_TAURI) {
      setSetupStatus(MOCK_SETUP_STATUS);
      return MOCK_SETUP_STATUS;
    }

    try {
      const status = await invoke<SetupStatus>("get_setup_status");
      setSetupStatus(status);
      return status;
    } catch (e) {
      console.error("Failed to load setup status:", e);
      setSetupStatus(null);
      return null;
    }
  }, []);

  const applyAuthSession = useCallback((session: Awaited<ReturnType<typeof getSession>>) => {
    authSessionRef.current = session;
    const summary = summarizeSession(session);
    setAuthUser(summary);
    if (passwordRecoveryRef.current && session) {
      setAuthStatus("passwordRecovery");
      return;
    }
    setAuthStatus(summary ? "signedIn" : "signedOut");
  }, []);

  const routeAfterAuth = useCallback(async () => {
    const cfg = await loadConfig();
    if (!cfg || !cfg.onboarding_completed) {
      setActiveTab("onboarding");
      return;
    }
    if (cfg.model_provider === "api" && !cfg.groq_api_key) {
      setActiveTab("settings");
      return;
    }
    setActiveTab("dictate");
  }, [loadConfig]);

  const refreshEntitlement = useCallback(async (
    userId?: string | null,
    sessionOverride?: Awaited<ReturnType<typeof getSession>>,
    options?: { showFreeMessage?: boolean }
  ) => {
    const effectiveUserId = userId ?? authUser?.id;
    if (!effectiveUserId) {
      setEntitlementChecking(false);
      setEntitlement(FREE_ENTITLEMENT);
      setEntitlementMessage("");
      await clearActiveEntitlementUser().catch(() => {});
      return FREE_ENTITLEMENT;
    }

    setEntitlementChecking(true);
    let cached = FREE_ENTITLEMENT;
    try {
      cached = await loadCachedEntitlement(effectiveUserId);
      setEntitlement(cached);
    } catch (e) {
      console.warn("Could not load cached entitlement:", e);
    }

    try {
      const serverEntitlement = await refreshEntitlementFromServer(effectiveUserId, sessionOverride);
      setEntitlement(serverEntitlement);
      setEntitlementMessage(
        serverEntitlement.tier === "pro_lifetime"
          ? "Echo Pro is active."
          : options?.showFreeMessage
            ? NO_PRO_PURCHASE_MESSAGE
            : ""
      );
      return serverEntitlement;
    } catch (e) {
      console.warn("Could not refresh entitlement:", e);
      await clearActiveEntitlementUser().catch(() => {});
      const offlineEntitlement = {
        ...FREE_ENTITLEMENT,
        source: cached.source === "free" ? "offline" : "offline_stale",
      };
      setEntitlement(offlineEntitlement);
      setEntitlementMessage(formatErrorMessage(e));
      return offlineEntitlement;
    } finally {
      setEntitlementChecking(false);
    }
  }, [authUser?.id]);

  const ensureFreshCloudEntitlement = useCallback(async () => {
    if (!authUser?.id) return FREE_ENTITLEMENT;
    return refreshEntitlement(authUser.id);
  }, [authUser?.id, refreshEntitlement]);

  const handleRefreshEntitlement = useCallback(async () => {
    setEntitlementMessage("");
    setActiveTab("settings");

    const session = await getFreshSession(authSessionRef.current).catch(() => null);
    if (!session?.user?.id) {
      setEntitlementChecking(false);
      setEntitlement(FREE_ENTITLEMENT);
      await clearActiveEntitlementUser().catch(() => {});
      setEntitlementMessage("Your session expired. Sign out and sign in again to restore Echo Pro.");
      return FREE_ENTITLEMENT;
    }

    if (authUser?.id !== session.user.id) {
      applyAuthSession(session);
    }

    return refreshEntitlement(session.user.id, session, { showFreeMessage: true });
  }, [applyAuthSession, authUser?.id, refreshEntitlement]);

  const completeAuthSession = useCallback(async (
    session: Awaited<ReturnType<typeof getSession>>,
    options?: { route?: boolean }
  ) => {
    applyAuthSession(session);
    if (session?.user?.id) {
      void refreshEntitlement(session.user.id, session);
    }
    if (options?.route !== false) {
      await routeAfterAuth();
    }
  }, [applyAuthSession, refreshEntitlement, routeAfterAuth]);

  const localFallbackAvailable = useCallback(async (cfg: AppConfig) => {
    if (!HAS_TAURI) return true;
    try {
      const status = await invoke<ModelStatus>("check_model_status", {
        modelSize: cfg.local_model_size,
      });
      return status.downloaded && !status.integrity_error;
    } catch {
      return false;
    }
  }, []);

  const handleAuthDeepLink = useCallback(
    async (urlString: string) => {
      let parsed: URL;
      try {
        parsed = new URL(urlString);
      } catch {
        return;
      }

      if (parsed.protocol !== "echo:") return;

      if (parsed.hostname === "billing") {
        setCheckoutPending(false);
        setActiveTab("settings");

        if (parsed.pathname === "/cancel") {
          setEntitlementMessage("Checkout was cancelled. Echo Pro is still locked.");
          return;
        }

        if (parsed.pathname !== "/complete") return;

        setEntitlementMessage("Payment complete. Verifying Echo Pro status.");
        const session = await getFreshSession(authSessionRef.current).catch(() => null);
        if (!session?.user?.id) {
          setEntitlementMessage("Payment complete. Sign in again to restore Echo Pro.");
          return;
        }
        if (authUser?.id !== session.user.id) {
          applyAuthSession(session);
        }

        try {
          const checkoutSessionId = parsed.searchParams.get("session_id");
          if (checkoutSessionId) {
            await confirmCheckoutSession(checkoutSessionId, session);
          }
          const nextEntitlement = await refreshEntitlement(session.user.id, session);
          setEntitlementMessage(
            nextEntitlement.tier === "pro_lifetime"
              ? "Echo Pro is active."
              : "Payment complete. Echo is still waiting for Stripe to confirm Pro."
          );
        } catch (e) {
          setEntitlementMessage(
            `Payment complete. Echo could not verify Pro yet: ${formatErrorMessage(e)}`
          );
        }
        return;
      }

      if (parsed.hostname !== "auth") return;
      const isCallback = parsed.pathname === "/callback";
      const isResetPassword = parsed.pathname === "/reset-password";
      if (!isCallback && !isResetPassword) return;

      const params = authUrlParams(parsed);
      const callbackError = params.get("error_description") ?? params.get("error");
      if (callbackError) {
        passwordRecoveryRef.current = false;
        setAuthStatus("error");
        setAuthMessage(callbackError);
        return;
      }

      const code = params.get("code");
      if (!code) {
        setAuthStatus("error");
        setAuthMessage("The sign-in link did not include an authorization code. Start the flow again.");
        return;
      }

      const callbackKey = `${parsed.pathname}:${code}`;
      if (authCallbackInFlightRef.current.has(callbackKey) || completedAuthCallbackRef.current.has(callbackKey)) {
        return;
      }

      authCallbackInFlightRef.current.add(callbackKey);
      googleSignInAttemptRef.current += 1;
      setAuthStatus("loading");
      setAuthMessage("");
      passwordRecoveryRef.current = isResetPassword;
      try {
        const session = await exchangeCodeForSession(code);
        completedAuthCallbackRef.current.add(callbackKey);
        if (isResetPassword) {
          applyAuthSession(session);
          setAuthStatus("passwordRecovery");
        } else {
          await completeAuthSession(session);
        }
      } catch (e) {
        const existingSession = await getSession().catch(() => null);
        if (existingSession) {
          completedAuthCallbackRef.current.add(callbackKey);
          setAuthMessage("");
          if (isResetPassword) {
            applyAuthSession(existingSession);
            setAuthStatus("passwordRecovery");
          } else {
            await completeAuthSession(existingSession);
          }
          return;
        }

        passwordRecoveryRef.current = false;
        setAuthStatus("error");
        setAuthMessage(formatErrorMessage(e));
      } finally {
        authCallbackInFlightRef.current.delete(callbackKey);
      }
    },
    [applyAuthSession, authUser?.id, completeAuthSession, refreshEntitlement]
  );

  const loadStats = useCallback(async () => {
    if (!HAS_TAURI) {
      setStats(MOCK_STATS);
      return MOCK_STATS;
    }

    try {
      const nextStats = await invoke<DictationStats>("get_dictation_stats", {
        localDate: getLocalDateKey(),
      });
      setStats(nextStats);
      return nextStats;
    } catch (e) {
      console.error("Failed to load dictation stats:", e);
      setStats(MOCK_STATS);
      return MOCK_STATS;
    }
  }, []);

  const showMilestoneCelebration = useCallback((milestone: number) => {
    setMilestoneCelebration({ id: Date.now(), milestone });
    if (milestoneTimerRef.current) {
      clearTimeout(milestoneTimerRef.current);
    }
    milestoneTimerRef.current = setTimeout(() => {
      setMilestoneCelebration(null);
      milestoneTimerRef.current = null;
    }, 5200);
  }, []);

  const dismissMilestoneCelebration = useCallback(() => {
    if (milestoneTimerRef.current) {
      clearTimeout(milestoneTimerRef.current);
      milestoneTimerRef.current = null;
    }
    setMilestoneCelebration(null);
  }, []);

  const resetDictationTarget = useCallback(() => {
    dictationTargetRef.current = "external";
  }, []);

  const startRecording = useCallback(
    async (captureFocus = true): Promise<boolean> => {
      if (startInFlightRef.current) return false;
      startInFlightRef.current = true;
      lastDictationResultRef.current = null;

      try {
        if (!HAS_TAURI) {
          setAppState("recording");
          setTranscript("");
          setErrorMsg("");
          dictationTargetRef.current = "external";
          recordingStartedAtRef.current = Date.now();
          setTimeout(() => setAppState("idle"), 1800);
          return true;
        }

        const recording = await invoke<boolean>("is_recording");
        if (recording) return false;

        const cfg = await invoke<AppConfig>("get_config");
        if (cfg.model_provider === "api") {
          const freshEntitlement = await ensureFreshCloudEntitlement();
          if (!freshEntitlement.features.cloudProvider) {
            if (await localFallbackAvailable(cfg)) {
              setErrorMsg(ONLINE_PRO_REQUIRED_MESSAGE);
            } else {
              setErrorMsg(
                "No internet connection. Reconnect to verify Echo Pro, or download a local Whisper model before dictating offline."
              );
              setActiveTab("settings");
              return false;
            }
          } else if (!cfg.groq_api_key) {
            setActiveTab("settings");
            return false;
          }
        }

        const target: DictationTarget =
          captureFocus && notepadFocusedRef.current ? "standalone-notepad" : "external";
        dictationTargetRef.current = target;

        if (captureFocus && target === "external") {
          await invoke("capture_focus");
        }
        await invoke("start_recording");
        invoke("pause_media").catch(() => {});
        setIndicatorMode("recording");

        activeDeliveryAudioPathRef.current = null;
        activeShortcutSessionIdRef.current = null;
        processingSessionIdRef.current = null;
        deliveredSessionIdsRef.current.clear();
        consumedAudioPathsRef.current.clear();
        setLastPerformance([]);
        setAppState("recording");
        setTranscript("");
        setErrorMsg("");
        recordingStartedAtRef.current = Date.now();
        return true;
      } catch (e: unknown) {
        const msg = formatErrorMessage(e);
        resetDictationTarget();
        setErrorMsg(msg);
        setAppState("error");
        return false;
      } finally {
        startInFlightRef.current = false;
      }
    },
    [ensureFreshCloudEntitlement, localFallbackAvailable, resetDictationTarget, setIndicatorMode]
  );

  const processRecordedAudio = useCallback(async (
    audioPath: string,
    recordingDurationMs: number,
    sessionId?: number | null
  ): Promise<boolean> => {
    if (sessionId != null) {
      if (
        processingSessionIdRef.current === sessionId ||
        deliveredSessionIdsRef.current.has(sessionId)
      ) {
        logDictationDelivery("process", {
          accepted: false,
          reason: "duplicate-session",
          sessionId,
        });
        return false;
      }
    }

    if (activeDeliveryAudioPathRef.current === audioPath || consumedAudioPathsRef.current.has(audioPath)) {
      logDictationDelivery("process", {
        accepted: false,
        reason: "duplicate-audio",
        sessionId: sessionId ?? null,
      });
      return false;
    }

    if (sessionId != null) {
      processingSessionIdRef.current = sessionId;
      deliveredSessionIdsRef.current.add(sessionId);
    }
    activeDeliveryAudioPathRef.current = audioPath;
    consumedAudioPathsRef.current.add(audioPath);
    logDictationDelivery("process", {
      accepted: true,
      sessionId: sessionId ?? null,
    });

    try {
      recordingStartedAtRef.current = null;
      const rawText = await invoke<string>("transcribe_audio", { audioPath });
      const finalText = transcriptTextOrThrow(rawText);

      setIndicatorMode("pasting");
      await emitIndicatorLiveTranscript(finalText, true);
      setTranscript(finalText);
      const activeTarget = dictationTargetRef.current;
      if (activeTarget === "standalone-notepad") {
        await emit("notepad-insert-transcript", finalText);
      }
      const pasteResult =
        activeTarget === "standalone-notepad"
          ? { status: "pasted", warning: null }
          : await (async () => {
              logDictationDelivery("paste_transcript", {
                accepted: true,
                sessionId: sessionId ?? null,
              });
              return invoke<PasteTranscriptResult>("paste_transcript", { text: finalText });
            })();
      const result = pasteResult.status;
      lastDictationResultRef.current = result;
      const fallbackNotice = offlineFallbackNoticeRef.current;
      offlineFallbackNoticeRef.current = "";
      const pasteWarning = pasteResult.warning ? formatErrorMessage(pasteResult.warning) : "";
      setErrorMsg(pasteWarning || fallbackNotice);

      if (result === "pasted") {
        setAppState("success");
        setIndicatorMode("success");
      } else if (result === "copied_no_target") {
        setAppState("copied");
        setIndicatorMode("copied_no_target", finalText);
      } else {
        setAppState("copied");
        setIndicatorMode("copied");
      }
      playChime();
      resetDictationTarget();

      void (async () => {
        try {
          const item = await invoke<HistoryItem>("add_transcript_history", {
            text: finalText,
            pasteResult: result,
          });
          setHistory((prev) => [item, ...prev]);
        } catch (e) {
          console.error("Failed to save history:", e);
        }

        try {
          const wordCount = countDictationWords(finalText);
          if (wordCount > 0) {
            const update = await invoke<DictationStatsUpdate>("record_dictation_stats", {
              wordCount,
              durationMs: recordingDurationMs,
              localDate: getLocalDateKey(),
            });
            setStats(update.stats);
            const latestMilestone =
              update.crossed_milestones[update.crossed_milestones.length - 1];
            if (latestMilestone) {
              showMilestoneCelebration(latestMilestone);
            }
          }
        } catch (e) {
          console.error("Failed to update dictation stats:", e);
        }
      })();

      setTimeout(() => setAppState("idle"), 3000);
      return true;
    } catch (e: unknown) {
      const msg = formatErrorMessage(e);
      if (isEmptyTranscriptError(e)) {
        recordingStartedAtRef.current = null;
        resetDictationTarget();
        lastDictationResultRef.current = null;
        setTranscript("");
        setErrorMsg(EMPTY_TRANSCRIPT_MESSAGE);
        setAppState("error");
        setIndicatorMode("error");
        return true;
      }

      if (errorCode(e) === "not_recording" || msg.includes("Not recording")) {
        recordingStartedAtRef.current = null;
        resetDictationTarget();
        lastDictationResultRef.current = null;
        setTranscript("");
        setErrorMsg("Recording has already stopped. Start a new dictation and try again.");
        setAppState("idle");
        setIndicatorMode("idle");
        return false;
      }

      setErrorMsg(msg);
      setAppState("error");
      setIndicatorMode("error");
      recordingStartedAtRef.current = null;
      resetDictationTarget();
      lastDictationResultRef.current = null;
      return false;
    } finally {
      if (sessionId != null && processingSessionIdRef.current === sessionId) {
        processingSessionIdRef.current = null;
      }
      if (activeDeliveryAudioPathRef.current === audioPath) {
        activeDeliveryAudioPathRef.current = null;
      }
    }
  }, [playChime, resetDictationTarget, setIndicatorMode, showMilestoneCelebration]);

  const stopAndPaste = useCallback(async (): Promise<boolean> => {
    if (stopInFlightRef.current) return false;
    stopInFlightRef.current = true;

    try {
      const recording = await invoke<boolean>("is_recording");
      if (!recording) {
        stopRequestedRef.current = false;
        resetDictationTarget();
        return false;
      }

      stopRequestedRef.current = false;
      setAppState("processing");
      setIndicatorMode("transcribing");
      const audioPath = await invoke<string>("stop_recording");
      const recordingDurationMs = Math.max(
        0,
        Date.now() - (recordingStartedAtRef.current ?? Date.now())
      );
      return await processRecordedAudio(audioPath, recordingDurationMs);
    } finally {
      invoke("resume_media").catch(() => {});
      stopInFlightRef.current = false;
    }
  }, [processRecordedAudio, resetDictationTarget, setIndicatorMode]);

  const applyOnboardingDictationResult = useCallback(async (completed: boolean) => {
    const result = lastDictationResultRef.current;
    const passed =
      completed &&
      !!result &&
      ["pasted", "copied", "copied_no_target", "copied_accessibility"].includes(result);

    if (passed) {
      setOnboardingFirstDictationPassed(true);
      setOnboardingDictationState("success");
      setOnboardingDictationMessage(
        result === "pasted"
          ? "Hotkey test worked and pasted into the target."
          : "Hotkey test worked. Echo copied the transcript as a fallback."
      );
      await loadSetupStatus();
      return true;
    }

    setOnboardingFirstDictationPassed(false);
    setOnboardingDictationState("error");
    setOnboardingDictationMessage(errorMsg || "Try again with a short spoken sentence.");
    return false;
  }, [errorMsg, loadSetupStatus]);

  const handleStartRecording = useCallback(async () => {
    stopRequestedRef.current = false;
    await startRecording();
  }, [startRecording]);

  const handleStopAndPaste = useCallback(async () => {
    stopRequestedRef.current = true;
    await stopAndPaste();
    sessionActiveRef.current = false;
  }, [stopAndPaste]);

  const handleCancelRecording = useCallback(async () => {
    stopRequestedRef.current = false;
    shortcutHeldRef.current = false;
    sessionActiveRef.current = false;
    recordingStartedAtRef.current = null;
    activeShortcutSessionIdRef.current = null;
    processingSessionIdRef.current = null;
    deliveredSessionIdsRef.current.clear();
    activeDeliveryAudioPathRef.current = null;
    consumedAudioPathsRef.current.clear();
    resetDictationTarget();

    try {
      if (HAS_TAURI) {
        const recording = await invoke<boolean>("is_recording");
        if (recording) {
          await invoke<string>("stop_recording");
        }
      }
    } catch (e) {
      console.error("Failed to cancel recording:", e);
    } finally {
      if (HAS_TAURI) {
        invoke("resume_media").catch(() => {});
      }
      setTranscript("");
      setErrorMsg("");
      setAppState("idle");
      setIndicatorMode("idle");
    }
  }, [resetDictationTarget, setIndicatorMode]);

  const handleNativeShortcutEvent = useCallback(async (payload: AppShortcutEvent) => {
    const isOnboardingTest = activeTab === "onboarding" && config?.onboarding_completed === false;
    const sessionId = payload.sessionId ?? null;
    logDictationDelivery("shortcut-event", {
      sessionId,
      state: payload.state,
      source: "app-shortcut",
    });

    if (payload.state === "Started") {
      shortcutHeldRef.current = true;
      sessionActiveRef.current = true;
      stopRequestedRef.current = false;
      stopInFlightRef.current = false;
      lastDictationResultRef.current = null;
      activeDeliveryAudioPathRef.current = null;
      activeShortcutSessionIdRef.current = sessionId;
      processingSessionIdRef.current = null;
      deliveredSessionIdsRef.current.clear();
      consumedAudioPathsRef.current.clear();
      setLastPerformance([]);
      dictationTargetRef.current = notepadFocusedRef.current ? "standalone-notepad" : "external";
      recordingStartedAtRef.current = Date.now();
      setAppState("recording");
      setIndicatorMode("recording");
      setTranscript("");
      setErrorMsg("");

      if (isOnboardingTest) {
        setOnboardingFirstDictationPassed(false);
        setOnboardingDictationState("recording");
        setOnboardingDictationMessage("Shortcut detected. Speak a short sentence, then release the hotkey.");
      }
      return;
    }

    if (payload.state === "Stopping") {
      shortcutHeldRef.current = false;
      stopRequestedRef.current = true;
      stopInFlightRef.current = true;
      setAppState("processing");
      setIndicatorMode("transcribing");
      if (isOnboardingTest) {
        setOnboardingDictationState("processing");
        setOnboardingDictationMessage("Transcribing and checking the paste/copy fallback...");
      }
      return;
    }

    if (payload.state === "Stopped") {
      shortcutHeldRef.current = false;
      stopRequestedRef.current = false;
      if (sessionId != null) {
        if (activeShortcutSessionIdRef.current !== sessionId) {
          logDictationDelivery("stopped", {
            accepted: false,
            reason: "stale-session",
            sessionId,
          });
          return;
        }
        if (
          processingSessionIdRef.current === sessionId ||
          deliveredSessionIdsRef.current.has(sessionId)
        ) {
          logDictationDelivery("stopped", {
            accepted: false,
            reason: "duplicate-session",
            sessionId,
          });
          return;
        }
      }
      const audioPath = payload.audioPath;
      if (!audioPath) {
        setErrorMsg("Recording stopped, but Echo did not receive an audio file.");
        setAppState("error");
        setIndicatorMode("error");
        sessionActiveRef.current = false;
        stopInFlightRef.current = false;
        activeShortcutSessionIdRef.current = null;
        if (sessionId != null && processingSessionIdRef.current === sessionId) {
          processingSessionIdRef.current = null;
        }
        return;
      }

      const fallbackDurationMs = Math.max(
        0,
        Date.now() - (recordingStartedAtRef.current ?? Date.now())
      );
      const completed = await processRecordedAudio(
        audioPath,
        payload.durationMs ?? fallbackDurationMs,
        sessionId
      );
      if (isOnboardingTest) {
        await applyOnboardingDictationResult(completed);
      }
      sessionActiveRef.current = false;
      stopInFlightRef.current = false;
      return;
    }

    if (payload.state === "StartFailed" || payload.state === "StopFailed") {
      const error = payload.error ?? "Could not run the dictation shortcut. Try again.";
      const msg = formatErrorMessage(error);
      shortcutHeldRef.current = false;
      stopRequestedRef.current = false;
      sessionActiveRef.current = false;
      stopInFlightRef.current = false;
      activeShortcutSessionIdRef.current = null;
      processingSessionIdRef.current = null;
      recordingStartedAtRef.current = null;
      resetDictationTarget();
      setErrorMsg(msg);
      setAppState("error");
      setIndicatorMode("error");
      if (errorCode(error) === "missing_api_key") {
        setActiveTab("settings");
      }
      if (isOnboardingTest) {
        setOnboardingDictationState("error");
        setOnboardingDictationMessage(msg || "Could not start recording. Review setup and try again.");
      }
    }
  }, [
    activeTab,
    applyOnboardingDictationResult,
    config?.onboarding_completed,
    processRecordedAudio,
    resetDictationTarget,
    setIndicatorMode,
  ]);

  const registerShortcut = useCallback(async (shortcut: string): Promise<boolean> => {
    if (!HAS_TAURI) return true;

    try {
      const validation = await invoke<ShortcutValidation>("validate_shortcut", { shortcut });
      if (!validation.valid) {
        setShortcutError(validation.message);
        return false;
      }

      await invoke("register_app_shortcut", { shortcut });
      registeredShortcut.current = shortcut;
      setShortcutError("");
      return true;
    } catch (e) {
      const msg = formatErrorMessage(e);
      setShortcutError(
        `Could not register ${shortcut}. Choose another shortcut or quit the app already using it. ${msg}`
      );
      console.error("Failed to register shortcut:", e);
      return false;
    }
  }, []);

  const saveConfig = useCallback(async (nextConfig: AppConfig) => {
    const normalizedConfig = {
      ...nextConfig,
      groq_api_key: nextConfig.groq_api_key.trim(),
    };

    if (!HAS_TAURI) {
      setConfig(normalizedConfig);
      setAppearancePreview(null);
      return {
        config: normalizedConfig,
        secure_storage: { state: "verified", message: "" },
      } satisfies ConfigSaveResult;
    }

    const launchAtLogin = await invoke<boolean>("set_launch_at_login", {
      enabled: normalizedConfig.launch_at_login,
    });
    normalizedConfig.launch_at_login = launchAtLogin;

    const saveResult = await invoke<ConfigSaveResult>("save_config", { config: normalizedConfig });
    const savedConfig = saveResult.config;
    const normalizedSavedConfig = {
      ...savedConfig,
      appearance_theme: normalizeTheme(savedConfig.appearance_theme),
    };

    setConfig(normalizedSavedConfig);
    setErrorMsg(
      saveResult.secure_storage.state === "verified" ? "" : saveResult.secure_storage.message
    );
    setAppearancePreview(null);
    emit("appearance-theme-changed", normalizedSavedConfig.appearance_theme).catch(() => {});
    emit("shortcut-changed", normalizedSavedConfig.shortcut).catch(() => {});
    await loadSetupStatus();
    await registerShortcut(normalizedSavedConfig.shortcut);

    return {
      ...saveResult,
      config: normalizedSavedConfig,
    };
  }, [loadSetupStatus, registerShortcut]);

  const loadHistory = useCallback(async () => {
    if (!HAS_TAURI) {
      setHistory(MOCK_HISTORY);
      return;
    }

    try {
      const items = await invoke<HistoryItem[]>("list_transcript_history");
      setHistory(items);
    } catch (e) {
      console.error("Failed to load history:", e);
      setHistory(MOCK_HISTORY);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    restorePersistedSession()
      .then((session) => {
        if (cancelled) return;
        if (session?.access_token) {
          void completeAuthSession(session);
        } else {
          applyAuthSession(session);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setAuthStatus("error");
          setAuthMessage(`Echo could not restore your account session. ${formatErrorMessage(e)}`);
        }
      });

    const subscription = onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        passwordRecoveryRef.current = true;
        authSessionRef.current = session;
        setAuthUser(summarizeSession(session));
        setAuthStatus("passwordRecovery");
        return;
      }
      if (event === "SIGNED_OUT") {
        passwordRecoveryRef.current = false;
        authSessionRef.current = null;
        setAuthUser(null);
        setAuthStatus("signedOut");
        setEntitlementChecking(false);
        setEntitlement(FREE_ENTITLEMENT);
        setEntitlementMessage("");
        clearActiveEntitlementUser().catch(() => {});
        return;
      }
      if (session) {
        void completeAuthSession(session, { route: false });
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (authStatus === "signedIn" && authUser?.id) {
      void refreshEntitlement(authUser.id);
      return;
    }
    setEntitlement(FREE_ENTITLEMENT);
    setEntitlementMessage("");
    setEntitlementChecking(false);
    clearActiveEntitlementUser().catch(() => {});
  }, [authStatus, authUser?.id, refreshEntitlement]);

  useEffect(() => {
    if (authStatus !== "signedIn" || !authUser?.id || config?.model_provider !== "api") return;

    const interval = window.setInterval(() => {
      void refreshEntitlement(authUser.id);
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [authStatus, authUser?.id, config?.model_provider, refreshEntitlement]);

  useEffect(() => {
    if (!HAS_TAURI) return;

    const unlisten: Array<() => void> = [];
    getCurrentDeepLinks()
      .then((urls) => {
        urls?.forEach((url) => void handleAuthDeepLink(url));
      })
      .catch((e) => console.warn("Could not read current deep links:", e));

    onOpenUrl((urls) => {
      urls.forEach((url) => void handleAuthDeepLink(url));
    })
      .then((u) => unlisten.push(u))
      .catch((e) => console.warn("Could not listen for deep links:", e));

    listen<string[]>("auth-deep-link", (event) => {
      event.payload.forEach((url) => void handleAuthDeepLink(url));
    })
      .then((u) => unlisten.push(u))
      .catch((e) => console.warn("Could not listen for native auth links:", e));

    return () => {
      unlisten.forEach((u) => u());
    };
  }, [handleAuthDeepLink]);

  useEffect(() => {
    loadConfig().then((cfg) => {
      if (cfg) {
        if (!cfg.onboarding_completed) {
          setActiveTab("onboarding");
        } else if (cfg.model_provider === "api" && !cfg.groq_api_key) {
          setActiveTab("settings");
        }
        registerShortcut(cfg.shortcut);
      }
    });
    loadSetupStatus();
    loadHistory();
    loadStats();
    return () => {
      if (registeredShortcut.current) {
        invoke("unregister_app_shortcut").catch(console.error);
        registeredShortcut.current = null;
      }
      if (milestoneTimerRef.current) {
        clearTimeout(milestoneTimerRef.current);
        milestoneTimerRef.current = null;
      }
      if (onboardingCompletionTimerRef.current) {
        clearTimeout(onboardingCompletionTimerRef.current);
        onboardingCompletionTimerRef.current = null;
      }
    };
  }, [loadConfig, loadHistory, loadSetupStatus, loadStats, registerShortcut]);

  useEffect(() => {
    contentMainColRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeTab]);

  useEffect(() => {
    if (!HAS_TAURI) return;

    const cleanup = [
      listenSafely<AppShortcutEvent>("app-shortcut", (event) => {
        void handleNativeShortcutEvent(event.payload);
      }),

      listenSafely("tray-start-recording", () => {
        void handleStartRecording();
      }),

      listenSafely("tray-stop-recording", () => {
        void handleStopAndPaste();
      }),

      listenSafely("tray-open-settings", () => {
        loadConfig();
        setActiveTab("settings");
      }),

      listenSafely("menu-open-dictate", () => {
        setActiveTab("dictate");
      }),

      listenSafely("menu-open-history", () => {
        loadHistory();
        setActiveTab("history");
      }),

      listenSafely("indicator-open-notepad", () => {
        setActiveTab("notepad");
      }),

      listenSafely("menu-check-setup", () => {
        loadSetupStatus();
        setActiveTab("dictate");
      }),

      listenSafely("indicator-cancel-recording", () => {
        void handleCancelRecording();
      }),

      listenSafely<boolean>("notepad-window-focus", (event) => {
        notepadFocusedRef.current = event.payload;
      }),

      listenSafely<DictationPerformancePayload>("dictation-performance", (event) => {
        setLastPerformance((prev) => {
          if (event.payload.phase === "transcribe") {
            return [event.payload];
          }
          return [...prev.filter((item) => item.phase !== event.payload.phase), event.payload];
        });
      }),

      listenSafely<string>("entitlement-offline-fallback", (event) => {
        offlineFallbackNoticeRef.current = event.payload || ONLINE_PRO_REQUIRED_MESSAGE;
        setEntitlementChecking(false);
        setEntitlement(FREE_ENTITLEMENT);
        setEntitlementMessage(event.payload || ONLINE_PRO_REQUIRED_MESSAGE);
        setErrorMsg(event.payload || ONLINE_PRO_REQUIRED_MESSAGE);
      }),
    ];

    return () => {
      cleanup.forEach((unlisten) => unlisten());
    };
  }, [
    handleCancelRecording,
    handleNativeShortcutEvent,
    handleStartRecording,
    handleStopAndPaste,
    loadConfig,
    loadHistory,
    loadSetupStatus,
  ]);

  const handleCopyHistoryItem = async (text: string, id: string) => {
    try {
      if (!HAS_TAURI) {
        await navigator.clipboard?.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 1500);
        return;
      }

      await invoke("copy_transcript", { text });
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  const handleDeleteHistoryItem = async (id: string) => {
    try {
      if (!HAS_TAURI) {
        setHistory((prev) => prev.filter((item) => item.id !== id));
        return;
      }

      await invoke("delete_transcript_history", { id });
      setHistory((prev) => prev.filter((item) => item.id !== id));
    } catch (e) {
      console.error("Failed to delete:", e);
    }
  };

  const handleClearHistory = async () => {
    try {
      if (!HAS_TAURI) {
        setHistory([]);
        return;
      }

      await invoke("clear_transcript_history");
      setHistory([]);
    } catch (e) {
      console.error("Failed to clear history:", e);
    }
  };

  const handleClearInsights = async () => {
    if (!HAS_TAURI) {
      setStats({
        total_words: 0,
        dictation_count: 0,
        rolling_wpm: 0,
        day_streak: 0,
        next_milestone: WORD_MILESTONES[0] ?? null,
        next_milestone_progress: 0,
      });
      dismissMilestoneCelebration();
      return;
    }

    await invoke("clear_dictation_stats");
    dismissMilestoneCelebration();
    await loadStats();
  };

  const handleStartCheckout = async () => {
    setEntitlementMessage("");
    let confirmedSession: Awaited<ReturnType<typeof getSession>>;
    try {
      confirmedSession = await getFreshSession(authSessionRef.current);
    } catch (e) {
      setActiveTab("settings");
      setEntitlementMessage(
        `Your session could not be refreshed. Sign out and sign in again to unlock Echo Pro. ${formatErrorMessage(e)}`
      );
      return;
    }

    if (!confirmedSession?.user?.id) {
      setActiveTab("settings");
      setEntitlementMessage("Your session expired. Sign out and sign in again to unlock Echo Pro.");
      return;
    }

    if (authUser?.id !== confirmedSession.user.id) {
      applyAuthSession(confirmedSession);
    }

    const checkoutUserId = confirmedSession.user.id;
    setCheckoutPending(true);
    try {
      const session = await createCheckoutSession(confirmedSession);
      if (HAS_TAURI) {
        await openUrl(session.url);
      } else {
        window.open(session.url, "_blank", "noopener,noreferrer");
      }
      setEntitlementMessage("Checkout opened in your browser. Echo will refresh Pro status here.");

      const startedAt = Date.now();
      const poll = window.setInterval(() => {
        void refreshEntitlement(checkoutUserId, confirmedSession)
          .then((next) => {
            if (next.tier === "pro_lifetime" || Date.now() - startedAt > 90_000) {
              window.clearInterval(poll);
              setCheckoutPending(false);
            }
          })
          .catch((e) => {
            console.warn("Could not refresh entitlement during checkout:", e);
          });
      }, 3_000);
    } catch (e) {
      setCheckoutPending(false);
      setEntitlementMessage(formatErrorMessage(e));
    }
  };

  const handleSaveSettings = async (newConfig: AppConfig) => {
    await saveConfig(newConfig);
    setActiveTab("dictate");
  };

  const handleSignInWithGoogle = async () => {
    const attempt = googleSignInAttemptRef.current + 1;
    googleSignInAttemptRef.current = attempt;
    setAuthStatus("loading");
    setAuthMessage("Opening your browser to finish Google sign-in.");
    try {
      await signInWithGoogle();
      if (googleSignInAttemptRef.current === attempt) {
        setAuthStatus("signedOut");
        setAuthMessage("Finish sign-in in your browser. Echo will continue when you return.");
      }
    } catch (e) {
      if (googleSignInAttemptRef.current === attempt) {
        setAuthStatus("error");
        setAuthMessage(formatErrorMessage(e));
      }
    }
  };

  const handleSignInWithEmail = async (email: string, password: string) => {
    setAuthStatus("loading");
    setAuthMessage("");
    try {
      const session = await signInWithPassword(email, password);
      passwordRecoveryRef.current = false;
      await completeAuthSession(session);
    } catch (e) {
      setAuthStatus("error");
      setAuthMessage(formatErrorMessage(e));
    }
  };

  const handleSignUpWithEmail = async (
    email: string,
    password: string,
    profile: SignUpProfile
  ) => {
    setAuthStatus("loading");
    setAuthMessage("");
    try {
      const result = await signUpWithPassword(email, password, profile);
      if (result.session) {
        await completeAuthSession(result.session);
        return;
      }
      setAuthStatus("emailVerificationPending");
      setAuthMessage(`Check ${email} for Echo's verification link, then return here.`);
    } catch (e) {
      setAuthStatus("error");
      setAuthMessage(formatErrorMessage(e));
    }
  };

  const handleSendPasswordReset = async (email: string) => {
    setAuthStatus("loading");
    setAuthMessage("");
    try {
      await sendPasswordReset(email);
      setAuthStatus("signedOut");
      setAuthMessage(`Password reset sent to ${email}. Open the link on this computer to continue.`);
    } catch (e) {
      setAuthStatus("error");
      setAuthMessage(formatErrorMessage(e));
    }
  };

  const handleUpdatePassword = async (password: string) => {
    setAuthStatus("loading");
    setAuthMessage("");
    try {
      await updatePassword(password);
      passwordRecoveryRef.current = false;
      const session = await getSession();
      await completeAuthSession(session);
    } catch (e) {
      setAuthStatus("passwordRecovery");
      setAuthMessage(formatErrorMessage(e));
    }
  };

  const handleSignOut = async () => {
    setAuthStatus("loading");
    setAuthMessage("");
    try {
      await signOut();
      passwordRecoveryRef.current = false;
      authSessionRef.current = null;
      setAuthUser(null);
      setAuthStatus("signedOut");
      setEntitlementChecking(false);
      setEntitlement(FREE_ENTITLEMENT);
      setEntitlementMessage("");
      await clearActiveEntitlementUser().catch(() => {});
      setActiveTab("onboarding");
    } catch (e) {
      setAuthStatus("error");
      setAuthMessage(formatErrorMessage(e));
    }
  };

  const handleSaveOnboardingShortcut = async (shortcut: string) => {
    if (!config) return false;
    setOnboardingFirstDictationPassed(false);
    await saveConfig({ ...config, shortcut });
    return registerShortcut(shortcut);
  };

  const handleSaveOnboardingInputDevice = async (inputDevice: string | null) => {
    if (!config) return;
    setOnboardingFirstDictationPassed(false);
    await saveConfig({ ...config, input_device: inputDevice });
  };

  const handleStartOnboardingDictation = async () => {
    setOnboardingFirstDictationPassed(false);
    setOnboardingDictationMessage("");
    const started = await startRecording(false);
    if (started) {
      setOnboardingDictationState("recording");
      setOnboardingDictationMessage("Speak a short sentence, then stop the test.");
    } else {
      setOnboardingDictationState("error");
      setOnboardingDictationMessage(errorMsg || "Could not start recording. Review setup and try again.");
    }
  };

  const handleStopOnboardingDictation = async () => {
    if (HAS_TAURI) {
      const recording = await invoke<boolean>("is_recording");
      if (!recording) {
        setOnboardingFirstDictationPassed(false);
        setOnboardingDictationState("idle");
        setOnboardingDictationMessage("Start the test dictation first, then stop it after speaking.");
        setErrorMsg("");
        return;
      }
    }

    setOnboardingDictationState("processing");
    setOnboardingDictationMessage("Transcribing and checking the paste/copy fallback...");
    const completed = await stopAndPaste();
    await applyOnboardingDictationResult(completed);
  };

  const handleCompleteOnboarding = async () => {
    if (!config) return;
    const latestStatus = await loadSetupStatus();
    const canComplete = latestStatus?.ready && !shortcutError && onboardingFirstDictationPassed;
    if (!canComplete) {
      setErrorMsg("Finish permissions and pass the hotkey test before leaving onboarding.");
      return;
    }
    await saveConfig({ ...config, onboarding_completed: true });
    setOnboardingCompletionVisible(true);
    if (onboardingCompletionTimerRef.current) {
      clearTimeout(onboardingCompletionTimerRef.current);
    }
    onboardingCompletionTimerRef.current = setTimeout(
      () => {
        setActiveTab("dictate");
        setOnboardingCompletionVisible(false);
        onboardingCompletionTimerRef.current = null;
      },
      reduceMotion ? 400 : 1200
    );
  };

  const handleSkipOnboarding = async () => {
    if (!config) return;
    if (onboardingCompletionTimerRef.current) {
      clearTimeout(onboardingCompletionTimerRef.current);
      onboardingCompletionTimerRef.current = null;
    }
    await saveConfig({ ...config, onboarding_completed: true });
    setOnboardingCompletionVisible(false);
    setOnboardingFirstDictationPassed(false);
    setOnboardingDictationState("idle");
    setOnboardingDictationMessage("");
    setErrorMsg("");
    setActiveTab("dictate");
  };

  const handleOpenSettingsFromOnboarding = async () => {
    if (!config) return;
    if (onboardingCompletionTimerRef.current) {
      clearTimeout(onboardingCompletionTimerRef.current);
      onboardingCompletionTimerRef.current = null;
    }
    await saveConfig({ ...config, onboarding_completed: true });
    setOnboardingCompletionVisible(false);
    setOnboardingFirstDictationPassed(false);
    setOnboardingDictationState("idle");
    setOnboardingDictationMessage("");
    setErrorMsg("");
    setActiveTab("settings");
  };

  const handleSetupAction = async (check: SetupCheck) => {
    if (check.id === "paste" || check.action_label?.includes("Accessibility")) {
      await invoke("request_accessibility_permission").catch(console.error);
      await loadSetupStatus();
      return;
    }
    if (check.id === "microphone") {
      await invoke("open_setup_help", { target: "microphone" }).catch(console.error);
      return;
    }
    setActiveTab("settings");
  };

  const handleOnboardingSetupAction = async (check: SetupCheck) => {
    if (check.id === "paste" || check.action_label?.includes("Accessibility")) {
      await invoke("request_accessibility_permission").catch(console.error);
      await loadSetupStatus();
      return;
    }
    if (check.id === "microphone") {
      await invoke("open_setup_help", { target: "microphone" }).catch(console.error);
      return;
    }
    setErrorMsg("Complete this step before continuing.");
  };

  const startWindowDrag = (event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !HAS_TAURI) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, textarea, input, select, a, [data-no-window-drag]")) return;
    event.preventDefault();
    getCurrentWindow().startDragging().catch(console.error);
  };

  if (onboardingLocked) {
    return (
      <main
        className="window-root window-root--main onboarding-shell"
        data-platform={platform}
        data-preview={!HAS_TAURI ? "true" : undefined}
        data-theme={resolvedTheme}
      >
        <div
          className="titlebar-drag-region"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
          aria-hidden
        />
        <section className="onboarding-window" data-tauri-drag-region onMouseDown={startWindowDrag}>
          <AnimatePresence mode="wait" initial={false}>
            {authStatus !== "signedIn" && (
              <motion.div
                className="first-run-transition"
                key="auth-gate"
                initial={false}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
              >
                <AuthGate
                  authMessage={authMessage}
                  authStatus={authStatus}
                  onGoogleSignIn={() => void handleSignInWithGoogle()}
                  onPasswordReset={(email) => void handleSendPasswordReset(email)}
                  onPasswordUpdate={(password) => void handleUpdatePassword(password)}
                  onRetry={() => {
                    setAuthStatus("signedOut");
                    setAuthMessage("");
                  }}
                  onSignIn={(email, password) => void handleSignInWithEmail(email, password)}
                  onSignUp={(email, password, profile) =>
                    void handleSignUpWithEmail(email, password, profile)
                  }
                />
              </motion.div>
            )}
            {authStatus === "signedIn" && !config && (
              <motion.div
                className="first-run-transition"
                key="onboarding-loading"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
              >
                <FirstRunShell
                  activeStep={2}
                  ariaLabel="Preparing Echo setup"
                  completedThrough={1}
                  panelClassName="first-run-panel__content--onboarding"
                >
                  <div className="onboarding-loading-card" role="status" aria-live="polite">
                    <div className="auth-state__icon auth-state__icon--loading" aria-hidden>
                      <span />
                    </div>
                    <h2>Opening Echo</h2>
                    <p>Loading your setup...</p>
                    <Progress />
                  </div>
                </FirstRunShell>
              </motion.div>
            )}
            {authStatus === "signedIn" && config && onboardingCompletionVisible && (
              <motion.div
                className="first-run-transition"
                key="onboarding-success"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
              >
                <FirstRunShell
                  activeStep={null}
                  ariaLabel="Echo setup complete"
                  completedThrough={3}
                  panelClassName="first-run-panel__content--onboarding"
                >
                  <OnboardingSuccess reduceMotion={reduceMotion} />
                </FirstRunShell>
              </motion.div>
            )}
            {authStatus === "signedIn" && config && !onboardingCompletionVisible && (
              <motion.div
                className="first-run-transition"
                key="onboarding-flow"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
              >
                <OnboardingPanel
                  config={config}
                  errorMsg={errorMsg}
                  platform={platform}
                  setupStatus={setupStatus}
                  shortcutError={shortcutError}
                  firstDictationPassed={onboardingFirstDictationPassed}
                  firstDictationState={onboardingDictationState}
                  firstDictationMessage={onboardingDictationMessage}
                  onAction={handleOnboardingSetupAction}
                  onComplete={() => void handleCompleteOnboarding()}
                  onOpenSettings={() => void handleOpenSettingsFromOnboarding()}
                  onRefresh={loadSetupStatus}
                  onSaveInputDevice={handleSaveOnboardingInputDevice}
                  onSaveShortcut={handleSaveOnboardingShortcut}
                  onSkip={() => void handleSkipOnboarding()}
                  onStartFirstDictation={handleStartOnboardingDictation}
                  onStopFirstDictation={handleStopOnboardingDictation}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>
    );
  }

  return (
    <main
      className="window-root window-root--main app-shell"
      data-platform={platform}
      data-preview={!HAS_TAURI ? "true" : undefined}
      data-theme={resolvedTheme}
    >
      <div
        className="titlebar-drag-region"
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
        aria-hidden
      />

      <aside className="sidebar" data-tauri-drag-region>
        <div className="sidebar-header" data-tauri-drag-region onMouseDown={startWindowDrag}>
          <span className="app-logo" role="img" aria-label="Echo" />
          <span className="app-wordmark">Echo</span>
          {entitlement.tier === "pro_lifetime" && <span className="app-pro-badge">PRO</span>}
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          <NavButton
            active={activeTab === "dictate"}
            icon={<Home />}
            label="Home"
            onClick={() => setActiveTab("dictate")}
          />
          <NavButton
            active={activeTab === "notepad"}
            icon={<FileText />}
            label="Notepad"
            onClick={() => setActiveTab("notepad")}
          />
          <NavButton
            active={activeTab === "history"}
            icon={<History />}
            label="History"
            onClick={() => setActiveTab("history")}
          />
        </nav>

        <div className="sidebar-footer">
          <NavButton
            active={activeTab === "settings"}
            icon={<SettingsIcon />}
            label="Settings"
            onClick={() => setActiveTab("settings")}
          />
        </div>
      </aside>

      <section className="main-content">
        <div className="content-body">
          <div className="content-main-col" ref={contentMainColRef}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeTab}
                className="content-main-pane"
                initial={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, y: 10, scale: 0.985 }
                }
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 0, scale: 1 }}
                transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
              >
                {activeTab === "dictate" && (
                  <DictatePanel
                    appState={appState}
                    config={config}
                    errorMsg={errorMsg}
                    setupStatus={setupStatus}
                    shortcutError={shortcutError}
                    stats={stats}
                    transcript={transcript}
                    lastPerformance={lastPerformance}
                    milestoneCelebration={milestoneCelebration}
                    onAction={handleSetupAction}
                    onDismissMilestone={dismissMilestoneCelebration}
                    onOpenSettings={() => setActiveTab("settings")}
                    onRefresh={loadSetupStatus}
                  />
                )}
                {activeTab === "history" && (
                  <HistoryPanel
                    copiedId={copiedId}
                    history={history}
                    onClear={handleClearHistory}
                    onCopy={handleCopyHistoryItem}
                    onDelete={handleDeleteHistoryItem}
                  />
                )}
                {activeTab === "notepad" && <NotepadPanel />}
                {activeTab === "settings" && config && (
                  <Suspense fallback={<SettingsFallback />}>
                    <Settings
                      authUser={authUser}
                      config={config}
                      entitlement={entitlement}
                      entitlementMessage={entitlementMessage}
                      entitlementChecking={entitlementChecking}
                      checkoutPending={checkoutPending}
                      onSave={handleSaveSettings}
                      onClearInsights={handleClearInsights}
                      onStartCheckout={handleStartCheckout}
                      onRefreshEntitlement={handleRefreshEntitlement}
                      onSignOut={handleSignOut}
                      onCancel={() => {
                        setAppearancePreview(null);
                        setActiveTab("dictate");
                      }}
                      onPreviewAppearance={setAppearancePreview}
                      shortcutError={shortcutError}
                      setupStatus={setupStatus}
                      onRefreshSetup={loadSetupStatus}
                      onOpenOnboarding={() => setActiveTab("onboarding")}
                    />
                  </Suspense>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </section>
    </main>
  );
}

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-item${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      type="button"
    >
      <span className="nav-item__icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function passwordStrengthError(password: string) {
  if (password.length < 8) return "Use at least 8 characters.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "Use letters and numbers.";
  }
  return "";
}

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 18 18">
      <path
        d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.716v2.259h2.909c1.702-1.568 2.684-3.875 2.684-6.616Z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.468-.806 5.956-2.179l-2.909-2.259c-.806.54-1.835.86-3.047.86-2.344 0-4.328-1.585-5.037-3.714H.956v2.333A9 9 0 0 0 9 18Z"
        fill="#34A853"
      />
      <path
        d="M3.963 10.708A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.281-1.708V4.959H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.041l3.007-2.333Z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.578c1.321 0 2.507.454 3.441 1.346l2.581-2.581C13.464.892 11.426 0 9 0A9 9 0 0 0 .956 4.959l3.007 2.333C4.672 5.163 6.656 3.578 9 3.578Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function AuthPasswordField({
  autoComplete,
  describedBy,
  id,
  label,
  onChange,
  placeholder,
  value,
  visible,
  onToggleVisibility,
}: {
  autoComplete: string;
  describedBy?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
  visible: boolean;
  onToggleVisibility: () => void;
}) {
  return (
    <label className="auth-field" htmlFor={id}>
      <span>{label}</span>
      <span className="auth-password-control">
        <input
          aria-describedby={describedBy}
          autoComplete={autoComplete}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required
          type={visible ? "text" : "password"}
          value={value}
        />
        <button
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="auth-password-toggle"
          onClick={onToggleVisibility}
          type="button"
        >
          <AnimatedIconSwap iconKey={visible ? "visible" : "hidden"}>
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </AnimatedIconSwap>
        </button>
      </span>
    </label>
  );
}

type FirstRunStepNumber = 1 | 2 | 3;

const FIRST_RUN_STEPS: Array<{ number: FirstRunStepNumber; label: string }> = [
  { number: 1, label: "Create your account" },
  { number: 2, label: "Set up your microphone" },
  { number: 3, label: "Try your shortcut" },
];

function FirstRunShell({
  activeStep,
  ariaLabel,
  children,
  completedThrough,
  panelClassName = "",
}: {
  activeStep: FirstRunStepNumber | null;
  ariaLabel: string;
  children: ReactNode;
  completedThrough: number;
  panelClassName?: string;
}) {
  return (
    <section className="first-run-shell" aria-label={ariaLabel}>
      <aside className="first-run-visual">
        <div className="first-run-visual__gradient" aria-hidden />
        <div className="first-run-visual__content">
          <div className="first-run-brand" aria-label="Echo">
            <img alt="" src={echoLogoMark} />
            <span>Echo</span>
          </div>
          <h1>Get started with Echo</h1>
          <p>Complete a few quick steps and start dictating anywhere.</p>
          <ol className="first-run-roadmap" aria-label="Getting started progress">
            {FIRST_RUN_STEPS.map((step) => {
              const isActive = activeStep === step.number;
              const isComplete = step.number <= completedThrough && !isActive;
              return (
                <li
                  className={`${isActive ? "is-active" : ""}${isComplete ? " is-complete" : ""}`.trim()}
                  key={step.number}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`${step.label}, ${isActive ? "current step" : isComplete ? "completed" : "not started"}`}
                >
                  <span aria-hidden>
                    {isComplete ? <Check size={13} /> : step.number}
                  </span>
                  <strong>{step.label}</strong>
                </li>
              );
            })}
          </ol>
        </div>
      </aside>

      <div className="first-run-panel">
        <div className="first-run-panel__mobile-brand" aria-label="Echo">
          <img alt="" src={echoLogoMark} />
          <span>Echo</span>
        </div>
        <div className={`first-run-panel__content ${panelClassName}`.trim()}>{children}</div>
      </div>
    </section>
  );
}

function AuthGate({
  authMessage,
  authStatus,
  onGoogleSignIn,
  onPasswordReset,
  onPasswordUpdate,
  onRetry,
  onSignIn,
  onSignUp,
}: {
  authMessage: string;
  authStatus: AuthStatus;
  onGoogleSignIn: () => void;
  onPasswordReset: (email: string) => void;
  onPasswordUpdate: (password: string) => void;
  onRetry: () => void;
  onSignIn: (email: string, password: string) => void;
  onSignUp: (email: string, password: string, profile: SignUpProfile) => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [mode, setMode] = useState<"login" | "signup" | "reset">("signup");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
  const [localError, setLocalError] = useState("");
  const [pendingLabel, setPendingLabel] = useState("");
  const isLoading = authStatus === "loading";
  const isRecovery = authStatus === "passwordRecovery";
  const isPending = authStatus === "emailVerificationPending";
  const isError = authStatus === "error";
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.24, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

  const changeMode = (nextMode: "login" | "signup" | "reset") => {
    setMode(nextMode);
    setLocalError("");
    setPendingLabel("");
    if (authMessage || isError) onRetry();
  };

  const submitEmail = (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError("");
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setLocalError("Enter a valid email address.");
      return;
    }
    if (mode === "reset") {
      setPendingLabel("Sending your reset link...");
      onPasswordReset(trimmedEmail);
      return;
    }
    if (!password) {
      setLocalError("Enter your password.");
      return;
    }
    if (mode === "signup") {
      const trimmedFirstName = firstName.trim();
      const trimmedLastName = lastName.trim();
      if (!trimmedFirstName || !trimmedLastName) {
        setLocalError("Enter your first and last name.");
        return;
      }
      const strengthError = passwordStrengthError(password);
      if (strengthError) {
        setLocalError(strengthError);
        return;
      }
      if (password !== confirmPassword) {
        setLocalError("Passwords do not match.");
        return;
      }
      setPendingLabel("Creating your account...");
      onSignUp(trimmedEmail, password, {
        firstName: trimmedFirstName,
        lastName: trimmedLastName,
      });
      return;
    }
    setPendingLabel("Signing you in...");
    onSignIn(trimmedEmail, password);
  };

  const submitNewPassword = (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError("");
    const strengthError = passwordStrengthError(password);
    if (strengthError) {
      setLocalError(strengthError);
      return;
    }
    if (password !== confirmPassword) {
      setLocalError("Passwords do not match.");
      return;
    }
    setPendingLabel("Updating your password...");
    onPasswordUpdate(password);
  };

  const body = () => {
    if (isLoading) {
      return (
        <div className="auth-state auth-state--loading" role="status">
          <div className="auth-state__icon auth-state__icon--loading" aria-hidden>
            <span />
          </div>
          <h2>Opening Echo</h2>
          <p>{authMessage || pendingLabel || "Checking your account session..."}</p>
          <Progress />
        </div>
      );
    }

    if (isRecovery) {
      return (
        <form className="auth-form auth-form--recovery" onSubmit={submitNewPassword}>
          <h2>Set a new password</h2>
          <p>Choose a new password for your Echo account, then setup will continue.</p>
          <AuthPasswordField
            autoComplete="new-password"
            describedBy="auth-password-help"
            id="auth-new-password"
            label="New password"
            onChange={setPassword}
            onToggleVisibility={() => setPasswordVisible((visible) => !visible)}
            placeholder="Enter your new password"
            value={password}
            visible={passwordVisible}
          />
          <small className="auth-field-hint" id="auth-password-help">
            Must be at least 8 characters and include a letter and number.
          </small>
          <AuthPasswordField
            autoComplete="new-password"
            id="auth-confirm-new-password"
            label="Confirm password"
            onChange={setConfirmPassword}
            onToggleVisibility={() => setConfirmPasswordVisible((visible) => !visible)}
            placeholder="Repeat your new password"
            value={confirmPassword}
            visible={confirmPasswordVisible}
          />
          {(localError || authMessage) && (
            <Alert tone={localError ? "error" : "info"}>{localError || authMessage}</Alert>
          )}
          <button className="auth-submit-button" type="submit">Update password</button>
        </form>
      );
    }

    if (isPending) {
      return (
        <div className="auth-state">
          <div className="auth-state__icon" aria-hidden>
            <Mail size={22} />
          </div>
          <h2>Check your email</h2>
          <p>{authMessage || "Open the verification link on this computer to continue setup."}</p>
          <p className="auth-state__supporting">
            Echo will resume automatically after the verification link opens the app.
          </p>
          <button
            className="auth-submit-button"
            onClick={() => {
              setMode("login");
              onRetry();
            }}
            type="button"
          >
            Back to log in
          </button>
        </div>
      );
    }

    const isSignup = mode === "signup";
    const isReset = mode === "reset";

    return (
      <form className="auth-form" onSubmit={submitEmail}>
        <div className="auth-form__heading">
          <h2>{isSignup ? "Create your account" : isReset ? "Reset your password" : "Welcome back"}</h2>
          <p>
            {isSignup
              ? "Enter your details to start using Echo."
              : isReset
                ? "Enter your email and Echo will send you a reset link."
                : "Sign in to continue to Echo."}
          </p>
        </div>

        {!isReset && (
          <>
            <button
              className="auth-google-button"
              onClick={() => {
                setPendingLabel("Opening your browser to finish Google sign-in...");
                onGoogleSignIn();
              }}
              type="button"
            >
              <GoogleMark />
              <span>Continue with Google</span>
            </button>
            <div className="auth-divider" aria-hidden>
              <span>or</span>
            </div>
          </>
        )}

        {isSignup && (
          <div className="auth-name-grid">
            <label className="auth-field" htmlFor="auth-first-name">
              <span>First name</span>
              <input
                autoComplete="given-name"
                id="auth-first-name"
                onChange={(event) => setFirstName(event.target.value)}
                placeholder="e.g. John"
                required
                type="text"
                value={firstName}
              />
            </label>
            <label className="auth-field" htmlFor="auth-last-name">
              <span>Last name</span>
              <input
                autoComplete="family-name"
                id="auth-last-name"
                onChange={(event) => setLastName(event.target.value)}
                placeholder="e.g. Francisco"
                required
                type="text"
                value={lastName}
              />
            </label>
          </div>
        )}

        <label className="auth-field" htmlFor="auth-email">
          <span>Email</span>
          <input
            autoComplete="email"
            id="auth-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
            type="email"
            value={email}
          />
        </label>

        {!isReset && (
          <>
            <AuthPasswordField
              autoComplete={isSignup ? "new-password" : "current-password"}
              describedBy={isSignup ? "auth-password-help" : undefined}
              id="auth-password"
              label="Password"
              onChange={setPassword}
              onToggleVisibility={() => setPasswordVisible((visible) => !visible)}
              placeholder="Enter your password"
              value={password}
              visible={passwordVisible}
            />
            {isSignup && (
              <small className="auth-field-hint" id="auth-password-help">
                Must be at least 8 characters and include a letter and number.
              </small>
            )}
          </>
        )}

        {isSignup && (
          <AuthPasswordField
            autoComplete="new-password"
            id="auth-confirm-password"
            label="Confirm password"
            onChange={setConfirmPassword}
            onToggleVisibility={() => setConfirmPasswordVisible((visible) => !visible)}
            placeholder="Repeat your password"
            value={confirmPassword}
            visible={confirmPasswordVisible}
          />
        )}

        {mode === "login" && (
          <button
            className="auth-text-button auth-text-button--forgot"
            onClick={() => changeMode("reset")}
            type="button"
          >
            Forgot password?
          </button>
        )}

        {(localError || authMessage) && (
          <Alert tone={localError || isError ? "error" : "info"}>{localError || authMessage}</Alert>
        )}

        <button className="auth-submit-button" type="submit">
          {isSignup ? "Create account" : isReset ? "Send reset link" : "Log in"}
        </button>

        <p className="auth-mode-switch">
          {isSignup ? "Already have an account?" : isReset ? "Remember your password?" : "New to Echo?"}
          <Button
            className="auth-mode-switch__button"
            onClick={() => {
              changeMode(isSignup ? "login" : isReset ? "login" : "signup");
            }}
            type="button"
            variant="ghost"
          >
            {isSignup ? "Log in" : isReset ? "Back to log in" : "Create an account"}
          </Button>
        </p>
      </form>
    );
  };

  const bodyKey = isLoading
    ? "loading"
    : isRecovery
      ? "recovery"
      : isPending
        ? "pending"
        : mode;

  return (
    <FirstRunShell activeStep={1} ariaLabel="Echo account" completedThrough={0}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
          initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
          key={bodyKey}
          transition={transition}
        >
          {body()}
        </motion.div>
      </AnimatePresence>
    </FirstRunShell>
  );
}

function OnboardingStatusIcon({ status }: { status?: SetupCheck["status"] }) {
  if (status === "ok") return <CheckCircle2 size={16} />;
  if (status === "error") return <AlertCircle size={16} />;
  return <CircleDot size={16} />;
}

function OnboardingPanel({
  config,
  errorMsg,
  platform,
  setupStatus,
  shortcutError,
  firstDictationPassed,
  firstDictationState,
  firstDictationMessage,
  onAction,
  onComplete,
  onOpenSettings,
  onRefresh,
  onSaveInputDevice,
  onSaveShortcut,
  onSkip,
  onStartFirstDictation,
  onStopFirstDictation,
}: {
  config: AppConfig;
  errorMsg: string;
  platform: DesktopPlatform;
  setupStatus: SetupStatus | null;
  shortcutError: string;
  firstDictationPassed: boolean;
  firstDictationState: "idle" | "recording" | "processing" | "success" | "error";
  firstDictationMessage: string;
  onAction: (check: SetupCheck) => void;
  onComplete: () => void;
  onOpenSettings: () => void;
  onRefresh: () => Promise<SetupStatus | null>;
  onSaveInputDevice: (inputDevice: string | null) => Promise<void>;
  onSaveShortcut: (shortcut: string) => Promise<boolean>;
  onSkip: () => void;
  onStartFirstDictation: () => void;
  onStopFirstDictation: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  type OnboardingStep = "permissions" | "hotkeyTest";
  const steps: Array<{ id: OnboardingStep; label: string }> = [
    { id: "permissions", label: "Set up your microphone" },
    { id: "hotkeyTest", label: "Try your shortcut" },
  ];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [shortcutDraft, setShortcutDraft] = useState(config.shortcut);
  const [shortcutMessage, setShortcutMessage] = useState("Focus the field to change the hotkey, or keep the default.");
  const [shortcutSaving, setShortcutSaving] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [micDevice, setMicDevice] = useState(config.input_device ?? "");
  const [micTestState, setMicTestState] = useState<"idle" | "testing" | "success" | "fail">("idle");
  const [micTestMessage, setMicTestMessage] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const ready = setupStatus?.ready ?? false;
  const currentStep = steps[currentIndex];
  const providerCheck = setupStatus?.checks.find((check) => check.id === "provider");
  const microphoneCheck = setupStatus?.checks.find((check) => check.id === "microphone");
  const pasteCheck = setupStatus?.checks.find((check) => check.id === "paste");
  const formattedShortcut = formatShortcutForPlatform(config.shortcut, platform);
  const canFinish = ready && !shortcutError && firstDictationPassed;
  const overallStep = (currentIndex + 2) as FirstRunStepNumber;
  const showSetupBlocker = !ready;
  const micStatusTone =
    micTestState === "testing"
      ? "info"
      : micTestState === "fail"
        ? "error"
        : microphoneCheck?.status === "ok" || micTestState === "success"
          ? "success"
          : "warning";
  const micStatusText =
    micTestState === "testing"
      ? "Listening for two seconds — speak now."
      : micTestState === "success"
      ? "Microphone is working."
      : micTestState === "fail"
        ? micTestMessage || "No audio detected. Check the selected device and microphone permission."
        : microphoneCheck?.message || "Run a quick microphone test before continuing.";
  const pasteReady = pasteCheck?.status === "ok";
  const pasteStatusTone = pasteReady ? "success" : platform === "macos" ? "warning" : "info";
  const pasteStatusText = pasteReady
    ? pasteCheck?.message || "Paste is ready."
    : pasteCheck?.message || "Refresh checks to confirm paste readiness.";
  const hotkeyStateLabel =
    firstDictationState === "recording"
      ? "Listening"
      : firstDictationState === "processing"
        ? "Transcribing"
        : firstDictationPassed
          ? "Test passed"
          : "Ready to test";

  useEffect(() => {
    setShortcutDraft(config.shortcut);
  }, [config.shortcut]);

  useEffect(() => {
    setMicDevice(config.input_device ?? "");
  }, [config.input_device]);

  useEffect(() => {
    if (!HAS_TAURI) {
      setDevices(["Built-in Microphone", "Studio Display Microphone"]);
      return;
    }

    invoke<string[]>("list_audio_devices")
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  const goNext = () => setCurrentIndex((index) => Math.min(index + 1, steps.length - 1));
  const goBack = () => setCurrentIndex((index) => Math.max(index - 1, 0));

  const handleShortcutCapture = (accelerator: string) => {
    setShortcutDraft(accelerator);
    setShortcutSaving(true);
    setShortcutMessage(`Captured ${accelerator}. Checking whether the system can use it...`);
    void onSaveShortcut(accelerator)
      .then((ok) => {
        setShortcutMessage(
          ok
            ? `${accelerator} is saved.`
            : `Echo saved ${accelerator}, but the system rejected it. Choose another key.`
        );
      })
      .catch((e) => setShortcutMessage(formatErrorMessage(e)))
      .finally(() => setShortcutSaving(false));
  };

  const handleMicDeviceChange = async (value: string) => {
    setMicDevice(value);
    await onSaveInputDevice(value || null);
    await onRefresh();
  };

  const handleTestMic = async () => {
    setMicTestState("testing");
    setMicTestMessage("");
    setMicLevel(0);
    if (!HAS_TAURI) {
      window.setTimeout(() => {
        setMicLevel(0.72);
        setMicTestState("success");
      }, 500);
      return;
    }

    try {
      const peak = await invoke<number>("test_microphone", { deviceName: micDevice || null });
      setMicLevel(peak);
      if (peak > 0.01) {
        setMicTestState("success");
      } else {
        setMicTestState("fail");
        setMicTestMessage(
          platform === "macos"
            ? "No audio detected. Enable Echo in System Settings > Privacy & Security > Microphone, then try again."
            : "No audio detected. Check the selected input device and microphone permission."
        );
      }
      await onRefresh();
    } catch (e) {
      setMicTestState("fail");
      setMicTestMessage(formatErrorMessage(e));
    }
  };

  const renderStep = () => {
    if (currentStep.id === "permissions") {
      return (
        <div className="onboarding-step-stack">
          <div className="onboarding-task-list">
            <div className="onboarding-task-row">
              <div className="onboarding-task-row__header">
                <span aria-hidden className={`onboarding-task-row__icon onboarding-task-row__icon--${micStatusTone}`}>
                  <OnboardingStatusIcon status={microphoneCheck?.status} />
                </span>
                <div>
                  <strong>Microphone</strong>
                  <p>Choose an input and confirm Echo can hear you.</p>
                </div>
              </div>
              <label className="onboarding-hotkey-field">
                <span>Microphone</span>
                <select
                  className="ui-select"
                  onChange={(event) => void handleMicDeviceChange(event.target.value)}
                  value={micDevice}
                >
                  <option value="">System Default</option>
                  {devices.map((device) => (
                    <option key={device} value={device}>
                      {device}
                    </option>
                  ))}
                </select>
              </label>
              <div className="onboarding-inline-actions">
                <Button
                  disabled={micTestState === "testing"}
                  icon={<Mic size={16} />}
                  onClick={() => void handleTestMic()}
                  variant="primary"
                >
                  {micTestState === "testing" ? "Listening..." : "Test Microphone"}
                </Button>
                {microphoneCheck?.action_label && (
                  <Button onClick={() => onAction(microphoneCheck)} variant="secondary">
                    {microphoneCheck.action_label}
                  </Button>
                )}
              </div>
              {(micTestState === "testing" || micTestState === "success") && (
                <Progress value={micTestState === "success" ? Math.min(micLevel * 100, 100) : undefined} />
              )}
              <Alert tone={micStatusTone}>{micStatusText}</Alert>
            </div>

            <div className="onboarding-task-row">
              <div className="onboarding-task-row__header">
                <span aria-hidden className={`onboarding-task-row__icon onboarding-task-row__icon--${pasteStatusTone}`}>
                  <OnboardingStatusIcon status={pasteCheck?.status} />
                </span>
                <div>
                  <strong>{platform === "macos" ? "Paste access" : "Paste readiness"}</strong>
                  <p>
                    {platform === "macos"
                      ? "Let Echo paste automatically after dictation."
                      : "Confirm clipboard and paste behavior for this device."}
                  </p>
                </div>
              </div>
              <div className="onboarding-inline-actions">
                {platform === "macos" && (
                  <Button onClick={() => pasteCheck && onAction(pasteCheck)} variant="primary">
                    Open Accessibility
                  </Button>
                )}
                <Button onClick={() => void onRefresh()} variant="secondary">
                  Refresh Checks
                </Button>
              </div>
              <Alert tone={pasteStatusTone}>{pasteStatusText}</Alert>
              {!pasteReady && platform === "macos" && (
                <p className="onboarding-muted-note">If Accessibility is unavailable, Echo keeps the transcript on the clipboard.</p>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="onboarding-step-stack">
        <div className="onboarding-status-line">
          <Chip tone={firstDictationPassed ? "success" : "neutral"}>{hotkeyStateLabel}</Chip>
        </div>
        <div className="onboarding-hotkey-test">
          <span className="onboarding-hotkey-test__icon" aria-hidden>
            <Keyboard size={20} />
          </span>
          <ShortcutKeys shortcut={formattedShortcut} />
          <span>{firstDictationPassed ? "The full dictation loop passed." : "Echo will record, transcribe, then paste or copy."}</span>
        </div>
        <div className="onboarding-hotkey-field">
          <span>Hotkey</span>
          <ShortcutCapture
            displayValue={formatShortcutForPlatform(shortcutDraft, platform)}
            invalid={!!shortcutError}
            onCapture={handleShortcutCapture}
            onFocus={() => setShortcutMessage("Press any key or key combo. Escape can be captured here.")}
            onIncomplete={() => setShortcutMessage("Press one final key to complete the shortcut.")}
            platform={platform}
            value={shortcutDraft}
          />
        </div>
        <Alert tone={shortcutError ? "error" : shortcutSaving ? "info" : "success"}>
          {shortcutError || shortcutMessage}
        </Alert>
        {firstDictationState === "recording" ? (
          <Button fullWidth icon={<Square size={16} />} onClick={onStopFirstDictation} variant="primary">
            Stop Test
          </Button>
        ) : (
          <Button
            disabled={!ready || !!shortcutError || firstDictationState === "processing"}
            fullWidth
            icon={<Mic size={16} />}
            onClick={onStartFirstDictation}
            variant={firstDictationPassed ? "secondary" : "primary"}
          >
            {firstDictationState === "processing" ? "Transcribing" : firstDictationPassed ? "Run test again" : "Start test"}
          </Button>
        )}
        {firstDictationMessage && (
          <Alert tone={firstDictationState === "success" ? "success" : firstDictationState === "error" ? "error" : "info"}>
            {firstDictationMessage}
          </Alert>
        )}
        {providerCheck && providerCheck.status !== "ok" && (
          <Alert tone="warning">
            {providerCheck?.message || "Set up Cloud or Local transcription in Settings before the hotkey test can run."}
            <div className="onboarding-alert-action">
              <Button onClick={onOpenSettings} variant="secondary">
                Open Settings
              </Button>
            </div>
          </Alert>
        )}
        {providerCheck?.status === "ok" && (!ready || shortcutError || !firstDictationPassed) && (
          <Alert tone="warning">
            Start the test before finishing onboarding.
          </Alert>
        )}
        {errorMsg && <Alert tone="error">{errorMsg}</Alert>}
      </div>
    );
  };

  return (
    <FirstRunShell
      activeStep={overallStep}
      ariaLabel={`Echo onboarding: ${currentStep.label}`}
      completedThrough={overallStep - 1}
      panelClassName="first-run-panel__content--onboarding"
    >
      <section className="onboarding-panel" aria-label={currentStep.label}>
        <header className="onboarding-heading">
          <div className="onboarding-heading__title">
            <span className="onboarding-heading__progress">Step {overallStep} of 3</span>
            <h2>{currentStep.label}</h2>
            <p>
              {currentStep.id === "permissions"
                ? "Choose your microphone and confirm Echo can paste on this computer."
                : "Hold your shortcut, say a short sentence, then release."}
            </p>
          </div>
          {showSetupBlocker && <Chip tone="warning">Needs setup</Chip>}
        </header>

        <div className="onboarding-flow">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={currentStep.id}
              className="onboarding-step"
              initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
            >
              {renderStep()}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="onboarding-actions">
          <div className="onboarding-actions__side">
            {currentIndex > 0 && (
              <Button onClick={goBack} variant="secondary">
                Back
              </Button>
            )}
            <Button onClick={onSkip} variant="ghost">
              Skip onboarding
            </Button>
          </div>
          <div className="onboarding-actions__side onboarding-actions__side--end">
            <Button
              disabled={currentIndex === steps.length - 1 && !canFinish}
              icon={currentIndex === 0 ? <ArrowRight size={16} /> : undefined}
              onClick={currentIndex === steps.length - 1 ? onComplete : goNext}
              variant="primary"
            >
              {currentIndex === steps.length - 1 ? "Finish" : "Continue"}
            </Button>
          </div>
        </div>
      </section>
    </FirstRunShell>
  );
}

function OnboardingSuccess({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <motion.div
      className="onboarding-success"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 1.02 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
      role="status"
      aria-live="polite"
    >
      <motion.div
        className="onboarding-success__mark"
        initial={reduceMotion ? false : { scale: 0.72, rotate: -8 }}
        animate={reduceMotion ? undefined : { scale: 1, rotate: 0 }}
        transition={reduceMotion ? undefined : { type: "spring", stiffness: 520, damping: 28 }}
        aria-hidden
      >
        <CheckCircle2 size={52} />
      </motion.div>
      <h2>Echo is ready</h2>
      <p>Setup is complete. Opening your dictation workspace.</p>
    </motion.div>
  );
}

function StatsBentoDashboard({ stats }: { stats: DictationStats }) {
  const nextMilestone = stats.next_milestone;
  const remaining = nextMilestone ? Math.max(nextMilestone - stats.total_words, 0) : 0;
  const finalMilestone = WORD_MILESTONES[WORD_MILESTONES.length - 1];

  return (
    <Disclosure
      className="insights-disclosure"
      summary="Insights"
      summaryMeta={`${formatInsightNumber(stats.total_words)} words`}
    >
      <section className="insights-grid" aria-label="Dictation insights">
        <div className="insight-value">
          <span>Total words</span>
          <strong>{formatInsightNumber(stats.total_words)}</strong>
        </div>
        <div className="insight-value">
          <span>Words per minute</span>
          <strong>{formatInsightNumber(stats.rolling_wpm)}</strong>
        </div>
        <div className="insight-value">
          <span>Day streak</span>
          <strong>{formatInsightNumber(stats.day_streak)}</strong>
        </div>
        <div className="insight-value">
          <span>Next milestone</span>
          <strong>
            {nextMilestone
              ? `${formatMilestone(remaining)} words remaining`
              : `${formatMilestone(finalMilestone)} reached`}
          </strong>
        </div>
      </section>
    </Disclosure>
  );
}

const SHORTCUT_KEY_SYMBOLS: Record<string, string> = {
  command: "\u2318",
  cmd: "\u2318",
  super: "\u2318",
  meta: "\u2318",
  control: "\u2303",
  ctrl: "\u2303",
  option: "\u2325",
  alt: "\u2325",
  shift: "\u21e7",
  enter: "\u23ce",
  return: "\u23ce",
  space: "Space",
  tab: "\u21e5",
  escape: "Esc",
  esc: "Esc",
};

function ShortcutKeys({ shortcut }: { shortcut: string }) {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const keys = shortcut
    .split(/\s*\+\s*/)
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) =>
      key.toLowerCase() === "commandorcontrol"
        ? isMac
          ? SHORTCUT_KEY_SYMBOLS.command
          : SHORTCUT_KEY_SYMBOLS.control
        : SHORTCUT_KEY_SYMBOLS[key.toLowerCase()] ?? key
    );

  return (
    <span className="shortcut-keys" aria-label={`Shortcut ${shortcut}`}>
      {keys.map((key, index) => (
        <kbd className="shortcut-key" key={`${key}-${index}`}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

function DictatePanel({
  appState,
  config,
  errorMsg,
  setupStatus,
  shortcutError,
  stats,
  transcript,
  lastPerformance,
  milestoneCelebration,
  onAction,
  onDismissMilestone,
  onOpenSettings,
  onRefresh,
}: {
  appState: AppState;
  config: AppConfig | null;
  errorMsg: string;
  setupStatus: SetupStatus | null;
  shortcutError: string;
  stats: DictationStats;
  transcript: string;
  lastPerformance: DictationPerformancePayload[];
  milestoneCelebration: MilestoneCelebration | null;
  onAction: (check: SetupCheck) => void;
  onDismissMilestone: () => void;
  onOpenSettings: () => void;
  onRefresh: () => Promise<SetupStatus | null>;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const needsSetup = Boolean(setupStatus && !setupStatus.ready);
  const localPreviewMessage =
    "On-device preview: Whisper runs privately on this computer. Cloud cleanup is not used, so wording stays closer to what you said.";
  const customerMessage = presentHomeMessage(errorMsg);
  const showMessageDetails =
    Boolean(errorMsg) && customerMessage !== errorMsg && !errorMsg.toLowerCase().includes("gsk_");
  const messageNeedsSettings = /secure storage|api key|provider|model|shortcut|setup/i.test(errorMsg);

  return (
    <div className="dictate-panel">
      <motion.section
        className={`dictate-hero dictate-hero--${appState}`}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
      >
        <span className="dictate-hero__glow" aria-hidden />
        <div className="dictate-hero__mark">
          <StateGlyph state={appState} />
        </div>
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={`${appState}-copy`}
            className="dictate-hero__copy"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, filter: "blur(4px)" }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <h2 className="dictate-hero__title">{stateTitle(appState)}</h2>
            <p className="dictate-hero__hint">{stateHint(appState, config?.shortcut, errorMsg)}</p>
          </motion.div>
        </AnimatePresence>

        {appState === "idle" && (
          <div className="dictate-hero__meta">
            <ShortcutKeys shortcut={config?.shortcut ?? "CommandOrControl+D"} />
            {config?.model_provider === "local" && (
              <IconButton className="dictate-hero__info" label={localPreviewMessage}>
                <Info size={15} />
              </IconButton>
            )}
          </div>
        )}

        {appState === "recording" && (
          <div className="recording-note" role="status">
            <CircleDot size={14} />
            Listening
          </div>
        )}

        {appState === "processing" && (
          <div className="dictate-hero__progress">
            <Progress />
          </div>
        )}

        {(appState === "success" || appState === "copied") && transcript && (
          <motion.div
            className="transcript-preview"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
          >
            <p>{transcript}</p>
          </motion.div>
        )}

      </motion.section>

      {errorMsg && (
        <InlineNotice
          tone={appState === "error" ? "error" : "warning"}
          action={
            messageNeedsSettings ? (
              <Button size="sm" variant="secondary" onClick={onOpenSettings}>
                Review
              </Button>
            ) : undefined
          }
          details={showMessageDetails ? errorMsg : undefined}
        >
          {customerMessage}
        </InlineNotice>
      )}

      <AnimatePresence>
        {milestoneCelebration && (
          <motion.div
            className="milestone-toast"
            key={milestoneCelebration.id}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
            role="status"
          >
            <div className="milestone-toast__icon" aria-hidden>
              <PartyPopper size={18} />
            </div>
            <div>
              <strong>{formatMilestone(milestoneCelebration.milestone)} words reached</strong>
              <span>Nice work. Echo added this milestone to your all-time stats.</span>
            </div>
            <IconButton label="Dismiss milestone" onClick={onDismissMilestone}>
              <X size={14} />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>

      <StatsBentoDashboard stats={stats} />

      {lastPerformance.length > 0 && (
        <DictationPerformanceCard
          config={config}
          performance={lastPerformance}
        />
      )}

      {needsSetup && setupStatus && (
        <SetupPanel
          status={setupStatus}
          shortcutError={shortcutError}
          onOpenSettings={onOpenSettings}
          onAction={onAction}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}

function DictationPerformanceCard({
  config,
  performance,
}: {
  config: AppConfig | null;
  performance: DictationPerformancePayload[];
}) {
  const transcribe = performance.find((item) => item.phase === "transcribe");
  const paste = performance.find((item) => item.phase === "paste");
  const cleanup = performance.find((item) => item.phase === "cleanup");
  if (!transcribe) return null;

  const providerLabel =
    transcribe.provider === "local"
      ? `Local ${transcribe.localModelSize ?? config?.local_model_size ?? "Whisper"}`
      : transcribe.model ?? "Cloud";
  const cacheLabel =
    transcribe.modelCacheHit == null
      ? null
      : transcribe.modelCacheHit
        ? "Model cached"
        : "Loaded model";
  const warning =
    transcribe.provider === "local" &&
    (transcribe.localModelSize ?? config?.local_model_size) === "medium" &&
    !transcribe.modelCacheHit;

  return (
    <Disclosure
      className="dictation-performance-card"
      summary="Last dictation details"
      summaryMeta={[providerLabel, cacheLabel].filter(Boolean).join(" · ")}
    >
      <div className="dictation-performance-grid">
        <PerformanceMetric label="Total" value={formatDurationMs(transcribe.totalMs)} />
        <PerformanceMetric label="Speech check" value={formatDurationMs(transcribe.speechCheckMs)} />
        {transcribe.speechDetected != null && (
          <PerformanceMetric
            label="Speech"
            value={transcribe.speechDetected ? "Detected" : "Borderline"}
          />
        )}
        {transcribe.provider === "local" ? (
          <>
            <PerformanceMetric label="Model load" value={formatDurationMs(transcribe.modelLoadMs)} />
            <PerformanceMetric label="Inference" value={formatDurationMs(transcribe.inferenceMs)} />
            <PerformanceMetric label="Threads" value={transcribe.threadCount ? `${transcribe.threadCount}` : "Auto"} />
          </>
        ) : (
          <PerformanceMetric label="Cloud" value={formatDurationMs(transcribe.cloudTranscribeMs)} />
        )}
        {paste && <PerformanceMetric label="Paste" value={formatDurationMs(paste.pasteMs)} />}
        {cleanup && <PerformanceMetric label="Cleanup" value={formatDurationMs(cleanup.cleanupMs)} />}
      </div>

      {warning && (
        <Alert tone="warning">
          Medium is the heavier local model. The next dictation should skip model load while Echo stays open.
        </Alert>
      )}
      {transcribe.errorCode && <Alert tone="warning">Error code: {transcribe.errorCode}</Alert>}
    </Disclosure>
  );
}

function PerformanceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="performance-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StateGlyph({ state }: { state: AppState }) {
  const reduceMotion = useReducedMotion() ?? false;

  if (state === "processing") {
    return (
      <motion.div
        className="native-state-glyph native-state-glyph--processing"
      >
        <span />
      </motion.div>
    );
  }

  const iconKey = state === "success" || state === "copied" ? "success" : state === "error" ? "error" : "idle";
  const icon =
    iconKey === "success" ? (
      <CheckCircle2 />
    ) : iconKey === "error" ? (
      <AlertCircle />
    ) : (
      <AudioWaveform />
    );
  const className =
    iconKey === "success"
      ? "state-icon state-icon--success"
      : iconKey === "error"
        ? "state-icon state-icon--error"
        : "native-state-glyph native-state-glyph--idle";

  return (
    <motion.div
      className={className}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
    >
      <AnimatedIconSwap iconKey={iconKey}>{icon}</AnimatedIconSwap>
    </motion.div>
  );
}

function presentHomeMessage(message: string): string {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("secure storage returned no key") ||
    normalized.includes("secure storage did not return the new key") ||
    normalized.includes("could not verify secure storage")
  ) {
    return "Key saved. Secure storage verification is still pending.";
  }

  if (normalized.includes("no speech")) {
    return "No speech was detected. Try again and speak a little closer to the microphone.";
  }

  if (normalized.includes("no target") || normalized.includes("clipboard")) {
    return "Your dictation was copied. Focus the destination and paste it.";
  }

  return message.split("CommandOrControl").join("the shortcut");
}

function stateTitle(state: AppState): string {
  const labels: Record<AppState, string> = {
    idle: "Ready",
    recording: "Listening",
    processing: "Transcribing",
    success: "Pasted",
    copied: "Copied",
    error: "Needs attention",
  };
  return labels[state];
}

function stateHint(state: AppState, _shortcut = "Command + D", errorMsg = ""): string {
  const labels: Record<AppState, string> = {
    idle: "Press the shortcut anywhere to dictate",
    recording: "Release the shortcut to stop",
    processing: "Turning speech into text",
    success: "Inserted in the active app",
    copied: presentHomeMessage(errorMsg || "Focus the destination and paste"),
    error: "Review the message below and try again",
  };
  return labels[state];
}

function SetupPanel({
  status,
  shortcutError,
  onOpenSettings,
  onAction,
  onRefresh,
}: {
  status: SetupStatus;
  shortcutError: string;
  onOpenSettings: () => void;
  onAction: (check: SetupCheck) => void;
  onRefresh: () => Promise<SetupStatus | null>;
}) {
  const blockers = status.checks.filter((check) => check.status !== "ok");
  const firstBlocker = blockers[0];
  if (!firstBlocker) return null;

  const firstMessage =
    firstBlocker.id === "shortcut" && shortcutError ? shortcutError : firstBlocker.message;
  const handleFix = () => {
    if (firstBlocker.action_label) {
      onAction(firstBlocker);
      return;
    }
    onOpenSettings();
  };

  return (
    <InlineNotice
      className="setup-panel"
      tone="warning"
      action={
        <Button size="sm" variant="secondary" onClick={handleFix}>
          Fix setup
        </Button>
      }
      details={
        <div className="setup-panel__details">
          {blockers.map((check) => (
            <div key={check.id}>
              <strong>{check.label}</strong>
              <span>{check.id === "shortcut" && shortcutError ? shortcutError : check.message}</span>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => void onRefresh()}>
            Refresh checks
          </Button>
        </div>
      }
      aria-label="Setup status"
    >
      <strong>{firstBlocker.label} needs attention.</strong> {firstMessage}
    </InlineNotice>
  );
}

type NoteSaveState = "idle" | "saving" | "saved" | "error";
type NotepadDictationState = "idle" | "recording" | "processing";

function noteTitle(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return firstLine || "Untitled note";
}

function notePreview(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact || "Start typing or dictate into this note.";
}

function sortNotesByUpdatedAt(notes: NotepadNote[]): NotepadNote[] {
  return [...notes].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at) || b.created_at.localeCompare(a.created_at)
  );
}

function NotepadPanel() {
  const reduceMotion = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingBodiesRef = useRef<Record<string, string>>({});
  const [notes, setNotes] = useState<NotepadNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [saveState, setSaveState] = useState<NoteSaveState>("idle");
  const [error, setError] = useState("");
  const [copiedNoteId, setCopiedNoteId] = useState<string | null>(null);
  const [dictationState, setDictationState] = useState<NotepadDictationState>("idle");

  const selectedNote = selectedId ? notes.find((note) => note.id === selectedId) ?? null : null;
  const saveStatusLabel =
    saveState === "saving"
      ? "Saving note"
      : saveState === "saved"
        ? "Note saved"
        : saveState === "error"
          ? "Note save failed"
          : "";

  useEffect(() => {
    if (!HAS_TAURI) return;
    return listenSafely<string>("entitlement-offline-fallback", (event) => {
      setError(event.payload || ONLINE_PRO_REQUIRED_MESSAGE);
    });
  }, []);

  const filteredNotes = notes.filter((note) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${noteTitle(note.body)} ${note.body}`.toLowerCase().includes(needle);
  });

  const updateLocalNote = useCallback((id: string, changes: Partial<NotepadNote>) => {
    setNotes((prev) =>
      sortNotesByUpdatedAt(prev.map((note) => (note.id === id ? { ...note, ...changes } : note)))
    );
  }, []);

  const flushSave = useCallback(
    async (id: string) => {
      const body = pendingBodiesRef.current[id];
      if (typeof body !== "string") return;

      if (saveTimersRef.current[id]) {
        clearTimeout(saveTimersRef.current[id]);
        delete saveTimersRef.current[id];
      }

      setSaveState("saving");

      if (!HAS_TAURI) {
        delete pendingBodiesRef.current[id];
        updateLocalNote(id, { body, updated_at: new Date().toISOString() });
        setSaveState("saved");
        return;
      }

      try {
        const saved = await invoke<NotepadNote>("update_notepad_note", { id, body });
        if (pendingBodiesRef.current[id] === body) {
          delete pendingBodiesRef.current[id];
          updateLocalNote(id, saved);
          setSaveState("saved");
        }
      } catch (e) {
        setError(formatErrorMessage(e));
        setSaveState("error");
      }
    },
    [updateLocalNote]
  );

  const scheduleSave = useCallback(
    (id: string, body: string) => {
      pendingBodiesRef.current[id] = body;
      setSaveState("saving");

      if (saveTimersRef.current[id]) {
        clearTimeout(saveTimersRef.current[id]);
      }
      saveTimersRef.current[id] = setTimeout(() => {
        void flushSave(id);
      }, 550);
    },
    [flushSave]
  );

  const loadNotes = useCallback(async () => {
    setError("");
    if (!HAS_TAURI) {
      setNotes(MOCK_NOTES);
      setSelectedId((current) => current ?? MOCK_NOTES[0]?.id ?? null);
      return;
    }

    try {
      const items = await invoke<NotepadNote[]>("list_notepad_notes");
      const sorted = sortNotesByUpdatedAt(items);
      setNotes(sorted);
      setSelectedId((current) => current ?? sorted[0]?.id ?? null);
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  useEffect(() => {
    if (!selectedNote) return;
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [selectedNote?.id]);

  useEffect(() => {
    return () => {
      Object.keys(saveTimersRef.current).forEach((id) => {
        clearTimeout(saveTimersRef.current[id]);
        void flushSave(id);
      });
    };
  }, [flushSave]);

  const handleCreateNote = async () => {
    setError("");

    if (!HAS_TAURI) {
      const now = new Date().toISOString();
      const note: NotepadNote = {
        id: `note-${Date.now()}`,
        body: "",
        created_at: now,
        updated_at: now,
      };
      setNotes((prev) => [note, ...prev]);
      setSelectedId(note.id);
      return;
    }

    try {
      const note = await invoke<NotepadNote>("create_notepad_note");
      setNotes((prev) => sortNotesByUpdatedAt([note, ...prev]));
      setSelectedId(note.id);
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  };

  const ensureSelectedNote = async (): Promise<NotepadNote | null> => {
    if (selectedNote) return selectedNote;

    if (!HAS_TAURI) {
      const now = new Date().toISOString();
      const note: NotepadNote = {
        id: `note-${Date.now()}`,
        body: "",
        created_at: now,
        updated_at: now,
      };
      setNotes((prev) => [note, ...prev]);
      setSelectedId(note.id);
      return note;
    }

    try {
      const note = await invoke<NotepadNote>("create_notepad_note");
      setNotes((prev) => sortNotesByUpdatedAt([note, ...prev]));
      setSelectedId(note.id);
      return note;
    } catch (e) {
      setError(formatErrorMessage(e));
      return null;
    }
  };

  const handleBodyChange = (body: string) => {
    if (!selectedNote) return;
    setError("");
    setNotes((prev) => prev.map((note) => (note.id === selectedNote.id ? { ...note, body } : note)));
    scheduleSave(selectedNote.id, body);
  };

  const insertTextIntoSelectedNote = async (text: string) => {
    const note = await ensureSelectedNote();
    if (!note) return;

    const currentBody = notes.find((item) => item.id === note.id)?.body ?? note.body;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? currentBody.length;
    const end = textarea?.selectionEnd ?? currentBody.length;
    const needsLeadingSpace = start > 0 && currentBody[start - 1] && !/\s/.test(currentBody[start - 1]);
    const needsTrailingSpace = end < currentBody.length && currentBody[end] && !/\s/.test(currentBody[end]);
    const insertion = `${needsLeadingSpace ? " " : ""}${text.trim()}${needsTrailingSpace ? " " : ""}`;
    const nextBody = `${currentBody.slice(0, start)}${insertion}${currentBody.slice(end)}`;
    setNotes((prev) => prev.map((item) => (item.id === note.id ? { ...item, body: nextBody } : item)));
    scheduleSave(note.id, nextBody);

    window.setTimeout(() => {
      textareaRef.current?.focus();
      const cursor = start + insertion.length;
      textareaRef.current?.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const handleDeleteNote = async (id: string) => {
    setError("");
    if (saveTimersRef.current[id]) {
      clearTimeout(saveTimersRef.current[id]);
      delete saveTimersRef.current[id];
    }
    delete pendingBodiesRef.current[id];

    const nextNotes = notes.filter((note) => note.id !== id);
    if (!HAS_TAURI) {
      setNotes(nextNotes);
      setSelectedId((current) => (current === id ? nextNotes[0]?.id ?? null : current));
      return;
    }

    try {
      await invoke("delete_notepad_note", { id });
      setNotes(nextNotes);
      setSelectedId((current) => (current === id ? nextNotes[0]?.id ?? null : current));
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  };

  const handleCopyNote = async (note: NotepadNote) => {
    try {
      if (!HAS_TAURI) {
        await navigator.clipboard?.writeText(note.body);
      } else {
        await invoke("copy_transcript", { text: note.body });
      }
      setCopiedNoteId(note.id);
      setTimeout(() => setCopiedNoteId(null), 1500);
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  };

  const handleStartDictation = async () => {
    setError("");
    await ensureSelectedNote();

    if (!HAS_TAURI) {
      setDictationState("recording");
      setTimeout(() => {
        void insertTextIntoSelectedNote("Preview dictation inserted into the note.");
        setDictationState("idle");
      }, 1000);
      return;
    }

    try {
      const recording = await invoke<boolean>("is_recording");
      if (recording) return;

      const cfg = await invoke<AppConfig>("get_config");
      if (cfg.model_provider === "api" && !cfg.groq_api_key) {
        setError("Enter a Groq API key or switch to a local Whisper model before dictating into Notepad.");
        return;
      }

      await invoke("start_recording");
      invoke("pause_media").catch(() => {});
      await emitIndicatorMode("recording");
      setDictationState("recording");
    } catch (e) {
      setError(formatErrorMessage(e));
      setDictationState("idle");
      emitIndicatorMode("error").catch(() => {});
    }
  };

  const handleStopDictation = async () => {
    if (!HAS_TAURI) {
      setDictationState("idle");
      return;
    }

    try {
      const recording = await invoke<boolean>("is_recording");
      if (!recording) {
        setDictationState("idle");
        return;
      }

      setDictationState("processing");
      await emitIndicatorMode("transcribing");
      const audioPath = await invoke<string>("stop_recording");
      const rawText = await invoke<string>("transcribe_audio", { audioPath });
      const finalText = transcriptTextOrThrow(rawText);

      await emitIndicatorMode("pasting");
      await insertTextIntoSelectedNote(finalText);
      invoke("play_chime").catch(() => {});
      emit("indicator-mode", { mode: "idle" }).catch(() => {});
      setDictationState("idle");
    } catch (e) {
      const msg = formatErrorMessage(e);
      setError(isEmptyTranscriptError(e) ? EMPTY_TRANSCRIPT_MESSAGE : msg);
      emit("indicator-mode", { mode: "error" }).catch(() => {});
      setDictationState("idle");
    } finally {
      invoke("resume_media").catch(() => {});
    }
  };

  return (
    <div className="notepad-panel">
      <div className="page-heading page-heading--split">
        <div>
          <h2>Notepad</h2>
          {saveStatusLabel && (
            <span className="visually-hidden" role="status">
              {saveStatusLabel}
            </span>
          )}
        </div>
        <button
          className="notepad-new-note-button"
          type="button"
          aria-label="New note"
          title="New note"
          onClick={handleCreateNote}
        >
          <Plus size={22} />
        </button>
      </div>

      {error && <Alert tone="warning">{error}</Alert>}

      <section className="notepad-workspace">
        <aside className="notepad-list" aria-label="Notes">
          <label className="notepad-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search notes"
              type="search"
            />
          </label>

          <div className="notepad-list__items">
            {filteredNotes.length === 0 ? (
              <div className="notepad-empty-list">
                <FileText size={18} />
                <span>{notes.length === 0 ? "No notes yet" : "No matching notes"}</span>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {filteredNotes.map((note) => (
                  <motion.button
                    className={`notepad-note-row${note.id === selectedId ? " is-active" : ""}`}
                    key={note.id}
                    layout
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                    transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
                    onClick={() => {
                      setSelectedId(note.id);
                    }}
                    type="button"
                  >
                    <strong>{noteTitle(note.body)}</strong>
                    <span>{notePreview(note.body)}</span>
                    <small>{formatDate(note.updated_at)}</small>
                  </motion.button>
                ))}
              </AnimatePresence>
            )}
          </div>
        </aside>

        <article className={`notepad-editor ui-card${selectedNote ? "" : " notepad-editor--empty"}`}>
          {selectedNote ? (
            <>
              <div className="notepad-editor__toolbar">
                <div>
                  <strong>{noteTitle(selectedNote.body)}</strong>
                  <span>{formatDate(selectedNote.updated_at)}</span>
                </div>
                <div className="notepad-editor__actions">
                  <IconButton
                    label={dictationState === "recording" ? "Stop Notepad dictation" : "Dictate into note"}
                    onClick={() =>
                      dictationState === "recording"
                        ? void handleStopDictation()
                        : void handleStartDictation()
                    }
                    disabled={dictationState === "processing"}
                  >
                    <AnimatedIconSwap iconKey={dictationState === "recording" ? "stop" : "mic"}>
                      {dictationState === "recording" ? <Square size={14} /> : <Mic size={15} />}
                    </AnimatedIconSwap>
                  </IconButton>
                  <IconButton
                    className={copiedNoteId === selectedNote.id ? "notepad-copy-button is-copied" : "notepad-copy-button"}
                    label={copiedNoteId === selectedNote.id ? "Copied" : "Copy note"}
                    onClick={() => void handleCopyNote(selectedNote)}
                  >
                    <AnimatedIconSwap iconKey={copiedNoteId === selectedNote.id ? "copied" : "copy"}>
                      {copiedNoteId === selectedNote.id ? <Check size={14} /> : <Copy size={14} />}
                    </AnimatedIconSwap>
                  </IconButton>
                  <IconButton
                    label="Delete note"
                    tone="danger"
                    onClick={() => void handleDeleteNote(selectedNote.id)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </div>

              {dictationState !== "idle" && (
                <div className="notepad-dictation-status" role="status">
                  <CircleDot size={13} />
                  <span>{dictationState === "recording" ? "Listening for this note" : "Transcribing into Notepad"}</span>
                </div>
              )}

              <textarea
                ref={textareaRef}
                className="notepad-textarea"
                value={selectedNote.body}
                onChange={(event) => handleBodyChange(event.target.value)}
                placeholder="Type a note, draft something, or use the mic to dictate here."
              />
            </>
          ) : (
            <div className="notepad-empty-editor">
              <FileText size={24} />
              <h3>No note selected</h3>
              <p>Create a note to start writing.</p>
              <button
                className="notepad-new-note-button"
                type="button"
                aria-label="New note"
                title="New note"
                onClick={handleCreateNote}
              >
                <Plus size={22} />
              </button>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

function HistoryPanel({
  copiedId,
  history,
  onClear,
  onCopy,
  onDelete,
}: {
  copiedId: string | null;
  history: HistoryItem[];
  onClear: () => void;
  onCopy: (text: string, id: string) => void;
  onDelete: (id: string) => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [clearConfirming, setClearConfirming] = useState(false);
  const [query, setQuery] = useState("");
  const searchQuery = query.trim().toLowerCase();
  const filteredHistory = searchQuery
    ? history.filter((item) => {
        const status = item.paste_result === "pasted" ? "pasted" : "copied";
        return `${item.text} ${status} ${formatDate(item.created_at)}`
          .toLowerCase()
          .includes(searchQuery);
      })
    : history;

  useEffect(() => {
    if (!clearConfirming) return;
    const timeout = window.setTimeout(() => setClearConfirming(false), 6000);
    return () => window.clearTimeout(timeout);
  }, [clearConfirming]);

  useEffect(() => {
    if (history.length === 0) {
      setClearConfirming(false);
    }
  }, [history.length]);

  const handleClearClick = () => {
    if (!clearConfirming) {
      setClearConfirming(true);
      return;
    }
    setClearConfirming(false);
    onClear();
  };

  return (
    <div className="history-panel">
      <div className="page-heading page-heading--split">
        <div>
          <h2>Recent Dictations</h2>
          <span>Saved transcripts stay on this device.</span>
        </div>
        {history.length > 0 && (
          <Button variant={clearConfirming ? "danger" : "secondary"} onClick={handleClearClick}>
            {clearConfirming ? "Confirm Clear" : "Clear All"}
          </Button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {clearConfirming && (
          <motion.div
            className="history-clear-confirm ui-card"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
            role="status"
          >
            <p>Clear all saved transcripts from this device? This cannot be undone.</p>
            <Button variant="secondary" size="sm" onClick={() => setClearConfirming(false)}>
              Cancel
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {history.length === 0 ? (
        <motion.div
          className="history-empty ui-card"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
        >
          <History size={22} />
          <h3>No transcriptions yet</h3>
          <p>Your dictation history will appear here.</p>
        </motion.div>
      ) : (
        <>
          <label className="history-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search history"
              type="search"
            />
          </label>
          {filteredHistory.length === 0 ? (
            <motion.div
              className="history-empty ui-card"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
            >
              <Search size={22} />
              <h3>No matching transcriptions</h3>
              <p>Try a different word, date, or paste status.</p>
            </motion.div>
          ) : (
            <div className="history-list">
              <AnimatePresence initial={false}>
                {filteredHistory.map((item) => (
                  <motion.article
                    className="history-row"
                    key={item.id}
                    layout
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                    transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
                  >
                    <div className="history-row__meta">
                      <span>{formatDate(item.created_at)}</span>
                      <Chip tone={item.paste_result === "pasted" ? "success" : "neutral"}>
                        {item.paste_result === "pasted" ? "Pasted" : "Copied"}
                      </Chip>
                    </div>
                    <p>{item.text}</p>
                    <div className="history-row__actions">
                      <IconButton
                        label={copiedId === item.id ? "Copied" : "Copy transcript"}
                        onClick={() => onCopy(item.text, item.id)}
                      >
                        <AnimatedIconSwap iconKey={copiedId === item.id ? "copied" : "copy"}>
                          {copiedId === item.id ? <Check size={14} /> : <Copy size={14} />}
                        </AnimatedIconSwap>
                      </IconButton>
                      <IconButton
                        label={`Delete transcript from ${formatDate(item.created_at)}`}
                        tone="danger"
                        onClick={() => onDelete(item.id)}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </div>
                  </motion.article>
                ))}
              </AnimatePresence>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StandaloneNotepadWindow() {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const insertTextIntoNoteRef = useRef<(text: string) => Promise<void>>(async () => {});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBodyRef = useRef<string | null>(null);
  const [note, setNote] = useState<NotepadNote | null>(null);
  const [saveState, setSaveState] = useState<NoteSaveState>("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [dictationState, setDictationState] = useState<NotepadDictationState>("idle");
  const [windowReady, setWindowReady] = useState(!HAS_TAURI);
  const [appearanceTheme, setAppearanceTheme] = useState<AppearanceTheme>(
    MOCK_CONFIG.appearance_theme
  );
  const resolvedTheme = useResolvedTheme(appearanceTheme);

  useEffect(() => {
    if (!HAS_TAURI) return;
    return listenSafely<string>("entitlement-offline-fallback", (event) => {
      setError(event.payload || ONLINE_PRO_REQUIRED_MESSAGE);
    });
  }, []);

  const updateNote = useCallback((changes: Partial<NotepadNote>) => {
    setNote((current) => (current ? { ...current, ...changes } : current));
  }, []);

  const ensureNote = useCallback(async (): Promise<NotepadNote | null> => {
    if (note) return note;

    if (!HAS_TAURI) {
      const fallback = MOCK_NOTES[0] ?? {
        id: `note-${Date.now()}`,
        body: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setNote(fallback);
      return fallback;
    }

    try {
      const notes = sortNotesByUpdatedAt(await invoke<NotepadNote[]>("list_notepad_notes"));
      const existing = notes[0];
      if (existing) {
        setNote(existing);
        return existing;
      }

      const created = await invoke<NotepadNote>("create_notepad_note");
      setNote(created);
      return created;
    } catch (e) {
      setError(formatErrorMessage(e));
      return null;
    }
  }, [note]);

  const flushSave = useCallback(async () => {
    if (!note || pendingBodyRef.current === null) return;
    const body = pendingBodyRef.current;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    setSaveState("saving");

    if (!HAS_TAURI) {
      pendingBodyRef.current = null;
      updateNote({ body, updated_at: new Date().toISOString() });
      setSaveState("saved");
      return;
    }

    try {
      const saved = await invoke<NotepadNote>("update_notepad_note", { id: note.id, body });
      if (pendingBodyRef.current === body) {
        pendingBodyRef.current = null;
        setNote(saved);
        setSaveState("saved");
      }
    } catch (e) {
      setError(formatErrorMessage(e));
      setSaveState("error");
    }
  }, [note, updateNote]);

  useEffect(() => {
    if (!HAS_TAURI) return;
    let unlistenFocus: (() => void) | null = null;
    const currentWindow = getCurrentWindow();

    currentWindow
      .isVisible()
      .then((visible) => {
        if (visible) setWindowReady(true);
      })
      .catch(() => setWindowReady(true));

    currentWindow
      .isFocused()
      .then((focused) => {
        emit("notepad-window-focus", focused).catch(() => {});
      })
      .catch(() => {});

    currentWindow
      .onFocusChanged(({ payload }) => {
        if (payload) setWindowReady(true);
        emit("notepad-window-focus", payload).catch(() => {});
      })
      .then((unlisten) => {
        unlistenFocus = unlisten;
      })
      .catch(() => {});

    return () => {
      emit("notepad-window-focus", false).catch(() => {});
      unlistenFocus?.();
    };
  }, []);

  useEffect(() => {
    if (!HAS_TAURI) {
      setAppearanceTheme(MOCK_CONFIG.appearance_theme);
      return;
    }

    let unlistenTheme: (() => void) | null = null;

    invoke<AppConfig>("get_config")
      .then((cfg) => setAppearanceTheme(normalizeTheme(cfg.appearance_theme)))
      .catch(() => setAppearanceTheme("system"));

    listen<AppearanceTheme>("appearance-theme-changed", (event) => {
      setAppearanceTheme(normalizeTheme(event.payload));
    }).then((unlisten) => {
      unlistenTheme = unlisten;
    });

    return () => {
      unlistenTheme?.();
    };
  }, []);

  useEffect(() => {
    if (windowReady) {
      void ensureNote();
    }
  }, [ensureNote, windowReady]);

  useEffect(() => {
    if (!note) return;
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [note?.id]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      void flushSave();
    };
  }, [flushSave]);

  const scheduleSave = (body: string) => {
    pendingBodyRef.current = body;
    setSaveState("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void flushSave();
    }, 550);
  };

  const handleBodyChange = (body: string) => {
    setError("");
    updateNote({ body });
    scheduleSave(body);
  };

  const insertTextIntoNote = async (text: string) => {
    const current = await ensureNote();
    if (!current) return;

    const currentBody = note?.body ?? current.body;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? currentBody.length;
    const end = textarea?.selectionEnd ?? currentBody.length;
    const needsLeadingSpace = start > 0 && currentBody[start - 1] && !/\s/.test(currentBody[start - 1]);
    const needsTrailingSpace = end < currentBody.length && currentBody[end] && !/\s/.test(currentBody[end]);
    const insertion = `${needsLeadingSpace ? " " : ""}${text.trim()}${needsTrailingSpace ? " " : ""}`;
    const nextBody = `${currentBody.slice(0, start)}${insertion}${currentBody.slice(end)}`;

    setNote((item) => (item ? { ...item, body: nextBody } : { ...current, body: nextBody }));
    scheduleSave(nextBody);

    window.setTimeout(() => {
      textareaRef.current?.focus();
      const cursor = start + insertion.length;
      textareaRef.current?.setSelectionRange(cursor, cursor);
    }, 0);
  };

  insertTextIntoNoteRef.current = insertTextIntoNote;

  useEffect(() => {
    if (!HAS_TAURI) return;
    let unlistenInsert: (() => void) | null = null;

    listen<string>("notepad-insert-transcript", (event) => {
      setError("");
      setDictationState("processing");
      void insertTextIntoNoteRef.current(event.payload).finally(() => {
        setDictationState("idle");
      });
    }).then((unlisten) => {
      unlistenInsert = unlisten;
    });

    return () => {
      unlistenInsert?.();
    };
  }, []);

  const handleCopy = async () => {
    if (!note) return;
    try {
      if (HAS_TAURI) {
        await invoke("copy_transcript", { text: note.body });
      } else {
        await navigator.clipboard?.writeText(note.body);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  };

  const handleDelete = async () => {
    if (!note) return;
    setError("");
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingBodyRef.current = null;

    if (HAS_TAURI) {
      try {
        await invoke("delete_notepad_note", { id: note.id });
        const notes = sortNotesByUpdatedAt(await invoke<NotepadNote[]>("list_notepad_notes"));
        const next = notes[0] ?? (await invoke<NotepadNote>("create_notepad_note"));
        setNote(next);
      } catch (e) {
        setError(formatErrorMessage(e));
      }
      return;
    }

    setNote({
      id: `note-${Date.now()}`,
      body: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  };

  const handleStartDictation = async () => {
    setError("");
    await ensureNote();

    if (!HAS_TAURI) {
      setDictationState("recording");
      setTimeout(() => {
        void insertTextIntoNote("Preview dictation inserted into the note.");
        setDictationState("idle");
      }, 1000);
      return;
    }

    try {
      const recording = await invoke<boolean>("is_recording");
      if (recording) return;

      const cfg = await invoke<AppConfig>("get_config");
      if (cfg.model_provider === "api" && !cfg.groq_api_key) {
        setError("Enter a Groq API key or switch to a local Whisper model before dictating into Notepad.");
        return;
      }

      await invoke("start_recording");
      invoke("pause_media").catch(() => {});
      await emitIndicatorMode("recording");
      setDictationState("recording");
    } catch (e) {
      setError(formatErrorMessage(e));
      setDictationState("idle");
      emitIndicatorMode("error").catch(() => {});
    }
  };

  const handleStopDictation = async () => {
    if (!HAS_TAURI) {
      setDictationState("idle");
      return;
    }

    try {
      const recording = await invoke<boolean>("is_recording");
      if (!recording) {
        setDictationState("idle");
        return;
      }

      setDictationState("processing");
      await emitIndicatorMode("transcribing");
      const audioPath = await invoke<string>("stop_recording");
      const rawText = await invoke<string>("transcribe_audio", { audioPath });
      const finalText = transcriptTextOrThrow(rawText);

      await emitIndicatorMode("pasting");
      await insertTextIntoNote(finalText);
      invoke("play_chime").catch(() => {});
      await emitIndicatorMode("idle");
      setDictationState("idle");
    } catch (e) {
      const msg = formatErrorMessage(e);
      setError(isEmptyTranscriptError(e) ? EMPTY_TRANSCRIPT_MESSAGE : msg);
      emitIndicatorMode("error").catch(() => {});
      setDictationState("idle");
    } finally {
      invoke("resume_media").catch(() => {});
    }
  };

  const startWindowDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !HAS_TAURI) return;
    getCurrentWindow().startDragging().catch(console.error);
  };

  const status =
    dictationState === "recording"
      ? "Listening for this note"
      : dictationState === "processing"
        ? "Transcribing into Notepad"
        : saveState === "saving"
          ? "Saving..."
          : saveState === "saved"
            ? "Saved"
            : "";

  return (
    <main className="window-root window-root--notepad" data-theme={resolvedTheme} onPointerDownCapture={startWindowDrag}>
      <div
        className="standalone-note-drag-zone"
        data-tauri-drag-region
        aria-hidden
      />
      <section className="standalone-note-shell">
        <article className="standalone-note-card">
          <header className="standalone-note-header" data-tauri-drag-region onMouseDown={startWindowDrag}>
            <div className="standalone-note-title">
              <h1>{note ? noteTitle(note.body) : "Untitled note"}</h1>
              <p>{note ? formatDate(note.updated_at) : ""}</p>
            </div>
            <div className="standalone-note-actions">
              <IconButton
                label={dictationState === "recording" ? "Stop Notepad dictation" : "Dictate into note"}
                onClick={() =>
                  dictationState === "recording" ? void handleStopDictation() : void handleStartDictation()
                }
                disabled={dictationState === "processing"}
              >
                <AnimatedIconSwap iconKey={dictationState === "recording" ? "stop" : "mic"}>
                  {dictationState === "recording" ? <Square size={19} /> : <Mic size={21} />}
                </AnimatedIconSwap>
              </IconButton>
              <IconButton
                className={copied ? "notepad-copy-button is-copied" : "notepad-copy-button"}
                label={copied ? "Copied" : "Copy note"}
                onClick={() => void handleCopy()}
              >
                <AnimatedIconSwap iconKey={copied ? "copied" : "copy"}>
                  {copied ? <Check size={20} /> : <Copy size={20} />}
                </AnimatedIconSwap>
              </IconButton>
              <IconButton label="Delete note" tone="danger" onClick={() => void handleDelete()}>
                <Trash2 size={21} />
              </IconButton>
            </div>
          </header>

          {error && <Alert tone="warning">{error}</Alert>}
          {status && <div className="standalone-note-status">{status}</div>}

          <textarea
            ref={textareaRef}
            className="standalone-note-textarea"
            value={note?.body ?? ""}
            onChange={(event) => handleBodyChange(event.target.value)}
            placeholder="Type a note, draft something, or use the mic to dictate here."
          />
        </article>
      </section>
    </main>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default App;
