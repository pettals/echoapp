import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { motion, useReducedMotion } from "motion/react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  icon?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

export function Button({
  children,
  className = "",
  fullWidth = false,
  icon,
  size = "md",
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button--${variant} ui-button--${size}${fullWidth ? " ui-button--full" : ""} ${className}`.trim()}
      type={type}
      {...props}
    >
      {icon && <span className="ui-button__icon">{icon}</span>}
      <span>{children}</span>
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  label: string;
  tone?: "neutral" | "danger";
}

export function IconButton({
  children,
  className = "",
  label,
  tone = "neutral",
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={`ui-icon-button ui-icon-button--${tone} ${className}`.trim()}
      data-no-window-drag
      title={label}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}

interface CardProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export function Card({ children, className = "", ...props }: CardProps) {
  return (
    <section className={`ui-card ${className}`.trim()} {...props}>
      {children}
    </section>
  );
}

interface ChipProps {
  children: ReactNode;
  icon?: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "error";
}

export function Chip({ children, icon, tone = "neutral" }: ChipProps) {
  return (
    <span className={`ui-chip ui-chip--${tone}`}>
      {icon && <span className="ui-chip__icon">{icon}</span>}
      <span>{children}</span>
    </span>
  );
}

interface AlertProps {
  children: ReactNode;
  tone?: "info" | "success" | "warning" | "error";
}

export function Alert({ children, tone = "info" }: AlertProps) {
  return <div className={`ui-alert ui-alert--${tone}`}>{children}</div>;
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  helperText?: ReactNode;
  label: string;
}

export function Field({ className = "", error = false, helperText, id, label, ...props }: FieldProps) {
  return (
    <label className={`ui-field ${className}`.trim()} htmlFor={id}>
      <span className="ui-label">{label}</span>
      <input className={`ui-input${error ? " ui-input--error" : ""}`} id={id} {...props} />
      {helperText && <span className={`ui-helper${error ? " ui-helper--error" : ""}`}>{helperText}</span>}
    </label>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  helperText?: ReactNode;
  label: string;
  options: Array<{ label: string; value: string }>;
}

export function SelectField({ className = "", helperText, id, label, options, ...props }: SelectFieldProps) {
  return (
    <label className={`ui-field ${className}`.trim()} htmlFor={id}>
      <span className="ui-label">{label}</span>
      <select className="ui-select" id={id} {...props}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {helperText && <span className="ui-helper">{helperText}</span>}
    </label>
  );
}

interface ToggleProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export function Toggle({ checked, label, onChange }: ToggleProps) {
  return (
    <label className="ui-toggle">
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <span aria-hidden className="ui-toggle__track">
        <span className="ui-toggle__thumb" />
      </span>
      <span>{label}</span>
    </label>
  );
}

interface SegmentedControlProps<T extends string> {
  label: string;
  onChange: (value: T) => void;
  options: Array<{ icon?: ReactNode; label: string; value: T }>;
  value: T;
}

export function SegmentedControl<T extends string>({
  label,
  onChange,
  options,
  value,
}: SegmentedControlProps<T>) {
  const reduceMotion = useReducedMotion() ?? false;
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selector, setSelector] = useState<{ left: number; width: number; visible: boolean }>({
    left: 0,
    width: 0,
    visible: false,
  });

  useEffect(() => {
    const activeIndex = options.findIndex((option) => option.value === value);
    const activeEl = itemRefs.current[activeIndex];
    const parent = activeEl?.parentElement;

    if (!activeEl || !parent) {
      setSelector((prev) => ({ ...prev, visible: false }));
      return;
    }

    const update = () => {
      const parentRect = parent.getBoundingClientRect();
      const itemRect = activeEl.getBoundingClientRect();
      setSelector({
        left: itemRect.left - parentRect.left,
        width: itemRect.width,
        visible: true,
      });
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [options, value]);

  return (
    <div className="ui-segmented" aria-label={label} role="radiogroup">
      {selector.visible && (
        <motion.div
          aria-hidden
          className="ui-segmented__selector"
          initial={false}
          animate={{ x: selector.left, width: selector.width }}
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38 }}
        />
      )}
      {options.map((option, index) => (
        <button
          aria-checked={value === option.value}
          className={`ui-segmented__item${value === option.value ? " is-active" : ""}`}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Progress({ value }: { value?: number }) {
  const determinate = typeof value === "number";
  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={determinate ? value : undefined}
      className={`ui-progress${determinate ? "" : " ui-progress--indeterminate"}`}
      role="progressbar"
    >
      <span style={determinate ? { width: `${Math.max(0, Math.min(100, value))}%` } : undefined} />
    </div>
  );
}
