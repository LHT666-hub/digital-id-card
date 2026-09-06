"use client";

import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Send } from "lucide-react";
import { useSpeechRecognition } from "@/lib/useSpeechRecognition";

type Props = { disabled?: boolean; onTranscript: (text: string) => void; onFallback?: () => void };
type ServerVoiceState = "idle" | "preparing" | "recording" | "transcribing" | "error";

function preferredMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function HoldToTalkButton({ disabled = false, onTranscript, onFallback }: Props) {
  const browserSpeech = useSpeechRecognition();
  const [serverState, setServerState] = useState<ServerVoiceState>("idle");
  const [serverError, setServerError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const holdingRef = useRef(false);
  const serverModeRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestRef = useRef<AbortController | null>(null);
  const deliveredRef = useRef("");

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const transcribe = useCallback(async (blob: Blob, extension: string) => {
    if (!blob.size) {
      setServerError("没有录到声音，请再试一次");
      setServerState("error");
      return;
    }
    setServerState("transcribing");
    const form = new FormData();
    form.append("audio", blob, `voice-${Date.now()}.${extension}`);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch("/api/v1/speech/transcribe", { method: "POST", body: form, signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "语音识别失败");
      const text = String(payload.data?.text ?? "").trim();
      if (!text) throw new Error("没有听清楚，请再说一遍");
      deliveredRef.current = text;
      setServerState("idle");
      onTranscript(text);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setServerError(reason instanceof Error ? reason.message : "语音识别失败，请重试");
      setServerState("error");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [onTranscript]);

  const startServerRecording = useCallback(async () => {
    setServerState("preparing");
    setServerError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!holdingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        setServerState("idle");
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        releaseStream();
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        void transcribe(blob, extension);
      };
      recorder.start(200);
      setServerState("recording");
    } catch (reason) {
      releaseStream();
      setServerError(reason instanceof DOMException && reason.name === "NotAllowedError"
        ? "请允许麦克风权限后再试"
        : "录音没有启动成功，请重试");
      setServerState("error");
    }
  }, [releaseStream, transcribe]);

  const begin = useCallback(() => {
    if (disabled || holdingRef.current || serverState === "transcribing") return;
    deliveredRef.current = "";
    holdingRef.current = true;
    setSeconds(0);
    navigator.vibrate?.(18);
    if (typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined") {
      serverModeRef.current = true;
      void startServerRecording();
    } else if (browserSpeech.isSupported()) {
      serverModeRef.current = false;
      browserSpeech.start();
    } else {
      holdingRef.current = false;
      onFallback?.();
    }
  }, [browserSpeech, disabled, onFallback, serverState, startServerRecording]);

  const finish = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    navigator.vibrate?.(12);
    if (serverModeRef.current) {
      if (recorderRef.current?.state === "recording") {
        setServerState("transcribing");
        recorderRef.current.stop();
      } else if (serverState === "preparing") {
        setServerState("idle");
      }
    } else {
      browserSpeech.stop();
    }
  }, [browserSpeech, serverState]);

  useEffect(() => {
    if (browserSpeech.state !== "result" || !browserSpeech.transcript) return;
    if (deliveredRef.current === browserSpeech.transcript) return;
    deliveredRef.current = browserSpeech.transcript;
    onTranscript(browserSpeech.transcript);
  }, [browserSpeech.state, browserSpeech.transcript, onTranscript]);

  const recording = serverState === "recording" || browserSpeech.state === "listening";
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setSeconds((value) => {
      if (value >= 29) {
        window.setTimeout(() => finish(), 0);
        return 30;
      }
      return value + 1;
    }), 1000);
    return () => window.clearInterval(timer);
  }, [finish, recording]);

  useEffect(() => {
    const release = () => finish();
    const hidden = () => { if (document.visibilityState !== "visible") finish(); };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("touchend", release, true);
    window.addEventListener("touchcancel", release, true);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("touchend", release, true);
      window.removeEventListener("touchcancel", release, true);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [finish]);

  useEffect(() => () => {
    holdingRef.current = false;
    requestRef.current?.abort();
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    releaseStream();
  }, [releaseStream]);

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    begin();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault();
      begin();
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      finish();
    }
  }

  const processing = serverState === "preparing" || serverState === "transcribing" || browserSpeech.state === "processing";
  const failed = serverState === "error" || browserSpeech.state === "error";
  const label = recording
    ? `松开，转成文字${seconds ? ` ${seconds} 秒` : ""}`
    : processing
      ? serverState === "preparing" ? "正在打开麦克风…" : "正在识别…"
      : failed
        ? serverError || browserSpeech.errorMessage || "没有听清，请重试"
        : "按住说话";

  return (
    <>
      <button
        type="button"
        disabled={disabled || serverState === "transcribing"}
        aria-label="按住说话，松开转文字"
        onPointerDown={handlePointerDown}
        onPointerUp={(event) => { event.preventDefault(); finish(); }}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onContextMenu={(event) => event.preventDefault()}
        className={`ios-pressable flex h-12 min-w-0 flex-1 touch-none select-none items-center justify-center gap-2 rounded-full border px-4 text-sm font-semibold transition ${recording || processing
          ? "border-danger/25 bg-risk-strong text-danger shadow-[0_0_0_5px_rgba(164,74,63,0.08)]"
          : failed ? "border-danger/20 bg-risk-soft text-danger" : "border-line bg-surface-card text-navy"} disabled:opacity-60`}
      >
        {processing ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" /> : recording ? (
          <span className="flex h-5 items-center gap-1" aria-hidden="true">
            {[10, 18, 14, 20].map((height, index) => (
              <span key={height} className="wave-bar wave-bar-live w-1 bg-danger" style={{ height, animationDelay: `${index * 90}ms` }} />
            ))}
          </span>
        ) : <Mic className="h-4 w-4 shrink-0" />}
        <span className="truncate">{label}</span>
      </button>
      <button
        type="submit"
        disabled={disabled}
        aria-label="发送"
        className="ios-pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-navy text-white shadow-[0_10px_22px_rgba(16,42,67,0.2)] disabled:opacity-40"
      >
        <Send className="h-4 w-4" />
      </button>
    </>
  );
}
