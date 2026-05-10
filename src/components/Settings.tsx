import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Settings.css";

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

interface ModelStatus {
  downloaded: boolean;
  downloading: boolean;
  file_size_bytes: number;
  model_size: string;
}

interface DownloadProgress {
  bytes_downloaded: number;
  total_bytes: number;
  percentage: number;
  model_size: string;
}

interface SettingsProps {
  config: AppConfig;
  onSave: (config: AppConfig) => Promise<void>;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function ModelDownloadSection({ modelSize }: { modelSize: "small" | "medium" }) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState("");

  const checkStatus = useCallback(async () => {
    try {
      const s = await invoke<ModelStatus>("check_model_status", { modelSize });
      setStatus(s);
      return s;
    } catch (e) {
      console.error("Status check error:", e);
      return null;
    }
  }, [modelSize]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    if (!status?.downloading) {
      setProgress(null);
      return;
    }

    const interval = setInterval(async () => {
      try {
        const p = await invoke<DownloadProgress>("get_model_download_progress");
        setProgress(p);
        if (p.percentage >= 100) {
          clearInterval(interval);
          await checkStatus();
        }
      } catch {
        /* ignore */
      }
    }, 400);

    return () => clearInterval(interval);
  }, [status?.downloading, checkStatus]);

  const handleDownload = async () => {
    setError("");
    setStatus((prev) => prev ? { ...prev, downloading: true } : prev);
    try {
      await invoke("download_whisper_model", { modelSize });
      await checkStatus();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      await checkStatus();
    }
  };

  const handleDelete = async () => {
    try {
      await invoke("delete_whisper_model", { modelSize });
      await checkStatus();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  };

  const sizeHint = modelSize === "small" ? "~465 MB" : "~1.5 GB";

  if (!status) return null;

  return (
    <div className="model-download-section">
      <div className="model-download-header">
        <span className="model-download-name">
          Whisper {modelSize.charAt(0).toUpperCase() + modelSize.slice(1)}
        </span>
        <span className="model-download-size">{sizeHint}</span>
      </div>

      {status.downloaded && !status.downloading && (
        <div className="model-download-status downloaded">
          <span className="model-status-dot" />
          <span>Downloaded ({formatBytes(status.file_size_bytes)})</span>
          <button
            type="button"
            className="model-delete-btn"
            onClick={handleDelete}
          >
            Remove
          </button>
        </div>
      )}

      {!status.downloaded && !status.downloading && (
        <button
          type="button"
          className="btn-secondary model-download-btn"
          onClick={handleDownload}
        >
          Download Model
        </button>
      )}

      {status.downloading && progress && (
        <div className="model-download-progress">
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
          <span className="progress-text">
            {formatBytes(progress.bytes_downloaded)} / {formatBytes(progress.total_bytes)}
            {" "}({progress.percentage.toFixed(0)}%)
          </span>
        </div>
      )}

      {status.downloading && !progress && (
        <div className="model-download-progress">
          <div className="progress-bar-track">
            <div className="progress-bar-fill indeterminate" />
          </div>
          <span className="progress-text">Starting download...</span>
        </div>
      )}

      {error && <div className="model-download-error">{error}</div>}
    </div>
  );
}

export default function Settings({ config, onSave, onCancel }: SettingsProps) {
  const [form, setForm] = useState<AppConfig>({ ...config });
  const [saving, setSaving] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [micTestState, setMicTestState] = useState<
    "idle" | "testing" | "success" | "fail"
  >("idle");
  const [micLevel, setMicLevel] = useState(0);

  useEffect(() => {
    invoke<string[]>("list_audio_devices")
      .then(setDevices)
      .catch(console.error);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  };

  const handleTestMic = async () => {
    setMicTestState("testing");
    setMicLevel(0);
    try {
      const peak = await invoke<number>("test_microphone", {
        deviceName: form.input_device,
      });
      setMicLevel(peak);
      setMicTestState(peak > 0.01 ? "success" : "fail");
    } catch (e) {
      console.error("Mic test error:", e);
      setMicTestState("fail");
    }
    setTimeout(() => setMicTestState("idle"), 4000);
  };

  const canCancel =
    config.model_provider === "local" || !!config.groq_api_key;

  return (
    <div className="settings-pane">
      <h2>Settings</h2>
      <form onSubmit={handleSubmit}>
        <fieldset className="form-section">
          <legend>Transcription Provider</legend>

          <div className="provider-toggle">
            <button
              type="button"
              className={`provider-option ${form.model_provider === "api" ? "active" : ""}`}
              onClick={() => setForm({ ...form, model_provider: "api" })}
            >
              <span className="provider-icon">
                <CloudIcon />
              </span>
              <span className="provider-label">Groq API</span>
              <span className="provider-desc">Online, fast</span>
            </button>
            <button
              type="button"
              className={`provider-option ${form.model_provider === "local" ? "active" : ""}`}
              onClick={() => setForm({ ...form, model_provider: "local" })}
            >
              <span className="provider-icon">
                <CpuIcon />
              </span>
              <span className="provider-label">Local</span>
              <span className="provider-desc">Offline, private</span>
            </button>
          </div>
        </fieldset>

        {form.model_provider === "api" && (
          <>
            <div className="form-group">
              <label htmlFor="api-key">Groq API Key</label>
              <input
                id="api-key"
                type="password"
                value={form.groq_api_key}
                onChange={(e) =>
                  setForm({ ...form, groq_api_key: e.target.value })
                }
                placeholder="gsk_..."
                required={form.model_provider === "api"}
              />
              <small>
                Get your key at{" "}
                <a
                  href="https://console.groq.com/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  console.groq.com/keys
                </a>
              </small>
            </div>

            <fieldset className="form-section">
              <legend>AI Models</legend>

              <div className="form-group">
                <label htmlFor="transcription-model">
                  Transcription Model
                </label>
                <select
                  id="transcription-model"
                  value={form.transcription_model}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      transcription_model: e.target.value,
                    })
                  }
                >
                  <option value="whisper-large-v3-turbo">
                    Whisper Large v3 Turbo (fast)
                  </option>
                  <option value="whisper-large-v3">
                    Whisper Large v3 (accurate)
                  </option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="cleanup-model">Cleanup Model</label>
                <select
                  id="cleanup-model"
                  value={form.cleanup_model}
                  onChange={(e) =>
                    setForm({ ...form, cleanup_model: e.target.value })
                  }
                >
                  <option value="llama-3.1-8b-instant">
                    Llama 3.1 8B (fast)
                  </option>
                  <option value="llama-3.3-70b-versatile">
                    Llama 3.3 70B (quality)
                  </option>
                </select>
              </div>

              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={form.cleanup_enabled}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        cleanup_enabled: e.target.checked,
                      })
                    }
                  />
                  Enable AI cleanup (fixes punctuation, removes filler words)
                </label>
              </div>
            </fieldset>
          </>
        )}

        {form.model_provider === "local" && (
          <fieldset className="form-section">
            <legend>Local Whisper Models</legend>

            <div className="form-group">
              <label htmlFor="local-model-size">Model Size</label>
              <select
                id="local-model-size"
                value={form.local_model_size}
                onChange={(e) =>
                  setForm({
                    ...form,
                    local_model_size: e.target.value as "small" | "medium",
                  })
                }
              >
                <option value="small">Small (faster, less accurate)</option>
                <option value="medium">Medium (slower, more accurate)</option>
              </select>
              <small>
                Models run entirely on your device. No internet needed after download.
              </small>
            </div>

            <ModelDownloadSection
              key="small"
              modelSize="small"
            />
            <ModelDownloadSection
              key="medium"
              modelSize="medium"
            />
          </fieldset>
        )}

        <div className="form-group">
          <label htmlFor="shortcut">Global Shortcut</label>
          <input
            id="shortcut"
            type="text"
            value={form.shortcut}
            onChange={(e) => setForm({ ...form, shortcut: e.target.value })}
            placeholder="CommandOrControl+Shift+Space"
          />
          <small>
            Accelerator format (e.g. CommandOrControl+Shift+Space)
          </small>
        </div>

        <fieldset className="form-section">
          <legend>Microphone</legend>

          <div className="form-group">
            <label htmlFor="input-device">Input Device</label>
            <select
              id="input-device"
              value={form.input_device ?? ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  input_device: e.target.value || null,
                })
              }
            >
              <option value="">System Default</option>
              {devices.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="mic-test">
            <button
              type="button"
              className="btn-secondary mic-test-btn"
              onClick={handleTestMic}
              disabled={micTestState === "testing"}
            >
              {micTestState === "testing"
                ? "Listening..."
                : "Test Microphone"}
            </button>

            {micTestState === "testing" && (
              <div className="mic-level-container">
                <div className="mic-level-bar testing" />
              </div>
            )}

            {micTestState === "success" && (
              <div className="mic-test-result success">
                <div className="mic-level-container">
                  <div
                    className="mic-level-bar"
                    style={{ width: `${Math.min(micLevel * 100, 100)}%` }}
                  />
                </div>
                <span>Microphone working</span>
              </div>
            )}

            {micTestState === "fail" && (
              <div className="mic-test-result fail">
                <span>No audio detected</span>
              </div>
            )}
          </div>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          {canCancel && (
            <button
              type="button"
              className="btn-secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function CloudIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  );
}

function CpuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}
