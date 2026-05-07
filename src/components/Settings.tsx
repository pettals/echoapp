import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Settings.css";

interface AppConfig {
  groq_api_key: string;
  shortcut: string;
  transcription_model: string;
  cleanup_model: string;
  cleanup_enabled: boolean;
  input_device: string | null;
}

interface SettingsProps {
  config: AppConfig;
  onSave: (config: AppConfig) => Promise<void>;
  onCancel: () => void;
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

  return (
    <main className="settings-page">
      <h2>Settings</h2>
      <form onSubmit={handleSubmit}>
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
            required
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

        <fieldset className="form-section">
          <legend>AI Models</legend>

          <div className="form-group">
            <label htmlFor="transcription-model">Transcription Model</label>
            <select
              id="transcription-model"
              value={form.transcription_model}
              onChange={(e) =>
                setForm({ ...form, transcription_model: e.target.value })
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
                  setForm({ ...form, cleanup_enabled: e.target.checked })
                }
              />
              Enable AI cleanup (fixes punctuation, removes filler words)
            </label>
          </div>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          {config.groq_api_key && (
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
    </main>
  );
}
