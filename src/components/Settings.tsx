import { useCallback, useEffect, useState } from "react";
import {
  Cloud,
  Cpu,
  RefreshCw,
  Shield,
  Volume2,
  X,
} from "./AureoleIcons";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import type { AppConfig, AppearanceTheme } from "../App";
import type { AuthUserSummary } from "../auth";
import { getSession } from "../auth";
import type { EntitlementStatus } from "../entitlements";
import ShortcutCapture from "./ShortcutCapture";
import {
  Alert,
  Button,
  Card,
  Chip,
  Disclosure,
  Field,
  IconButton,
  InlineNotice,
  Progress,
  SegmentedControl,
  SelectField,
  SettingsGroup,
  SettingsRow,
  Toggle,
} from "./ui";
import "./Settings.css";

interface ModelStatus {
  downloaded: boolean;
  downloading: boolean;
  file_size_bytes: number;
  expected_size_bytes: number;
  integrity_checked: boolean;
  integrity_error: string | null;
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

interface GroqReadiness {
  ok: boolean;
  message: string;
  transcription_model_ok: boolean;
  cleanup_model_ok: boolean;
}

interface SettingsProps {
  authUser: AuthUserSummary | null;
  config: AppConfig;
  entitlement: EntitlementStatus;
  entitlementMessage?: string;
  entitlementChecking?: boolean;
  checkoutPending?: boolean;
  onSave: (config: AppConfig) => Promise<void>;
  onCancel: () => void;
  onClearInsights?: () => Promise<void>;
  onStartCheckout: () => Promise<void>;
  onRefreshEntitlement: () => Promise<EntitlementStatus>;
  onSignOut: () => Promise<void>;
  onOpenOnboarding?: () => void;
  onPreviewAppearance?: (theme: AppearanceTheme) => void;
  shortcutError?: string;
  setupStatus?: SetupStatus | null;
  onRefreshSetup?: () => Promise<SetupStatus | null>;
}

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const TRANSCRIPTION_MODELS = [
  { label: "Whisper Large v3 Turbo (fast)", value: "whisper-large-v3-turbo" },
  { label: "Whisper Large v3 (accurate)", value: "whisper-large-v3" },
];

const CLEANUP_MODELS = [
  { label: "Llama 3.1 8B (fast)", value: "llama-3.1-8b-instant" },
  { label: "Llama 3.3 70B (quality)", value: "llama-3.3-70b-versatile" },
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

const LOCAL_THREAD_OPTIONS = [
  { label: "Balanced", value: "" },
  { label: "Light", value: "1" },
  { label: "Steady", value: "2" },
  { label: "Fast", value: "4" },
  { label: "Faster", value: "6" },
  { label: "Fastest", value: "8" },
];
const SETTINGS_EASE = [0.2, 0.8, 0.2, 1] as const;

type SettingsTabId = "account" | "dictation" | "input" | "app";

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: "account", label: "Account" },
  { id: "dictation", label: "Dictation" },
  { id: "input", label: "Input" },
  { id: "app", label: "App" },
];

function formatShortcutForDisplay(shortcut: string): string {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return shortcut
    .split(/\s*\+\s*/)
    .map((key) => {
      if (key.toLowerCase() === "commandorcontrol") return isMac ? "⌘" : "Ctrl";
      if (key.toLowerCase() === "command") return "⌘";
      if (key.toLowerCase() === "control") return isMac ? "⌃" : "Ctrl";
      if (key.toLowerCase() === "shift") return isMac ? "⇧" : "Shift";
      if (key.toLowerCase() === "alt" || key.toLowerCase() === "option") return isMac ? "⌥" : "Alt";
      return key;
    })
    .join(" + ");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
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

function SettingsSection({
  children,
  className = "",
  description,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  title: string;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const sectionVariants: Variants = reduceMotion
    ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { duration: 0 } },
      }
    : {
        hidden: { opacity: 0, y: 8, filter: "blur(4px)" },
        visible: {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          transition: { duration: 0.22, ease: SETTINGS_EASE },
        },
      };

  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={sectionVariants}
    >
      <SettingsGroup className="settings-section" description={description} title={title}>
        <div className="settings-section__body">{children}</div>
      </SettingsGroup>
    </motion.div>
  );
}

function SettingsFadeTabs({
  active,
  onChange,
}: {
  active: SettingsTabId;
  onChange: (tab: SettingsTabId) => void;
}) {
  const handleChange = (tab: SettingsTabId) => {
    const scroller = document.querySelector<HTMLElement>(".content-main-col");
    if (scroller) {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
    }
    onChange(tab);
  };

  return (
    <nav className="settings-fade-tabs" aria-label="Settings sections">
      {SETTINGS_TABS.map((tab) => (
        <button
          aria-current={active === tab.id ? "page" : undefined}
          className={`settings-fade-tab${active === tab.id ? " is-active" : ""}`}
          key={tab.id}
          onClick={() => handleChange(tab.id)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

function SettingsStatusSummary({
  onOpenOnboarding,
  onRefreshSetup,
  ready,
  setupStatus,
}: {
  onOpenOnboarding?: () => void;
  onRefreshSetup?: () => Promise<SetupStatus | null>;
  ready?: boolean;
  setupStatus?: SetupStatus | null;
}) {
  const blockers = setupStatus?.checks.filter((check) => check.status !== "ok") ?? [];
  const firstBlocker = blockers[0];

  if (ready !== false || !firstBlocker) return null;

  return (
    <InlineNotice
      className="settings-status-summary"
      aria-label="Setup needs attention"
      tone="warning"
      action={
        onOpenOnboarding ? (
          <Button size="sm" variant="secondary" onClick={onOpenOnboarding}>
            Fix setup
          </Button>
        ) : undefined
      }
      details={
        <div className="settings-readiness-details">
          {blockers.map((check) => (
            <div key={check.id}>
              <strong>{check.label}</strong>
              <span>{check.message}</span>
            </div>
          ))}
          {onRefreshSetup && (
            <Button size="sm" variant="ghost" onClick={() => void onRefreshSetup()}>
              Refresh checks
            </Button>
          )}
        </div>
      }
    >
      <strong>{firstBlocker.label} needs attention.</strong> {firstBlocker.message}
    </InlineNotice>
  );
}

function ProviderCard({
  active,
  ariaLabel,
  description,
  label,
  locked = false,
  note,
  onClick,
}: {
  active: boolean;
  ariaLabel?: string;
  description: string;
  icon?: React.ReactNode;
  locked?: boolean;
  note?: string;
  label: React.ReactNode;
  onClick: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <motion.button
      type="button"
      className={`settings-choice settings-choice--${active ? "active" : "inactive"} provider-card provider-card--${
        active ? "active" : "inactive"
      }${locked ? " provider-card--locked" : ""}`}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      whileHover={reduceMotion ? undefined : { y: -1 }}
      whileTap={reduceMotion ? undefined : { scale: 0.96 }}
      animate={active && !reduceMotion ? { scale: 1.01 } : { scale: 1 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="provider-card__title">
        <strong>{label}</strong>
        <span className={`settings-choice__chip provider-card__chip${active ? " settings-choice__chip--active provider-card__chip--active" : ""}`}>
          {locked && !active ? "Pro" : active ? "Selected" : "Not selected"}
        </span>
      </div>
      <span>{description}</span>
      {note && <span className="provider-card__note">{note}</span>}
    </motion.button>
  );
}

function ProPaywallCard({
  busy,
  message,
  onRefresh,
  onStartCheckout,
}: {
  busy?: boolean;
  message?: string;
  onRefresh: () => Promise<EntitlementStatus>;
  onStartCheckout: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="pro-paywall-card">
      <div>
        <strong>Unlock Echo Pro</strong>
        <span>Cloud dictation and unlimited local history with a one-time purchase.</span>
        {message && <em>{message}</em>}
      </div>
      <div className="pro-paywall-card__actions">
        <Button
          onClick={() => void onStartCheckout()}
          variant="outline"
          disabled={busy}
        >
          {busy ? "Opening..." : "Unlock"}
        </Button>
        <Button
          onClick={() => void handleRefresh()}
          variant="secondary"
          disabled={refreshing}
        >
          {refreshing ? "Checking..." : "Restore"}
        </Button>
      </div>
    </div>
  );
}

function ModelDownloadSection({
  modelSize,
  onSelect,
  selected,
}: {
  modelSize: "small" | "medium";
  onSelect: (modelSize: "small" | "medium") => void;
  selected: boolean;
}) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const reduceMotion = useReducedMotion() ?? false;

  const checkStatus = useCallback(async () => {
    if (!HAS_TAURI) {
      const mockStatus = {
        downloaded: modelSize === "small",
        downloading: false,
        file_size_bytes: modelSize === "small" ? 487_601_967 : 0,
        expected_size_bytes: modelSize === "small" ? 487_601_967 : 1_533_763_059,
        integrity_checked: false,
        integrity_error: null,
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
        file_size_bytes: modelSize === "small" ? 487_601_967 : 1_533_763_059,
        expected_size_bytes: modelSize === "small" ? 487_601_967 : 1_533_763_059,
        integrity_checked: true,
        integrity_error: null,
        model_size: modelSize,
      });
      return;
    }

    setStatus((prev) => (prev ? { ...prev, downloading: true } : prev));
    try {
      const session = await getSession();
      const accessToken = session?.access_token ?? "";
      await invoke("download_whisper_model", { modelSize, accessToken });
      await checkStatus();
    } catch (e) {
      setError(formatErrorMessage(e));
      await checkStatus();
    }
  };

  const handleVerify = async () => {
    setError("");
    if (!HAS_TAURI) {
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              integrity_checked: true,
              integrity_error: null,
            }
          : prev
      );
      return;
    }

    setVerifying(true);
    try {
      const verified = await invoke<ModelStatus>("verify_model_status", { modelSize });
      setStatus(verified);
      if (!verified.downloaded && verified.integrity_error) {
        setError(verified.integrity_error);
      }
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setVerifying(false);
    }
  };

  const handleDelete = async () => {
    if (!HAS_TAURI) {
      setStatus({
        downloaded: false,
        downloading: false,
        file_size_bytes: 0,
        expected_size_bytes: modelSize === "small" ? 487_601_967 : 1_533_763_059,
        integrity_checked: false,
        integrity_error: null,
        model_size: modelSize,
      });
      return;
    }

    try {
      await invoke("delete_whisper_model", { modelSize });
      await checkStatus();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  };

  const expectedSize =
    status?.expected_size_bytes || (modelSize === "small" ? 487_601_967 : 1_533_763_059);
  const sizeLabel = `${formatBytes(expectedSize)} download`;
  const modelBenefit =
    modelSize === "small"
      ? "Fastest. Good for everyday dictation."
      : "More accurate. Larger download.";
  const canSelect = Boolean(status?.downloaded && !status.downloading);
  const selectedAvailable = selected && canSelect;
  const statusTone = !status
    ? "neutral"
    : selectedAvailable
      ? "accent"
      : status.downloaded
      ? "neutral"
      : status.downloading
        ? "accent"
        : "neutral";
  const statusLabel = !status
    ? "Checking"
    : selectedAvailable
      ? "Selected"
      : status.downloading
        ? "Downloading"
        : status.integrity_error
          ? "Needs retry"
          : "Not downloaded";

  return (
    <Card
      className={`settings-choice settings-choice--${selectedAvailable ? "active" : "inactive"}${
        canSelect ? "" : " settings-choice--unavailable"
      } model-download-card${selectedAvailable ? " model-download-card--selected" : ""}${
        canSelect ? "" : " model-download-card--unavailable"
      }${canSelect ? " model-download-card--ready" : ""}`}
    >
      <div className="model-download-card__header">
        <div>
          <strong>Whisper {modelSize.charAt(0).toUpperCase() + modelSize.slice(1)}</strong>
          <span>{sizeLabel}</span>
        </div>
        <div className="model-download-card__header-actions">
          {selectedAvailable ? (
            <>
              <Chip tone="accent">Selected</Chip>
              <IconButton
                label="Remove model"
                tone="danger"
                onClick={() => void handleDelete()}
              >
                <X size={14} />
              </IconButton>
              {!status?.integrity_checked && (
                <IconButton
                  label={verifying ? "Verifying..." : "Verify model"}
                  onClick={() => void handleVerify()}
                  disabled={verifying}
                >
                  <RefreshCw size={15} />
                </IconButton>
              )}
            </>
          ) : status?.downloaded && !status.downloading ? (
            <Button variant="outline" onClick={() => onSelect(modelSize)} size="sm">
              Use this model
            </Button>
          ) : (
            <Chip tone={statusTone}>{statusLabel}</Chip>
          )}
        </div>
      </div>

      <p className="model-download-card__subtitle">{modelBenefit}</p>

      <AnimatePresence initial={false} mode="wait">
        {status?.downloading && (
          <motion.div
            key="download-progress"
            className="download-progress"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <Progress value={progress?.percentage} />
            <span>
              {progress
                ? `${formatBytes(progress.bytes_downloaded)} / ${formatBytes(progress.total_bytes || expectedSize)} (${progress.percentage.toFixed(0)}%)`
                : "Starting download..."}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {(error || status?.integrity_error) && (
          <motion.div
            key="download-error"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <Alert tone="error">{error || status?.integrity_error}</Alert>
          </motion.div>
        )}
      </AnimatePresence>

      {(!status || (status && !status.downloaded && !status.downloading)) && (
        <div className="model-download-card__actions">
          {!status && (
            <Button variant="secondary" disabled size="sm">
              Checking...
            </Button>
          )}
          {status && !status.downloaded && !status.downloading && (
            <Button variant="secondary" onClick={handleDownload} size="sm">
              {status.integrity_error ? "Retry Download" : "Download Model"}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Settings({
  authUser,
  config,
  entitlement,
  entitlementMessage = "",
  entitlementChecking = false,
  checkoutPending = false,
  onSave,
  onCancel,
  onClearInsights,
  onStartCheckout,
  onRefreshEntitlement,
  onSignOut,
  onOpenOnboarding,
  onPreviewAppearance,
  shortcutError = "",
  setupStatus,
  onRefreshSetup,
}: SettingsProps) {
  const [form, setForm] = useState<AppConfig>({ ...config });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [groqTest, setGroqTest] = useState<{
    message: string;
    signature: string;
    status: "idle" | "testing" | "success" | "warning" | "error";
  }>({ message: "", signature: "", status: "idle" });
  const [devices, setDevices] = useState<string[]>([]);
  const [micTestState, setMicTestState] = useState<"idle" | "testing" | "success" | "fail">("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [shortcutCaptureHint, setShortcutCaptureHint] = useState(
    "Click the field, then press your shortcut."
  );
  const [shortcutFocused, setShortcutFocused] = useState(false);
  const [clearInsightsConfirming, setClearInsightsConfirming] = useState(false);
  const [clearInsightsState, setClearInsightsState] = useState<"idle" | "clearing" | "success" | "error">("idle");
  const [clearInsightsMessage, setClearInsightsMessage] = useState("");
  const [activeTab, setActiveTab] = useState<SettingsTabId>("account");
  const reduceMotion = useReducedMotion() ?? false;
  const hasPro = entitlement.tier === "pro_lifetime";
  const checkingEntitlement = entitlementChecking && !hasPro;
  const canUseCloud = entitlement.features.cloudProvider;
  const canUseUnlimitedHistory = entitlement.features.unlimitedHistory;
  const isDirty = JSON.stringify(form) !== JSON.stringify(config);

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
    setSaveError("");

    const nextForm = {
      ...form,
      groq_api_key: form.groq_api_key.trim(),
      history_limit: canUseUnlimitedHistory ? form.history_limit : Math.min(form.history_limit, 100),
      local_transcription_threads:
        form.local_transcription_threads && form.local_transcription_threads > 0
          ? Math.round(form.local_transcription_threads)
          : null,
    };

    if (nextForm.model_provider === "api") {
      if (!canUseCloud) {
        setSaveError("Unlock Echo Pro to save cloud transcription settings.");
        return;
      }
      if (!nextForm.groq_api_key) {
        setSaveError("Enter a Groq API key or switch to a local Whisper model.");
        return;
      }
      if (!nextForm.groq_api_key.startsWith("gsk_")) {
        setSaveError("Groq API keys usually start with gsk_. Check the key and try again.");
        return;
      }
    }

    setSaving(true);
    try {
      setForm(nextForm);
      await onSave(nextForm);
    } catch (e) {
      setSaveError(formatErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setForm({ ...config });
    setSaveError("");
    setGroqTest({ message: "", signature: "", status: "idle" });
    onPreviewAppearance?.(config.appearance_theme);
    onCancel();
  };

  const handleClearInsights = async () => {
    setClearInsightsMessage("");
    if (!clearInsightsConfirming) {
      setClearInsightsConfirming(true);
      setClearInsightsState("idle");
      return;
    }

    setClearInsightsState("clearing");
    try {
      await onClearInsights?.();
      setClearInsightsConfirming(false);
      setClearInsightsState("success");
      setClearInsightsMessage("Insights cleared. Your history and notes were kept.");
    } catch (e) {
      setClearInsightsState("error");
      setClearInsightsMessage(formatErrorMessage(e));
    }
  };

  const groqTestSignature = [
    form.groq_api_key.trim(),
    form.transcription_model,
    form.cleanup_model,
    String(form.cleanup_enabled),
  ].join("|");

  const handleTestGroqConnection = async () => {
    if (!canUseCloud) {
      setGroqTest({
        message: "Unlock Echo Pro to test cloud transcription.",
        signature: groqTestSignature,
        status: "error",
      });
      return;
    }

    const nextForm = {
      ...form,
      groq_api_key: form.groq_api_key.trim(),
    };
    const signature = [
      nextForm.groq_api_key,
      nextForm.transcription_model,
      nextForm.cleanup_model,
      String(nextForm.cleanup_enabled),
    ].join("|");

    if (!nextForm.groq_api_key) {
      setGroqTest({
        message: "Enter a Groq API key before testing the connection.",
        signature,
        status: "error",
      });
      return;
    }

    setGroqTest({ message: "Testing Groq connection...", signature, status: "testing" });

    if (!HAS_TAURI) {
      window.setTimeout(() => {
        setGroqTest({
          message: "Groq connection looks good in preview mode.",
          signature,
          status: "success",
        });
      }, 500);
      return;
    }

    try {
      const readiness = await invoke<GroqReadiness>("test_groq_connection", {
        config: nextForm,
      });
      setGroqTest({
        message: readiness.message,
        signature,
        status: readiness.ok ? "success" : "warning",
      });
    } catch (e) {
      setGroqTest({
        message: formatErrorMessage(e),
        signature,
        status: "error",
      });
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

  const handleShortcutCapture = (accelerator: string) => {
    setForm({ ...form, shortcut: accelerator });
    setShortcutCaptureHint(`Captured ${accelerator}. Save to apply it.`);
  };

  const ready = setupStatus?.ready;
  const settingsContainerVariants: Variants = reduceMotion
    ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { duration: 0 } },
      }
    : {
        hidden: { opacity: 1 },
        visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
      };
  const settingsEntryVariants: Variants = reduceMotion
    ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { duration: 0 } },
      }
    : {
        hidden: { opacity: 0, y: 8, filter: "blur(4px)" },
        visible: {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          transition: { duration: 0.22, ease: SETTINGS_EASE },
        },
      };

  return (
    <motion.form
      className="settings-pane"
      onSubmit={handleSubmit}
      initial="hidden"
      animate="visible"
      variants={settingsContainerVariants}
    >
      <motion.div className="page-heading page-heading--split" variants={settingsEntryVariants}>
        <div>
          <h2>Settings</h2>
        </div>
      </motion.div>

      <SettingsStatusSummary
        onOpenOnboarding={onOpenOnboarding}
        onRefreshSetup={onRefreshSetup}
        ready={ready}
        setupStatus={setupStatus}
      />

      <motion.div className="settings-tab-shell" variants={settingsEntryVariants}>
        <SettingsFadeTabs active={activeTab} onChange={setActiveTab} />
      </motion.div>

      <AnimatePresence initial={false} mode="wait">
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="settings-tab-panel"
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          key={activeTab}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: SETTINGS_EASE }}
        >
          {activeTab === "account" && (
            <>
              <SettingsSection title="Account">
                <SettingsRow
                  label={authUser?.email ?? "Signed in"}
                  description={authUser ? `${authUser.provider} account` : "Echo account"}
                  action={
                    <Button onClick={() => void onSignOut()} type="button" variant="secondary">
                    Sign Out
                    </Button>
                  }
                />
                {checkingEntitlement ? (
                  <SettingsRow
                    label="Plan"
                    description="Checking your Echo Pro status"
                    action={<Chip tone="accent">Checking</Chip>}
                  />
                ) : hasPro ? (
                  <SettingsRow
                    label="Echo Pro"
                    description="Cloud dictation and unlimited local history are active"
                    action={<Chip tone="success">Active</Chip>}
                  />
                ) : (
                  <ProPaywallCard
                    busy={checkoutPending}
                    message={entitlementMessage}
                    onRefresh={onRefreshEntitlement}
                    onStartCheckout={onStartCheckout}
                  />
                )}
                <Disclosure className="settings-inner-disclosure" summary="Local data and privacy">
                  <p>
                    Dictation history, Notepad notes, and insights stay on this device. Signing out does not
                    delete them.
                  </p>
                </Disclosure>
              </SettingsSection>
            </>
          )}

          {activeTab === "dictation" && (
            <>
              <SettingsSection
                icon={<Cloud size={18} />}
                title="Provider"
              >
                <div className="settings-grid settings-grid--two">
                  <ProviderCard
                    active={form.model_provider === "api"}
                    ariaLabel="Cloud"
                    icon={<Cloud size={18} />}
                    label="Cloud"
                    description={
                      canUseCloud
                        ? "Fast online transcription"
                        : checkingEntitlement
                          ? "Checking Echo Pro status"
                          : "Available with Echo Pro"
                    }
                    locked={!canUseCloud}
                    note={canUseCloud ? "Uses your Groq API key" : undefined}
                    onClick={() => {
                      if (canUseCloud) {
                        setForm({ ...form, model_provider: "api" });
                      } else {
                        setActiveTab("account");
                      }
                    }}
                  />
                  <ProviderCard
                    active={form.model_provider === "local"}
                    icon={<Cpu size={18} />}
                    label="On-device"
                    description="Private local transcription"
                    onClick={() => setForm({ ...form, model_provider: "local" })}
                  />
                </div>
                {!canUseCloud && (
                  <InlineNotice
                    tone="info"
                    action={
                      <Button size="sm" variant="ghost" onClick={() => setActiveTab("account")}>
                        View plan
                      </Button>
                    }
                  >
                    Cloud transcription requires Echo Pro.
                  </InlineNotice>
                )}
              </SettingsSection>

              {form.model_provider === "api" && canUseCloud && (
                <>
                  <SettingsSection
                    icon={<Shield size={18} />}
                    title="Cloud"
                  >
                    <Field
                      id="api-key"
                      label="Groq API key"
                      type="password"
                      value={form.groq_api_key}
                      onChange={(e) => setForm({ ...form, groq_api_key: e.target.value })}
                      placeholder="gsk_..."
                      required={form.model_provider === "api"}
                      helperText={
                        <>
                          Stored in your operating system’s secure credential store. Get a key at{" "}
                          <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">
                            console.groq.com/keys
                          </a>
                          .
                        </>
                      }
                    />
                    <div className="settings-row settings-row--wrap">
                      <Button
                        disabled={groqTest.status === "testing"}
                        onClick={() => void handleTestGroqConnection()}
                        variant="secondary"
                      >
                        {groqTest.status === "testing" ? "Testing..." : "Test connection"}
                      </Button>
                      {groqTest.message && groqTest.signature === groqTestSignature && (
                        <Chip
                          tone={
                            groqTest.status === "success"
                              ? "success"
                              : groqTest.status === "warning"
                                ? "warning"
                                : groqTest.status === "testing"
                                  ? "accent"
                                  : "error"
                          }
                        >
                          {groqTest.status === "testing"
                            ? "Checking"
                            : groqTest.status === "success"
                              ? "Ready"
                              : "Needs attention"}
                        </Chip>
                      )}
                    </div>
                    <AnimatePresence initial={false}>
                      {groqTest.message && groqTest.signature === groqTestSignature && (
                        <motion.div
                          key={`${groqTest.status}-${groqTest.message}`}
                          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                          transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: SETTINGS_EASE }}
                        >
                          <Alert
                            tone={
                              groqTest.status === "success"
                                ? "success"
                                : groqTest.status === "warning"
                                  ? "warning"
                                  : groqTest.status === "testing"
                                    ? "info"
                                    : "error"
                            }
                          >
                            {groqTest.message}
                          </Alert>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </SettingsSection>

                  <Disclosure className="settings-advanced" summary="Advanced">
                    <div className="settings-advanced__content">
                      <div className="settings-grid settings-grid--two">
                        <SelectField
                          id="transcription-model"
                          label="Transcription model"
                          value={form.transcription_model}
                          onChange={(e) => setForm({ ...form, transcription_model: e.target.value })}
                          options={TRANSCRIPTION_MODELS}
                        />
                        <SelectField
                          id="cleanup-model"
                          label="Cleanup model"
                          value={form.cleanup_model}
                          onChange={(e) => setForm({ ...form, cleanup_model: e.target.value })}
                          options={CLEANUP_MODELS}
                        />
                      </div>
                      <Toggle
                        checked={form.cleanup_enabled}
                        onChange={(cleanup_enabled) => setForm({ ...form, cleanup_enabled })}
                        label="Clean up wording"
                      />
                      <p className="settings-supporting-copy">
                        If cleanup fails, Echo keeps the original transcript.
                      </p>
                    </div>
                  </Disclosure>
                </>
              )}

              {form.model_provider === "local" && (
                <SettingsSection
                  icon={<Cpu size={18} />}
                  title="On-device model"
                >
                  <div className="local-model-list">
                    <ModelDownloadSection
                      key="small"
                      modelSize="small"
                      selected={form.local_model_size === "small"}
                      onSelect={(local_model_size) => setForm({ ...form, local_model_size })}
                    />
                    <ModelDownloadSection
                      key="medium"
                      modelSize="medium"
                      selected={form.local_model_size === "medium"}
                      onSelect={(local_model_size) => setForm({ ...form, local_model_size })}
                    />
                  </div>
                  {form.local_model_size === "medium" && (
                    <InlineNotice tone="warning">
                      Medium uses more memory and may take longer on the first dictation after launch.
                    </InlineNotice>
                  )}
                  <Disclosure className="settings-inner-disclosure" summary="Advanced">
                    <SelectField
                      id="local-transcription-threads"
                      label="Performance"
                      value={form.local_transcription_threads ? String(form.local_transcription_threads) : ""}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          local_transcription_threads: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      options={LOCAL_THREAD_OPTIONS}
                      helperText="Choose how much processing power Echo can use."
                    />
                  </Disclosure>
                </SettingsSection>
              )}
            </>
          )}

          {activeTab === "input" && (
            <SettingsSection title="Input">
              <SettingsRow
                label="Shortcut"
                description={shortcutError || (shortcutFocused ? shortcutCaptureHint : undefined)}
                action={
                  <ShortcutCapture
                    className="settings-row-control"
                    displayValue={formatShortcutForDisplay(form.shortcut)}
                    id="shortcut"
                    invalid={!!shortcutError}
                    onBlur={() => {
                      setShortcutFocused(false);
                      setShortcutCaptureHint("Click the field, then press your shortcut.");
                    }}
                    onCancel={() => setShortcutCaptureHint("Shortcut unchanged.")}
                    onCapture={handleShortcutCapture}
                    onFocus={() => {
                      setShortcutFocused(true);
                      setShortcutCaptureHint("Press a key combination. Escape cancels.");
                    }}
                    onIncomplete={() => setShortcutCaptureHint("Press any key or key combo.")}
                    platform={/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "macos" : "windows"}
                    value={form.shortcut}
                  />
                }
              />
              <SettingsRow
                label="Microphone"
                action={
                  <select
                    aria-label="Input device"
                    className="ui-select settings-row-control"
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
                    {devices.map((device) => (
                      <option key={device} value={device}>
                        {device}
                      </option>
                    ))}
                  </select>
                }
              >
                <div className="mic-test">
                  <Button
                    variant="secondary"
                    onClick={handleTestMic}
                    disabled={micTestState === "testing"}
                  >
                    {micTestState === "testing" ? "Listening..." : "Test microphone"}
                  </Button>
                  {(micTestState === "testing" || micTestState === "success") && (
                    <Progress value={micTestState === "success" ? Math.min(micLevel * 100, 100) : undefined} />
                  )}
                  {micTestState === "success" && <span className="mic-test__status is-success">Microphone working</span>}
                  {micTestState === "fail" && <span className="mic-test__status is-error">No audio detected</span>}
                </div>
              </SettingsRow>
              <SettingsRow
                label="Sounds"
                action={
                  <Toggle
                    checked={form.sounds_enabled}
                    onChange={(sounds_enabled) => setForm({ ...form, sounds_enabled })}
                    label={form.sounds_enabled ? "On" : "Off"}
                  />
                }
              >
                {form.sounds_enabled && (
                  <div className="settings-grid settings-grid--two settings-sound-grid">
                    <SoundSelect
                      id="indicator-sound"
                      label="Start and stop sound"
                      value={form.indicator_sound}
                      onChange={(indicator_sound) => setForm({ ...form, indicator_sound })}
                    />
                    <SoundSelect
                      id="success-sound"
                      label="Completion sound"
                      value={form.success_sound}
                      onChange={(success_sound) => setForm({ ...form, success_sound })}
                    />
                  </div>
                )}
              </SettingsRow>
            </SettingsSection>
          )}

          {activeTab === "app" && (
            <SettingsSection title="App">
              <SettingsRow label="Appearance">
                <SegmentedControl<AppearanceTheme>
                  label="Appearance"
                  value={form.appearance_theme}
                  onChange={(appearance_theme) => {
                    setForm({ ...form, appearance_theme });
                    onPreviewAppearance?.(appearance_theme);
                  }}
                  options={[
                    { label: "Dark", value: "dark" },
                    { label: "Light", value: "light" },
                    { label: "System", value: "system" },
                  ]}
                />
              </SettingsRow>
              <SettingsRow
                label="Dictation history"
                description={
                  form.history_enabled
                    ? canUseUnlimitedHistory
                      ? "Stored on this device with no item limit"
                      : "Stored on this device. Free includes up to 100 items."
                    : "New dictations will not be saved"
                }
                action={
                  <Toggle
                    checked={form.history_enabled}
                    onChange={(history_enabled) => setForm({ ...form, history_enabled })}
                    label={form.history_enabled ? "On" : "Off"}
                  />
                }
              >
                {form.history_enabled && !canUseUnlimitedHistory && (
                  <Field
                    className="history-limit-field"
                    id="history-limit"
                    label="Keep up to"
                    type="number"
                    value={Math.min(form.history_limit, 100)}
                    min={1}
                    max={100}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        history_limit: Math.min(Number(e.target.value) || 1, 100),
                      })
                    }
                    helperText="items"
                  />
                )}
              </SettingsRow>
              <SettingsRow
                label="Launch at login"
                action={
                  <Toggle
                    checked={form.launch_at_login}
                    onChange={(launch_at_login) => setForm({ ...form, launch_at_login })}
                    label={form.launch_at_login ? "On" : "Off"}
                  />
                }
              />
              {onOpenOnboarding && (
                <SettingsRow
                  label="Setup assistant"
                  description="Review your microphone, paste, and shortcut setup"
                  action={
                    <Button type="button" variant="secondary" onClick={onOpenOnboarding}>
                      Run setup
                    </Button>
                  }
                />
              )}
              {onClearInsights && (
                <Disclosure className="settings-inner-disclosure" summary="Data management">
                  <div className="settings-danger-row">
                    <div>
                      <strong>Dictation insights</strong>
                      <span>Total words, WPM, streaks, and milestones are stored locally.</span>
                    </div>
                    <Button
                      type="button"
                      variant={clearInsightsConfirming ? "danger" : "secondary"}
                      onClick={() => void handleClearInsights()}
                      disabled={clearInsightsState === "clearing"}
                    >
                      {clearInsightsState === "clearing"
                        ? "Clearing..."
                        : clearInsightsConfirming
                          ? "Confirm clear"
                          : "Clear insights"}
                    </Button>
                  </div>
                  {clearInsightsConfirming && (
                    <InlineNotice tone="warning">
                      This resets insights only. History and Notepad notes are kept.
                    </InlineNotice>
                  )}
                  {clearInsightsMessage && (
                    <InlineNotice tone={clearInsightsState === "error" ? "error" : "success"}>
                      {clearInsightsMessage}
                    </InlineNotice>
                  )}
                </Disclosure>
              )}
            </SettingsSection>
          )}
        </motion.div>
      </AnimatePresence>

      {isDirty && (
        <div className="settings-actions">
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button type="button" variant="secondary" onClick={handleDiscard}>
            Discard
          </Button>
        </div>
      )}
      {saveError && <Alert tone="error">{saveError}</Alert>}
    </motion.form>
  );
}

function SoundSelect({
  disabled = false,
  helperText,
  id,
  label,
  onChange,
  value,
}: {
  disabled?: boolean;
  helperText?: string;
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
