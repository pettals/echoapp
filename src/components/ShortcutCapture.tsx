import type { KeyboardEvent } from "react";
import "./ShortcutCapture.css";

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

type ShortcutPlatform = "macos" | "windows";

const FUNCTION_KEY_SHORTCUTS = Array.from(
  { length: 24 },
  (_, index) => `F${index + 1}`,
);

function normalizeShortcutKey(key: string): string {
  if (key === " ") return "Space";
  if (key.startsWith("Arrow")) return key.replace("Arrow", "");
  if (key === "Esc") return "Escape";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function acceleratorFromKeyboardEvent(
  event: KeyboardEvent<HTMLInputElement>,
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("CommandOrControl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  const key = normalizeShortcutKey(event.key);
  if (!parts.includes(key)) parts.push(key);

  return parts.join("+");
}

function selectedFunctionKey(shortcut: string): string {
  const normalized = shortcut.trim().toUpperCase();
  return /^F(?:[1-9]|1\d|2[0-4])$/.test(normalized) ? normalized : "";
}

interface ShortcutCaptureProps {
  className?: string;
  displayValue?: string;
  id?: string;
  invalid?: boolean;
  onBlur?: () => void;
  onCancel?: () => void;
  onCapture: (shortcut: string) => void;
  onFocus?: () => void;
  onIncomplete?: () => void;
  platform: ShortcutPlatform;
  value: string;
}

export default function ShortcutCapture({
  className = "",
  displayValue,
  id,
  invalid = false,
  onBlur,
  onCancel,
  onCapture,
  onFocus,
  onIncomplete,
  platform,
  value,
}: ShortcutCaptureProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape" && onCancel) {
      event.currentTarget.blur();
      onCancel();
      return;
    }

    const accelerator = acceleratorFromKeyboardEvent(event);
    if (!accelerator) {
      onIncomplete?.();
      return;
    }

    onCapture(accelerator);
  };

  const invalidClass = invalid ? " ui-input--error" : "";

  return (
    <div className={`shortcut-capture ${className}`.trim()}>
      <div className="shortcut-capture__controls">
        <input
          aria-invalid={invalid}
          aria-label="Global shortcut"
          className={`ui-input shortcut-capture__input${invalidClass}`}
          id={id}
          onBlur={onBlur}
          onFocus={onFocus}
          onKeyDown={handleKeyDown}
          readOnly
          value={displayValue ?? value}
        />
        <select
          aria-invalid={invalid}
          aria-label="Choose a function key shortcut"
          className={`ui-select shortcut-capture__function-key${invalidClass}`}
          onBlur={onBlur}
          onChange={(event) => {
            if (event.target.value) onCapture(event.target.value);
          }}
          onFocus={onFocus}
          value={selectedFunctionKey(value)}
        >
          <option value="">F key…</option>
          {FUNCTION_KEY_SHORTCUTS.map((functionKey) => (
            <option key={functionKey} value={functionKey}>
              {functionKey}
            </option>
          ))}
        </select>
      </div>
      {platform === "macos" && (
        <span className="shortcut-capture__guidance">
          For top-row keys, hold Fn/Globe unless standard function keys are enabled in macOS.
        </span>
      )}
    </div>
  );
}
