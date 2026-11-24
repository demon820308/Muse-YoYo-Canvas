// Bottom-left zoom capsule, per Wei's final 2026-11-15 spec
// (corrected 03:09): exactly five items — fit button, − button,
// a short slider, the live percentage, and the ＋ button —
// identical on desktop and touch widths (no per-breakpoint
// variants). Only the old trailing 100% reset button was removed.
// Anchor: the main toolbar is horizontally centered and ~620px
// wide, so below xl its left end reaches into the capsule's
// corner band (at 820px wide it would start near x≈100, under
// the capsule) — the capsule therefore rides one row above the
// toolbar until xl, where the toolbar's left end clears the
// capsule's right edge (~271px) with room to spare. Same capsule,
// same five items at every width; only the row changes.
// The minimap itself lives at the canvas's bottom-right
// (MiniMap.tsx), always on, as in the reference canvas.

import { IconFocus, IconMinus, IconPlus } from "../icons";

export function ZoomControls({
  scale,
  onScaleChange,
  onFit,
}: {
  scale: number;
  onScaleChange: (scale: number) => void;
  onFit: () => void;
}) {
  const percent = Math.round(scale * 100);
  return (
    <div
      data-ui
      data-canvas-no-zoom
      className="w-full"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="capsule-chrome flex h-10 w-full items-center gap-0.5 rounded-full px-1.5">
        <button
          type="button"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          onClick={onFit}
          aria-label="适配全图"
          title="适应屏幕"
        >
          <IconFocus size={15} />
        </button>
        <button
          type="button"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          onClick={() => onScaleChange(scale / 1.2)}
          aria-label="缩小画布"
          title="缩小"
        >
          <IconMinus size={14} />
        </button>
        <label className="sr-only" htmlFor="canvas-zoom-slider">
          放大/缩小画布
        </label>
        <input
          id="canvas-zoom-slider"
          type="range"
          min="5"
          max="500"
          step="1"
          value={percent}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--text)]"
          onChange={(event) => onScaleChange(Number(event.target.value) / 100)}
          aria-label="放大/缩小画布"
        />
        <span
          className="w-9 shrink-0 text-center text-[11px] tabular-nums text-[var(--dim)]"
          aria-live="polite"
        >
          {percent}%
        </span>
        <button
          type="button"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--dim)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          onClick={() => onScaleChange(scale * 1.2)}
          aria-label="放大画布"
          title="放大"
        >
          <IconPlus size={14} />
        </button>
      </div>
    </div>
  );
}
