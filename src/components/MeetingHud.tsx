import { invoke } from "@tauri-apps/api/core";
import { Users, Square, FileText } from "./AureoleIcons";
import { meetingTime, type MeetingStatus } from "../meetings";
import "./MeetingHud.css";
export default function MeetingHud({
  status,
  onError,
}: {
  status: MeetingStatus;
  onError: (error: unknown) => void;
}) {
  const recording = status.state === "recording" || status.state === "paused";
  async function control(command: string) {
    try {
      await invoke("control_meeting", { command });
    } catch (e) {
      onError(e);
    }
  }
  return (
    <div
      className="meeting-hud"
      role="region"
      aria-label="Meeting recording controls"
    >
      <button
        className="meeting-hud__library"
        aria-label="Open Meetings"
        onClick={() => void invoke("show_meetings").catch(onError)}
      >
        <Users size={19} />
      </button>
      <div className="meeting-hud__content">
        <span>
          {status.state === "paused"
            ? "Meeting paused"
            : status.state === "recording"
              ? "Recording meeting"
              : status.state === "summarizing"
                ? "Creating meeting notes"
                : status.state === "starting"
                  ? "Starting meeting"
                  : "Finishing transcript"}
        </span>
        <strong>{meetingTime(status.durationMs)}</strong>
        {recording && (
          <meter
            aria-label="Meeting audio level"
            min={0}
            max={1}
            value={Math.max(status.microphoneLevel, status.computerLevel)}
          />
        )}
      </div>
      {recording ? (
        <>
          <button
            className="meeting-hud__pause"
            onClick={() =>
              void control(status.state === "paused" ? "resume" : "pause")
            }
          >
            {status.state === "paused" ? "Resume" : "Pause"}
          </button>
          <button
            className="meeting-hud__stop"
            aria-label="Stop meeting and create notes"
            onClick={() => void control("stop")}
          >
            <Square size={16} />
          </button>
        </>
      ) : (
        <button
          className="meeting-hud__library"
          aria-label="Review meeting"
          onClick={() => void invoke("show_meetings").catch(onError)}
        >
          <FileText size={18} />
        </button>
      )}
    </div>
  );
}
