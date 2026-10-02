import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { brand } from "@/brand/assets";
import { Button } from "@/components/ui/button";
import type { AppError } from "@/lib/ipc";

interface SplashProps {
  /** 初始化完成后开始淡出 */
  done: boolean;
  error?: AppError | null;
  onRetry?: () => void;
  onHidden?: () => void;
}

const FADE_MS = 250;

// 布局按 BRAND.md 第 6 节：标志中心约 32%，字标约 55%–65%，光带底部对齐。
export function Splash({ done, error, onRetry, onHidden }: SplashProps) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!done) return;
    setFading(true);
    const t = setTimeout(() => onHidden?.(), FADE_MS);
    return () => clearTimeout(t);
  }, [done, onHidden]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!done && !error}
      data-testid="splash"
      className="fixed inset-0 z-50 overflow-hidden bg-night transition-opacity"
      style={{ opacity: fading ? 0 : 1, transitionDuration: `${FADE_MS}ms` }}
    >
      <img
        src={brand.assets.splashHorizon}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-1/2 h-auto min-w-full max-w-none -translate-x-1/2 select-none animate-eg-breathe"
        draggable={false}
      />
      <img
        src={brand.assets.markForDarkBg}
        alt="EastGenesis 标志"
        className="absolute left-1/2 top-[32%] w-[min(22vw,180px)] -translate-x-1/2 -translate-y-1/2 select-none animate-eg-breathe"
        draggable={false}
      />
      <div className="absolute left-1/2 top-[55%] flex -translate-x-1/2 flex-col items-center gap-4">
        <img
          src={brand.assets.wordmarkLight}
          alt="EastGenesis Desktop"
          className="w-[min(40vw,360px)] select-none"
          draggable={false}
        />
        {error ? (
          <div role="alert" className="mt-2 flex flex-col items-center gap-3 text-sm">
            <p className="flex items-center gap-2 text-foreground">
              <AlertTriangle aria-hidden="true" className="size-4 text-china-gold" />
              启动失败：{error.message}
            </p>
            <Button size="sm" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : (
          <p className="text-sm tracking-brand text-muted-foreground">{brand.splashCaption}</p>
        )}
      </div>
    </div>
  );
}
