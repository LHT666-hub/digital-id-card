"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { DocumentAnalysis } from "@/lib/documents/analysis";

export type DocumentImageAttachment = {
  id: string;
  name: string;
  previewUrl: string;
  thumbnail: string;
  analysis: DocumentAnalysis | null;
  loading: boolean;
  error: string;
  consentRequired: boolean;
};

export type DocumentImagePanelHandle = {
  open: () => void;
  openCamera: () => void;
  openLibrary: () => void;
  openFile: () => void;
  clear: () => void;
};

async function createThumbnail(file: File) {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<string>((resolve) => {
      const image = new window.Image();
      image.onload = () => {
        const maxEdge = 220;
        const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) return resolve("");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      image.onerror = () => resolve("");
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export const DocumentImagePanel = forwardRef<
  DocumentImagePanelHandle,
  { onChange: (attachment: DocumentImageAttachment | null) => void }
>(function DocumentImagePanel({ onChange }, ref) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef("");
  const activeIdRef = useRef("");
  const [attachment, setAttachment] = useState<DocumentImageAttachment | null>(null);

  function clear() {
    activeIdRef.current = "";
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = "";
    setAttachment(null);
    for (const input of [cameraInputRef.current, libraryInputRef.current, fileInputRef.current]) {
      if (input) input.value = "";
    }
  }

  useImperativeHandle(ref, () => ({
    open: () => cameraInputRef.current?.click(),
    openCamera: () => cameraInputRef.current?.click(),
    openLibrary: () => libraryInputRef.current?.click(),
    openFile: () => fileInputRef.current?.click(),
    clear,
  }));

  useEffect(() => {
    onChange(attachment);
  }, [attachment, onChange]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  async function analyze(file: File) {
    const id = crypto.randomUUID();
    activeIdRef.current = id;

    if (file.size > 4 * 1024 * 1024) {
      setAttachment({
        id,
        name: file.name || "图片",
        previewUrl: "",
        thumbnail: "",
        analysis: null,
        loading: false,
        error: "图片不能超过 4MB，请压缩或重新拍摄。",
        consentRequired: false,
      });
      return;
    }
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) {
      setAttachment({
        id,
        name: file.name || "图片",
        previewUrl: "",
        thumbnail: "",
        analysis: null,
        loading: false,
        error: "目前支持 JPG、PNG 和 WebP 图片。",
        consentRequired: false,
      });
      return;
    }

    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    previewUrlRef.current = previewUrl;
    setAttachment({
      id,
      name: file.name || "图片",
      previewUrl,
      thumbnail: "",
      analysis: null,
      loading: true,
      error: "",
      consentRequired: false,
    });

    void createThumbnail(file).then((thumbnail) => {
      if (activeIdRef.current !== id) return;
      setAttachment((current) => current?.id === id ? { ...current, thumbnail } : current);
    });

    try {
      const form = new FormData();
      form.append("image", file);
      const response = await fetch("/api/v1/documents/analyze", {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (activeIdRef.current !== id) return;
      if (!response.ok) {
        setAttachment((current) => current?.id === id
          ? {
              ...current,
              loading: false,
              error: payload.error?.message ?? "图片识别失败",
              consentRequired: payload.error?.code === "DOCUMENT_CONSENT_REQUIRED",
            }
          : current);
        return;
      }
      setAttachment((current) => current?.id === id
        ? {
            ...current,
            loading: false,
            analysis: payload.data as DocumentAnalysis,
            error: "",
            consentRequired: false,
          }
        : current);
    } catch (reason) {
      if (activeIdRef.current !== id) return;
      setAttachment((current) => current?.id === id
        ? {
            ...current,
            loading: false,
            error: reason instanceof Error ? reason.message : "图片识别失败",
          }
        : current);
    }
  }

  return (
    <>
      {[
        {
          ref: cameraInputRef,
          label: "拍照识别医疗文件",
          capture: "environment" as const,
        },
        {
          ref: libraryInputRef,
          label: "从相册选择医疗文件",
          capture: undefined,
        },
        {
          ref: fileInputRef,
          label: "上传医疗图片文件",
          capture: undefined,
        },
      ].map((input) => (
        <input
          key={input.label}
          ref={input.ref}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture={input.capture}
          className="sr-only"
          aria-label={input.label}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void analyze(file);
          }}
        />
      ))}
    </>
  );
});
