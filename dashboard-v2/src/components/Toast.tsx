import { useEffect, useRef, useCallback } from "react";
import { useStore } from "../store";
import type { Toast as ToastType } from "../types";

const ICONS: Record<ToastType["type"], string> = {
  error: "\u26A0",
  warning: "\u26A1",
  success: "\u2713",
  info: "\u24D8",
};

function ToastItem({ toast }: { toast: ToastType }) {
  const removeToast = useStore((s) => s.removeToast);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(5000);
  const startRef = useRef(Date.now());
  const progressRef = useRef<HTMLDivElement | null>(null);

  const startTimer = useCallback(() => {
    startRef.current = Date.now();
    if (progressRef.current) {
      progressRef.current.style.animationPlayState = "running";
    }
    timerRef.current = setTimeout(() => {
      removeToast(toast.id);
    }, remainingRef.current);
  }, [removeToast, toast.id]);

  const pauseTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    remainingRef.current -= Date.now() - startRef.current;
    if (progressRef.current) {
      progressRef.current.style.animationPlayState = "paused";
    }
  }, []);

  useEffect(() => {
    startTimer();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [startTimer]);

  return (
    <div
      className={`toast toast--${toast.type}`}
      onMouseEnter={pauseTimer}
      onMouseLeave={startTimer}
    >
      <div className="toast__icon">{ICONS[toast.type]}</div>
      <div className="toast__body">
        <div className="toast__title">{toast.title}</div>
        <div className="toast__message">{toast.message}</div>
      </div>
      <button
        className="toast__close"
        onClick={() => removeToast(toast.id)}
        aria-label="Dismiss"
      >
        &times;
      </button>
      <div className="toast__progress" ref={progressRef} />
    </div>
  );
}

export default function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  const visible = toasts.slice(0, 5);

  if (visible.length === 0) return null;

  return (
    <div className="toast-container">
      {visible.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
