import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import {
  Copy,
  FileText,
  Mic,
  Monitor,
  Search,
  Settings,
  Shield,
  Square,
  Trash2,
  Users,
  X,
} from "./AureoleIcons";
import { Alert, Button, IconButton } from "./ui";
import { getSession } from "../auth";
import {
  activeMeeting,
  EMPTY_MEETING_STATUS,
  HAS_NATIVE,
  meetingError,
  meetingTime,
  NOTES_MODEL,
  PROVIDERS,
  type Meeting,
  type MeetingReadiness,
  type MeetingSettings,
  type MeetingStatus,
  type NotePoint,
} from "../meetings";
import "./MeetingsPanel.css";

const DEFAULT_SETTINGS: MeetingSettings = {
  transcriptionModel: "auto",
  summaryProvider: "local",
  mode: "online",
  cloudConsent: false,
};

export default function MeetingsPanel({
  onAccount,
}: {
  onAccount?: () => void;
}) {
  const [meetings, setMeetings] = useState<Meeting[]>([]),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [selected, setSelected] = useState<Meeting | null>(null);
  const [query, setQuery] = useState(""),
    [tab, setTab] = useState<"notes" | "transcript">("notes"),
    [status, setStatus] = useState<MeetingStatus>(EMPTY_MEETING_STATUS);
  const [readiness, setReadiness] = useState<MeetingReadiness | null>(null),
    [settings, setSettings] = useState<MeetingSettings>(DEFAULT_SETTINGS),
    [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [renaming, setRenaming] = useState(false),
    [originalTranscript, setOriginalTranscript] = useState(false),
    [editing, setEditing] = useState(false),
    [editTitle, setEditTitle] = useState(""),
    [editNotes, setEditNotes] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null),
    [credential, setCredential] = useState(""),
    [download, setDownload] = useState<{
      id: string;
      percentage: number;
    } | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const requestRef = useRef(0),
    mounted = useRef(true),
    settingsInitialized = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshReadiness = useCallback(async () => {
    if (!HAS_NATIVE) return;
    const value = await invoke<MeetingReadiness>("meeting_readiness");
    setReadiness(value);
    if (!settingsInitialized.current) {
      setSettings(value.settings);
      settingsInitialized.current = true;
    }
  }, []);
  const refreshList = useCallback(async () => {
    if (!HAS_NATIVE) {
      setLoading(false);
      return;
    }
    const request = ++requestRef.current;
    try {
      const values = await invoke<Meeting[]>("list_meetings", { query });
      if (request !== requestRef.current) return;
      setMeetings(values);
      setSelectedId((current) =>
        current && values.some((m) => m.id === current)
          ? current
          : (values[0]?.id ?? null),
      );
    } catch (e) {
      setError(meetingError(e));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [query]);
  const refreshSelected = useCallback(async () => {
    const id = selectedRef.current;
    if (!id || !HAS_NATIVE) return;
    const meeting = await invoke<Meeting>("get_meeting", { id });
    if (selectedRef.current === id) setSelected(meeting);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void refreshList(), 180);
    return () => clearTimeout(timer);
  }, [refreshList]);
  useEffect(() => {
    if (!HAS_NATIVE) return;
    let disposed = false;
    void Promise.all([
      refreshReadiness(),
      invoke<MeetingStatus>("meeting_status").then((v) => {
        if (!disposed) setStatus(v);
      }),
    ]).catch((e) => setError(meetingError(e)));
    const unlisten = listen<MeetingStatus>("meeting-status", ({ payload }) => {
      if (disposed) return;
      setStatus(payload);
      if (!["recording", "paused", "starting"].includes(payload.state)) {
        void refreshList();
        void refreshSelected().catch((e) => setError(meetingError(e)));
      }
    });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, [refreshReadiness, refreshList, refreshSelected]);
  useEffect(() => {
    if (!HAS_NATIVE) return;
    const unlisten = listen<string>("meeting-action-error", ({ payload }) =>
      setError(payload),
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    setSelected(null);
    setEditing(false);
    setRenaming(false);
    setDeleteId(null);
    if (selectedId)
      void refreshSelected().catch((e) => setError(meetingError(e)));
  }, [selectedId, refreshSelected]);
  useEffect(() => {
    if (!activeMeeting(status)) return;
    const timer = setInterval(() => {
      void refreshList();
      if (!editing)
        void refreshSelected().catch((e) => setError(meetingError(e)));
    }, 5000);
    return () => clearInterval(timer);
  }, [status.state, editing, refreshList, refreshSelected]);
  useEffect(() => {
    if (!download || !HAS_NATIVE) return;
    const timer = setInterval(() => {
      void invoke<{ model_size: string; percentage: number }>(
        "get_model_download_progress",
      )
        .then((v) => {
          if (mounted.current && v.model_size === download.id)
            setDownload({ id: download.id, percentage: v.percentage });
        })
        .catch((e) => setError(meetingError(e)));
    }, 600);
    return () => clearInterval(timer);
  }, [download?.id]);

  async function perform(action: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(meetingError(e));
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    await perform(async () => {
      if (!HAS_NATIVE) {
        setError("Open the desktop app to record meetings.");
        return;
      }
      const id = await invoke<string>("start_meeting", { mode: settings.mode });
      await refreshList();
      setSelectedId(id);
      setTab("notes");
    });
  }
  async function control(command: string) {
    await perform(() => invoke("control_meeting", { command }));
  }
  async function saveSettings() {
    await perform(async () => {
      await invoke("save_meeting_settings", { settings });
      setCredential("");
      await refreshReadiness();
      setNotice("Meetings settings saved.");
    });
  }
  async function modelAction(
    id: string,
    action: "download" | "verify" | "remove",
  ) {
    await perform(async () => {
      if (action === "download") {
        setDownload({ id, percentage: 0 });
        try {
          const session = await getSession();
          await invoke("download_local_model", {
            modelSize: id,
            accessToken: session?.access_token ?? "",
          });
          setNotice("Model downloaded and verified.");
        } finally {
          setDownload(null);
        }
      } else if (action === "verify") {
        const result = await invoke<{
          downloaded: boolean;
          integrity_error: string | null;
        }>("verify_model_status", { modelSize: id });
        if (!result.downloaded)
          throw new Error(
            result.integrity_error ??
              "The model is incomplete. Download it again.",
          );
        setNotice("Model verified.");
      } else {
        await invoke("delete_local_model", { modelSize: id });
        setNotice("Model removed from this computer.");
      }
      await refreshReadiness();
    });
  }
  async function copyOrExport(exportFile: boolean) {
    if (!selected) return;
    await perform(async () => {
      if (exportFile) {
        await invoke("save_meeting_export", { id: selected.id, format: tab === "transcript" && originalTranscript ? "transcript-original" : tab });
        setNotice(
          `Saved ${tab === "notes" ? "Markdown notes" : "text transcript"} in Downloads / Echo Meetings.`,
        );
      } else {
        const text = await invoke<string>("export_meeting", {
          id: selected.id,
          format: tab === "transcript" && originalTranscript ? "transcript-original" : tab,
        });
        await invoke("copy_transcript", { text });
        setNotice("Copied.");
      }
    });
  }
  async function beginEdit() {
    if (!selected) return;
    await perform(async () => {
      const text = await invoke<string>("export_meeting", {
        id: selected.id,
        format: "notes",
      });
      setEditTitle(selected.title);
      setEditNotes(text);
      setEditing(true);
    });
  }
  function reference(ids: number[]) {
    return ids.map((id) => {
      const segment = selected?.segments.find((s) => s.id === id);
      return segment ? (
        <button
          key={id}
          className="meeting-reference"
          onClick={() => {
            setTab("transcript");
            requestAnimationFrame(() =>
              document
                .getElementById(`meeting-segment-${id}`)
                ?.scrollIntoView({ block: "center", behavior: "smooth" }),
            );
          }}
          aria-label={`View transcript at ${meetingTime(segment.startMs)}`}
        >
          {meetingTime(segment.startMs)}
        </button>
      ) : null;
    });
  }
  function points(title: string, items: NotePoint[]) {
    return items.length > 0 ? (
      <section className="meeting-note-section">
        <h3>{title}</h3>
        <ul>
          {items.map((item, index) => (
            <li key={index}>
              <span>{item.text}</span>
              <span className="meeting-references">
                {reference(item.segmentIds)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  }
  const recording = ["recording", "paused"].includes(status.state),
    working = activeMeeting(status),
    current = selected?.id === status.meetingId;
  const settingsDirty =
    !!readiness &&
    JSON.stringify({ ...settings, mode: readiness.settings.mode }) !==
      JSON.stringify(readiness.settings);
  const savedProvider = readiness?.settings.summaryProvider ?? "local";
  const ready =
    readiness?.supported &&
    readiness.pro &&
    readiness.requirements.length === 0 &&
    !settingsDirty;
  return (
    <div className="meetings-panel">
      <div className="page-heading page-heading--split">
        <div>
          <h2>Meetings</h2>
          <p className="meetings-subtitle">A clear record of what matters.</p>
        </div>
        <div className="meeting-toolbar">
          <span className="meeting-local-badge">
            <Shield size={13} />
            {savedProvider === "local" ? "On-device" : "Your provider"}
          </span>
          <IconButton
            label={
              settingsOpen ? "Close Meetings settings" : "Meetings settings"
            }
            onClick={() => {
              setSettingsOpen((v) => !v);
              setCredential("");
            }}
          >
            <Settings size={18} />
          </IconButton>
        </div>
      </div>
      {error && <Alert tone="warning">{error}</Alert>}
      {notice && (
        <div className="meeting-notice" role="status">
          {notice}
        </div>
      )}
      {!HAS_NATIVE && (
        <Alert tone="info">
          Open Echo’s desktop app to record and manage meetings. Everything is
          processed on your computer by default.
        </Alert>
      )}
      {settingsOpen && (
        <section className="meeting-settings" aria-label="Meetings settings">
          <div className="meeting-setting-header">
            <h3>Processing</h3>
            <span>
              Meeting content stays on this computer unless you choose a
              provider.
            </span>
          </div>
          <label>
            Transcription model
            <select
              value={settings.transcriptionModel}
              onChange={(e) =>
                setSettings({ ...settings, transcriptionModel: e.target.value })
              }
            >
              <option value="auto">
                Automatic · Bark Clean when available, otherwise Whisper
              </option>
              <option value="bark-3-clean">
                Bark 3 Clean · Apple Silicon, macOS 15+
              </option>
              <option value="small">Whisper Small</option>
              <option value="medium">Whisper Medium</option>
            </select>
          </label>
          <label>
            Generate meeting notes
            <select
              value={settings.summaryProvider}
              onChange={(e) => {
                setSettings({
                  ...settings,
                  summaryProvider: e.target
                    .value as MeetingSettings["summaryProvider"],
                  cloudConsent: false,
                });
                setCredential("");
              }}
            >
              {Object.entries(PROVIDERS).map(([id, label]) => (
                <option value={id} key={id}>
                  {label}
                  {id !== "local" ? " · your API key" : " · Qwen3.5-4B"}
                </option>
              ))}
            </select>
          </label>
          {settings.summaryProvider !== "local" ? (
            <div className="meeting-provider-key">
              <p>
                Your transcript will be sent directly to{" "}
                {PROVIDERS[settings.summaryProvider]} to create notes. Audio
                stays local. You pay the provider; its data policies apply.
              </p>
              <label>
                API key
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  placeholder={
                    readiness?.keys[settings.summaryProvider]
                      ? "Key saved securely · enter a replacement"
                      : "Enter your provider API key"
                  }
                />
              </label>
              <div className="meeting-toolbar">
                <Button
                  disabled={!credential.trim() || busy || !readiness?.pro}
                  onClick={() =>
                    void perform(async () => {
                      await invoke("save_meeting_provider_key", {
                        provider: settings.summaryProvider,
                        key: credential,
                      });
                      setCredential("");
                      await refreshReadiness();
                      setNotice(
                        "Key saved in secure storage. Select the provider and save to enable cloud notes.",
                      );
                    })
                  }
                >
                  Save key
                </Button>
                <Button
                  disabled={busy || !readiness?.keys[settings.summaryProvider]}
                  onClick={() =>
                    void perform(async () => {
                      await invoke("test_meeting_provider", {
                        provider: settings.summaryProvider,
                      });
                      setNotice(
                        "Connection verified. This test sent no meeting content.",
                      );
                    })
                  }
                >
                  Test connection
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || !readiness?.keys[settings.summaryProvider]}
                  onClick={() =>
                    void perform(async () => {
                      await invoke("save_meeting_provider_key", {
                        provider: settings.summaryProvider,
                        key: "",
                      });
                      await refreshReadiness();
                      setNotice("Provider key removed.");
                    })
                  }
                >
                  Remove key
                </Button>
              </div>
              <label className="meeting-consent">
                <input
                  type="checkbox"
                  checked={settings.cloudConsent}
                  onChange={(e) =>
                    setSettings({ ...settings, cloudConsent: e.target.checked })
                  }
                />
                Use my API key to send meeting transcripts to this provider for
                notes.
              </label>
            </div>
          ) : (
            <p className="meeting-settings-help">
              Qwen3.5-4B runs locally. After downloading the models and
              verifying Pro once, Meetings works offline. 8 GB memory
              recommended; 16 GB provides more headroom.
            </p>
          )}
          <div className="meeting-model">
            <div>
              <strong>Local notes model</strong>
              <span>Qwen3.5-4B · 2.74 GB · English meeting notes</span>
            </div>
            {readiness?.notesModel.downloaded ? (
              <div className="meeting-toolbar">
                <Button
                  size="sm"
                  disabled={busy || working}
                  onClick={() => void modelAction(NOTES_MODEL, "verify")}
                >
                  Verify
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || working}
                  onClick={() => void modelAction(NOTES_MODEL, "remove")}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                disabled={busy || working || !HAS_NATIVE || !readiness?.notesModel.supported}
                onClick={() => void modelAction(NOTES_MODEL, "download")}
              >
                {download?.id === NOTES_MODEL
                  ? `${Math.floor(download.percentage)}%${download.percentage >= 100 ? " · verifying" : ""}`
                  : "Download"}
              </Button>
            )}
          </div>
          {!readiness?.transcriptionModel && (
            <div className="meeting-model">
              <div>
                <strong>Whisper Small</strong>
                <span>Local transcription on Mac and Windows · 488 MB</span>
              </div>
              <Button
                size="sm"
                disabled={busy || working || !HAS_NATIVE}
                onClick={() => void modelAction("small", "download")}
              >
                {download?.id === "small"
                  ? `${Math.floor(download.percentage)}%`
                  : "Download"}
              </Button>
            </div>
          )}
          <div className="meeting-settings-footer">
            <span>
              {readiness?.offlineLicense
                ? "Offline Pro licence verified."
                : "Verify your Pro purchase online once to enable offline access."}
            </span>
            <Button
              variant="primary"
              disabled={
                busy ||
                !readiness?.pro ||
                (settings.summaryProvider !== "local" &&
                  (!settings.cloudConsent ||
                    !readiness.keys[settings.summaryProvider]))
              }
              onClick={() => void saveSettings()}
            >
              Save settings
            </Button>
          </div>
        </section>
      )}
      <section
        className={`meeting-recorder${working ? " meeting-recorder--active" : ""}`}
        aria-label="Meeting recording"
      >
        <div className="meeting-recorder-icon">
          {settings.mode === "online" ? (
            <Monitor size={22} />
          ) : (
            <Users size={22} />
          )}
        </div>
        <div className="meeting-recording-main">
          <strong>
            {working
              ? status.state === "paused"
                ? "Meeting paused"
                : status.state === "summarizing"
                  ? "Creating meeting notes"
                  : status.state === "transcribing"
                    ? "Finishing transcript"
                    : status.state === "starting"
                      ? "Starting recorder"
                      : "Recording meeting"
              : "Capture your next meeting"}
          </strong>
          {working ? (
            <span className="meeting-clock">
              {meetingTime(status.durationMs)}
              {status.state === "summarizing" && status.sections > 0
                ? ` · Section ${status.section} of ${status.sections}`
                : " · Up to 4 hours"}
            </span>
          ) : (
            <span>
              English · system default microphone
              {settings.mode === "online" ? " + computer audio" : ""} ·
              temporary audio deleted after transcription
            </span>
          )}
          {recording && (
            <div className="meeting-levels">
              <label>
                Microphone
                <meter min={0} max={1} value={status.microphoneLevel} />
              </label>
              {settings.mode === "online" && (
                <label>
                  Computer
                  <meter min={0} max={1} value={status.computerLevel} />
                </label>
              )}
            </div>
          )}
          {recording && status.durationMs >= 14_100_000 && (
            <span className="meeting-limit-warning">
              Five minutes remain. Echo will stop and save at four hours.
            </span>
          )}
        </div>
        <div className="meeting-recording-actions">
          {working ? (
            recording ? (
              <>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void control(status.state === "paused" ? "resume" : "pause")
                  }
                >
                  {status.state === "paused" ? "Resume" : "Pause"}
                </Button>
                <Button
                  variant="primary"
                  icon={<Square size={13} />}
                  disabled={busy}
                  onClick={() => void control("stop")}
                >
                  Stop
                </Button>
              </>
            ) : (
              <div className="meeting-toolbar">
                <span className="meeting-processing" role="status">
                  {status.state === "starting"
                    ? "Check permissions…"
                    : savedProvider === "local"
                      ? "Working locally…"
                      : `Creating notes with ${PROVIDERS[savedProvider]}…`}
                </span>
                {status.state !== "starting" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void perform(() => invoke("cancel_meeting_processing"))
                    }
                  >
                    Stop processing
                  </Button>
                )}
              </div>
            )
          ) : (
            <>
              <select
                aria-label="Meeting recording mode"
                value={settings.mode}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    mode: e.target.value as MeetingSettings["mode"],
                  })
                }
              >
                <option value="online">Online meeting</option>
                <option value="in-person">In-person meeting</option>
              </select>
              <Button
                variant="primary"
                icon={<Mic size={15} />}
                disabled={busy || !ready || !HAS_NATIVE}
                onClick={() => void start()}
              >
                Record meeting
              </Button>
            </>
          )}
        </div>
      </section>
      {readiness && !working && readiness.requirements.length > 0 && (
        <div className="meeting-readiness">
          <span>{readiness.requirements[0]}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!readiness.pro && onAccount) onAccount();
              else setSettingsOpen(true);
            }}
          >
            {readiness.pro ? "Set up Meetings" : "Unlock Echo Pro"}
          </Button>
        </div>
      )}
      {settings.mode === "online" && !working && (
        <p className="meeting-capture-hint">
          Online mode records audio played through the computer. Headphones give
          the clearest result. Make sure everyone knows you’re recording.
        </p>
      )}
      <section className="meetings-workspace" aria-label="Saved meetings">
        <aside className="meeting-list">
          <label className="meeting-search">
            <Search size={16} />
            <input
              aria-label="Search meetings"
              type="search"
              placeholder="Search meetings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="meeting-list-items">
            {meetings.map((meeting) => (
              <button
                className={`meeting-list-item${selectedId === meeting.id ? " is-selected" : ""}`}
                key={meeting.id}
                onClick={() => setSelectedId(meeting.id)}
              >
                <span className="meeting-list-title">{meeting.title}</span>
                <span>
                  {new Date(meeting.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}{" "}
                  · {meetingTime(meeting.durationMs)}
                </span>
                <span className="meeting-list-state">
                  {meeting.state === "ready"
                    ? "Notes ready"
                    : meeting.state === "failed" ||
                        meeting.state === "interrupted"
                      ? "Needs attention"
                      : meeting.state}
                </span>
              </button>
            ))}
            {!meetings.length && (
              <div className="meeting-list-empty">
                {loading
                  ? "Loading meetings…"
                  : query
                    ? "No matching meetings"
                    : "Your meetings will appear here."}
              </div>
            )}
          </div>
        </aside>
        <article className="meeting-detail">
          {selected ? (
            <>
              <div className="meeting-detail-heading">
                <div>
                  {renaming ? (
                    <form
                      className="meeting-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void perform(async () => {
                          await invoke("update_meeting", {
                            id: selected.id,
                            title: editTitle,
                            notes: selected.editedNotes,
                          });
                          setRenaming(false);
                          await refreshSelected();
                          await refreshList();
                        });
                      }}
                    >
                      <label
                        className="visually-hidden"
                        htmlFor="meeting-rename-title"
                      >
                        Meeting title
                      </label>
                      <input
                        id="meeting-rename-title"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        autoFocus
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={busy || !editTitle.trim()}
                      >
                        Save
                      </Button>
                      <Button size="sm" onClick={() => setRenaming(false)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <h3>{selected.title}</h3>
                  )}
                  <span>
                    {new Date(selected.createdAt).toLocaleString()} ·{" "}
                    {meetingTime(selected.durationMs)}
                  </span>
                </div>
                <div className="meeting-toolbar">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditTitle(selected.title);
                      setRenaming(true);
                    }}
                  >
                    Rename
                  </Button>
                  <IconButton
                    label="Copy current view"
                    disabled={busy}
                    onClick={() => void copyOrExport(false)}
                  >
                    <Copy size={16} />
                  </IconButton>
                  <IconButton
                    label="Export current view to Downloads"
                    disabled={busy}
                    onClick={() => void copyOrExport(true)}
                  >
                    <FileText size={16} />
                  </IconButton>
                  <IconButton
                    label="Delete meeting"
                    tone="danger"
                    disabled={busy}
                    onClick={() => setDeleteId(selected.id)}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </div>
              {deleteId === selected.id && (
                <div className="meeting-delete-confirm" role="alert">
                  <span>
                    Delete this meeting, its notes, transcript, and remaining
                    temporary audio?
                  </span>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await invoke("delete_meeting", { id: selected.id });
                        selectedRef.current = null;
                        setSelected(null);
                        setSelectedId(null);
                        setDeleteId(null);
                        await refreshList();
                      })
                    }
                  >
                    Delete meeting
                  </Button>
                  <Button size="sm" onClick={() => setDeleteId(null)}>
                    Cancel
                  </Button>
                </div>
              )}
              <div className="meeting-detail-nav">
                <div role="tablist" aria-label="Meeting views">
                  <button
                    role="tab"
                    aria-selected={tab === "notes"}
                    onClick={() => setTab("notes")}
                  >
                    Notes
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "transcript"}
                    onClick={() => setTab("transcript")}
                  >
                    Transcript
                  </button>
                </div>
                <span>
                  {PROVIDERS[selected.provider as keyof typeof PROVIDERS] ??
                    "On-device"}
                </span>
              </div>
              {selected.error && (
                <div className="meeting-recovery">
                  <p>{selected.error}</p>
                  <div className="meeting-toolbar">
                    <Button
                      size="sm"
                      disabled={
                        busy || working || settingsDirty || !readiness?.pro
                      }
                      onClick={() =>
                        void perform(async () => {
                          await invoke("regenerate_meeting_notes", {
                            id: selected.id,
                            recover: true,
                          });
                        })
                      }
                    >
                      Recover & create notes
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || working}
                      onClick={() =>
                        void perform(async () => {
                          await invoke("discard_meeting_recording", {
                            id: selected.id,
                          });
                          await refreshSelected();
                        })
                      }
                    >
                      Discard unprocessed audio
                    </Button>
                  </div>
                </div>
              )}
              <div className="meeting-detail-body">
                {tab === "transcript" ? (
                  <>
                    <p className="meeting-transcript-label">
                      {selected.model === "bark-3-clean"
                        ? "Bark Clean transcription · fillers and false starts removed"
                        : "Whisper transcription"}
                      . Source labels distinguish microphone and computer audio,
                      not individual people.
                    </p>
                    <label className="meeting-original-toggle">
                      <input
                        type="checkbox"
                        checked={originalTranscript}
                        onChange={(e) =>
                          setOriginalTranscript(e.target.checked)
                        }
                      />
                      Show original ASR output, including possible playback echo
                    </label>
                    {(originalTranscript
                      ? selected.segments
                      : selected.transcript
                    )
                      .filter((s) => s.text.trim())
                      .map((segment) => (
                        <section
                          id={`meeting-segment-${segment.id}`}
                          className="meeting-segment"
                          key={segment.id}
                        >
                          <div>
                            <time>{meetingTime(segment.startMs)}</time>
                            <span>
                              {segment.source === "computer"
                                ? "Computer audio"
                                : "Microphone"}
                            </span>
                          </div>
                          <p>{segment.text}</p>
                        </section>
                      ))}
                    {!selected.segments.some((s) => s.text.trim()) && (
                      <div className="meeting-detail-empty">
                        <FileText size={25} />
                        <p>
                          {current && working
                            ? "The transcript will appear as recording segments are processed."
                            : "No speech has been transcribed."}
                        </p>
                      </div>
                    )}
                  </>
                ) : editing ? (
                  <div className="meeting-editor">
                    <label>
                      Meeting title
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                      />
                    </label>
                    <label>
                      Notes · Markdown
                      <textarea
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        rows={18}
                      />
                    </label>
                    <div className="meeting-toolbar">
                      <Button
                        variant="primary"
                        disabled={busy || !editTitle.trim()}
                        onClick={() =>
                          void perform(async () => {
                            await invoke("update_meeting", {
                              id: selected.id,
                              title: editTitle,
                              notes: editNotes,
                            });
                            setEditing(false);
                            await refreshSelected();
                            await refreshList();
                          })
                        }
                      >
                        Save notes
                      </Button>
                      <Button onClick={() => setEditing(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : selected.notes ? (
                  <>
                    {selected.editedNotes !== null ? (
                      <div className="meeting-markdown">
                        <ReactMarkdown>{selected.editedNotes}</ReactMarkdown>
                      </div>
                    ) : (
                      <>
                        <div className="meeting-overview">
                          <h4>Overview</h4>
                          <p>{selected.notes.overview}</p>
                          <span className="meeting-references">
                            {reference(selected.notes.overviewSegmentIds)}
                          </span>
                        </div>
                        {points("Discussion", selected.notes.discussionPoints)}
                        {points("Decisions", selected.notes.decisions)}
                        {selected.notes.actionItems.length > 0 && (
                          <section className="meeting-note-section">
                            <h3>Action items</h3>
                            <ul>
                              {selected.notes.actionItems.map(
                                (action, index) => (
                                  <li key={index}>
                                    <span>{action.text}</span>
                                    {(action.owner || action.deadline) && (
                                      <small>
                                        {action.owner ?? "Owner not specified"}
                                        {action.deadline
                                          ? ` · ${action.deadline}`
                                          : ""}
                                      </small>
                                    )}
                                    <span className="meeting-references">
                                      {reference(action.segmentIds)}
                                    </span>
                                  </li>
                                ),
                              )}
                            </ul>
                          </section>
                        )}
                        {points("Open questions", selected.notes.openQuestions)}
                      </>
                    )}
                    <div className="meeting-notes-actions">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void beginEdit()}
                      >
                        Edit notes
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          busy || working || settingsDirty || !readiness?.pro
                        }
                        onClick={() =>
                          void perform(async () => {
                            await invoke("regenerate_meeting_notes", {
                              id: selected.id,
                              recover: false,
                            });
                          })
                        }
                      >
                        Regenerate
                        {savedProvider !== "local"
                          ? ` with ${PROVIDERS[savedProvider]}`
                          : " on-device"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="meeting-detail-empty">
                    <Shield size={27} />
                    <h4>
                      {current && working
                        ? "Your meeting is being captured"
                        : "Your transcript is saved"}
                    </h4>
                    <p>
                      {current && working
                        ? "Stop recording to create an overview, decisions, action items, and open questions."
                        : "Create notes from the transcript using the processing option you selected."}
                    </p>
                    {!working &&
                      selected.segments.some((s) => s.text.trim()) && (
                        <Button
                          disabled={busy || settingsDirty || !readiness?.pro}
                          onClick={() =>
                            void perform(() =>
                              invoke("regenerate_meeting_notes", {
                                id: selected.id,
                                recover: false,
                              }),
                            )
                          }
                        >
                          Create notes
                        </Button>
                      )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="meeting-detail-empty meeting-detail-empty--library">
              <Users size={34} />
              <h3>Your meetings, remembered.</h3>
              <p>
                Record a meeting to keep the discussion, decisions, and next
                steps together. Notes and transcripts stay on this computer.
              </p>
              <button
                className="meeting-setup-link"
                onClick={() => setSettingsOpen(true)}
              >
                Set up local meeting notes
              </button>
            </div>
          )}
        </article>
      </section>
      {settingsOpen && (
        <button
          className="meeting-settings-close"
          onClick={() => setSettingsOpen(false)}
        >
          <X size={14} />
          Close settings
        </button>
      )}
    </div>
  );
}
