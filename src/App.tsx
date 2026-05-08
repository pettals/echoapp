import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import Settings from "./components/Settings";
import "./App.css";

type AppState = "idle" | "recording" | "processing" | "success" | "copied" | "error";
type ActiveTab = "dictate" | "history";

interface AppConfig {
  groq_api_key: string;
  shortcut: string;
  transcription_model: string;
  cleanup_model: string;
  cleanup_enabled: boolean;
  input_device: string | null;
}

interface ScreenSize {
  width: number;
  height: number;
}

interface HistoryItem {
  id: string;
  text: string;
  created_at: string;
  paste_result: string;
}

const PILL_WIDTH = 200;
const PILL_HEIGHT = 56;
const NORMAL_WIDTH = 380;
const NORMAL_HEIGHT = 520;

function App() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [activeTab, setActiveTab] = useState<ActiveTab>("dictate");
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const registeredShortcut = useRef<string | null>(null);
  const normalPosition = useRef<{ x: number; y: number } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const getAudioCtx = useCallback((): AudioContext | null => {
    try {
      if (!audioCtxRef.current) {
        const Ctor =
          (window as unknown as { AudioContext?: typeof AudioContext })
            .AudioContext ??
          (
            window as unknown as {
              webkitAudioContext?: typeof AudioContext;
            }
          ).webkitAudioContext;
        if (!Ctor) return null;
        audioCtxRef.current = new Ctor();
      }
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const playChime = useCallback(async () => {
    // Prefer the native OS chime (more reliable than WKWebView autoplay
    // policies). Fall back to Web Audio if the native call fails.
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

    // Pleasant two-note "ding" (C6 -> E6)
    playTone(1046.5, now, 0.18);
    playTone(1318.51, now + 0.09, 0.28);
  }, [getAudioCtx]);

  const switchToPillMode = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      const pos = await win.outerPosition();
      normalPosition.current = { x: pos.x, y: pos.y };
    } catch {
      normalPosition.current = { x: 100, y: 100 };
    }

    try {
      const screen = await invoke<ScreenSize>("get_screen_size");
      const scaleFactor = await win.scaleFactor();
      const logicalWidth = screen.width / scaleFactor;
      const x = logicalWidth - PILL_WIDTH - 16;
      const y = 16;
      await win.setSize(new LogicalSize(PILL_WIDTH, PILL_HEIGHT));
      await win.setPosition(new LogicalPosition(x, y));
    } catch (e) {
      console.error("Failed to switch to pill mode:", e);
    }
  }, []);

  const switchToNormalMode = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      await win.setSize(new LogicalSize(NORMAL_WIDTH, NORMAL_HEIGHT));
      if (normalPosition.current) {
        await win.setPosition(
          new LogicalPosition(normalPosition.current.x, normalPosition.current.y)
        );
      }
    } catch (e) {
      console.error("Failed to switch to normal mode:", e);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await invoke<AppConfig>("get_config");
      setConfig(cfg);
      return cfg;
    } catch (e) {
      console.error("Failed to load config:", e);
      return null;
    }
  }, []);

  const handleStartRecording = useCallback(async () => {
    try {
      const recording = await invoke<boolean>("is_recording");
      if (recording) return;

      const cfg = await invoke<AppConfig>("get_config");
      if (!cfg.groq_api_key) {
        setShowSettings(true);
        return;
      }

      // Capture the previously-focused app FIRST, before any UI / window
      // manipulation. Resizing or repositioning the always-on-top window can
      // briefly raise Echo on macOS, which would cause us to capture
      // ourselves and skip the auto-paste.
      await invoke("capture_focus");
      await invoke("start_recording");

      setAppState("recording");
      setTranscript("");
      setErrorMsg("");
      await switchToPillMode();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setAppState("error");
      await switchToNormalMode();
      setTimeout(() => setAppState("idle"), 5000);
    }
  }, [switchToPillMode, switchToNormalMode]);

  const handleStopAndPaste = useCallback(async () => {
    try {
      const recording = await invoke<boolean>("is_recording");
      if (!recording) return;

      setAppState("processing");
      const audioPath = await invoke<string>("stop_recording");

      await switchToNormalMode();

      const rawText = await invoke<string>("transcribe_audio", {
        audioPath,
      });

      let finalText = rawText;
      const cfg = await invoke<AppConfig>("get_config");
      if (cfg.cleanup_enabled) {
        finalText = await invoke<string>("cleanup_text", { text: rawText });
      }

      setTranscript(finalText);
      const result = await invoke<string>("paste_transcript", {
        text: finalText,
      });

      if (result === "pasted") {
        setAppState("success");
      } else {
        setAppState("copied");
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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setAppState("error");
      await switchToNormalMode();
      setTimeout(() => setAppState("idle"), 5000);
    }
  }, [switchToNormalMode, playChime]);

  const registerShortcut = useCallback(
    async (shortcut: string) => {
      try {
        if (registeredShortcut.current) {
          await unregister(registeredShortcut.current);
          registeredShortcut.current = null;
        }
        await register(shortcut, (event) => {
          if (event.state === "Pressed") {
            handleStartRecording();
          } else if (event.state === "Released") {
            handleStopAndPaste();
          }
        });
        registeredShortcut.current = shortcut;
      } catch (e) {
        console.error("Failed to register shortcut:", e);
      }
    },
    [handleStartRecording, handleStopAndPaste]
  );

  const loadHistory = useCallback(async () => {
    try {
      const items = await invoke<HistoryItem[]>("list_transcript_history");
      setHistory(items);
    } catch (e) {
      console.error("Failed to load history:", e);
    }
  }, []);

  useEffect(() => {
    loadConfig().then((cfg) => {
      if (cfg) {
        if (!cfg.groq_api_key) {
          setShowSettings(true);
        }
        registerShortcut(cfg.shortcut);
      }
    });
    loadHistory();
    return () => {
      if (registeredShortcut.current) {
        unregister(registeredShortcut.current).catch(console.error);
      }
    };
  }, [loadConfig, registerShortcut, loadHistory]);

  const handleCopyHistoryItem = async (text: string, id: string) => {
    try {
      await invoke("copy_transcript", { text });
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  const handleDeleteHistoryItem = async (id: string) => {
    try {
      await invoke("delete_transcript_history", { id });
      setHistory((prev) => prev.filter((item) => item.id !== id));
    } catch (e) {
      console.error("Failed to delete:", e);
    }
  };

  const handleClearHistory = async () => {
    try {
      await invoke("clear_transcript_history");
      setHistory([]);
    } catch (e) {
      console.error("Failed to clear history:", e);
    }
  };

  const handleSaveSettings = async (newConfig: AppConfig) => {
    await invoke("save_config", { config: newConfig });
    setConfig(newConfig);
    setShowSettings(false);
    await registerShortcut(newConfig.shortcut);
  };

  if (showSettings && config) {
    return (
      <Settings
        config={config}
        onSave={handleSaveSettings}
        onCancel={() => setShowSettings(false)}
      />
    );
  }

  // Recording pill mode
  if (appState === "recording") {
    return (
      <main className="pill" data-tauri-drag-region>
        <GlowingOrb state="recording" />
        <span className="pill-label">Recording...</span>
        <button className="pill-stop" onClick={handleStopAndPaste}>
          <StopIcon />
        </button>
      </main>
    );
  }

  // Normal window mode
  return (
    <main className="overlay" data-tauri-drag-region>
      <div className="overlay-header">
        <h1 className="app-title">Echo</h1>
        <button
          className="settings-btn"
          onClick={() => {
            loadConfig();
            setShowSettings(true);
          }}
          title="Settings"
        >
          <SettingsIcon />
        </button>
      </div>

      <div className="overlay-tabs">
        <button
          className={`overlay-tab ${activeTab === "dictate" ? "active" : ""}`}
          onClick={() => setActiveTab("dictate")}
        >
          Dictate
        </button>
        <button
          className={`overlay-tab ${activeTab === "history" ? "active" : ""}`}
          onClick={() => setActiveTab("history")}
        >
          History
        </button>
      </div>

      {activeTab === "dictate" && (
        <>
          <div className={`state-display ${appState}`}>
            {appState === "idle" && (
              <>
                <div className="state-icon idle-icon">
                  <GlowingOrb state="idle" />
                </div>
                <p className="state-label">Ready to dictate</p>
                <p className="state-hint">
                  Press{" "}
                  <kbd>{config?.shortcut ?? "CommandOrControl+Shift+Space"}</kbd>{" "}
                  or click the button
                </p>
              </>
            )}

            {appState === "processing" && (
              <>
                <div className="state-icon processing-icon">
                  <GlowingOrb state="processing" />
                </div>
                <p className="state-label">Processing...</p>
                <p className="state-hint">Transcribing and polishing your text</p>
              </>
            )}

            {appState === "success" && (
              <>
                <div className="state-icon success-icon">
                  <CheckIcon />
                </div>
                <p className="state-label">Pasted!</p>
                <p className="transcript-preview">{transcript}</p>
              </>
            )}

            {appState === "copied" && (
              <>
                <div className="state-icon success-icon">
                  <CheckIcon />
                </div>
                <p className="state-label">Copied to clipboard</p>
                <p className="state-hint">
                  Focus your target app and press Cmd/Ctrl+V to paste
                </p>
                <p className="transcript-preview">{transcript}</p>
              </>
            )}

            {appState === "error" && (
              <>
                <div className="state-icon error-icon">
                  <ErrorIcon />
                </div>
                <p className="state-label">Error</p>
                <p className="error-message">{errorMsg}</p>
              </>
            )}
          </div>

          <button
            className={`record-btn ${appState}`}
            onClick={handleStartRecording}
            disabled={appState === "processing"}
          >
            {appState === "idle" && "Hold Shortcut to Dictate"}
            {appState === "processing" && "Processing..."}
            {appState === "success" && "Hold Shortcut to Dictate"}
            {appState === "copied" && "Hold Shortcut to Dictate"}
            {appState === "error" && "Try Again"}
          </button>
        </>
      )}

      {activeTab === "history" && (
        <div className="history-panel">
          {history.length === 0 ? (
            <div className="history-empty">
              <HistoryIcon />
              <p className="state-label">No transcriptions yet</p>
              <p className="state-hint">
                Your dictation history will appear here
              </p>
            </div>
          ) : (
            <>
              <div className="history-list">
                {history.map((item) => (
                  <div key={item.id} className="history-card">
                    <div className="history-meta">
                      <span className="history-date">
                        {formatDate(item.created_at)}
                      </span>
                      <span
                        className={`history-badge ${item.paste_result === "pasted" ? "badge-pasted" : "badge-copied"}`}
                      >
                        {item.paste_result === "pasted" ? "Pasted" : "Copied"}
                      </span>
                    </div>
                    <p className="history-text">{item.text}</p>
                    <div className="history-actions">
                      <button
                        className="history-copy"
                        onClick={() => handleCopyHistoryItem(item.text, item.id)}
                      >
                        {copiedId === item.id ? "Copied!" : "Copy"}
                      </button>
                      <button
                        className="history-delete"
                        onClick={() => handleDeleteHistoryItem(item.id)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button className="history-clear" onClick={handleClearHistory}>
                Clear All History
              </button>
            </>
          )}
        </div>
      )}
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

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function GlowingOrb({ state = "idle" }: { state?: "idle" | "recording" | "processing" }) {
  const sizeClass = state === "recording" ? "orb--small" : "";
  const stateClass = state === "recording" ? "recording" : state === "processing" ? "processing" : "";
  return (
    <div className="orb-wrapper">
      <div className={`orb ${sizeClass} ${stateClass}`}>
        <span className="orb-ring" />
        <span className="orb-ring" />
        <span className="orb-ring" />
        <span className="orb-ring" />
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export default App;
