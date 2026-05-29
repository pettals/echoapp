import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import {
  AlertCircle,
  AudioWaveform,
  BookOpen,
  CheckCircle2,
  CircleDot,
  Copy,
  FileText,
  Flame,
  Gauge,
  History,
  Mic,
  PartyPopper,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Target,
  Trash2,
  Trophy,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import AudioHudIndicator, { type AudioHudIndicatorState } from "./components/AudioHudIndicator";
import AnimatedOrb from "./components/AnimatedOrb";
import Settings from "./components/Settings";
import { Alert, Button, Card, Chip, IconButton, Progress } from "./components/ui";
import echoLogo from "./assets/echo-logo.png";
import "./App.css";

type AppState = "idle" | "recording" | "processing" | "success" | "copied" | "error";
type ActiveTab = "dictate" | "notepad" | "history" | "settings";
type DesktopPlatform = "macos" | "windows";
type DictationTarget = "external" | "standalone-notepad";
type IndicatorMode =
  | "idle"
  | "recording"
  | "processing"
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
  sounds_enabled: boolean;
  indicator_sound: string;
  success_sound: string;
  onboarding_completed: boolean;
  history_enabled: boolean;
  history_limit: number;
  appearance_theme: AppearanceTheme;
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

interface DictationStats {
  total_words: number;
  dictation_count: number;
  rolling_wpm: number;
  day_streak: number;
  next_milestone: number | null;
  next_milestone_progress: number;
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

interface ShortcutValidation {
  valid: boolean;
  message: string;
}

const WINDOW_LABEL = (() => {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
})();

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const NO_SPEECH_DETECTED = "NO_SPEECH_DETECTED";
const WORD_MILESTONES = [100, 1_000, 2_000, 5_000, 7_500, 10_000, 20_000, 50_000, 100_000];
const INDICATOR_COMPACT_SIZE = { width: 56, height: 14 };
const INDICATOR_HOVER_SIZE = { width: 264, height: 74 };
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
  shortcut: "Command+d",
  transcription_model: "whisper-large-v3-turbo",
  cleanup_model: "llama-3.1-8b-instant",
  cleanup_enabled: true,
  input_device: null,
  model_provider: "api",
  local_model_size: "small",
  sounds_enabled: true,
  indicator_sound: "tink",
  success_sound: "glass",
  onboarding_completed: false,
  history_enabled: true,
  history_limit: 100,
  appearance_theme: "dark",
};

const MOCK_SETUP_STATUS: SetupStatus = {
  ready: false,
  checks: [
    {
      id: "provider",
      label: "Provider",
      status: "ok",
      message: "Groq API key is configured for preview.",
      action_label: null,
    },
    {
      id: "microphone",
      label: "Microphone",
      status: "warning",
      message: "Test your microphone before release QA.",
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

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
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

async function emitIndicatorMode(mode: IndicatorMode, transcript?: string) {
  if (!HAS_TAURI) return;
  await emit("indicator-mode", { mode, transcript });
}

async function emitIndicatorLiveTranscript(transcript: string, isFinal = false) {
  if (!HAS_TAURI) return;
  await emit("indicator-live-transcript", { transcript, isFinal });
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

  if (WINDOW_LABEL === "indicator") {
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
  if (mode === "recording" || mode === "processing") {
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

  return (
    <main className="hud-preview-screen">
      <section className="hud-preview-stage" aria-label="Audio HUD preview">
        <div className="hud-preview-frame">
          <AudioHudIndicator
            state={previewState}
            level={previewLevel}
            expanded={previewState === "idle" && previewExpanded}
            copyText="Here is the transcript ready to copy when Echo cannot find the last focused text field."
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
  const prevRecording = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const platform = detectDesktopPlatform();
  const recording = mode === "recording";
  const hudState = mapIndicatorToHudState(mode);
  const level = useRecordingLevel(recording);
  const resolvedTheme = useResolvedTheme(appearanceTheme);
  const completeLabel = mode === "copied" || mode === "copied_no_target" ? "Copied" : "Pasted";

  useEffect(() => {
    if (mode !== "idle" && expanded) {
      setExpanded(false);
    }
  }, [mode, expanded]);

  useEffect(() => {
    if (!HAS_TAURI) return;
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
    if (!HAS_TAURI) return;

    let cancelled = false;
    const targetSize = indicatorSizeForMode(mode, expanded, liveTranscript);

    const resizeIndicator = async () => {
      try {
        if (cancelled) return;
        await invoke("reposition_indicator", {
          width: targetSize.width,
          height: targetSize.height,
        });
      } catch {
        /* preview or hidden window */
      }
    };

    resizeIndicator();

    let dockPoll: ReturnType<typeof setInterval> | null = null;
    if (platform === "macos" || mode !== "idle" || expanded) {
      dockPoll = setInterval(resizeIndicator, 500);
    }

    return () => {
      cancelled = true;
      if (dockPoll) {
        clearInterval(dockPoll);
      }
    };
  }, [mode, expanded, liveTranscript, platform]);

  useEffect(() => {
    if (!HAS_TAURI) return;
    if (mode !== "idle") return;

    const refreshPosition = async () => {
      try {
        const targetSize = indicatorSizeForMode("idle", expanded);
        await invoke("reposition_indicator", {
          width: targetSize.width,
          height: targetSize.height,
        });
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
  }, [mode, expanded]);

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
    if (!HAS_TAURI) return;
    invoke("show_idle_indicator")
      .then(() =>
        invoke("reposition_indicator", {
          width: INDICATOR_COMPACT_SIZE.width,
          height: INDICATOR_COMPACT_SIZE.height,
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
          setMode((current) => (current === "recording" ? "processing" : current));
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
      if (platform === "macos") {
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
        setMode("processing");
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
      className={`window-root window-root--indicator recording-hud-shell recording-hud-shell--${mode} recording-hud-shell--platform-${platform}`}
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
        canConfirm={mode !== "processing"}
        completeLabel={completeLabel}
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
          invoke("show_notepad_window").catch(() => {});
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
  const [shortcutError, setShortcutError] = useState("");
  const [appearancePreview, setAppearancePreview] = useState<AppearanceTheme | null>(null);
  const contentMainColRef = useRef<HTMLDivElement | null>(null);
  const registeredShortcut = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const shortcutHeldRef = useRef(false);
  const startInFlightRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const notepadFocusedRef = useRef(false);
  const dictationTargetRef = useRef<DictationTarget>("external");
  const milestoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shortcutPressedRef = useRef<() => void>(() => {});
  const shortcutReleasedRef = useRef<() => void>(() => {});
  const resolvedTheme = useResolvedTheme(appearancePreview ?? config?.appearance_theme ?? "dark");

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
      const normalized = { ...cfg, appearance_theme: normalizeTheme(cfg.appearance_theme) };
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
        if (cfg.model_provider === "api" && !cfg.groq_api_key) {
          setActiveTab("settings");
          return false;
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
    [resetDictationTarget, setIndicatorMode]
  );

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
      setIndicatorMode("processing");
      const audioPath = await invoke<string>("stop_recording");
      const recordingDurationMs = Math.max(
        0,
        Date.now() - (recordingStartedAtRef.current ?? Date.now())
      );
      recordingStartedAtRef.current = null;

      const rawText = await invoke<string>("transcribe_audio", { audioPath });

      let finalText = rawText;
      let recoverableWarning = "";
      const cfg = await invoke<AppConfig>("get_config");
      if (cfg.cleanup_enabled && cfg.model_provider === "api") {
        try {
          finalText = await invoke<string>("cleanup_text", { text: rawText });
        } catch (e) {
          recoverableWarning = `Transcribed, but cleanup failed: ${formatErrorMessage(e)}`;
          finalText = rawText;
        }
      }

      await emitIndicatorLiveTranscript(finalText, true);
      setTranscript(finalText);
      const activeTarget = dictationTargetRef.current;
      const result =
        activeTarget === "standalone-notepad"
          ? await emit("notepad-insert-transcript", finalText).then(() => "pasted")
          : await invoke<string>("paste_transcript", { text: finalText });
      const pasteWarning =
        result === "copied_accessibility"
          ? "Copied because Echo is not enabled in Accessibility."
          : "";
      setErrorMsg([recoverableWarning, pasteWarning].filter(Boolean).join(" "));

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

      setTimeout(() => setAppState("idle"), 3000);
      return true;
    } catch (e: unknown) {
      const msg = formatErrorMessage(e);
      if (msg === NO_SPEECH_DETECTED) {
        recordingStartedAtRef.current = null;
        resetDictationTarget();
        setTranscript("");
        setErrorMsg("");
        setAppState("idle");
        setIndicatorMode("idle");
        return true;
      }

      setErrorMsg(msg);
      setAppState("error");
      setIndicatorMode("error");
      recordingStartedAtRef.current = null;
      resetDictationTarget();
      return false;
    } finally {
      invoke("resume_media").catch(() => {});
      stopInFlightRef.current = false;
    }
  }, [playChime, resetDictationTarget, setIndicatorMode, showMilestoneCelebration]);

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

  const handleShortcutPressed = useCallback(async () => {
    if (shortcutHeldRef.current || sessionActiveRef.current) return;

    shortcutHeldRef.current = true;
    sessionActiveRef.current = true;
    stopRequestedRef.current = false;

    const started = await startRecording();
    if (!started) {
      sessionActiveRef.current = false;
      return;
    }

    if (stopRequestedRef.current) {
      await stopAndPaste();
      sessionActiveRef.current = false;
    }
  }, [startRecording, stopAndPaste]);

  const handleShortcutReleased = useCallback(async () => {
    shortcutHeldRef.current = false;
    stopRequestedRef.current = true;

    if (!sessionActiveRef.current) return;
    if (!startInFlightRef.current) {
      await stopAndPaste();
      sessionActiveRef.current = false;
    }
  }, [stopAndPaste]);

  shortcutPressedRef.current = handleShortcutPressed;
  shortcutReleasedRef.current = handleShortcutReleased;

  const registerShortcut = useCallback(async (shortcut: string) => {
    if (!HAS_TAURI) return;

    try {
      const validation = await invoke<ShortcutValidation>("validate_shortcut", { shortcut });
      if (!validation.valid) {
        setShortcutError(validation.message);
        return;
      }

      if (registeredShortcut.current) {
        await unregister(registeredShortcut.current);
        registeredShortcut.current = null;
      }
      await register(shortcut, (event) => {
        if (event.state === "Pressed") {
          void shortcutPressedRef.current();
        } else if (event.state === "Released") {
          void shortcutReleasedRef.current();
        }
      });
      registeredShortcut.current = shortcut;
      setShortcutError("");
    } catch (e) {
      const msg = formatErrorMessage(e);
      setShortcutError(
        `Could not register ${shortcut}. Choose another shortcut or quit the app already using it. ${msg}`
      );
      console.error("Failed to register shortcut:", e);
    }
  }, []);

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
    loadConfig().then((cfg) => {
      if (cfg) {
        if (cfg.model_provider === "api" && !cfg.groq_api_key) {
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
        unregister(registeredShortcut.current).catch(console.error);
      }
      if (milestoneTimerRef.current) {
        clearTimeout(milestoneTimerRef.current);
        milestoneTimerRef.current = null;
      }
    };
  }, [loadConfig, loadHistory, loadSetupStatus, loadStats, registerShortcut]);

  useEffect(() => {
    contentMainColRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeTab]);

  useEffect(() => {
    if (!HAS_TAURI) return;

    const unlisten: (() => void)[] = [];
    listen("tray-start-recording", () => {
      void handleStartRecording();
    }).then((u) => unlisten.push(u));

    listen("tray-stop-recording", () => {
      void handleStopAndPaste();
    }).then((u) => unlisten.push(u));

    listen("tray-open-settings", () => {
      loadConfig();
      setActiveTab("settings");
    }).then((u) => unlisten.push(u));

    listen("menu-open-dictate", () => {
      setActiveTab("dictate");
    }).then((u) => unlisten.push(u));

    listen("menu-open-history", () => {
      loadHistory();
      setActiveTab("history");
    }).then((u) => unlisten.push(u));

    listen("indicator-open-notepad", () => {
      setActiveTab("notepad");
    }).then((u) => unlisten.push(u));

    listen("menu-check-setup", () => {
      loadSetupStatus();
      setActiveTab("dictate");
    }).then((u) => unlisten.push(u));

    listen("indicator-cancel-recording", () => {
      void handleCancelRecording();
    }).then((u) => unlisten.push(u));

    listen<boolean>("notepad-window-focus", (event) => {
      notepadFocusedRef.current = event.payload;
    }).then((u) => unlisten.push(u));

    return () => {
      unlisten.forEach((u) => u());
    };
  }, [handleCancelRecording, handleStartRecording, handleStopAndPaste, loadConfig, loadHistory, loadSetupStatus]);

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

  const handleSaveSettings = async (newConfig: AppConfig) => {
    const normalizedConfig = {
      ...newConfig,
      groq_api_key: newConfig.groq_api_key.trim(),
    };

    if (!HAS_TAURI) {
      setConfig(normalizedConfig);
      setAppearancePreview(null);
      setActiveTab("dictate");
      return;
    }

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
    setActiveTab("dictate");
    await registerShortcut(normalizedSavedConfig.shortcut);
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

  const startWindowDrag = (event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !HAS_TAURI) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, textarea, input, select, a, [data-no-window-drag]")) return;
    event.preventDefault();
    getCurrentWindow().startDragging().catch(console.error);
  };

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
          <div className="app-logo-wrap">
            <img src={echoLogo} alt="Echo" className="app-logo" draggable={false} />
            <div>
              <h1>Echo</h1>
              <p>Dictation</p>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          <NavButton
            active={activeTab === "dictate"}
            icon={<AudioWaveform />}
            label="Dictate"
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
            onClick={() => {
              loadConfig();
              setActiveTab("settings");
            }}
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
                    milestoneCelebration={milestoneCelebration}
                    onAction={handleSetupAction}
                    onDismissMilestone={dismissMilestoneCelebration}
                    onOpenSettings={() => setActiveTab("settings")}
                    onRefresh={loadSetupStatus}
                    onStartRecording={handleStartRecording}
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
                  <Settings
                    config={config}
                    onSave={handleSaveSettings}
                    onCancel={() => {
                      setAppearancePreview(null);
                      setActiveTab("dictate");
                    }}
                    onPreviewAppearance={setAppearancePreview}
                    shortcutError={shortcutError}
                    setupStatus={setupStatus}
                    onRefreshSetup={loadSetupStatus}
                  />
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

function StatsBentoDashboard({ stats }: { stats: DictationStats }) {
  const nextMilestone = stats.next_milestone;
  const progress = Math.round(Math.min(Math.max(stats.next_milestone_progress, 0), 1) * 100);
  const remaining = nextMilestone ? Math.max(nextMilestone - stats.total_words, 0) : 0;
  const finalMilestone = WORD_MILESTONES[WORD_MILESTONES.length - 1];

  return (
    <section className="stats-bento" aria-label="Dictation insights">
      <article className="stats-tile stats-tile--total">
        <span className="stats-tile__icon" aria-hidden>
          <Trophy size={16} />
        </span>
        <div>
          <span>Total words</span>
          <strong>{formatInsightNumber(stats.total_words)}</strong>
        </div>
      </article>

      <article className="stats-tile">
        <span className="stats-tile__icon" aria-hidden>
          <Gauge size={16} />
        </span>
        <div>
          <span>WPM</span>
          <strong>{formatInsightNumber(stats.rolling_wpm)}</strong>
        </div>
      </article>

      <article className="stats-tile">
        <span className="stats-tile__icon" aria-hidden>
          <Flame size={16} />
        </span>
        <div>
          <span>Day streak</span>
          <strong>{formatInsightNumber(stats.day_streak)}</strong>
        </div>
      </article>

      <article className="stats-tile stats-tile--progress">
        <div className="stats-tile__progress-head">
          <span className="stats-tile__icon" aria-hidden>
            <Target size={16} />
          </span>
          <div>
            <span>Next milestone</span>
            <strong>{nextMilestone ? `${progress}%` : "Complete"}</strong>
          </div>
        </div>
        <div
          className="stats-progress"
          aria-label={
            nextMilestone
              ? `${progress}% toward ${formatMilestone(nextMilestone)} words`
              : `${formatMilestone(finalMilestone)} word milestone complete`
          }
        >
          <span style={{ width: `${nextMilestone ? progress : 100}%` }} />
        </div>
        <p>
          {nextMilestone
            ? `${formatMilestone(remaining)} words to ${formatMilestone(nextMilestone)}`
            : `${formatMilestone(finalMilestone)} word milestone reached`}
        </p>
      </article>
    </section>
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
  milestoneCelebration,
  onAction,
  onDismissMilestone,
  onOpenSettings,
  onRefresh,
  onStartRecording,
}: {
  appState: AppState;
  config: AppConfig | null;
  errorMsg: string;
  setupStatus: SetupStatus | null;
  shortcutError: string;
  stats: DictationStats;
  transcript: string;
  milestoneCelebration: MilestoneCelebration | null;
  onAction: (check: SetupCheck) => void;
  onDismissMilestone: () => void;
  onOpenSettings: () => void;
  onRefresh: () => Promise<SetupStatus | null>;
  onStartRecording: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <div className="dictate-panel">
      <div className="page-heading page-heading--split page-heading--workspace">
        <div>
          <p>Dictate</p>
          <h2>{stateTitle(appState)}</h2>
          <span>{stateHint(appState, config?.shortcut, errorMsg)}</span>
        </div>
        {appState === "idle" && (
          <Button
            size="md"
            variant="primary"
            icon={<AudioWaveform size={16} />}
            onClick={onStartRecording}
          >
            Start
          </Button>
        )}
        {appState === "recording" && (
          <div className="recording-note" role="status">
            <CircleDot size={14} />
            Listening
          </div>
        )}
      </div>

      <StatsBentoDashboard stats={stats} />

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

      <motion.section
        key={appState}
        className={`ui-card command-surface command-surface--dictate command-surface--${appState}`}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
      >
        <div className="command-surface__stack">
          <div className="dictation-status-row">
            <StateGlyph state={appState} />
            <div>
              <strong>{statusLabel(appState)}</strong>
              <span>{statusDetail(appState, config?.shortcut, errorMsg)}</span>
            </div>
          </div>

          {(appState === "idle" || appState === "recording") && (
            <div className="command-chips">
              <Chip icon={<Mic size={14} />}>{config?.shortcut ?? "Command + D"}</Chip>
              <Chip icon={<Sparkles size={14} />}>
                {config?.cleanup_enabled ? "Cleanup on" : "Raw transcript"}
              </Chip>
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

          {appState === "processing" && <Progress />}
          {appState === "idle" && errorMsg && <Alert tone="warning">{errorMsg}</Alert>}
          {(appState === "success" || appState === "copied") && errorMsg && (
            <Alert tone="warning">{errorMsg}</Alert>
          )}
          {appState === "error" && errorMsg && <Alert tone="error">{errorMsg}</Alert>}
        </div>
      </motion.section>

      {setupStatus && (
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

  if (state === "success" || state === "copied") {
    return (
      <motion.div
        className="state-icon state-icon--success"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
      >
        <CheckCircle2 />
      </motion.div>
    );
  }

  if (state === "error") {
    return (
      <motion.div
        className="state-icon state-icon--error"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
      >
        <AlertCircle />
      </motion.div>
    );
  }

  return (
    <motion.div
      className="native-state-glyph native-state-glyph--idle"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
    >
      <AudioWaveform />
    </motion.div>
  );
}

function statusLabel(state: AppState): string {
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

function statusDetail(state: AppState, shortcut = "Command + D", errorMsg = ""): string {
  const labels: Record<AppState, string> = {
    idle: errorMsg || `Use ${shortcut}, the menu, or the Start button.`,
    recording: "Release the shortcut or use Stop Recording from the menu.",
    processing: "Cleaning up your dictation and preparing the paste.",
    success: errorMsg || "Inserted in the previously focused app.",
    copied: errorMsg || "The transcript is on the clipboard.",
    error: errorMsg || "Review setup and try again.",
  };
  return labels[state];
}

function stateTitle(state: AppState): string {
  const labels: Record<AppState, string> = {
    idle: "Ready to dictate",
    recording: "Recording",
    processing: "Processing",
    success: "Pasted",
    copied: "Copied to clipboard",
    error: "Needs attention",
  };
  return labels[state];
}

function stateHint(state: AppState, shortcut = "Command + D", errorMsg = ""): string {
  const labels: Record<AppState, string> = {
    idle: `Press ${shortcut} or start manually`,
    recording: "Release the shortcut to stop",
    processing: "Transcribing and polishing your text",
    success: "Inserted into the target app",
    copied: errorMsg || "Focus your target app and press Cmd/Ctrl+V to paste",
    error: "Review the message below, then try again",
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
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <Card className={`setup-panel${status.ready ? " setup-panel--ready" : ""}`} aria-label="Setup status">
      <div className="setup-panel__header">
        <div>
          <Chip tone={status.ready ? "success" : "warning"}>
            {status.ready ? "Ready" : "Needs setup"}
          </Chip>
          <h3>{status.ready ? "Setup complete" : "Finish setup before dictating"}</h3>
        </div>
        <IconButton label="Refresh setup checks" onClick={() => void onRefresh()}>
          <RefreshCw size={16} />
        </IconButton>
      </div>

      <div className="readiness-strip" aria-label="Readiness checks">
        {status.checks.map((check) => (
          <motion.button
            className={`readiness-pill readiness-pill--${check.status}`}
            key={check.id}
            onClick={() => check.status !== "ok" && onAction(check)}
            type="button"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
            whileHover={reduceMotion ? undefined : { y: -1 }}
            whileTap={reduceMotion ? undefined : { scale: 0.98 }}
          >
            <CircleDot size={12} />
            <span>{check.label}</span>
          </motion.button>
        ))}
      </div>

      <div className="setup-list">
        {blockers.map((check) => (
          <motion.div
            key={check.id}
            className={`setup-check setup-check--${check.status}`}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : PANEL_TRANSITION}
          >
            <CircleDot className="setup-dot" size={16} />
            <div>
              <strong>{check.label}</strong>
              <span>{check.id === "shortcut" && shortcutError ? shortcutError : check.message}</span>
            </div>
            {check.action_label && (
              <Button size="sm" variant="secondary" onClick={() => onAction(check)}>
                {check.action_label}
              </Button>
            )}
          </motion.div>
        ))}
      </div>

      {!status.ready && (
        <Button fullWidth variant="primary" onClick={onOpenSettings}>
          Review settings
        </Button>
      )}
    </Card>
  );
}

type NoteSaveState = "idle" | "saving" | "saved" | "error";
type NotepadDictationState = "idle" | "recording" | "processing";
type NotepadMode = "edit" | "read";

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
  const [mode, setMode] = useState<NotepadMode>("edit");
  const [saveState, setSaveState] = useState<NoteSaveState>("idle");
  const [error, setError] = useState("");
  const [copiedNoteId, setCopiedNoteId] = useState<string | null>(null);
  const [dictationState, setDictationState] = useState<NotepadDictationState>("idle");

  const selectedNote = selectedId ? notes.find((note) => note.id === selectedId) ?? null : null;
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
    return () => {
      Object.keys(saveTimersRef.current).forEach((id) => {
        clearTimeout(saveTimersRef.current[id]);
        void flushSave(id);
      });
    };
  }, [flushSave]);

  const handleCreateNote = async () => {
    setError("");
    setMode("edit");

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
    setMode("edit");
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
      await emitIndicatorMode("processing");
      const audioPath = await invoke<string>("stop_recording");
      const rawText = await invoke<string>("transcribe_audio", { audioPath });
      const cfg = await invoke<AppConfig>("get_config");
      let finalText = rawText;

      if (cfg.cleanup_enabled && cfg.model_provider === "api") {
        try {
          finalText = await invoke<string>("cleanup_text", { text: rawText });
        } catch (e) {
          setError(`Transcribed, but cleanup failed: ${formatErrorMessage(e)}`);
        }
      }

      await insertTextIntoSelectedNote(finalText);
      invoke("play_chime").catch(() => {});
      emit("indicator-mode", { mode: "idle" }).catch(() => {});
      setDictationState("idle");
    } catch (e) {
      const msg = formatErrorMessage(e);
      setError(msg === NO_SPEECH_DETECTED ? "No speech detected. Try again when you are ready." : msg);
      emit("indicator-mode", { mode: "error" }).catch(() => {});
      setDictationState("idle");
    } finally {
      invoke("resume_media").catch(() => {});
    }
  };

  const saveLabel =
    saveState === "saving"
      ? "Saving..."
      : saveState === "saved"
        ? "Saved locally"
        : saveState === "error"
          ? "Save failed"
          : "Local notes";

  return (
    <div className="notepad-panel">
      <div className="page-heading page-heading--split">
        <div>
          <p>Notepad</p>
          <h2>Notes and drafts</h2>
          <span>{saveLabel}</span>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={handleCreateNote}>
          New Note
        </Button>
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
                      setMode("edit");
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

        <article className="notepad-editor ui-card">
          {selectedNote ? (
            <>
              <div className="notepad-editor__toolbar">
                <div>
                  <strong>{noteTitle(selectedNote.body)}</strong>
                  <span>{formatDate(selectedNote.updated_at)}</span>
                </div>
                <div className="notepad-editor__actions">
                  <IconButton
                    label={mode === "edit" ? "Preview note" : "Edit note"}
                    onClick={() => setMode((current) => (current === "edit" ? "read" : "edit"))}
                  >
                    {mode === "edit" ? <BookOpen size={15} /> : <Pencil size={15} />}
                  </IconButton>
                  <IconButton
                    label={dictationState === "recording" ? "Stop Notepad dictation" : "Dictate into note"}
                    onClick={() =>
                      dictationState === "recording"
                        ? void handleStopDictation()
                        : void handleStartDictation()
                    }
                    disabled={dictationState === "processing"}
                  >
                    {dictationState === "recording" ? <Square size={14} /> : <Mic size={15} />}
                  </IconButton>
                  <IconButton
                    label={copiedNoteId === selectedNote.id ? "Copied" : "Copy note"}
                    onClick={() => void handleCopyNote(selectedNote)}
                  >
                    <Copy size={14} />
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

              {mode === "edit" ? (
                <textarea
                  ref={textareaRef}
                  className="notepad-textarea"
                  value={selectedNote.body}
                  onChange={(event) => handleBodyChange(event.target.value)}
                  placeholder="Type a note, draft something, or use the mic to dictate here."
                />
              ) : (
                <div className="notepad-markdown">
                  {selectedNote.body.trim() ? (
                    <ReactMarkdown
                      components={{
                        a: ({ children, ...props }) => (
                          <a {...props} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {selectedNote.body}
                    </ReactMarkdown>
                  ) : (
                    <p className="notepad-markdown__empty">Nothing to preview yet.</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="notepad-empty-editor">
              <FileText size={24} />
              <h3>No note selected</h3>
              <p>Create a note to start writing.</p>
              <Button variant="primary" icon={<Plus size={16} />} onClick={handleCreateNote}>
                New Note
              </Button>
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

  return (
    <div className="history-panel">
      <div className="page-heading page-heading--split">
        <div>
          <p>Local history</p>
          <h2>Recent dictations</h2>
          <span>Saved transcripts stay on this device.</span>
        </div>
        {history.length > 0 && (
          <Button variant="secondary" onClick={onClear}>
            Clear All
          </Button>
        )}
      </div>

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
        <div className="history-list">
          <AnimatePresence initial={false}>
            {history.map((item) => (
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
                    <Copy size={14} />
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
    </div>
  );
}

function StandaloneNotepadWindow() {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const insertTextIntoNoteRef = useRef<(text: string) => Promise<void>>(async () => {});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBodyRef = useRef<string | null>(null);
  const [note, setNote] = useState<NotepadNote | null>(null);
  const [mode, setMode] = useState<NotepadMode>("edit");
  const [saveState, setSaveState] = useState<NoteSaveState>("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [dictationState, setDictationState] = useState<NotepadDictationState>("idle");
  const [windowReady, setWindowReady] = useState(!HAS_TAURI);

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
    if (windowReady) {
      void ensureNote();
    }
  }, [ensureNote, windowReady]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      void flushSave();
    };
  }, [flushSave]);

  useEffect(() => {
    if (note && mode === "edit") {
      window.setTimeout(() => textareaRef.current?.focus(), 80);
    }
  }, [note, mode]);

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

    setMode("edit");
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
        setMode("edit");
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
      await emitIndicatorMode("processing");
      const audioPath = await invoke<string>("stop_recording");
      const rawText = await invoke<string>("transcribe_audio", { audioPath });
      const cfg = await invoke<AppConfig>("get_config");
      let finalText = rawText;

      if (cfg.cleanup_enabled && cfg.model_provider === "api") {
        try {
          finalText = await invoke<string>("cleanup_text", { text: rawText });
        } catch (e) {
          setError(`Transcribed, but cleanup failed: ${formatErrorMessage(e)}`);
        }
      }

      await insertTextIntoNote(finalText);
      invoke("play_chime").catch(() => {});
      await emitIndicatorMode("idle");
      setDictationState("idle");
    } catch (e) {
      const msg = formatErrorMessage(e);
      setError(msg === NO_SPEECH_DETECTED ? "No speech detected. Try again when you are ready." : msg);
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
    <main className="window-root window-root--notepad" data-theme="light" onPointerDownCapture={startWindowDrag}>
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
                label={mode === "edit" ? "Preview note" : "Edit note"}
                onClick={() => setMode((current) => (current === "edit" ? "read" : "edit"))}
              >
                {mode === "edit" ? <BookOpen size={20} /> : <Pencil size={20} />}
              </IconButton>
              <IconButton
                label={dictationState === "recording" ? "Stop Notepad dictation" : "Dictate into note"}
                onClick={() =>
                  dictationState === "recording" ? void handleStopDictation() : void handleStartDictation()
                }
                disabled={dictationState === "processing"}
              >
                {dictationState === "recording" ? <Square size={19} /> : <Mic size={21} />}
              </IconButton>
              <IconButton label={copied ? "Copied" : "Copy note"} onClick={() => void handleCopy()}>
                <Copy size={20} />
              </IconButton>
              <IconButton label="Delete note" tone="danger" onClick={() => void handleDelete()}>
                <Trash2 size={21} />
              </IconButton>
            </div>
          </header>

          {error && <Alert tone="warning">{error}</Alert>}
          {status && <div className="standalone-note-status">{status}</div>}

          {mode === "edit" ? (
            <textarea
              ref={textareaRef}
              className="standalone-note-textarea"
              value={note?.body ?? ""}
              onChange={(event) => handleBodyChange(event.target.value)}
              placeholder="Type a note, draft something, or use the mic to dictate here."
            />
          ) : (
            <div className="standalone-note-preview">
              {note?.body.trim() ? (
                <ReactMarkdown
                  components={{
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {note.body}
                </ReactMarkdown>
              ) : (
                <p>Nothing to preview yet.</p>
              )}
            </div>
          )}
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
