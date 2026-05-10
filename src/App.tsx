import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Settings from "./components/Settings";
import echoLogo from "./assets/echo-logo.png";
import "./App.css";

type AppState = "idle" | "recording" | "processing" | "success" | "copied" | "error";
type ActiveTab = "dictate" | "history" | "settings";

interface AppConfig {
  groq_api_key: string;
  shortcut: string;
  transcription_model: string;
  cleanup_model: string;
  cleanup_enabled: boolean;
  input_device: string | null;
  model_provider: "api" | "local";
  local_model_size: "small" | "medium";
}

interface HistoryItem {
  id: string;
  text: string;
  created_at: string;
  paste_result: string;
}

const WINDOW_LABEL = getCurrentWindow().label;

function App() {
  if (WINDOW_LABEL === "indicator") {
    return <DockIndicator />;
  }
  return <MainApp />;
}

/* ------------------------------------------------------------------ */
/*  Dock Indicator (tiny always-visible window above the dock)        */
/* ------------------------------------------------------------------ */

const BAR_OFFSETS = [0.7, 1.0, 0.85, 0.95, 0.6];

function DockIndicator() {
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const prevRecording = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let mounted = true;

    const poll = setInterval(async () => {
      if (!mounted) return;
      try {
        const isRec = await invoke<boolean>("is_recording");
        setRecording(isRec);
      } catch { /* ignore */ }
    }, 150);

    return () => {
      mounted = false;
      clearInterval(poll);
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
    if (!recording) {
      setLevel(0);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    pollRef.current = setInterval(async () => {
      try {
        const l = await invoke<number>("get_recording_level");
        setLevel(l);
      } catch { /* ignore */ }
    }, 60);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [recording]);

  const hue = recording ? level * 60 : 0;
  const glowOpacity = recording ? 0.35 + level * 0.55 : 0.2;
  const glowSize = recording ? 6 + level * 18 : 4;

  return (
    <div className="dock-indicator" data-tauri-drag-region>
      <div
        className={`dock-shell ${recording ? "dock-shell--open" : ""}`}
        style={{
          filter: recording ? `hue-rotate(${hue}deg)` : "none",
          boxShadow: `0 0 ${glowSize}px rgba(229,255,92,${glowOpacity}), 0 0 ${glowSize * 2.5}px rgba(229,255,92,${glowOpacity * 0.35})`,
        }}
      >
        <div className="dock-dot" />
        <div className="dock-waveform">
          {BAR_OFFSETS.map((offset, i) => {
            const barLevel = Math.min(level * offset, 1);
            const height = recording ? 4 + barLevel * 22 : 0;
            return (
              <span
                key={i}
                className="dock-wave-bar"
                style={{ height: `${height}px` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Echo App (sidebar + content)                                 */
/* ------------------------------------------------------------------ */

function MainApp() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [activeTab, setActiveTab] = useState<ActiveTab>("dictate");
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const registeredShortcut = useRef<string | null>(null);
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
  }, [getAudioCtx]);

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
      if (cfg.model_provider === "api" && !cfg.groq_api_key) {
        setActiveTab("settings");
        return;
      }

      await invoke("capture_focus");
      await invoke("start_recording");

      setAppState("recording");
      setTranscript("");
      setErrorMsg("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setAppState("error");
      setTimeout(() => setAppState("idle"), 5000);
    }
  }, []);

  const handleStopAndPaste = useCallback(async () => {
    try {
      const recording = await invoke<boolean>("is_recording");
      if (!recording) return;

      setAppState("processing");
      const audioPath = await invoke<string>("stop_recording");

      const rawText = await invoke<string>("transcribe_audio", {
        audioPath,
      });

      let finalText = rawText;
      const cfg = await invoke<AppConfig>("get_config");
      if (cfg.cleanup_enabled && cfg.model_provider === "api") {
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
      setTimeout(() => setAppState("idle"), 5000);
    }
  }, [playChime]);

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
        if (cfg.model_provider === "api" && !cfg.groq_api_key) {
          setActiveTab("settings");
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

  useEffect(() => {
    const unlisten: (() => void)[] = [];

    listen("tray-start-recording", () => {
      handleStartRecording();
    }).then((u) => unlisten.push(u));

    listen("tray-stop-recording", () => {
      handleStopAndPaste();
    }).then((u) => unlisten.push(u));

    listen("tray-open-settings", () => {
      loadConfig();
      setActiveTab("settings");
    }).then((u) => unlisten.push(u));

    return () => {
      unlisten.forEach((u) => u());
    };
  }, [handleStartRecording, handleStopAndPaste, loadConfig]);

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
    setActiveTab("dictate");
    await registerShortcut(newConfig.shortcut);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="app-logo-wrap">
            <img
              src={echoLogo}
              alt="Echo"
              className="app-logo"
              draggable={false}
            />
          </div>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${activeTab === "dictate" ? "active" : ""}`}
            onClick={() => setActiveTab("dictate")}
          >
            <WaveIcon />
            <span>Dictate</span>
          </button>
          <button
            className={`nav-item ${activeTab === "history" ? "active" : ""}`}
            onClick={() => setActiveTab("history")}
          >
            <ClockIcon />
            <span>History</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <button
            className={`nav-item ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => {
              loadConfig();
              setActiveTab("settings");
            }}
          >
            <SettingsIcon />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <div className="main-content">
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

              {appState === "recording" && (
                <>
                  <div className="state-icon idle-icon">
                    <GlowingOrb state="recording" />
                  </div>
                  <p className="state-label">Recording...</p>
                  <p className="state-hint">Release the shortcut to stop</p>
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
              disabled={appState === "processing" || appState === "recording"}
            >
              <WaveIcon />
              <span>
                {appState === "idle" && "Hold Shortcut to Dictate"}
                {appState === "recording" && "Recording..."}
                {appState === "processing" && "Processing..."}
                {appState === "success" && "Hold Shortcut to Dictate"}
                {appState === "copied" && "Hold Shortcut to Dictate"}
                {appState === "error" && "Try Again"}
              </span>
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

        {activeTab === "settings" && config && (
          <Settings
            config={config}
            onSave={handleSaveSettings}
            onCancel={() => setActiveTab("dictate")}
          />
        )}
      </div>
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

function WaveIcon() {
  return (
    <svg className="wave-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 10v4" />
      <path d="M8 7v10" />
      <path d="M12 4v16" />
      <path d="M16 7v10" />
      <path d="M20 10v4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="clock-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
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
