import { useEffect, useState } from "react";

type Beat = 0 | 1 | 2 | 3 | 4 | 5;

const CURSOR_POS: Record<Beat, { x: string; y: string; press?: boolean }> = {
  0: { x: "22%", y: "34%", press: true },
  1: { x: "72%", y: "38%", press: true },
  2: { x: "22%", y: "66%", press: true },
  3: { x: "72%", y: "58%", press: true },
  4: { x: "82%", y: "80%", press: true },
  5: { x: "82%", y: "80%", press: false },
};

export function StageshowPasteDemo({ hostname }: { hostname: string }) {
  const [beat, setBeat] = useState<Beat>(0);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      setBeat(5);
      return;
    }
    const timings = [1300, 1400, 1300, 1400, 1200, 2600];
    let idx: Beat = 0;
    let timer = 0;
    const step = () => {
      timer = window.setTimeout(() => {
        idx = ((idx + 1) % 6) as Beat;
        setBeat(idx);
        step();
      }, timings[idx]);
    };
    step();
    return () => window.clearTimeout(timer);
  }, []);

  const urlFilled = beat >= 1;
  const tokenFilled = beat >= 3;
  const paired = beat === 5;
  const cursor = CURSOR_POS[beat];

  return (
    <div
      className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 select-none"
      aria-hidden="true"
    >
      <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--dim)]">
        <span>演示：复制两项到云端 Muse「YoYo桥」设置</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors duration-300 ${
            paired
              ? "bg-[var(--teal-soft)] text-[var(--teal)]"
              : "bg-[var(--surface-3)] text-[var(--dim)]"
          }`}
        >
          {paired ? "已配对 ✓" : "等待配对"}
        </span>
      </div>

      <div className="relative grid grid-cols-12 gap-2.5">
        {/* 左侧：本机弹窗提供的两项复制卡片 */}
        <div className="col-span-5 space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
          <div className="text-[10px] font-medium text-[var(--dim)]">本机向导</div>
          <div
            className={`rounded-md border px-2 py-1.5 text-[11px] transition-all duration-200 ${
              beat === 0
                ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                : "border-[var(--border)] bg-[var(--surface-2)]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">1. 地址</span>
              <span className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                {beat === 0 ? "已复制" : "复制"}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[10px] text-[var(--dim)]">
              https://{hostname}
            </div>
          </div>

          <div
            className={`rounded-md border px-2 py-1.5 text-[11px] transition-all duration-200 ${
              beat === 2
                ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                : "border-[var(--border)] bg-[var(--surface-2)]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">2. 令牌</span>
              <span className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                {beat === 2 ? "已复制" : "复制"}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-[var(--dim)]">••••••••••••</div>
          </div>
        </div>

        {/* 右侧：云端 Muse YoYo桥设置卡片 */}
        <div className="col-span-7 flex flex-col justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-medium text-[var(--dim)]">
                云端 Muse · YoYo桥
              </span>
              <span
                className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${
                  paired ? "bg-[var(--ok)]" : "bg-[var(--dim)]/40"
                }`}
              />
            </div>
            <div className="space-y-1.5">
              <div className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[10px]">
                <span className="text-[var(--dim)]">隧道地址：</span>
                <span className="font-mono text-[var(--text)]">
                  {urlFilled ? `https://${hostname}` : "待粘贴…"}
                </span>
              </div>
              <div className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[10px]">
                <span className="text-[var(--dim)]">桥令牌：</span>
                <span className="font-mono text-[var(--text)]">
                  {tokenFilled ? "••••••••••••" : "待粘贴…"}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <span
              className={`rounded px-2.5 py-1 text-[10px] font-medium transition-all duration-200 ${
                paired
                  ? "bg-[var(--ok)] text-white"
                  : beat === 4
                    ? "scale-95 bg-[var(--accent)] text-[var(--accent-ink)]"
                    : "bg-[var(--accent)] text-[var(--accent-ink)]"
              }`}
            >
              {paired ? "已配对 ✓" : "保存并配对"}
            </span>
          </div>
        </div>

        {/* 动画光标 */}
        <div
          className="pointer-events-none absolute z-10 transition-all duration-500 ease-out"
          style={{
            left: cursor.x,
            top: cursor.y,
            transform: `translate(-20%, -15%) scale(${cursor.press ? 0.88 : 1})`,
          }}
        >
          <svg width="18" height="20" viewBox="0 0 18 20" fill="none">
            <path
              d="M2 1.5L15.5 10.5L9.2 11.8L6.5 17.5L2 1.5Z"
              fill="var(--text)"
              stroke="var(--surface)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
