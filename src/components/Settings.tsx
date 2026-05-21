import { useCallback, useEffect, useState } from "react";
import {
  Cloud,
  Command,
  Cpu,
  History,
  Mic,
  Moon,
  Monitor,
  RefreshCw,
  Save,
  Shield,
  Sparkles,
  Sun,
  Volume2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, AppearanceTheme } from "../App";
import {
  Alert,
  Button,
  Card,
  Chip,
  Field,
  IconButton,
  Progress,
  SegmentedControl,
  SelectField,
  Toggle,
} from "./ui";
import "./Settings.css";

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

interface SettingsProps {
  config: AppConfig;
  onSave: (config: AppConfig) => Promise<void>;
  onCancel: () => void;
  onPreviewAppearance?: (theme: AppearanceTheme) => void;
  shortcutError?: string;
  setupStatus?: SetupStatus | null;
  onRefreshSetup?: () => Promise<SetupStatus | null>;
}

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

const TRANSCRIPTION_MODELS = [
  { label: "Whisper Large v3 Turbo (fast)", value: "whisper-large-v3-turbo" },
  { label: "Whisper Large v3 (accurate)", value: "whisper-large-v3" },
];

const CLEANUP_MODELS = [
  { label: "Llama 3.1 8B (fast)", value: "llama-3.1-8b-instant" },
  { label: "Llama 3.3 70B (quality)", value: "llama-3.3-70b-versatile" },
];

const LOCAL_MODEL_OPTIONS = [
  { label: "Small (faster, less accurate)", value: "small" },
  { label: "Medium (slower, more accurate)", value: "medium" },
];

const SOUND_OPTIONS = [
  { label: "Tink", value: "tink" },
  { label: "Pop", value: "pop" },
  { label: "Glass", value: "glass" },
  { label: "Hero", value: "hero" },
  { label: "Purr", value: "purr" },
  { label: "Morse", value: "morse" },
  { label: "None", value: "none" },
];

function normalizeShortcutKey(key: string): string {
  if (key === " ") return "Space";
  if (key.startsWith("Arrow")) return key.replace("Arrow", "");
  if (key === "Esc") return "Escape";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function acceleratorFromKeyboardEvent(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("CommandOrControl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  const key = normalizeShortcutKey(event.key);
  if (!parts.includes(key)) parts.push(key);

  return parts.length > 1 ? parts.join("+") : null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function SettingsSection({
  children,
  icon,
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <Card className="settings-section">
      <div className="settings-section__header">
        <span className="settings-section-icon">{icon}</span>
        <h3>{title}</h3>
      </div>
      <div className="settings-section__body">{children}</div>
    </Card>
  );
}

function ProviderCard({
  active,
  description,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`provider-card${active ? " provider-card--active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="provider-card-icon">{icon}</span>
      <strong>{label}</strong>
      <span>{description}</span>
    </button>
  );
}

function ModelDownloadSection({ modelSize }: { modelSize: "small" | "medium" }) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState("");

  const checkStatus = useCallback(async () => {
    if (!HAS_TAURI) {
      const mockStatus = {
        downloaded: modelSize === "small",
        downloading: false,
        file_size_bytes: modelSize === "small" ? 465 * 1024 * 1024 : 0,
        model_size: modelSize,
      };
      setStatus(mockStatus);
      return mockStatus;
    }

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
    if (!HAS_TAURI) {
      setStatus({
        downloaded: true,
        downloading: false,
        file_size_bytes: modelSize === "small" ? 465 * 1024 * 1024 : 1.5 * 1024 * 1024 * 1024,
        model_size: modelSize,
      });
      return;
    }

    setStatus((prev) => (prev ? { ...prev, downloading: true } : prev));
    try {
      await invoke("download_whisper_model", { modelSize });
      await checkStatus();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      await checkStatus();
    }
  };

  const handleDelete = async () => {
    if (!HAS_TAURI) {
      setStatus({
        downloaded: false,
        downloading: false,
        file_size_bytes: 0,
        model_size: modelSize,
      });
      return;
    }

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
    <Card className="model-download-card">
      <div className="model-download-card__header">
        <div>
          <strong>Whisper {modelSize.charAt(0).toUpperCase() + modelSize.slice(1)}</strong>
          <span>{sizeHint}</span>
        </div>
        <Chip tone={status.downloaded ? "success" : status.downloading ? "accent" : "neutral"}>
          {status.downloaded
            ? `Downloaded (${formatBytes(status.file_size_bytes)})`
            : status.downloading
              ? "Downloading"
              : "Not downloaded"}
        </Chip>
      </div>

      {status.downloading && (
        <div className="download-progress">
          <Progress value={progress?.percentage} />
          <span>
            {progress
              ? `${formatBytes(progress.bytes_downloaded)} / ${formatBytes(progress.total_bytes)} (${progress.percentage.toFixed(0)}%)`
              : "Starting download..."}
          </span>
        </div>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      <div className="settings-row">
        {!status.downloaded && !status.downloading && (
          <Button variant="primary" onClick={handleDownload}>
            Download Model
          </Button>
        )}
        {status.downloaded && !status.downloading && (
          <Button variant="secondary" onClick={handleDelete}>
            Remove
          </Button>
        )}
      </div>
    </Card>
  );
}

export default function Settings({
  config,
  onSave,
  onCancel,
  onPreviewAppearance,
  shortcutError = "",
  setupStatus,
  onRefreshSetup,
}: SettingsProps) {
  const [form, setForm] = useState<AppConfig>({ ...config });
  const [saving, setSaving] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [micTestState, setMicTestState] = useState<"idle" | "testing" | "success" | "fail">("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [shortcutCaptureHint, setShortcutCaptureHint] = useState(
    "Click the field, then press your shortcut."
  );

  useEffect(() => {
    setForm({ ...config });
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const loadDevices = () => {
      if (cancelled) return;
      if (!HAS_TAURI) {
        setDevices(["Studio Display Microphone", "MacBook Pro Microphone"]);
        return;
      }

      invoke<string[]>("list_audio_devices")
        .then((deviceNames) => {
          if (!cancelled) setDevices(deviceNames);
        })
        .catch(() => {
          if (!cancelled) setDevices(["Studio Display Microphone", "MacBook Pro Microphone"]);
        });
    };

    timer = window.setTimeout(loadDevices, HAS_TAURI ? 160 : 0);

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
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
    if (!HAS_TAURI) {
      setTimeout(() => {
        setMicLevel(0.72);
        setMicTestState("success");
      }, 700);
      setTimeout(() => setMicTestState("idle"), 4000);
      return;
    }

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

  const handleShortcutKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      event.currentTarget.blur();
      setShortcutCaptureHint("Shortcut unchanged.");
      return;
    }

    const accelerator = acceleratorFromKeyboardEvent(event);
    if (!accelerator) {
      setShortcutCaptureHint("Press one more key to complete the shortcut.");
      return;
    }

    setForm({ ...form, shortcut: accelerator });
    setShortcutCaptureHint(`Captured ${accelerator}. Save to apply it.`);
  };

  const canCancel = config.model_provider === "local" || !!config.groq_api_key;
  const ready = setupStatus?.ready;

  return (
    <form className="settings-pane" onSubmit={handleSubmit}>
      <div className="page-heading page-heading--split">
        <div>
          <p>Preferences</p>
          <h2>Settings</h2>
          <span>Provider, shortcut, permissions, history, sounds, and appearance.</span>
        </div>
        <Chip tone={ready ? "success" : "warning"}>{ready ? "Ready" : "Needs setup"}</Chip>
      </div>

      <Card className="settings-readiness-card" aria-label="Setup readiness">
        <div>
          <strong>Setup readiness</strong>
          <span>Groq keys stay in the OS credential store. Keep checks green before release QA.</span>
        </div>
        {onRefreshSetup && (
          <IconButton label="Refresh setup checks" onClick={() => void onRefreshSetup()}>
            <RefreshCw size={16} />
          </IconButton>
        )}
        {setupStatus?.checks && (
          <div className="readiness-chips">
            {setupStatus.checks.map((check) => (
              <Chip
                key={check.id}
                tone={check.status === "ok" ? "success" : check.status === "error" ? "error" : "warning"}
              >
                {check.label}
              </Chip>
            ))}
          </div>
        )}
      </Card>

      <SettingsSection icon={<Monitor size={18} />} title="Appearance">
        <SegmentedControl<AppearanceTheme>
          label="Appearance"
          value={form.appearance_theme}
          onChange={(appearance_theme) => {
            setForm({ ...form, appearance_theme });
            onPreviewAppearance?.(appearance_theme);
          }}
          options={[
            { icon: <Monitor size={15} />, label: "System", value: "system" },
            { icon: <Sun size={15} />, label: "Light", value: "light" },
            { icon: <Moon size={15} />, label: "Dark", value: "dark" },
          ]}
        />
      </SettingsSection>

      <SettingsSection icon={<Cloud size={18} />} title="Transcription Provider">
        <div className="settings-grid settings-grid--two">
          <ProviderCard
            active={form.model_provider === "api"}
            icon={<Sparkles size={18} />}
            label="Groq API"
            description="Online, fast"
            onClick={() => setForm({ ...form, model_provider: "api" })}
          />
          <ProviderCard
            active={form.model_provider === "local"}
            icon={<Cpu size={18} />}
            label="Local"
            description="Offline, private"
            onClick={() => setForm({ ...form, model_provider: "local" })}
          />
        </div>
      </SettingsSection>

      {form.model_provider === "api" && (
        <>
          <SettingsSection icon={<Shield size={18} />} title="Groq API">
            <Field
              id="api-key"
              label="Groq API Key"
              type="password"
              value={form.groq_api_key}
              onChange={(e) => setForm({ ...form, groq_api_key: e.target.value })}
              placeholder="gsk_..."
              required={form.model_provider === "api"}
              helperText={
                <>
                  Get your key at{" "}
                  <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">
                    console.groq.com/keys
                  </a>
                  . Saved securely in your OS credential store, not in config.json.
                </>
              }
            />
          </SettingsSection>

          <SettingsSection icon={<Sparkles size={18} />} title="AI Models">
            <div className="settings-grid settings-grid--two">
              <SelectField
                id="transcription-model"
                label="Transcription Model"
                value={form.transcription_model}
                onChange={(e) => setForm({ ...form, transcription_model: e.target.value })}
                options={TRANSCRIPTION_MODELS}
              />
              <SelectField
                id="cleanup-model"
                label="Cleanup Model"
                value={form.cleanup_model}
                onChange={(e) => setForm({ ...form, cleanup_model: e.target.value })}
                options={CLEANUP_MODELS}
              />
            </div>
            <Toggle
              checked={form.cleanup_enabled}
              onChange={(cleanup_enabled) => setForm({ ...form, cleanup_enabled })}
              label="Enable AI cleanup"
            />
          </SettingsSection>
        </>
      )}

      {form.model_provider === "local" && (
        <SettingsSection icon={<Cpu size={18} />} title="Local Whisper Models">
          <SelectField
            id="local-model-size"
            label="Model Size"
            value={form.local_model_size}
            onChange={(e) =>
              setForm({
                ...form,
                local_model_size: e.target.value as "small" | "medium",
              })
            }
            options={LOCAL_MODEL_OPTIONS}
            helperText="Models run entirely on your device. No internet needed after download."
          />
          <div className="settings-grid settings-grid--two">
            <ModelDownloadSection key="small" modelSize="small" />
            <ModelDownloadSection key="medium" modelSize="medium" />
          </div>
        </SettingsSection>
      )}

      <SettingsSection icon={<Command size={18} />} title="Global Shortcut">
        <Field
          id="shortcut"
          label="Shortcut"
          value={form.shortcut}
          readOnly
          onFocus={() => setShortcutCaptureHint("Press the keys you want to use.")}
          onKeyDown={handleShortcutKeyDown}
          placeholder="CommandOrControl+Shift+Space"
          helperText={shortcutError || shortcutCaptureHint}
          error={!!shortcutError}
        />
      </SettingsSection>

      <SettingsSection icon={<Mic size={18} />} title="Microphone">
        <SelectField
          id="input-device"
          label="Input Device"
          value={form.input_device ?? ""}
          onChange={(e) =>
            setForm({
              ...form,
              input_device: e.target.value || null,
            })
          }
          options={[
            { label: "System Default", value: "" },
            ...devices.map((device) => ({ label: device, value: device })),
          ]}
        />

        <div className="mic-test">
          <Button
            variant="secondary"
            icon={<Mic size={16} />}
            onClick={handleTestMic}
            disabled={micTestState === "testing"}
          >
            {micTestState === "testing" ? "Listening..." : "Test Microphone"}
          </Button>

          {(micTestState === "testing" || micTestState === "success") && (
            <Progress value={micTestState === "success" ? Math.min(micLevel * 100, 100) : undefined} />
          )}

          {micTestState === "success" && <Alert tone="success">Microphone working</Alert>}
          {micTestState === "fail" && <Alert tone="error">No audio detected</Alert>}
        </div>
      </SettingsSection>

      <SettingsSection icon={<Shield size={18} />} title="Permissions">
        <div className="settings-grid settings-grid--two">
          <Alert tone="info">
            Microphone access is required to record your voice. Use Test Microphone after granting access.
          </Alert>
          <Alert tone="warning">
            On macOS, enable Echo in Accessibility for automatic paste. If blocked, Echo copies the transcript.
          </Alert>
        </div>
      </SettingsSection>

      <SettingsSection icon={<History size={18} />} title="History">
        <Toggle
          checked={form.history_enabled}
          onChange={(history_enabled) => setForm({ ...form, history_enabled })}
          label="Save dictation history"
        />
        <Field
          className="history-limit-field"
          id="history-limit"
          label="History Limit"
          type="number"
          value={form.history_limit}
          disabled={!form.history_enabled}
          min={1}
          max={100}
          onChange={(e) =>
            setForm({
              ...form,
              history_limit: Number(e.target.value) || 1,
            })
          }
          helperText="Echo keeps at most 100 local history items."
        />
      </SettingsSection>

      <SettingsSection icon={<Volume2 size={18} />} title="Sounds">
        <Toggle
          checked={form.sounds_enabled}
          onChange={(sounds_enabled) => setForm({ ...form, sounds_enabled })}
          label="Enable sounds"
        />

        <div className="settings-grid settings-grid--two">
          <SoundSelect
            disabled={!form.sounds_enabled}
            id="indicator-sound"
            label="Recording Indicator Sound"
            value={form.indicator_sound}
            helperText="Played when recording starts and stops"
            onChange={(indicator_sound) => setForm({ ...form, indicator_sound })}
          />
          <SoundSelect
            disabled={!form.sounds_enabled}
            id="success-sound"
            label="Success Sound"
            value={form.success_sound}
            helperText="Played after transcription completes"
            onChange={(success_sound) => setForm({ ...form, success_sound })}
          />
        </div>
      </SettingsSection>

      <div className="settings-actions">
        <Button type="submit" variant="primary" icon={<Save size={16} />} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
        {canCancel && (
          <Button type="button" variant="secondary" icon={<X size={16} />} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function SoundSelect({
  disabled,
  helperText,
  id,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  helperText: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="sound-select">
      <SelectField
        id={id}
        label={label}
        value={value}
        disabled={disabled}
        helperText={helperText}
        options={SOUND_OPTIONS}
        onChange={(e) => onChange(e.target.value)}
      />
      <IconButton
        label={`Preview ${label.toLowerCase()}`}
        disabled={disabled || value === "none"}
        onClick={() =>
          HAS_TAURI ? invoke("play_sound_preview", { sound: value }).catch(() => {}) : undefined
        }
      >
        <Volume2 size={16} />
      </IconButton>
    </div>
  );
}
