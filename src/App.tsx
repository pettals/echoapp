import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  AlertCircle,
  AudioWaveform,
  CheckCircle2,
  CircleDot,
  Copy,
  History,
  Mic,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import Settings from "./components/Settings";
import { Alert, Button, Card, Chip, IconButton, Progress } from "./components/ui";
import echoLogo from "./assets/echo-logo.png";
import "./App.css";

type AppState = "idle" | "recording" | "processing" | "success" | "copied" | "error";
type ActiveTab = "dictate" | "history" | "settings";
type DesktopPlatform = "macos" | "windows";
type IndicatorMode = "idle" | "recording" | "processing" | "success" | "copied" | "error";
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

interface HistoryItem {
  id: string;
  text: string;
  created_at: string;
  paste_result: string;
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
const BAR_OFFSETS = [0.7, 1, 0.85, 0.95, 0.6];
const HUD_BAR_OFFSETS = [0.54, 0.76, 0.62, 0.92, 0.7, 1, 0.82, 0.94, 0.66, 0.86, 0.58, 0.78];
const INDICATOR_COMPACT_SIZE = { width: 68, height: 16 };
const INDICATOR_RECORDING_SIZE = { width: 228, height: 52 };

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
  appearance_theme: "system",
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
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function App() {
  if (WINDOW_LABEL === "indicator") {
    return <DockIndicator />;
  }

  return <MainApp />;
}

function DockIndicator() {
  const [mode, setMode] = useState<IndicatorMode>("idle");
  const [level, setLevel] = useState(0);
  const [appearanceTheme, setAppearanceTheme] = useState<AppearanceTheme>("system");
  const prevRecording = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visualLevelRef = useRef(0);
  const platform = detectDesktopPlatform();
  const recording = mode === "recording";
  const resolvedTheme = useResolvedTheme(appearanceTheme);

  useEffect(() => {
    if (!HAS_TAURI) return;

    let cancelled = false;
    const targetSize = recording ? INDICATOR_RECORDING_SIZE : INDICATOR_COMPACT_SIZE;

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
    if (mode !== "idle") {
      dockPoll = setInterval(resizeIndicator, 500);
    }

    return () => {
      cancelled = true;
      if (dockPoll) {
        clearInterval(dockPoll);
      }
    };
  }, [mode, recording]);

  useEffect(() => {
    if (!HAS_TAURI) return;
    if (mode !== "idle") return;

    const refreshPosition = async () => {
      try {
        await invoke("reposition_indicator", {
          width: INDICATOR_COMPACT_SIZE.width,
          height: INDICATOR_COMPACT_SIZE.height,
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
  }, [mode]);

  useEffect(() => {
    if (!HAS_TAURI) {
      setAppearanceTheme(MOCK_CONFIG.appearance_theme);
      return;
    }
    invoke<AppConfig>("get_config")
      .then((cfg) => setAppearanceTheme(normalizeTheme(cfg.appearance_theme)))
      .catch(() => setAppearanceTheme("system"));
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

    listen<IndicatorMode>("indicator-mode", (event) => {
      setMode(event.payload);
    }).then((u) => {
      unlistenMode = u;
    });

    listen<AppearanceTheme>("appearance-theme-changed", (event) => {
      setAppearanceTheme(normalizeTheme(event.payload));
    }).then((u) => {
      unlistenTheme = u;
    });

    return () => {
      unlistenMode?.();
      unlistenTheme?.();
    };
  }, []);

  useEffect(() => {
    if (recording && !prevRecording.current) {
      invoke("play_indicator_sound", { kind: "open" }).catch(() => {});
    } else if (!recording && prevRecording.current) {
      invoke("play_indicator_sound", { kind: "close" }).catch(() => {});
    }
    prevRecording.current = recording;
  }, [recording]);

  useEffect(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }

    if (mode === "idle") {
      if (HAS_TAURI) {
        getCurrentWindow().hide().catch(() => {});
      }
      return;
    }

    if (mode === "success" || mode === "copied" || mode === "error") {
      hideTimer.current = setTimeout(() => {
        setMode("idle");
      }, 1600);
    }

    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [mode]);

  useEffect(() => {
    if (!recording) {
      setLevel(0);
      visualLevelRef.current = 0;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    pollRef.current = setInterval(async () => {
      try {
        const l = await invoke<number>("get_recording_level");
        const target = Math.min(Math.max(l, 0), 1);
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
  }, [recording]);

  const handleStartRecording = useCallback(async () => {
    if (recording) return;
    try {
      if (platform === "macos") {
        const monitor = await currentMonitor().catch(() => null);
        if (monitor) {
          await invoke("reposition_indicator", {
            width: INDICATOR_COMPACT_SIZE.width,
            height: INDICATOR_COMPACT_SIZE.height,
          });
        }
      }
      await emit("indicator-start-recording");
    } catch {
      /* ignore */
    }
  }, [recording]);

  const handleStopClick = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (!recording) return;
      try {
        setMode("processing");
        await emit("tray-stop-recording");
      } catch {
        /* ignore */
      }
    },
    [recording]
  );

  return (
    <div
      className={`window-root window-root--indicator recording-hud-shell recording-hud-shell--${mode} recording-hud-shell--platform-${platform}`}
      data-theme={resolvedTheme}
    >
      {recording ? (
        <div className="recording-hud recording-hud--recording">
          <div className="recording-hud-waveform" aria-hidden>
            {HUD_BAR_OFFSETS.map((offset, i) => {
              const barLevel = Math.min(level * offset, 1);
              const height = 5 + barLevel * 27;
              return (
                <span
                  key={i}
                  className="recording-hud-bar"
                  style={{ height: `${height}px` }}
                />
              );
            })}
          </div>
          <button className="dock-stop-btn" aria-label="Stop recording" onClick={handleStopClick}>
            <Square size={13} fill="currentColor" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="recording-hud recording-hud--compact"
          aria-label={mode === "idle" ? "Start dictation" : "Dictation status"}
          onClick={mode === "idle" ? handleStartRecording : undefined}
          disabled={mode !== "idle"}
        />
      )}
    </div>
  );
}

function MainApp() {
  const platform = detectDesktopPlatform();
  const [appState, setAppState] = useState<AppState>("idle");
  const [activeTab, setActiveTab] = useState<ActiveTab>("dictate");
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [shortcutError, setShortcutError] = useState("");
  const [appearancePreview, setAppearancePreview] = useState<AppearanceTheme | null>(null);
  const registeredShortcut = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const shortcutHeldRef = useRef(false);
  const startInFlightRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const shortcutPressedRef = useRef<() => void>(() => {});
  const shortcutReleasedRef = useRef<() => void>(() => {});
  const resolvedTheme = useResolvedTheme(appearancePreview ?? config?.appearance_theme ?? "system");

  const setIndicatorMode = useCallback((mode: IndicatorMode) => {
    if (!HAS_TAURI) return;
    emit("indicator-mode", mode).catch(() => {});
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

  const startRecording = useCallback(
    async (captureFocus = true): Promise<boolean> => {
      if (startInFlightRef.current) return false;
      startInFlightRef.current = true;

      try {
        if (!HAS_TAURI) {
          setAppState("recording");
          setTranscript("");
          setErrorMsg("");
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

        if (captureFocus) {
          await invoke("capture_focus");
        }
        await invoke("start_recording");
        invoke("pause_media").catch(() => {});
        setIndicatorMode("recording");

        setAppState("recording");
        setTranscript("");
        setErrorMsg("");
        return true;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setErrorMsg(msg);
        setAppState("error");
        setTimeout(() => setAppState("idle"), 5000);
        return false;
      } finally {
        startInFlightRef.current = false;
      }
    },
    [setIndicatorMode]
  );

  const stopAndPaste = useCallback(async (): Promise<boolean> => {
    if (stopInFlightRef.current) return false;
    stopInFlightRef.current = true;

    try {
      const recording = await invoke<boolean>("is_recording");
      if (!recording) {
        stopRequestedRef.current = false;
        return false;
      }

      stopRequestedRef.current = false;
      setAppState("processing");
      setIndicatorMode("processing");
      const audioPath = await invoke<string>("stop_recording");

      const rawText = await invoke<string>("transcribe_audio", { audioPath });

      let finalText = rawText;
      const cfg = await invoke<AppConfig>("get_config");
      if (cfg.cleanup_enabled && cfg.model_provider === "api") {
        finalText = await invoke<string>("cleanup_text", { text: rawText });
      }

      setTranscript(finalText);
      const result = await invoke<string>("paste_transcript", { text: finalText });

      if (result === "pasted") {
        setAppState("success");
        setIndicatorMode("success");
      } else {
        if (result === "copied_accessibility") {
          setErrorMsg("Copied because Echo is not enabled in Accessibility.");
        }
        setAppState("copied");
        setIndicatorMode("copied");
      }
      playChime();

      try {
        const item = await invoke<HistoryItem>("add_transcript_history", {
          text: finalText,
          pasteResult: result,
        });
        setHistory((prev) => [item, ...prev]);
      } catch (e) {
        console.error("Failed to save history:", e);
      }

      setTimeout(() => setAppState("idle"), 3000);
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === NO_SPEECH_DETECTED) {
        setTranscript("");
        setErrorMsg("");
        setAppState("idle");
        setIndicatorMode("idle");
        return true;
      }

      setErrorMsg(msg);
      setAppState("error");
      setIndicatorMode("error");
      setTimeout(() => setAppState("idle"), 5000);
      return false;
    } finally {
      invoke("resume_media").catch(() => {});
      stopInFlightRef.current = false;
    }
  }, [playChime, setIndicatorMode]);

  const handleStartRecording = useCallback(async () => {
    stopRequestedRef.current = false;
    await startRecording();
  }, [startRecording]);

  const handleStopAndPaste = useCallback(async () => {
    stopRequestedRef.current = true;
    await stopAndPaste();
    sessionActiveRef.current = false;
  }, [stopAndPaste]);

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
      const msg = e instanceof Error ? e.message : String(e);
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
    return () => {
      if (registeredShortcut.current) {
        unregister(registeredShortcut.current).catch(console.error);
      }
    };
  }, [loadConfig, loadHistory, loadSetupStatus, registerShortcut]);

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

    listen("indicator-start-recording", () => {
      stopRequestedRef.current = false;
      void startRecording(false);
    }).then((u) => unlisten.push(u));

    return () => {
      unlisten.forEach((u) => u());
    };
  }, [handleStartRecording, handleStopAndPaste, loadConfig, startRecording]);

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
    if (!HAS_TAURI) {
      setConfig(newConfig);
      setAppearancePreview(null);
      setActiveTab("dictate");
      return;
    }

    await invoke("save_config", { config: newConfig });
    setConfig(newConfig);
    setAppearancePreview(null);
    emit("appearance-theme-changed", newConfig.appearance_theme).catch(() => {});
    setActiveTab("dictate");
    await registerShortcut(newConfig.shortcut);
    await loadSetupStatus();
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

  const startWindowDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !HAS_TAURI) return;
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
          <div className="content-main-col" key={activeTab}>
            {activeTab === "dictate" && (
              <DictatePanel
                appState={appState}
                config={config}
                errorMsg={errorMsg}
                setupStatus={setupStatus}
                shortcutError={shortcutError}
                transcript={transcript}
                onAction={handleSetupAction}
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

function DictatePanel({
  appState,
  config,
  errorMsg,
  setupStatus,
  shortcutError,
  transcript,
  onAction,
  onOpenSettings,
  onRefresh,
  onStartRecording,
}: {
  appState: AppState;
  config: AppConfig | null;
  errorMsg: string;
  setupStatus: SetupStatus | null;
  shortcutError: string;
  transcript: string;
  onAction: (check: SetupCheck) => void;
  onOpenSettings: () => void;
  onRefresh: () => Promise<SetupStatus | null>;
  onStartRecording: () => void;
}) {
  return (
    <div className="dictate-panel">
      <div className="page-heading page-heading--centered">
        <p>Echo</p>
        <h2>{stateTitle(appState)}</h2>
        <span>{stateHint(appState, config?.shortcut, errorMsg)}</span>
      </div>

      <Card className={`command-surface command-surface--${appState}`}>
        <StateGlyph state={appState} />

        {(appState === "idle" || appState === "recording") && (
          <div className="command-chips">
            <Chip icon={<Mic size={14} />}>{config?.shortcut ?? "Command + D"}</Chip>
            <Chip icon={<Sparkles size={14} />}>
              {config?.cleanup_enabled ? "Cleanup on" : "Raw transcript"}
            </Chip>
          </div>
        )}

        {appState === "idle" && (
          <Button
            size="lg"
            variant="primary"
            icon={<AudioWaveform size={18} />}
            onClick={onStartRecording}
          >
            Start Dictation
          </Button>
        )}

        {appState === "recording" && (
          <div className="recording-note">
            <CircleDot size={14} />
            Listening now
          </div>
        )}

        {(appState === "success" || appState === "copied") && transcript && (
          <div className="transcript-preview">
            <p>{transcript}</p>
          </div>
        )}

        {appState === "processing" && <Progress />}
        {appState === "error" && errorMsg && <Alert tone="error">{errorMsg}</Alert>}
      </Card>

      {setupStatus && !setupStatus.ready && (
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
  if (state === "recording") {
    return (
      <div className="native-state-glyph native-state-glyph--recording">
        {BAR_OFFSETS.map((offset, index) => (
          <span key={index} style={{ height: `${10 + offset * 24}px` }} />
        ))}
      </div>
    );
  }

  if (state === "processing") {
    return (
      <div className="native-state-glyph native-state-glyph--processing">
        <span />
      </div>
    );
  }

  if (state === "success" || state === "copied") {
    return (
      <div className="state-icon state-icon--success">
        <CheckCircle2 />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="state-icon state-icon--error">
        <AlertCircle />
      </div>
    );
  }

  return (
    <div className="native-state-glyph native-state-glyph--idle">
      <AudioWaveform />
    </div>
  );
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
    idle: `Press ${shortcut} or click the button`,
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

  return (
    <Card className="setup-panel" aria-label="Setup status">
      <div className="setup-panel__header">
        <div>
          <Chip tone={status.ready ? "success" : "warning"}>
            {status.ready ? "Ready" : "Needs setup"}
          </Chip>
          <h3>Finish setup before dictating</h3>
        </div>
        <IconButton label="Refresh setup checks" onClick={() => void onRefresh()}>
          <RefreshCw size={16} />
        </IconButton>
      </div>

      <div className="setup-list">
        {blockers.map((check) => (
          <div key={check.id} className={`setup-check setup-check--${check.status}`}>
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
          </div>
        ))}
      </div>

      <Button fullWidth variant="primary" onClick={onOpenSettings}>
        Review settings
      </Button>
    </Card>
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
        <Card className="history-empty">
          <History size={22} />
          <h3>No transcriptions yet</h3>
          <p>Your dictation history will appear here.</p>
        </Card>
      ) : (
        <div className="history-list">
          {history.map((item) => (
            <article className="history-row" key={item.id}>
              <div className="history-row__meta">
                <span>{formatDate(item.created_at)}</span>
                <Chip tone={item.paste_result === "pasted" ? "success" : "neutral"}>
                  {item.paste_result === "pasted" ? "Pasted" : "Copied"}
                </Chip>
              </div>
              <p>{item.text}</p>
              <div className="history-row__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Copy size={14} />}
                  onClick={() => onCopy(item.text, item.id)}
                >
                  {copiedId === item.id ? "Copied" : "Copy"}
                </Button>
                <IconButton
                  label={`Delete transcript from ${formatDate(item.created_at)}`}
                  tone="danger"
                  onClick={() => onDelete(item.id)}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
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
