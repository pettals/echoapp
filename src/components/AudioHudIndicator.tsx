import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { AppWindow, Check, Copy, Mic, StickyNote } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import "./AudioHudIndicator.css";

export type AudioHudIndicatorState = "idle" | "recording" | "processing" | "complete" | "copy" | "error";

export interface AudioHudIndicatorProps {
  state: AudioHudIndicatorState;
  expanded?: boolean;
  level?: number;
  errorMessage?: string;
  canConfirm?: boolean;
  completeLabel?: string;
  statusLabel?: string;
  livePlaceholder?: string;
  shortcutLabel?: string;
  notepadLabel?: string;
  copyText?: string;
  liveTranscript?: string;
  liveFinal?: boolean;
  targetIconUrl?: string;
  copyCountdownMs?: number;
  onPrimaryAction?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
  onCopy?: () => void;
  onNotepadAction?: () => void;
}

const WAVEFORM_BARS = [
  0.42, 0.72, 0.54, 0.88, 0.64, 0.96, 0.48, 0.78, 0.58, 0.9, 0.7, 0.52,
  0.84, 0.62, 0.94, 0.46, 0.76, 0.56, 0.86, 0.68, 0.5, 0.8, 0.6, 0.92,
];

const islandSpring = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.82,
} as const;

const actionSpring = {
  type: "spring",
  stiffness: 520,
  damping: 28,
  mass: 0.7,
} as const;

const hudEase = [0.2, 0, 0, 1] as const;
const emphasizedEase = [0.05, 0.7, 0.1, 1] as const;
const exitEase = [0.3, 0, 1, 1] as const;
const idleAnimationDuration = 0.42;
const idleCollapseDuration = idleAnimationDuration * 1.5;
const idleActionRevealDuration = idleAnimationDuration * 0.28;
const idleActionRevealDelay = idleAnimationDuration - idleActionRevealDuration;
const IDLE_COMPACT_WIDTH = 56;
const IDLE_COMPACT_HEIGHT = 14;
const IDLE_EXPANDED_WIDTH = 252;
const IDLE_EXPANDED_HEIGHT = 46;
const RECORDING_WIDTH = 420;
const RECORDING_HEIGHTS: Record<LiveTier, number> = {
  compact: 52,
  short: 86,
  medium: 110,
  long: 132,
};

type IdleAction = "mic" | "notepad";
type LiveTier = "compact" | "short" | "medium" | "long";

function stateLabel(state: AudioHudIndicatorState, completeLabel?: string): string {
  if (state === "complete") return completeLabel ?? "Complete";
  if (state === "copy") return "Copied";
  if (state === "error") return "Needs attention";
  if (state === "processing") return "Processing";
  if (state === "recording") return "Recording";
  return "Ready";
}

function liveTierForWords(wordCount: number): LiveTier {
  if (wordCount === 0) return "compact";
  if (wordCount <= 16) return "short";
  if (wordCount <= 36) return "medium";
  return "long";
}

function maxVisibleWordsForTier(tier: LiveTier): number {
  if (tier === "short") return 24;
  if (tier === "medium") return 46;
  if (tier === "long") return 68;
  return 0;
}

export default function AudioHudIndicator({
  state,
  expanded = false,
  level = 0,
  errorMessage,
  canConfirm = true,
  completeLabel,
  statusLabel,
  livePlaceholder,
  shortcutLabel = "Command + D",
  notepadLabel = "Notepad",
  copyText = "",
  liveTranscript = "",
  liveFinal = false,
  targetIconUrl,
  copyCountdownMs = 0,
  onPrimaryAction,
  onConfirm,
  onCancel,
  onCopy,
  onNotepadAction,
}: AudioHudIndicatorProps) {
  const reduceMotion = useReducedMotion();
  const clampedLevel = Math.min(Math.max(level, 0), 1);
  const label = statusLabel ?? stateLabel(state, completeLabel);
  const [activeAction, setActiveAction] = useState<IdleAction | null>(null);
  const countdownSeconds = Math.ceil(copyCountdownMs / 1000);
  const copyProgress = Math.max(0, Math.min(copyCountdownMs / 5000, 1));
  const liveWords = liveTranscript.trim().split(/\s+/).filter(Boolean);
  const hasLiveTranscript = liveWords.length > 0;
  const liveTier = liveTierForWords(liveWords.length);
  const maxVisibleWords = maxVisibleWordsForTier(liveTier);
  const displayLiveWords =
    hasLiveTranscript && liveWords.length > maxVisibleWords
      ? liveWords.slice(-maxVisibleWords)
      : liveWords;
  const livePlaceholderText = livePlaceholder ?? (state === "processing" ? "Transcribing" : "Listening");
  const idleExpanded = state === "idle" && expanded;
  const visibleAction = idleExpanded ? activeAction : null;
  const islandVariant = state === "idle" ? (idleExpanded ? "idleExpanded" : "idleCollapsed") : state;
  const idleTransition = reduceMotion
    ? { duration: 0.01 }
    : { duration: idleAnimationDuration, ease: hudEase };
  const idleCollapseTransition = reduceMotion
    ? { duration: 0.01 }
    : { duration: idleCollapseDuration, ease: hudEase };
  const idleActionRevealTransition = reduceMotion
    ? { duration: 0.01 }
    : { duration: idleActionRevealDuration, delay: idleActionRevealDelay, ease: hudEase };
  const idleActionItemTransition = reduceMotion
    ? { duration: 0.01 }
    : { duration: idleActionRevealDuration, ease: hudEase };
  const islandVariants: Variants = {
    idleCollapsed: {
      width: IDLE_COMPACT_WIDTH,
      height: IDLE_COMPACT_HEIGHT,
      borderRadius: 999,
      scale: 1,
      transition: reduceMotion
        ? { duration: 0.01 }
        : {
            width: idleCollapseTransition,
            height: idleCollapseTransition,
            borderRadius: idleCollapseTransition,
            scale: { duration: idleCollapseDuration, ease: hudEase },
          },
    },
    idleExpanded: {
      width: IDLE_EXPANDED_WIDTH,
      height: IDLE_EXPANDED_HEIGHT,
      borderRadius: 999,
      scale: 1,
      transition: reduceMotion
        ? { duration: 0.01 }
        : {
            width: idleTransition,
            height: idleTransition,
            borderRadius: idleTransition,
            scale: { duration: idleAnimationDuration, ease: hudEase },
          },
    },
    recording: {
      width: RECORDING_WIDTH,
      height: RECORDING_HEIGHTS[liveTier],
      borderRadius: 26,
      scale: reduceMotion ? 1 : [0.965, 0.992, 1],
      transition: reduceMotion
        ? { duration: 0.01 }
        : {
            width: islandSpring,
            height: islandSpring,
            borderRadius: islandSpring,
            scale: { duration: 0.2, ease: emphasizedEase },
            layout: islandSpring,
          },
    },
    processing: {
      width: RECORDING_WIDTH,
      height: RECORDING_HEIGHTS[liveTier],
      borderRadius: 26,
      scale: reduceMotion ? 1 : [0.985, 0.996, 1],
      transition: reduceMotion
        ? { duration: 0.01 }
        : {
            width: islandSpring,
            height: islandSpring,
            borderRadius: islandSpring,
            scale: { duration: 0.22, ease: hudEase },
            layout: islandSpring,
          },
    },
    complete: {
      width: 132,
      height: 34,
      borderRadius: 999,
      scale: reduceMotion ? 1 : [0.9, 0.985, 1],
      transition: reduceMotion
        ? { duration: 0.01 }
        : {
            width: islandSpring,
            height: islandSpring,
            borderRadius: islandSpring,
            scale: { duration: 0.22, times: [0, 0.72, 1], ease: emphasizedEase },
            layout: islandSpring,
          },
    },
    copy: {
      width: 420,
      height: 92,
      borderRadius: 24,
      scale: reduceMotion ? 1 : [0.975, 0.994, 1],
      transition: reduceMotion
        ? { duration: 0.01 }
        : {
            width: islandSpring,
            height: islandSpring,
            borderRadius: islandSpring,
            scale: { duration: 0.28, ease: hudEase },
            layout: islandSpring,
          },
    },
    error: {
      width: 240,
      height: 72,
      borderRadius: 24,
      scale: reduceMotion ? 1 : [0.982, 1, 0.992, 1],
      transition: reduceMotion
        ? { duration: 0.01 }
        : {
            width: islandSpring,
            height: islandSpring,
            borderRadius: islandSpring,
            scale: { duration: 0.26, ease: hudEase },
            layout: islandSpring,
          },
    },
  };
  const actionGroupVariants: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : 2,
      transition: idleCollapseTransition,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: idleActionItemTransition,
    },
  };
  const actionItemVariants: Variants = {
    hidden: {
      opacity: 0,
      y: reduceMotion ? 0 : 1,
      transition: idleCollapseTransition,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: idleActionRevealTransition,
    },
  };
  const contentIn = reduceMotion
    ? { duration: 0.01 }
    : { duration: 0.16, ease: emphasizedEase };
  const contentOut = reduceMotion
    ? { duration: 0.01 }
    : { duration: 0.1, ease: exitEase };

  useEffect(() => {
    if (!idleExpanded) {
      setActiveAction(null);
    }
  }, [idleExpanded]);

  const handleButtonClick = (event: MouseEvent<HTMLButtonElement>, action?: () => void) => {
    event.stopPropagation();
    action?.();
  };

  const renderShortcutLabel = (action: IdleAction, text: string) => (
    <AnimatePresence initial={false}>
      {visibleAction === action ? (
        <motion.span
          key={`${action}-label`}
          className="audio-hud__shortcut-label"
          initial={{ opacity: 0, y: 3, scale: reduceMotion ? 1 : 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 3, scale: reduceMotion ? 1 : 0.96 }}
          transition={reduceMotion ? { duration: 0.01 } : { duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {text}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );

  const handleIslandClick = () => {
    if (state === "recording" && canConfirm) {
      onConfirm?.();
      return;
    }

    if (state === "complete" || state === "copy" || state === "error") {
      onCancel?.();
    }
  };

  return (
    <motion.div
      className={`audio-hud audio-hud--${state}${idleExpanded ? " audio-hud--expanded" : ""}`}
      aria-label={`Dictation ${label.toLowerCase()}`}
      role="group"
      tabIndex={0}
      onClick={handleIslandClick}
      layout={state !== "idle"}
      transition={{
        layout: state === "idle" && !idleExpanded ? idleCollapseTransition : reduceMotion ? { duration: 0.01 } : islandSpring,
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onCancel) {
          event.preventDefault();
          onCancel();
        }
        if ((event.key === "Enter" || event.key === " ") && state === "recording") {
          event.preventDefault();
          if (canConfirm) onConfirm?.();
        }
      }}
    >
      <motion.div
        className="audio-hud__island"
        layout={state !== "idle"}
        variants={islandVariants}
        animate={islandVariant}
        initial={false}
        style={{ originX: 0.5, originY: state === "idle" ? 1 : 0.5 }}
      >
        <AnimatePresence initial={false}>
          {state === "idle" && !expanded ? (
            <motion.span
              key="idle-collapsed"
              className="audio-hud__compact-mark"
              aria-hidden
              initial={{ opacity: 0.86, scaleX: 0.92 }}
              animate={{ opacity: 1, scaleX: 1 }}
              exit={{ opacity: 0, scaleX: 0.92 }}
              transition={{ duration: 0.12 }}
            />
          ) : null}

          {state === "idle" && expanded ? (
            <motion.div
              key="idle-expanded"
              className="audio-hud__idle-actions"
              variants={actionGroupVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
            >
              <motion.button
                className="audio-hud__action audio-hud__action--mic"
                type="button"
                aria-label={`Start dictation with ${shortcutLabel}`}
                onClick={(event) => handleButtonClick(event, onPrimaryAction)}
                onPointerEnter={() => setActiveAction("mic")}
                onPointerLeave={() => setActiveAction((current) => (current === "mic" ? null : current))}
                onFocus={() => setActiveAction("mic")}
                onBlur={() => setActiveAction((current) => (current === "mic" ? null : current))}
                variants={actionItemVariants}
                whileTap={reduceMotion ? undefined : { scale: 0.94 }}
              >
                {renderShortcutLabel("mic", shortcutLabel)}
                <span className="audio-hud__action-circle">
                  <Mic size={17} strokeWidth={2.6} />
                </span>
              </motion.button>

              <motion.span className="audio-hud__center-divider" aria-hidden variants={actionItemVariants} />

              <motion.button
                className="audio-hud__action audio-hud__action--notepad"
                type="button"
                aria-label="Open Notepad"
                onClick={(event) => handleButtonClick(event, onNotepadAction)}
                onPointerEnter={() => setActiveAction("notepad")}
                onPointerLeave={() => setActiveAction((current) => (current === "notepad" ? null : current))}
                onFocus={() => setActiveAction("notepad")}
                onBlur={() => setActiveAction((current) => (current === "notepad" ? null : current))}
                variants={actionItemVariants}
                whileTap={reduceMotion ? undefined : { scale: 0.94 }}
              >
                {renderShortcutLabel("notepad", notepadLabel)}
                <span className="audio-hud__action-circle">
                  <StickyNote size={17} strokeWidth={2.5} />
                </span>
              </motion.button>
            </motion.div>
          ) : null}

          {state === "recording" || state === "processing" ? (
            <motion.div
              key="live-transcript"
              className={`audio-hud__live audio-hud__live--${liveTier}${liveFinal ? " audio-hud__live--final" : ""}`}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 2, scale: reduceMotion ? 1 : 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : -2, scale: reduceMotion ? 1 : 0.96 }}
              transition={contentIn}
            >
              <span
                className={`audio-hud__target-icon${targetIconUrl ? " audio-hud__target-icon--image" : ""}`}
                aria-hidden
              >
                {targetIconUrl ? <img src={targetIconUrl} alt="" /> : <AppWindow size={17} strokeWidth={2.35} />}
              </span>
              <p className="audio-hud__live-text" aria-live="polite">
                <AnimatePresence initial={false} mode="wait">
                  {hasLiveTranscript ? (
                    <motion.span
                      key="transcript"
                      className="audio-hud__live-transcript"
                      initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: reduceMotion ? 0 : -3 }}
                      transition={reduceMotion ? { duration: 0.01 } : { duration: 0.16, ease: emphasizedEase }}
                    >
                      {displayLiveWords.map((word, index) => (
                        <motion.span
                          key={`${word}-${index}`}
                          className="audio-hud__live-word"
                          initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={reduceMotion ? { duration: 0.01 } : { duration: 0.14, ease: emphasizedEase }}
                        >
                          {word}
                        </motion.span>
                      ))}
                    </motion.span>
                  ) : (
                    <motion.span
                      key="placeholder"
                      className="audio-hud__live-placeholder"
                      initial={{ opacity: 0, y: reduceMotion ? 0 : 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: reduceMotion ? 0 : -3 }}
                      transition={reduceMotion ? { duration: 0.01 } : { duration: 0.14, ease: hudEase }}
                    >
                      {livePlaceholderText}
                    </motion.span>
                  )}
                </AnimatePresence>
              </p>
              <div className="audio-hud__waveform audio-hud__waveform--mini" aria-hidden>
                {WAVEFORM_BARS.slice(0, 12).map((bar, index) => {
                  const responsiveLevel =
                    state === "recording" ? 0.18 + clampedLevel * bar : 0.28 + bar * 0.34;
                  const height = Math.round(4 + Math.min(responsiveLevel, 1) * 14);
                  return (
                    <span
                      key={`${bar}-${index}`}
                      className="audio-hud__bar"
                      style={
                        {
                          "--bar-height": `${height}px`,
                          "--bar-scale": `${0.68 + bar * 0.55}`,
                          "--bar-delay": `${index * 32}ms`,
                        } as CSSProperties
                      }
                    />
                  );
                })}
              </div>
            </motion.div>
          ) : null}

          {state === "complete" ? (
            <motion.span
              key="complete"
              className="audio-hud__success"
              aria-label={completeLabel ?? "Complete"}
              initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.76, rotate: reduceMotion ? 0 : -8 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.9 }}
              transition={reduceMotion ? { duration: 0.01 } : actionSpring}
            >
              <Check size={15} strokeWidth={3} />
            </motion.span>
          ) : null}

          {state === "copy" ? (
            <motion.div
              key="copy"
              className="audio-hud__copy-review"
              role="status"
              initial="hidden"
              animate="visible"
              exit="hidden"
              variants={{
                hidden: { opacity: 0, y: reduceMotion ? 0 : 4 },
                visible: {
                  opacity: 1,
                  y: 0,
                  transition: reduceMotion
                    ? { duration: 0.01 }
                    : { duration: 0.16, ease: hudEase, when: "beforeChildren", staggerChildren: 0.035 },
                },
              }}
            >
              <motion.p
                className="audio-hud__copy-text"
                variants={{
                  hidden: { opacity: 0, x: reduceMotion ? 0 : -5 },
                  visible: { opacity: 1, x: 0, transition: contentIn },
                }}
              >
                {copyText}
              </motion.p>
              <motion.button
                className="audio-hud__copy-button"
                type="button"
                aria-label="Copy transcript"
                onClick={(event) => handleButtonClick(event, onCopy)}
                variants={{
                  hidden: { opacity: 0, scale: reduceMotion ? 1 : 0.86 },
                  visible: { opacity: 1, scale: 1, transition: reduceMotion ? { duration: 0.01 } : actionSpring },
                }}
                whileTap={reduceMotion ? undefined : { scale: 0.92 }}
              >
                <Copy size={15} strokeWidth={2.4} />
              </motion.button>
              <motion.span
                className="audio-hud__countdown"
                style={{ "--copy-progress": copyProgress } as CSSProperties}
                aria-label={`${countdownSeconds} seconds remaining`}
                variants={{
                  hidden: { opacity: 0, scale: reduceMotion ? 1 : 0.86 },
                  visible: { opacity: 1, scale: 1, transition: reduceMotion ? { duration: 0.01 } : actionSpring },
                }}
              >
                {countdownSeconds}
              </motion.span>
            </motion.div>
          ) : null}

          {state === "error" && errorMessage ? (
            <motion.p
              key="error"
              className="audio-hud__error"
              role="status"
              initial={{ opacity: 0, y: reduceMotion ? 0 : 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : 3 }}
              transition={state === "error" ? contentIn : contentOut}
            >
              {errorMessage}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
