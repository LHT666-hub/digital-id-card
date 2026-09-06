"use client";

import { BottomNav } from "@/components/BottomNav";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  GlobalClawAssistant,
  type ClawAppointmentDraft,
} from "@/components/GlobalClawAssistant";

type PhoneShellProps = {
  children: React.ReactNode;
  showBottomNav?: boolean;
  contentMode?: "scroll" | "fixed";
  onClawAppointmentDraft?: (draft: ClawAppointmentDraft) => void;
};

export function PhoneShell({
  children,
  showBottomNav = false,
  contentMode = "scroll",
  onClawAppointmentDraft,
}: PhoneShellProps) {
  const pathname = usePathname();
  const [viewportState, setViewportState] = useState<{
    height: number;
    width: number;
    offsetTop: number;
    keyboardOpen: boolean;
  } | null>(null);
  const shouldHideBottomNav = pathname === "/group";
  const shouldShowBottomNav = showBottomNav && !shouldHideBottomNav;

  useEffect(() => {
    if (contentMode !== "fixed") return;
    const viewport = window.visualViewport;
    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    const updateViewport = () => {
      const height = Math.round(viewport?.height ?? window.innerHeight);
      const offsetTop = Math.max(0, Math.round(viewport?.offsetTop ?? 0));
      setViewportState({
        height,
        width: Math.round(viewport?.width ?? window.innerWidth),
        offsetTop,
        keyboardOpen: height < window.innerHeight - 120,
      });
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
    };
  }, [contentMode]);

  const fixedViewportStyle =
    contentMode === "fixed" && viewportState
      ? {
          top: `${viewportState.offsetTop}px`,
          height: `${viewportState.height}px`,
          minHeight: `${viewportState.height}px`,
          width: `${viewportState.width}px`,
        }
      : undefined;
  return (
    <main
      style={fixedViewportStyle}
      className={`phone-shell-stage mx-auto flex min-w-0 w-full items-center justify-center overflow-hidden sm:px-6 sm:py-6 ${contentMode === "fixed" ? "fixed inset-x-0 top-0 h-dvh min-h-0 overscroll-none" : "min-h-dvh"} ${viewportState?.keyboardOpen ? "phone-keyboard-open" : ""}`}
    >
      <div
        className={`phone-shell-frame relative min-w-0 w-full max-w-[430px] overflow-hidden border border-white/70 shadow-[0_28px_70px_rgba(16,42,67,0.12),inset_0_1px_0_rgba(255,255,255,0.9)] sm:max-h-[920px] ${contentMode === "fixed" ? "h-full" : "h-[calc(100dvh-1.5rem)]"}`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-3">
          <div className="h-1.5 w-[72px] rounded-full bg-navy/16 shadow-[inset_0_1px_1px_rgba(255,255,255,0.6)]" />
        </div>
        <div
          className={`resident-ui phone-scroll h-full min-h-0 min-w-0 overflow-x-hidden overscroll-contain ${
            contentMode === "fixed"
              ? "overflow-hidden"
              : `overflow-y-auto ${shouldShowBottomNav ? "pb-32" : "pb-8"}`
          }`}
        >
          {children}
        </div>
        {shouldShowBottomNav ? <BottomNav /> : null}
        {shouldShowBottomNav ? (
          <GlobalClawAssistant onAppointmentDraft={onClawAppointmentDraft} />
        ) : null}
      </div>
      <style jsx global>{`
        .phone-scroll {
          overflow-x: hidden !important;
        }

        .ask-composer {
          min-width: 0;
          align-items: center;
        }

        .ask-composer > button[aria-label^="切换到"] {
          order: 1;
        }

        .ask-composer > input,
        .ask-composer > button[aria-label="按住说话，松开转文字"] {
          order: 2;
        }

        .ask-composer > button[aria-label="添加附件"],
        .ask-composer > button[aria-label="关闭附件菜单"] {
          order: 3;
        }

        .ask-composer > button[aria-label="发送"] {
          order: 4;
        }

        @media (max-width: 639px) {
          .ask-composer > input {
            font-size: 16px !important;
          }
        }
      `}</style>
    </main>
  );
}
