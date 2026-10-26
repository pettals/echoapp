import { invoke } from "@tauri-apps/api/core";
import { supabase } from "./auth";
export const HAS_NATIVE =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const NOTES_MODEL = "qwen-3.5-4b-notes";
export type MeetingProvider = "local" | "openai" | "gemini" | "anthropic";
export interface MeetingSettings {
  transcriptionModel: string;
  summaryProvider: MeetingProvider;
  mode: "online" | "in-person";
  cloudConsent: boolean;
}
export interface MeetingSegment {
  id: number;
  startMs: number;
  endMs: number;
  source: string;
  text: string;
}
export interface NotePoint {
  text: string;
  segmentIds: number[];
}
export interface MeetingNotes {
  title: string;
  overview: string;
  overviewSegmentIds: number[];
  discussionPoints: NotePoint[];
  decisions: NotePoint[];
  actionItems: (NotePoint & {
    owner: string | null;
    deadline: string | null;
  })[];
  openQuestions: NotePoint[];
}
export interface Meeting {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  mode: string;
  model: string;
  state: string;
  error: string | null;
  notes: MeetingNotes | null;
  editedNotes: string | null;
  provider: string;
  segments: MeetingSegment[];
  transcript: MeetingSegment[];
}
export interface MeetingStatus {
  provider?:MeetingProvider;
  meetingId: string | null;
  state: string;
  durationMs: number;
  microphoneLevel: number;
  computerLevel: number;
  section: number;
  sections: number;
  message: string | null;
}
export interface MeetingModelStatus {
  supported: boolean;
  downloaded: boolean;
  downloading: boolean;
  expected_size_bytes: number;
  integrity_checked: boolean;
  integrity_error: string | null;
}
export interface MeetingReadiness {
  supported: boolean;
  pro: boolean;
  offlineLicense: boolean;
  settings: MeetingSettings;
  transcriptionModel: string | null;
  notesModel: MeetingModelStatus;
  keys: Record<string, boolean>;
  busy: boolean;
  requirements: string[];
}
export const PROVIDERS: Record<MeetingProvider, string> = {
  local: "On-device",
  openai: "OpenAI",
  gemini: "Google Gemini",
  anthropic: "Anthropic (Claude)",
};
export function meetingError(error: unknown): string {
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "Meetings could not complete that action. Try again.";
}
export function meetingTime(ms: number) {
  const secs = Math.floor(ms / 1000);
  return `${Math.floor(secs / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((secs / 60) % 60)
    .toString()
    .padStart(2, "0")}:${(secs % 60).toString().padStart(2, "0")}`;
}
export function activeMeeting(status: MeetingStatus | null) {
  return (
    !!status &&
    ["starting", "recording", "paused", "transcribing", "summarizing"].includes(
      status.state,
    )
  );
}
export const EMPTY_MEETING_STATUS: MeetingStatus = {
  meetingId: null,
  state: "idle",
  durationMs: 0,
  microphoneLevel: 0,
  computerLevel: 0,
  section: 0,
  sections: 0,
  message: null,
};
export async function refreshMeetingLicense(userId: string, token: string) {
  // Licensing contains account metadata only. No meeting content is ever sent here.
  if (!HAS_NATIVE) return;
  const { data, error } = await supabase.functions.invoke(
    "get-meetings-license",
    { headers: { Authorization: `Bearer ${token}` }, body: {} },
  );
  if (error || !data || data.userId !== userId) return;
  if (data.active === false) {
    await invoke("revoke_meeting_license", { userId });
  } else if (data.active === true && data.license) {
    await invoke("cache_meeting_license", { userId, license: data.license });
  }
}
