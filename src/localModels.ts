export type LocalModelId = "small" | "medium" | "bark-3-clean";

export interface LocalModelDescriptor {
  id: LocalModelId;
  name: string;
  engine: "whisper" | "coreml";
  description: string;
  download_size_bytes: number;
  supported: boolean;
  unsupported_reason: string | null;
  built_in_cleanup: boolean;
  english_only: boolean;
}

// Browser previews cannot establish native capabilities. Tauri supplies the real catalog.
export const PREVIEW_LOCAL_MODELS: LocalModelDescriptor[] = [
  { id: "small", name: "Whisper Small", engine: "whisper", description: "Fastest. Good for everyday dictation.", download_size_bytes: 487_601_967, supported: true, unsupported_reason: null, built_in_cleanup: false, english_only: false },
  { id: "medium", name: "Whisper Medium", engine: "whisper", description: "More accurate. Larger download.", download_size_bytes: 1_533_763_059, supported: true, unsupported_reason: null, built_in_cleanup: false, english_only: false },
  { id: "bark-3-clean", name: "Bark 3 Clean", engine: "coreml", description: "English only. Removes fillers, false starts and repeated words on device.", download_size_bytes: 447_420_698, supported: false, unsupported_reason: "Requires Apple Silicon and macOS 15 or later.", built_in_cleanup: true, english_only: true },
];

export function localModelName(id?: string): string {
  return PREVIEW_LOCAL_MODELS.find((model) => model.id === id)?.name ?? "Local model";
}
