// Direct mask editor for YoYoCanvas, adapted from Goohai's mask editor UI/engine.

import type { MaskColorKey, MaskNodeStyleState } from "./mask-helpers";

export type YoYoMaskSaveResult = {
  maskDataUrl: string;
  strokesDataUrl: string;
  maskStateJson: string;
};

const MAX_EDIT_LONG_SIDE = 1536;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

function canvasToObjectUrl(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality = 0.92,
): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("Cannot create preview blob"));
        else resolve(URL.createObjectURL(blob));
      },
      type,
      quality,
    );
  });
}

export function injectYoYoMaskStyles() {
  if (document.getElementById("guhai-mask-editor-style")) return;
  const style = document.createElement("style");
  style.id = "guhai-mask-editor-style";
  style.textContent = `
.guhai-mask-root{position:fixed;inset:0;z-index:100000;background:#15171b;color:#f0f2f5;font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;display:flex;flex-direction:column}
.guhai-mask-root,.guhai-mask-root *,.guhai-mask-color-menu,.guhai-mask-color-menu *{box-sizing:border-box}
.guhai-mask-root button,.guhai-mask-root input,.guhai-mask-color-menu button{min-height:0;min-width:0;line-height:normal}
.guhai-mask-keyboard-sink{position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none}
.guhai-mask-toolbar{min-height:48px;display:flex;align-items:center;gap:14px;padding:8px 12px;background:#202329;border-bottom:1px solid #353a43;box-shadow:0 8px 24px rgba(0,0,0,.26);position:relative}
.guhai-mask-tools-left,.guhai-mask-tools-right{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.guhai-mask-tools-left{justify-content:flex-end;padding-right:220px}
.guhai-mask-tools-right{justify-content:flex-start;padding-left:220px}
.guhai-mask-brush-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:12px;font-weight:700;color:#487d7d;white-space:nowrap;pointer-events:none}
.guhai-mask-segment{display:flex;overflow:hidden;border:1px solid #454b56;border-radius:999px;background:#181a1f}
.guhai-mask-btn{border:0;background:transparent;color:#c6cbd3;font-size:14px;font-weight:700;padding:7px 12px;cursor:pointer;line-height:1;white-space:nowrap}
.guhai-mask-btn:hover{background:#2b3038;color:#fff}
.guhai-mask-btn.active{background:#45c7bf;color:white}
.guhai-mask-icon-btn{width:30px;height:30px;padding:0;font-size:16px;line-height:1;border-radius:999px;border:1px solid transparent;background:transparent;color:#c6cbd3;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-weight:800}
.guhai-mask-icon-btn:hover{background:#2b3038;color:#fff}
.guhai-mask-icon-btn:disabled{opacity:.35;cursor:default}
.guhai-mask-action{height:30px;border-radius:999px;border:1px solid #4a5260;background:transparent;color:#d7dbe2;font-size:14px;font-weight:700;padding:0 12px;cursor:pointer;line-height:1}
.guhai-mask-action:hover{background:#2b3038;color:#fff}
.guhai-mask-primary{height:30px;border-radius:999px;border:0;background:#45c7bf;color:white;font-size:14px;font-weight:800;padding:0 16px;cursor:pointer;line-height:1;box-shadow:0 3px 12px rgba(69,199,191,.35)}
.guhai-mask-primary:hover{background:#55d8d0}
.guhai-mask-swatch{flex:0 0 auto;width:20px;height:20px;padding:0;border-radius:50%;border:1px solid #626a78;cursor:pointer;opacity:.75}
.guhai-mask-swatch.active{outline:2px solid #45c7bf;outline-offset:2px;opacity:1;transform:scale(1.06)}
.guhai-mask-stage{position:relative;flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#111318;cursor:none}
.guhai-mask-output-panel{position:absolute;left:14px;top:14px;z-index:12;display:flex;flex-direction:column;gap:12px;width:222px;padding:10px;color:#dce2ea;font-size:14px;user-select:none;cursor:pointer;background:rgba(8,58,62,.4);border:1px solid rgba(77,174,177,.2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.18);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.guhai-mask-output-row{display:flex;align-items:center;width:100%;min-height:24px}
.guhai-mask-output-label{font-size:14px;font-weight:700;color:#b9c2ce;white-space:nowrap}
.guhai-mask-output-segment{display:flex;width:100%;overflow:hidden;border:1px solid rgba(130,145,160,.65);border-radius:999px;background:rgba(18,22,28,.28)}
.guhai-mask-output-btn{flex:1;border:0;background:transparent;color:#c7d0da;font-size:14px;line-height:1.2;padding:5px 9px;cursor:pointer;white-space:nowrap}
.guhai-mask-output-btn.active{background:rgba(69,199,191,.78);color:#fff}
.guhai-mask-output-swatches{display:flex;align-items:center;justify-content:space-between;width:100%}
.guhai-mask-output-swatch{flex:0 0 auto;width:17px;height:17px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.7);cursor:pointer;opacity:.72;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
.guhai-mask-output-swatch.active{outline:2px solid #45c7bf;outline-offset:2px;opacity:1}
.guhai-mask-output-opacity-row{flex-direction:column;align-items:stretch;gap:3px}
.guhai-mask-output-opacity-head{display:flex;align-items:center;justify-content:space-between;width:100%}
.guhai-mask-output-range{display:block;width:100%;height:16px;margin:0;accent-color:#45c7bf;cursor:pointer}
.guhai-mask-output-value{font-size:14px;color:#c8d1dc;font-family:Consolas,monospace;text-align:right}
.guhai-mask-output-check{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;width:100%;min-height:24px;cursor:pointer;color:#c7d0da;font-size:14px}
.guhai-mask-output-check input{position:absolute;opacity:0;pointer-events:none}
.guhai-mask-output-toggle{position:relative;width:46px;height:18px;justify-self:center;border-radius:999px;background:rgba(91,101,114,.72);box-shadow:inset 0 0 0 1px rgba(255,255,255,.2);transition:background .16s ease}
.guhai-mask-output-toggle::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#d9dee5;box-shadow:0 1px 3px rgba(0,0,0,.45);transition:transform .16s ease,background .16s ease}
.guhai-mask-output-check input:checked+.guhai-mask-output-toggle{background:#45c7bf}
.guhai-mask-output-check input:checked+.guhai-mask-output-toggle::after{transform:translateX(28px);background:#fff}
.guhai-mask-frame{position:relative;display:none;box-shadow:0 10px 32px rgba(0,0,0,.45);transform-origin:center center}
.guhai-mask-frame img{display:block;max-width:90vw;max-height:calc(100vh - 110px);user-select:none;-webkit-user-drag:none}
.guhai-mask-frame canvas.guhai-mask-paint{position:absolute;inset:0;width:100%;height:100%;opacity:.5;touch-action:none;pointer-events:none}
.guhai-mask-marquee{position:absolute;inset:0;pointer-events:none;z-index:5}
.guhai-mask-cursor{position:absolute;pointer-events:none;z-index:20;border:2px solid #f5f7fb;box-shadow:0 0 0 1px #111318;border-radius:50%;display:none}
.guhai-mask-size{font-size:12px;color:#aeb5c0;font-family:"JetBrains Mono",Consolas,monospace;min-width:52px;text-align:right}
.guhai-mask-dims{position:absolute;left:0;right:0;top:100%;margin-top:6px;text-align:center;font-size:12px;color:#c8ccd3;font-family:"JetBrains Mono",Consolas,monospace;pointer-events:none}
.guhai-mask-loading{position:absolute;color:#c6cbd3;font-size:14px}
.guhai-mask-error{position:absolute;color:#ff9a9a;font-size:14px;max-width:70vw;text-align:center}
.guhai-mask-color-menu{position:fixed;z-index:100001;display:flex;gap:5px;padding:7px;border:1px solid rgba(255,255,255,.22);border-radius:8px;background:rgba(18,22,28,.95);box-shadow:0 8px 24px rgba(0,0,0,.45)}
.guhai-mask-color-menu button{width:22px;height:22px;padding:0;border:1px solid rgba(255,255,255,.6);border-radius:50%;cursor:pointer;color:#fff;font-size:16px;line-height:18px}
@media (max-width:920px){
  .guhai-mask-toolbar{gap:8px}
  .guhai-mask-tools-left{padding-right:0;justify-content:flex-start}
  .guhai-mask-tools-right{padding-left:0;justify-content:flex-end}
  .guhai-mask-brush-hint{display:none}
}
`;
  document.head.appendChild(style);
}

type Rect = { x: number; y: number; w: number; h: number };
type HistorySnapshot = { image: ImageData; inverted: boolean };
type MarqueeMoveState = {
  start: { x: number; y: number };
  snap: HTMLCanvasElement;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  rects: Rect[];
  edgeCache: { points: [number, number][] } | null;
  dx?: number;
  dy?: number;
};

export class YoYoMaskEditor {
  imageUrl: string;
  strokesUrl: string | null;
  onSave: (result: YoYoMaskSaveResult) => void;
  onClose: () => void;

  outputMode: "color" | "original";
  outputColor: string;
  outputOpacity: number;
  autoFillHoles: boolean;
  maskInverted: boolean;

  tool: "brush" | "eraser" | "marquee" = "brush";
  maskBrushColor = "green";
  brushColor: string;
  brushSize = 30;
  activePaintColor: string;
  maskModePaint: HTMLCanvasElement | null = null;
  colorModePaint: HTMLCanvasElement | null = null;
  maskModeBasePaint: HTMLCanvasElement | null = null;
  maskModeChangesDirty = false;
  fillRevision = 0;

  scale = 1;
  offset = { x: 0, y: 0 };
  isDrawing = false;
  isPanning = false;
  panStart: { x: number; y: number; ox: number; oy: number } | null = null;
  spaceDown = false;
  altDown = false;
  shiftDown = false;
  shiftTemp = false;
  prevToolBeforeShift: "brush" | "eraser" | "marquee" | null = null;
  shiftTempDrew = false;
  rightResize: {
    x: number;
    y: number;
    size: number;
    moved: boolean;
    colorContext: {
      x: number;
      y: number;
      rgb: number[];
      pos: { x: number; y: number };
      sourceName: string;
    } | null;
  } | null = null;
  lastPos: { x: number; y: number } | null = null;
  lastMouse: { x: number; y: number } | null = null;
  lastDrawClient: { x: number; y: number } | null = null;
  history: HistorySnapshot[] = [];
  redo: HistorySnapshot[] = [];
  marqueeRects: Rect[] = [];
  marqueeDraft: Rect | null = null;
  marqueeAction: "none" | "draw" | "move" = "none";
  marqueeStart: { x: number; y: number; mode: "new" | "add" | "subtract"; square: boolean } | null = null;
  marqueeMove: MarqueeMoveState | null = null;
  dashOffset = 0;
  marqueeEdgeCache: { points: [number, number][] } | null = null;
  marqueeEdgeDirty = true;
  lastMoveRedrawAt = 0;
  natural = { w: 0, h: 0, sf: 1 };
  colors: Record<string, string> = {
    green: "hsl(142 71% 45%)",
    white: "#fff",
    black: "#000",
  };
  outputColors: Record<string, string> = {
    white: "#ffffff",
    red: "#ff3030",
    orange: "#ff8c20",
    yellow: "#ffe52e",
    green: "#28d66f",
    cyan: "#24d9d1",
    blue: "#347cff",
    purple: "#b04cff",
    gray: "#808080",
  };
  colorOrder: string[];
  colorLayers = new Map<string, HTMLCanvasElement>();
  filledColorLayers = new Map<string, HTMLCanvasElement>();
  dirtyFilledColors = new Set<string>();

  root!: HTMLDivElement;
  keyboardSink!: HTMLTextAreaElement;
  stage!: HTMLDivElement;
  frame!: HTMLDivElement;
  img!: HTMLImageElement;
  paint!: HTMLCanvasElement;
  marquee!: HTMLCanvasElement;
  cursor!: HTMLDivElement;
  loading!: HTMLDivElement;
  sizeText!: HTMLSpanElement;
  hint!: HTMLDivElement;
  dims!: HTMLDivElement;
  shapeMask!: HTMLCanvasElement;
  rawPaint!: HTMLCanvasElement;
  filledPaint!: HTMLCanvasElement;
  filledPaintValid = false;
  drawingPreviewPaint: HTMLCanvasElement | null = null;
  drawingPreviewRaf = 0;
  drawingColor: string | null = null;
  outputOpacityInput!: HTMLInputElement;
  outputOpacityValue!: HTMLSpanElement;
  outputPanel!: HTMLDivElement;
  outputColorRow!: HTMLDivElement;
  outputOpacityRow: HTMLElement | null = null;
  outputFillInput!: HTMLInputElement;
  sourceImage: HTMLImageElement | null = null;
  editImageCanvas: HTMLCanvasElement | null = null;
  previewObjectUrl: string | null = null;
  raf = 0;
  closed = false;

  private _move!: (e: MouseEvent) => void;
  private _up!: (e: MouseEvent) => void;
  private _keyDown!: (e: KeyboardEvent) => void;
  private _keyUp!: (e: KeyboardEvent) => void;
  private _resize!: () => void;
  private _wheel!: (e: WheelEvent) => void;
  private _colorMenu: HTMLDivElement | null = null;
  private _colorMenuOutside: ((e: MouseEvent) => void) | null = null;

  constructor(opts: {
    imageUrl: string;
    strokesUrl?: string | null;
    outputState?: Partial<MaskNodeStyleState> | null;
    onSave: (result: YoYoMaskSaveResult) => void;
    onClose: () => void;
  }) {
    injectYoYoMaskStyles();
    this.imageUrl = opts.imageUrl;
    this.strokesUrl = opts.strokesUrl ?? null;
    this.outputMode = opts.outputState?.outputMode === "original" ? "original" : "color";
    this.outputColor = opts.outputState?.colorKey || "red";
    this.outputOpacity = clamp(Number(opts.outputState?.opacity ?? 50), 0, 100);
    this.autoFillHoles = Boolean(opts.outputState?.fillHoles);
    this.maskInverted = Boolean(opts.outputState?.inverted);
    this.onSave = opts.onSave;
    this.onClose = opts.onClose;
    this.brushColor = this.outputMode === "color" ? this.outputColor : this.maskBrushColor;
    this.activePaintColor = this.brushColor;
    this.colorOrder = Object.keys(this.outputColors);
    this.dirtyFilledColors = new Set(this.colorOrder);

    this.build();
    this.bind();
    void this.init();
  }

  build() {
    this.root = document.createElement("div");
    this.root.className = "guhai-mask-root";
    this.root.setAttribute("data-ui", "");
    this.root.setAttribute("data-canvas-no-zoom", "");
    this.root.tabIndex = -1;
    this.root.innerHTML = `
      <textarea class="guhai-mask-keyboard-sink" aria-hidden="true" readonly spellcheck="false" inputmode="none"></textarea>
      <div class="guhai-mask-toolbar">
        <div class="guhai-mask-tools-left">
          <div class="guhai-mask-segment">
            <button class="guhai-mask-btn active" data-tool="brush" title="B">画笔</button>
            <button class="guhai-mask-btn" data-tool="eraser" title="E">橡皮擦</button>
            <button class="guhai-mask-btn" data-tool="marquee" title="M">选框</button>
          </div>
          <button class="guhai-mask-swatch active" data-color="green" title="绿色"></button>
          <button class="guhai-mask-swatch" data-color="white" title="白色"></button>
          <button class="guhai-mask-swatch" data-color="black" title="黑色"></button>
          <span class="guhai-mask-size">30px</span>
        </div>
        <div class="guhai-mask-brush-hint">鼠标右键左右拖动调整画笔大小</div>
        <div class="guhai-mask-tools-right">
          <button class="guhai-mask-icon-btn" data-act="undo" title="Ctrl+Z">↶</button>
          <button class="guhai-mask-icon-btn" data-act="redo" title="Ctrl+Shift+Z">↷</button>
          <button class="guhai-mask-action" data-act="invert" title="Ctrl+I">反转</button>
          <button class="guhai-mask-action" data-act="clear" title="X">清空</button>
          <button class="guhai-mask-action" data-act="cancel" title="Esc">取消</button>
          <button class="guhai-mask-primary" data-act="save" title="Enter">保存遮罩</button>
        </div>
      </div>
      <div class="guhai-mask-stage">
        <div class="guhai-mask-output-panel">
          <div class="guhai-mask-output-row">
            <div class="guhai-mask-output-segment">
              <button class="guhai-mask-output-btn" data-output-mode="original">仅遮罩</button>
              <button class="guhai-mask-output-btn" data-output-mode="color">颜色叠加</button>
            </div>
          </div>
          <div class="guhai-mask-output-row guhai-mask-output-color-row">
            <div class="guhai-mask-output-swatches">
              <button class="guhai-mask-output-swatch" data-output-color="white" title="白"></button>
              <button class="guhai-mask-output-swatch" data-output-color="red" title="红"></button>
              <button class="guhai-mask-output-swatch" data-output-color="orange" title="橙"></button>
              <button class="guhai-mask-output-swatch" data-output-color="yellow" title="黄"></button>
              <button class="guhai-mask-output-swatch" data-output-color="green" title="绿"></button>
              <button class="guhai-mask-output-swatch" data-output-color="cyan" title="青"></button>
              <button class="guhai-mask-output-swatch" data-output-color="blue" title="蓝"></button>
              <button class="guhai-mask-output-swatch" data-output-color="purple" title="紫"></button>
              <button class="guhai-mask-output-swatch" data-output-color="gray" title="128 中性灰"></button>
            </div>
          </div>
          <div class="guhai-mask-output-row guhai-mask-output-opacity-row">
            <div class="guhai-mask-output-opacity-head">
              <span class="guhai-mask-output-label">透明度</span>
              <span class="guhai-mask-output-value" data-output-opacity-value></span>
            </div>
            <input class="guhai-mask-output-range" data-output-opacity type="range" min="0" max="100" step="5" />
          </div>
          <label class="guhai-mask-output-check">
            <span>自动填充漏洞</span>
            <input data-output-fill type="checkbox" />
            <span class="guhai-mask-output-toggle" aria-hidden="true"></span>
          </label>
        </div>
        <div class="guhai-mask-loading">加载中...</div>
        <div class="guhai-mask-frame">
          <img draggable="false" />
          <canvas class="guhai-mask-paint"></canvas>
          <div class="guhai-mask-dims"></div>
        </div>
        <canvas class="guhai-mask-marquee"></canvas>
        <div class="guhai-mask-cursor"></div>
      </div>`;
    document.body.appendChild(this.root);

    this.keyboardSink = this.root.querySelector(".guhai-mask-keyboard-sink")!;
    this.stage = this.root.querySelector(".guhai-mask-stage")!;
    this.frame = this.root.querySelector(".guhai-mask-frame")!;
    this.img = this.root.querySelector("img")!;
    this.paint = this.root.querySelector(".guhai-mask-paint")!;
    this.marquee = this.root.querySelector(".guhai-mask-marquee")!;
    this.cursor = this.root.querySelector(".guhai-mask-cursor")!;
    this.loading = this.root.querySelector(".guhai-mask-loading")!;
    this.sizeText = this.root.querySelector(".guhai-mask-size")!;
    this.hint = this.root.querySelector(".guhai-mask-brush-hint")!;
    this.dims = this.root.querySelector(".guhai-mask-dims")!;
    this.shapeMask = document.createElement("canvas");
    this.rawPaint = document.createElement("canvas");
    this.filledPaint = document.createElement("canvas");
    this.outputOpacityInput = this.root.querySelector("[data-output-opacity]")!;
    this.outputOpacityValue = this.root.querySelector("[data-output-opacity-value]")!;
    this.outputPanel = this.root.querySelector(".guhai-mask-output-panel")!;
    this.outputColorRow = this.root.querySelector(".guhai-mask-output-color-row")!;
    this.outputOpacityRow = this.outputOpacityInput.closest(".guhai-mask-output-row");
    this.outputFillInput = this.root.querySelector("[data-output-fill]")!;

    for (const sw of Array.from(this.root.querySelectorAll<HTMLElement>(".guhai-mask-swatch"))) {
      sw.style.background = this.colors[sw.dataset.color || ""] || "";
    }
    for (const [name, value] of Object.entries(this.outputColors)) {
      this.colors[name] = value;
    }
    for (const sw of Array.from(this.root.querySelectorAll<HTMLElement>("[data-output-color]"))) {
      sw.style.background = this.outputColors[sw.dataset.outputColor || ""] || "";
    }
    this.outputOpacityInput.value = String(this.outputOpacity);
    this.outputFillInput.checked = this.autoFillHoles;
    this.updateOutputControls();
    this.keyboardSink.focus({ preventScroll: true });
  }

  bind() {
    this.root.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0 || e.target === this.keyboardSink) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest?.("button, input, textarea, select, option, label")) return;
        e.preventDefault();
        this.keyboardSink.focus({ preventScroll: true });
      },
      true,
    );
    this.root.addEventListener("mousedown", (e) => e.stopPropagation());
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const toolBtn = target?.closest<HTMLElement>("[data-tool]");
      if (toolBtn?.dataset.tool) {
        this.setTool(toolBtn.dataset.tool as "brush" | "eraser" | "marquee");
      }
      const colorBtn = target?.closest<HTMLElement>("[data-color]");
      if (colorBtn?.dataset.color) this.setColor(colorBtn.dataset.color);
      const act = target?.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "undo") this.undo();
      if (act === "redo") this.redoAction();
      if (act === "invert") this.invert();
      if (act === "clear") this.clear();
      if (act === "cancel") this.close();
      if (act === "save") this.save();
      const outputMode = target?.closest<HTMLElement>("[data-output-mode]")?.dataset.outputMode;
      if (outputMode) this.switchOutputMode(outputMode);
      const outputColor = target?.closest<HTMLElement>("[data-output-color]")?.dataset.outputColor;
      if (outputColor) {
        this.outputColor = outputColor;
        this.brushColor = outputColor;
        this.activePaintColor = outputColor;
        this.updateOutputControls();
        this.refreshMaskDisplay();
      }
      this.keyboardSink.focus({ preventScroll: true });
    });
    this.outputOpacityInput.addEventListener("input", () => {
      this.outputOpacity = clamp(Number(this.outputOpacityInput.value), 0, 100);
      this.updateOutputControls();
      this.refreshMaskDisplay();
    });
    this.outputFillInput.addEventListener("change", () => {
      this.autoFillHoles = !!this.outputFillInput.checked;
      this.filledPaintValid = false;
      this.refreshMaskDisplay();
    });
    this.stage.addEventListener("mousedown", (e) => this.pointerDown(e));
    window.addEventListener("mousemove", (this._move = (e) => this.pointerMove(e)), true);
    window.addEventListener("mouseup", (this._up = () => this.pointerUp()), true);
    this.stage.addEventListener("mouseleave", () => {
      this.cursor.style.display = "none";
    });
    this.stage.addEventListener("contextmenu", (e) => e.preventDefault());
    this.root.addEventListener("contextmenu", (e) => {
      const swatch = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-output-color]");
      if (!swatch?.dataset.outputColor || this.outputMode !== "color") return;
      e.preventDefault();
      this.setColor(swatch.dataset.outputColor);
    });
    this.stage.addEventListener("wheel", (this._wheel = (e) => this.wheel(e)), {
      passive: false,
    });
    window.addEventListener("keydown", (this._keyDown = (e) => this.keyDown(e)), true);
    window.addEventListener("keyup", (this._keyUp = (e) => this.keyUp(e)), true);
    window.addEventListener("resize", (this._resize = () => this.redrawMarquee()));
  }

  async init() {
    try {
      const srcImg = await loadImage(this.imageUrl);
      if (this.closed) return;
      this.sourceImage = srcImg;
      const natW = srcImg.naturalWidth || srcImg.width;
      const natH = srcImg.naturalHeight || srcImg.height;
      const longSide = Math.max(natW, natH);
      const sf = longSide > MAX_EDIT_LONG_SIDE ? MAX_EDIT_LONG_SIDE / longSide : 1;
      this.natural = { w: natW, h: natH, sf };
      const editW = Math.max(1, Math.round(natW * sf));
      const editH = Math.max(1, Math.round(natH * sf));

      const editCanvas = document.createElement("canvas");
      editCanvas.width = editW;
      editCanvas.height = editH;
      editCanvas.getContext("2d")!.drawImage(srcImg, 0, 0, editW, editH);
      this.editImageCanvas = editCanvas;
      const previewUrl = await canvasToObjectUrl(editCanvas, "image/png");
      if (this.closed) {
        URL.revokeObjectURL(previewUrl);
        return;
      }
      this.previewObjectUrl = previewUrl;
      this.img.src = previewUrl;

      this.paint.width = editW;
      this.paint.height = editH;
      this.shapeMask.width = editW;
      this.shapeMask.height = editH;
      this.rawPaint.width = editW;
      this.rawPaint.height = editH;
      this.filledPaint.width = editW;
      this.filledPaint.height = editH;

      await this.loadInitialStrokes(editW, editH);
      if (this.closed) return;
      this.initializeColorLayers(editW, editH);
      this.colorModePaint = this.cloneCanvas(this.rawPaint);
      if (this.outputMode === "original") {
        this.maskModeBasePaint = this.cloneCanvas(this.rawPaint);
        this.maskModeChangesDirty = false;
        this.brushColor = this.maskBrushColor;
        this.activePaintColor = this.maskBrushColor;
        this.recolorMask();
      }
      this.maskModePaint = this.cloneCanvas(this.rawPaint);
      this.refreshMaskDisplay();
      this.dims.textContent = `${editW} × ${editH}${
        sf < 1 ? `  (原图 ${natW} × ${natH})` : ""
      }`;
      this.frame.style.display = "inline-block";
      this.loading.style.display = "none";
      this.pushHistory();
      this.startMarqueeAnimation();
      this.updateToolbar();
    } catch (err) {
      this.loading.className = "guhai-mask-error";
      this.loading.textContent = `图片加载失败: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  async loadInitialStrokes(editW: number, editH: number) {
    if (!this.strokesUrl) return;
    try {
      const strokeImg = await loadImage(this.strokesUrl);
      const ctx = this.rawPaint.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, editW, editH);
      ctx.drawImage(strokeImg, 0, 0, editW, editH);
    } catch {
      // Best-effort restore
    }
  }

  initializeColorLayers(editW: number, editH: number) {
    this.colorLayers.clear();
    for (const name of this.colorOrder) {
      const canvas = document.createElement("canvas");
      canvas.width = editW;
      canvas.height = editH;
      this.colorLayers.set(name, canvas);
      const filled = document.createElement("canvas");
      filled.width = editW;
      filled.height = editH;
      this.filledColorLayers.set(name, filled);
    }
    this.syncColorLayersFromRawPaint();
    this.composeColorLayers();
  }

  composeColorLayers() {
    if (!this.colorLayers.size || !this.rawPaint.width) return;
    const ctx = this.rawPaint.getContext("2d")!;
    ctx.clearRect(0, 0, this.rawPaint.width, this.rawPaint.height);
    for (const name of this.colorOrder) {
      const layer = this.colorLayers.get(name);
      if (layer) ctx.drawImage(layer, 0, 0);
    }
    this.filledPaintValid = false;
  }

  syncColorLayersFromRawPaint() {
    if (!this.colorLayers.size || !this.rawPaint.width) return;
    const w = this.rawPaint.width;
    const h = this.rawPaint.height;
    const source = this.rawPaint.getContext("2d")!.getImageData(0, 0, w, h).data;
    const layerImages = new Map<string, ImageData>();
    const palette = this.colorOrder.map((name) => ({
      name,
      rgb: this.hexRgb(this.outputColors[name] || "#ff3030"),
    }));
    for (const name of this.colorOrder) {
      const layer = this.colorLayers.get(name)!;
      layerImages.set(name, layer.getContext("2d")!.createImageData(w, h));
    }
    for (let offset = 0; offset < source.length; offset += 4) {
      if ((source[offset + 3] ?? 0) <= 5) continue;
      let best = palette[0]!;
      let bestDistance = Infinity;
      for (const entry of palette) {
        const dr = (source[offset] ?? 0) - (entry.rgb[0] ?? 0);
        const dg = (source[offset + 1] ?? 0) - (entry.rgb[1] ?? 0);
        const db = (source[offset + 2] ?? 0) - (entry.rgb[2] ?? 0);
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          best = entry;
          bestDistance = distance;
        }
      }
      const target = layerImages.get(best.name)!.data;
      target[offset] = best.rgb[0] ?? 0;
      target[offset + 1] = best.rgb[1] ?? 0;
      target[offset + 2] = best.rgb[2] ?? 0;
      target[offset + 3] = source[offset + 3] ?? 255;
    }
    for (const [name, image] of layerImages) {
      this.colorLayers.get(name)!.getContext("2d")!.putImageData(image, 0, 0);
    }
    this.dirtyFilledColors = new Set(this.colorOrder);
    this.colorModePaint = this.cloneCanvas(this.rawPaint);
    this.filledPaintValid = false;
  }

  activeColorLayer() {
    return (
      this.colorLayers.get(this.outputColor) ||
      this.colorLayers.get("red") ||
      this.rawPaint
    );
  }

  switchOutputMode(mode: string) {
    const nextMode = mode === "color" ? "color" : "original";
    if (nextMode === this.outputMode) return;
    if (nextMode === "original") {
      this.composeColorLayers();
      this.maskModeBasePaint = this.cloneCanvas(this.rawPaint);
      this.maskModeChangesDirty = false;
      this.colorModePaint = this.cloneCanvas(this.rawPaint);
      this.outputMode = nextMode;
      this.brushColor = this.maskBrushColor;
      this.activePaintColor = this.maskBrushColor;
      this.recolorMask();
    } else {
      this.mergeMaskModeChanges();
      this.outputMode = nextMode;
      this.brushColor = this.outputColor || "red";
      this.activePaintColor = this.brushColor;
      this.composeColorLayers();
    }
    this.filledPaintValid = false;
    this.updateOutputControls();
    this.refreshMaskDisplay();
  }

  cloneCanvas(source: HTMLCanvasElement) {
    const target = document.createElement("canvas");
    target.width = source.width;
    target.height = source.height;
    target.getContext("2d")!.drawImage(source, 0, 0);
    return target;
  }

  updateOutputControls() {
    this.root.querySelectorAll<HTMLElement>("[data-output-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.outputMode === this.outputMode);
    });
    this.root.querySelectorAll<HTMLElement>("[data-output-color]").forEach((button) => {
      button.classList.toggle("active", button.dataset.outputColor === this.outputColor);
    });
    this.outputOpacityInput.value = String(this.outputOpacity);
    this.outputOpacityValue.textContent = `${this.outputOpacity}%`;
    const colorMode = this.outputMode === "color";
    if (colorMode && this.outputColor) {
      this.brushColor = this.outputColor;
      this.activePaintColor = this.outputColor;
    } else if (!colorMode) {
      this.brushColor = this.maskBrushColor;
      this.activePaintColor = this.maskBrushColor;
    }
    this.outputColorRow.style.display = colorMode ? "flex" : "none";
    if (this.outputOpacityRow) {
      this.outputOpacityRow.style.display = colorMode ? "flex" : "none";
    }
  }

  setTool(tool: "brush" | "eraser" | "marquee") {
    if (tool !== "marquee" && this.marqueeRects.length) {
      this.fillMarqueeIntoMask();
    }
    this.tool = tool;
    this.updateToolbar();
    this.filledPaintValid = false;
    this.refreshMaskDisplay();
  }

  setColor(color: string) {
    this.maskBrushColor = color;
    this.root.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => {
      b.classList.toggle("active", b.dataset.color === color);
    });
    if (this.outputMode !== "color") {
      this.brushColor = color;
      this.activePaintColor = color;
      this.recolorMask();
    }
    this.refreshMaskDisplay();
    this.updateCursor();
  }

  rebuildFilledPaint() {
    if (!this.rawPaint.width || this.tool === "marquee") {
      this.filledPaintValid = false;
      return;
    }
    this.rebuildSingleColorFill(this.rawPaint, this.filledPaint, this.colorRgb());
    this.filledPaintValid = true;
  }

  rebuildSingleColorFill(
    layer: HTMLCanvasElement,
    target: HTMLCanvasElement,
    rgb: number[],
  ) {
    const w = layer.width;
    const h = layer.height;
    const source = layer.getContext("2d")!.getImageData(0, 0, w, h);
    const result = target.getContext("2d")!.createImageData(w, h);
    const wall = new Uint8Array(w * h);
    let minX = w,
      minY = h,
      maxX = -1,
      maxY = -1;
    for (let index = 0; index < wall.length; index++) {
      if ((source.data[index * 4 + 3] ?? 0) <= 5) continue;
      wall[index] = 1;
      const x = index % w;
      const y = (index / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < 0) {
      target.getContext("2d")!.clearRect(0, 0, w, h);
      return;
    }
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(w - 1, maxX + 1);
    maxY = Math.min(h - 1, maxY + 1);
    const outside = new Uint8Array(w * h);
    const queue = new Int32Array((maxX - minX + 1) * (maxY - minY + 1));
    let head = 0,
      tail = 0;
    const visit = (x: number, y: number) => {
      if (x < minX || y < minY || x > maxX || y > maxY) return;
      const index = y * w + x;
      if (wall[index] || outside[index]) return;
      outside[index] = 1;
      queue[tail++] = index;
    };
    for (let x = minX; x <= maxX; x++) {
      visit(x, minY);
      visit(x, maxY);
    }
    for (let y = minY; y <= maxY; y++) {
      visit(minX, y);
      visit(maxX, y);
    }
    while (head < tail) {
      const index = queue[head++] ?? 0;
      const x = index % w;
      const y = (index / w) | 0;
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const index = y * w + x;
        if (!wall[index] && outside[index]) continue;
        const off = index * 4;
        result.data[off] = rgb[0] ?? 0;
        result.data[off + 1] = rgb[1] ?? 0;
        result.data[off + 2] = rgb[2] ?? 0;
        result.data[off + 3] = 255;
      }
    }
    target.getContext("2d")!.putImageData(result, 0, 0);
  }

  rebuildFilledColorLayers(names: string[] | null = null) {
    if (!this.colorLayers.size) {
      this.rebuildFilledPaint();
      return;
    }
    const rebuildNames = names || [...this.dirtyFilledColors];
    for (const name of rebuildNames) {
      const layer = this.colorLayers.get(name);
      const filledLayer = this.filledColorLayers.get(name);
      if (!layer || !filledLayer) continue;
      this.rebuildSingleColorFill(
        layer,
        filledLayer,
        this.hexRgb(this.outputColors[name] || "#ff3030"),
      );
      this.dirtyFilledColors.delete(name);
    }
    const output = this.filledPaint.getContext("2d")!;
    output.clearRect(0, 0, this.filledPaint.width, this.filledPaint.height);
    for (const name of this.colorOrder) {
      const fl = this.filledColorLayers.get(name);
      if (fl) output.drawImage(fl, 0, 0);
    }
    this.filledPaintValid = true;
  }

  effectiveMaskImageData() {
    const source =
      this.autoFillHoles && this.tool !== "marquee" && this.filledPaintValid
        ? this.filledPaint
        : this.rawPaint;
    const data = source
      .getContext("2d")!
      .getImageData(0, 0, source.width, source.height);
    if (!this.maskInverted) return data;
    const [r, g, b] =
      this.outputMode === "color" ? this.outputColorRgb() : this.colorRgb();
    for (let i = 0; i < data.data.length; i += 4) {
      if ((data.data[i + 3] ?? 0) > 5) {
        data.data[i] = 0;
        data.data[i + 1] = 0;
        data.data[i + 2] = 0;
        data.data[i + 3] = 0;
      } else {
        data.data[i] = r ?? 255;
        data.data[i + 1] = g ?? 0;
        data.data[i + 2] = b ?? 0;
        data.data[i + 3] = 255;
      }
    }
    return data;
  }

  saveMaskImageData() {
    if (this.autoFillHoles && this.tool !== "marquee" && !this.filledPaintValid) {
      if (this.outputMode === "color") this.rebuildFilledColorLayers();
      else this.rebuildFilledPaint();
    }
    return this.effectiveMaskImageData();
  }

  outputColorRgb() {
    const hex = String(this.outputColors[this.outputColor] || "#fff").replace("#", "");
    const value =
      hex.length === 3
        ? hex
            .split("")
            .map((part) => part + part)
            .join("")
        : hex;
    return [0, 1, 2].map((index) => {
      const channel = parseInt(value.slice(index * 2, index * 2 + 2), 16);
      return Number.isFinite(channel) ? channel : 255;
    });
  }

  refreshMaskDisplay(rebuildFill = true) {
    if (!this.rawPaint.width) return;
    if (
      rebuildFill &&
      this.autoFillHoles &&
      this.tool !== "marquee" &&
      !this.filledPaintValid
    ) {
      if (this.outputMode === "color") this.rebuildFilledColorLayers();
      else this.rebuildFilledPaint();
    }
    const source =
      !rebuildFill && this.tool !== "marquee" && this.drawingPreviewPaint
        ? this.drawingPreviewPaint
        : rebuildFill &&
            this.autoFillHoles &&
            this.tool !== "marquee" &&
            this.filledPaintValid
          ? this.filledPaint
          : this.rawPaint;
    const ctx = this.paint.getContext("2d")!;
    ctx.clearRect(0, 0, this.paint.width, this.paint.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (this.maskInverted) {
      ctx.putImageData(this.effectiveMaskImageData(), 0, 0);
    } else {
      ctx.drawImage(source, 0, 0);
    }
    this.paint.style.opacity =
      this.outputMode === "color" ? String(this.outputOpacity / 100) : ".5";
    this.paint.style.filter = "none";
  }

  refreshDrawingPreview() {
    if (this.drawingPreviewRaf) return;
    this.drawingPreviewRaf = requestAnimationFrame(() => {
      this.drawingPreviewRaf = 0;
      if (!this.isDrawing || !this.drawingPreviewPaint) return;
      const ctx = this.paint.getContext("2d")!;
      ctx.clearRect(0, 0, this.paint.width, this.paint.height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (this.maskInverted) {
        const data = this.drawingPreviewPaint
          .getContext("2d")!
          .getImageData(0, 0, this.paint.width, this.paint.height);
        const [r, g, b] =
          this.outputMode === "color" ? this.outputColorRgb() : this.colorRgb();
        for (let i = 0; i < data.data.length; i += 4) {
          if ((data.data[i + 3] ?? 0) > 5) data.data[i + 3] = 0;
          else {
            data.data[i] = r ?? 255;
            data.data[i + 1] = g ?? 0;
            data.data[i + 2] = b ?? 0;
            data.data[i + 3] = 255;
          }
        }
        ctx.putImageData(data, 0, 0);
      } else {
        ctx.drawImage(this.drawingPreviewPaint, 0, 0);
      }
      this.paint.style.opacity =
        this.outputMode === "color" ? String(this.outputOpacity / 100) : ".5";
      this.paint.style.filter = "none";
    });
  }

  updateToolbar() {
    this.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === this.tool);
    });
    const marquee = this.tool === "marquee";
    this.sizeText.style.visibility = marquee ? "hidden" : "";
    this.hint.textContent = marquee
      ? "Shift=1:1/加选区 · Alt=减选区 · 框内拖动移动 · 外部单击取消"
      : "鼠标右键左右拖动调整画笔大小";
    this.updateCursor();
  }

  keyDown(e: KeyboardEvent) {
    if (this.isEditable(e.target) && e.target !== this.keyboardSink) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = String(e.key || "");
    const code = String(e.code || "");
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    };
    if (ctrl && !e.shiftKey && (code === "KeyZ" || key.toLowerCase() === "z")) {
      consume();
      this.undo();
      return;
    }
    if (
      ctrl &&
      e.shiftKey &&
      (code === "KeyZ" ||
        code === "KeyY" ||
        key.toLowerCase() === "z" ||
        key.toLowerCase() === "y")
    ) {
      consume();
      this.redoAction();
      return;
    }
    if (ctrl && !e.shiftKey && (code === "KeyI" || key.toLowerCase() === "i")) {
      consume();
      this.invert();
      return;
    }
    if (!ctrl && code === "KeyB") {
      consume();
      this.setTool("brush");
      return;
    }
    if (!ctrl && code === "KeyE") {
      consume();
      this.setTool("eraser");
      return;
    }
    if (!ctrl && code === "KeyM") {
      consume();
      this.setTool("marquee");
      return;
    }
    if (!ctrl && code === "KeyX") {
      consume();
      this.clear();
      return;
    }
    if (!ctrl && code === "KeyF") {
      consume();
      this.autoFillHoles = !this.autoFillHoles;
      this.outputFillInput.checked = this.autoFillHoles;
      this.filledPaintValid = false;
      this.refreshMaskDisplay();
      return;
    }
    if (!ctrl && (code === "Enter" || code === "NumpadEnter" || key === "Enter")) {
      consume();
      this.save();
      return;
    }
    if (!ctrl && (code === "Escape" || key === "Escape")) {
      consume();
      this.close();
      return;
    }
    if (!ctrl && (code === "BracketLeft" || key === "[" || key === "【")) {
      consume();
      this.setBrushSize(this.brushSize - 5);
      return;
    }
    if (!ctrl && (code === "BracketRight" || key === "]" || key === "】")) {
      consume();
      this.setBrushSize(this.brushSize + 5);
      return;
    }
    if (code === "Space" || key === " ") {
      consume();
      this.spaceDown = true;
      this.updateCursor();
      return;
    }
    if (code === "AltLeft" || code === "AltRight" || key === "Alt") {
      consume();
      this.altDown = true;
      this.updateCursor();
      return;
    }
    if (
      (code === "ShiftLeft" || code === "ShiftRight" || key === "Shift") &&
      !this.shiftDown
    ) {
      consume();
      this.shiftDown = true;
      if (this.tool !== "marquee") {
        this.prevToolBeforeShift = this.tool;
        this.shiftTemp = true;
        this.shiftTempDrew = false;
        this.tool = "marquee";
        this.updateToolbar();
      }
    }
  }

  keyUp(e: KeyboardEvent) {
    if (this.isEditable(e.target) && e.target !== this.keyboardSink) return;
    const code = String(e.code || "");
    if (code === "Space" || e.key === " ") {
      this.spaceDown = false;
      this.updateCursor();
    }
    if (code === "AltLeft" || code === "AltRight" || e.key === "Alt") {
      this.altDown = false;
      this.updateCursor();
    }
    if (code === "ShiftLeft" || code === "ShiftRight" || e.key === "Shift") {
      this.shiftDown = false;
      if (this.shiftTemp) {
        if (!this.shiftTempDrew && this.prevToolBeforeShift) {
          this.tool = this.prevToolBeforeShift;
        }
        this.shiftTemp = false;
        this.prevToolBeforeShift = null;
        this.updateToolbar();
      }
    }
  }

  isEditable(t: EventTarget | null) {
    return (
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    );
  }

  setBrushSize(v: number) {
    this.brushSize = clamp(v, 2, 300);
    this.sizeText.textContent = `${this.brushSize}px`;
    this.updateCursor();
  }

  wheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const next = clamp(this.scale * factor, 0.05, 12);
    const rect = this.stage.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2;
    const my = e.clientY - rect.top - rect.height / 2;
    const ratio = next / this.scale;
    this.offset = {
      x: mx + (this.offset.x - mx) * ratio,
      y: my + (this.offset.y - my) * ratio,
    };
    this.scale = next;
    this.applyTransform();
  }

  applyTransform() {
    this.frame.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;
    this.updateCursor();
    this.redrawMarquee();
  }

  canvasPos(e: MouseEvent) {
    const r = this.paint.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * this.paint.width) / r.width,
      y: ((e.clientY - r.top) * this.paint.height) / r.height,
    };
  }

  pointerDown(e: MouseEvent) {
    if ((e.target as HTMLElement | null)?.closest?.(".guhai-mask-output-panel")) {
      this.cursor.style.display = "none";
      return;
    }
    if (!this.paint.width) return;
    this.lastMouse = { x: e.clientX, y: e.clientY };

    let colorContext: NonNullable<YoYoMaskEditor["rightResize"]>["colorContext"] = null;
    if (e.button === 2 && this.outputMode === "color" && this.tool !== "marquee") {
      const pos = this.canvasPos(e);
      if (!this.filledPaintValid || this.dirtyFilledColors.size) {
        this.rebuildFilledColorLayers([...this.dirtyFilledColors]);
      }
      let hit: { name: string } | null = null;
      for (let i = this.colorOrder.length - 1; i >= 0; i--) {
        const name = this.colorOrder[i]!;
        const layer = this.filledColorLayers.get(name);
        if (!layer) continue;
        const px = clamp(Math.floor(pos.x), 0, layer.width - 1);
        const py = clamp(Math.floor(pos.y), 0, layer.height - 1);
        const pixel = layer.getContext("2d")!.getImageData(px, py, 1, 1).data;
        if ((pixel[3] ?? 0) > 5) {
          hit = { name };
          break;
        }
      }
      if (hit) {
        colorContext = {
          x: e.clientX,
          y: e.clientY,
          rgb: this.hexRgb(this.outputColors[hit.name] || "#ff3030"),
          pos,
          sourceName: hit.name,
        };
      }
    }

    if (e.button === 2 && this.tool !== "marquee") {
      e.preventDefault();
      this.closeColorContextMenu();
      this.rightResize = {
        x: e.clientX,
        y: e.clientY,
        size: this.brushSize,
        moved: false,
        colorContext,
      };
      return;
    }

    if (this.spaceDown || e.button === 1) {
      this.isPanning = true;
      this.panStart = {
        x: e.clientX,
        y: e.clientY,
        ox: this.offset.x,
        oy: this.offset.y,
      };
      return;
    }

    if (this.tool === "marquee") {
      this.marqueeDown(e);
      return;
    }
    if (e.button !== 0) return;

    if (this.marqueeRects.length) this.fillMarqueeIntoMask();
    if (!this.filledPaintValid && this.autoFillHoles) {
      if (this.outputMode === "color") {
        this.rebuildFilledColorLayers([...this.dirtyFilledColors]);
      } else {
        this.rebuildFilledPaint();
      }
    }
    this.drawingPreviewPaint = document.createElement("canvas");
    this.drawingPreviewPaint.width = this.rawPaint.width;
    this.drawingPreviewPaint.height = this.rawPaint.height;
    this.drawingPreviewPaint
      .getContext("2d")!
      .drawImage(this.autoFillHoles ? this.filledPaint : this.rawPaint, 0, 0);

    this.isDrawing = true;
    this.lastDrawClient = { x: e.clientX, y: e.clientY };
    this.drawingColor = this.outputColor;
    if (this.outputMode === "color") this.dirtyFilledColors.add(this.drawingColor);
    this.filledPaintValid = false;
    this.lastPos = this.canvasPos(e);

    const ctx = (
      this.outputMode === "color" ? this.activeColorLayer() : this.rawPaint
    ).getContext("2d")!;
    this.applyBrush(ctx);
    ctx.beginPath();
    ctx.arc(this.lastPos.x, this.lastPos.y, this.brushSize / 2, 0, Math.PI * 2);
    ctx.fill();

    if (this.drawingPreviewPaint) {
      const previewCtx = this.drawingPreviewPaint.getContext("2d")!;
      this.applyBrush(previewCtx);
      previewCtx.beginPath();
      previewCtx.arc(
        this.lastPos.x,
        this.lastPos.y,
        this.brushSize / 2,
        0,
        Math.PI * 2,
      );
      previewCtx.fill();
    }
    this.refreshDrawingPreview();
  }

  pointerMove(e: MouseEvent) {
    this.lastMouse = { x: e.clientX, y: e.clientY };
    if (this.rightResize) {
      e.preventDefault();
      const dx = e.clientX - this.rightResize.x;
      const dy = e.clientY - this.rightResize.y;
      if (!this.rightResize.moved && Math.hypot(dx, dy) >= 5) {
        this.rightResize.moved = true;
        this.rightResize.colorContext = null;
      }
      if (this.rightResize.moved) {
        this.setBrushSize(this.rightResize.size + Math.round(dx / 2));
      }
      return;
    }
    this.updateCursor(e);
    if (this.isPanning && this.panStart) {
      this.offset = {
        x: this.panStart.ox + e.clientX - this.panStart.x,
        y: this.panStart.oy + e.clientY - this.panStart.y,
      };
      this.applyTransform();
      return;
    }
    if (this.tool === "marquee" && this.marqueeAction !== "none") {
      this.marqueeMoveAction(e);
      return;
    }
    if (!this.isDrawing || !this.lastPos) return;
    if (
      this.lastDrawClient &&
      Math.hypot(
        e.clientX - this.lastDrawClient.x,
        e.clientY - this.lastDrawClient.y,
      ) < 2.5
    ) {
      return;
    }
    this.lastDrawClient = { x: e.clientX, y: e.clientY };
    const pos = this.canvasPos(e);
    const ctx = (
      this.outputMode === "color" ? this.activeColorLayer() : this.rawPaint
    ).getContext("2d")!;
    this.filledPaintValid = false;
    this.applyBrush(ctx);
    ctx.beginPath();
    ctx.moveTo(this.lastPos.x, this.lastPos.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();

    if (this.drawingPreviewPaint) {
      const previewCtx = this.drawingPreviewPaint.getContext("2d")!;
      this.applyBrush(previewCtx);
      previewCtx.beginPath();
      previewCtx.moveTo(this.lastPos.x, this.lastPos.y);
      previewCtx.lineTo(pos.x, pos.y);
      previewCtx.stroke();
    }
    this.lastPos = pos;
    this.refreshDrawingPreview();
  }

  pointerUp() {
    if (this.rightResize) {
      const gesture = this.rightResize;
      this.rightResize = null;
      if (!gesture.moved && gesture.colorContext) {
        const hit = gesture.colorContext;
        this.openColorContextMenu(hit.x, hit.y, hit.rgb, hit.pos, hit.sourceName);
      }
      return;
    }
    if (this.isPanning) {
      this.isPanning = false;
      return;
    }
    if (this.tool === "marquee" && this.marqueeAction !== "none") {
      this.marqueeUp();
      return;
    }
    if (this.isDrawing) {
      this.isDrawing = false;
      this.lastDrawClient = null;
      if (this.drawingPreviewRaf) {
        cancelAnimationFrame(this.drawingPreviewRaf);
        this.drawingPreviewRaf = 0;
      }
      this.drawingPreviewPaint = null;
      if (this.outputMode === "color") this.composeColorLayers();
      this.pushHistory();
      if (this.outputMode === "color") {
        this.colorModePaint = this.cloneCanvas(this.rawPaint);
      } else {
        this.maskModeChangesDirty = true;
      }
      if (this.autoFillHoles && this.outputMode === "color") {
        const color = this.drawingColor;
        const revision = ++this.fillRevision;
        setTimeout(() => {
          if (revision !== this.fillRevision || !this.autoFillHoles || this.closed) return;
          this.rebuildFilledColorLayers(color ? [color] : null);
          this.refreshMaskDisplay(true);
        }, 0);
      } else if (this.autoFillHoles) {
        const revision = ++this.fillRevision;
        setTimeout(() => {
          if (revision !== this.fillRevision || !this.autoFillHoles || this.closed) return;
          this.rebuildFilledPaint();
          this.refreshMaskDisplay(true);
        }, 0);
      } else {
        this.refreshMaskDisplay();
      }
      this.drawingColor = null;
    }
  }

  applyBrush(ctx: CanvasRenderingContext2D) {
    const eraser = this.tool === "eraser" || this.altDown;
    ctx.lineWidth = this.brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    const strokeHex = eraser ? "#fff" : this.colors[this.brushColor] || "#ff3030";
    ctx.strokeStyle = strokeHex;
    ctx.fillStyle = strokeHex;
  }

  colorComponent(
    rgb: number[],
    forcedSourceName: string | null = null,
    useFilled = false,
  ) {
    const w = this.rawPaint.width;
    const h = this.rawPaint.height;
    const sourceName =
      forcedSourceName ||
      this.colorOrder.find((name) => {
        const c = this.hexRgb(this.outputColors[name] || "#ff3030");
        return (
          ((c[0] ?? 0) - (rgb[0] ?? 0)) ** 2 +
            ((c[1] ?? 0) - (rgb[1] ?? 0)) ** 2 +
            ((c[2] ?? 0) - (rgb[2] ?? 0)) ** 2 <=
          55 * 55
        );
      });
    const source = sourceName
      ? useFilled
        ? this.filledColorLayers.get(sourceName)
        : this.colorLayers.get(sourceName)
      : null;
    const data = (source || this.rawPaint)
      .getContext("2d")!
      .getImageData(0, 0, w, h).data;
    const same = (index: number) => {
      if ((data[index * 4 + 3] ?? 0) <= 5) return false;
      const dr = (data[index * 4] ?? 0) - (rgb[0] ?? 0);
      const dg = (data[index * 4 + 1] ?? 0) - (rgb[1] ?? 0);
      const db = (data[index * 4 + 2] ?? 0) - (rgb[2] ?? 0);
      return dr * dr + dg * dg + db * db <= 55 * 55;
    };
    const components: number[][] = [];
    const visited = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!same(i) || visited[i]) continue;
      const queue = [i];
      const cells: number[] = [];
      visited[i] = 1;
      for (let head = 0; head < queue.length; head++) {
        const index = queue[head]!;
        cells.push(index);
        const x = index % w;
        const y = Math.floor(index / w);
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!visited[ni] && same(ni)) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }
      components.push(cells);
    }
    return components;
  }

  openColorContextMenu(
    x: number,
    y: number,
    rgb: number[],
    point: { x: number; y: number } | null = null,
    sourceName: string | null = null,
  ) {
    this.closeColorContextMenu();
    const menu = document.createElement("div");
    menu.className = "guhai-mask-color-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const [name, color] of Object.entries(this.outputColors)) {
      const button = document.createElement("button");
      button.title = name;
      button.style.background = color;
      button.addEventListener("click", () => {
        this.modifyColorComponent(rgb, name, point, sourceName);
        this.closeColorContextMenu();
      });
      menu.appendChild(button);
    }
    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "删除连续区域";
    del.addEventListener("click", () => {
      this.modifyColorComponent(rgb, null, point, sourceName);
      this.closeColorContextMenu();
    });
    menu.appendChild(del);
    document.body.appendChild(menu);
    this._colorMenu = menu;
    setTimeout(() => {
      this._colorMenuOutside = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) this.closeColorContextMenu();
      };
      window.addEventListener("mousedown", this._colorMenuOutside, true);
    }, 0);
  }

  closeColorContextMenu() {
    this._colorMenu?.remove();
    this._colorMenu = null;
    if (this._colorMenuOutside) {
      window.removeEventListener("mousedown", this._colorMenuOutside, true);
    }
    this._colorMenuOutside = null;
  }

  modifyColorComponent(
    rgb: number[],
    colorName: string | null,
    point: { x: number; y: number } | null = null,
    forcedSourceName: string | null = null,
  ) {
    const components = this.colorComponent(rgb, forcedSourceName, !!forcedSourceName);
    let target = components[0];
    if (point) {
      const index = Math.floor(point.y) * this.rawPaint.width + Math.floor(point.x);
      target = components.find((cells) => cells.includes(index)) || target;
    }
    if (!target) return;
    const sourceName =
      forcedSourceName ||
      this.colorOrder.find((name) => {
        const c = this.hexRgb(this.outputColors[name] || "#ff3030");
        return (
          ((c[0] ?? 0) - (rgb[0] ?? 0)) ** 2 +
            ((c[1] ?? 0) - (rgb[1] ?? 0)) ** 2 +
            ((c[2] ?? 0) - (rgb[2] ?? 0)) ** 2 <=
          55 * 55
        );
      }) ||
      this.outputColor;
    const source = this.colorLayers.get(sourceName);
    const targetLayer = colorName ? this.colorLayers.get(colorName) : null;
    const ctx = (source || this.rawPaint).getContext("2d")!;
    const data = ctx.getImageData(0, 0, this.rawPaint.width, this.rawPaint.height);
    const targetData =
      targetLayer && targetLayer !== source
        ? targetLayer
            .getContext("2d")!
            .getImageData(0, 0, this.rawPaint.width, this.rawPaint.height)
        : null;
    const rgb2 = colorName
      ? this.hexRgb(this.outputColors[colorName] || "#ff3030")
      : [0, 0, 0];
    for (const index of target) {
      const off = index * 4;
      if ((data.data[off + 3] ?? 0) <= 5) continue;
      if (targetData) {
        targetData.data[off] = rgb2[0] ?? 0;
        targetData.data[off + 1] = rgb2[1] ?? 0;
        targetData.data[off + 2] = rgb2[2] ?? 0;
        targetData.data[off + 3] = data.data[off + 3] ?? 255;
      } else if (colorName) {
        data.data[off] = rgb2[0] ?? 0;
        data.data[off + 1] = rgb2[1] ?? 0;
        data.data[off + 2] = rgb2[2] ?? 0;
      }
      if (!colorName || targetData) {
        data.data[off] = 0;
        data.data[off + 1] = 0;
        data.data[off + 2] = 0;
        data.data[off + 3] = 0;
      }
    }
    ctx.putImageData(data, 0, 0);
    if (targetData && targetLayer) {
      targetLayer.getContext("2d")!.putImageData(targetData, 0, 0);
    }
    this.dirtyFilledColors.add(sourceName);
    if (colorName) this.dirtyFilledColors.add(colorName);
    this.composeColorLayers();
    this.filledPaintValid = false;
    this.pushHistory();
    this.refreshMaskDisplay();
  }

  hexRgb(hex: string) {
    const v = String(hex).replace("#", "");
    return [0, 1, 2].map((i) => parseInt(v.slice(i * 2, i * 2 + 2), 16) || 0);
  }

  mergeMaskModeChanges() {
    if (!this.maskModeChangesDirty || !this.maskModeBasePaint || !this.colorLayers.size) {
      return;
    }
    const w = this.rawPaint.width;
    const h = this.rawPaint.height;
    const current = this.rawPaint.getContext("2d")!.getImageData(0, 0, w, h);
    const base = this.maskModeBasePaint.getContext("2d")!.getImageData(0, 0, w, h).data;
    const selectedName = this.outputColor || "red";
    const selected = this.hexRgb(this.outputColors[selectedName] || "#ff3030");
    const layerData = new Map<string, ImageData>();
    for (const [name, layer] of this.colorLayers) {
      layerData.set(name, layer.getContext("2d")!.getImageData(0, 0, w, h));
    }
    let changed = false;
    for (let i = 0; i < current.data.length; i += 4) {
      const was = (base[i + 3] ?? 0) > 5;
      const is = (current.data[i + 3] ?? 0) > 5;
      if (was === is) continue;
      changed = true;
      if (!is) {
        for (const data of layerData.values()) {
          data.data[i] = 0;
          data.data[i + 1] = 0;
          data.data[i + 2] = 0;
          data.data[i + 3] = 0;
        }
      } else {
        const data =
          layerData.get(selectedName) ||
          layerData.get("red") ||
          [...layerData.values()][0]!;
        data.data[i] = selected[0] ?? 255;
        data.data[i + 1] = selected[1] ?? 0;
        data.data[i + 2] = selected[2] ?? 0;
        data.data[i + 3] = current.data[i + 3] ?? 255;
      }
    }
    if (changed) {
      for (const [name, data] of layerData) {
        this.colorLayers.get(name)!.getContext("2d")!.putImageData(data, 0, 0);
      }
      this.dirtyFilledColors = new Set(this.colorOrder);
      this.filledPaintValid = false;
    }
    this.colorModePaint = this.cloneCanvas(this.rawPaint);
    this.maskModeBasePaint = this.cloneCanvas(this.rawPaint);
    this.maskModeChangesDirty = false;
  }

  updateCursor(e?: MouseEvent) {
    if (!this.lastMouse && !e) return;
    if ((e?.target as HTMLElement | null)?.closest?.(".guhai-mask-output-panel")) {
      this.cursor.style.display = "none";
      this.stage.style.cursor = "";
      return;
    }
    const p = e ? { x: e.clientX, y: e.clientY } : this.lastMouse;
    if (!p) return;
    if (this.spaceDown) {
      this.cursor.style.display = "none";
      this.stage.style.cursor = "grab";
      return;
    }
    if (this.tool === "marquee") {
      this.cursor.style.display = "none";
      this.stage.style.cursor = "crosshair";
      return;
    }
    this.stage.style.cursor = "none";
    const r = this.stage.getBoundingClientRect();
    const displayScale =
      (this.img.clientWidth || this.paint.getBoundingClientRect().width) /
      Math.max(1, this.paint.width);
    const size = Math.max(4, this.brushSize * this.scale * displayScale);
    Object.assign(this.cursor.style, {
      display: "block",
      width: `${size}px`,
      height: `${size}px`,
      left: `${p.x - r.left - size / 2}px`,
      top: `${p.y - r.top - size / 2}px`,
    });
  }

  pushHistory() {
    const ctx = this.rawPaint.getContext("2d")!;
    this.history.push({
      image: ctx.getImageData(0, 0, this.paint.width, this.paint.height),
      inverted: this.maskInverted,
    });
    if (this.history.length > 50) this.history.shift();
    this.redo = [];
  }

  invalidateFillAfterHistoryChange() {
    this.fillRevision++;
    this.filledPaintValid = false;
    if (this.outputMode === "color") this.syncColorLayersFromRawPaint();
    else this.maskModeChangesDirty = true;
  }

  undo() {
    if (this.history.length <= 1) return;
    const ctx = this.rawPaint.getContext("2d")!;
    const popped = this.history.pop();
    if (popped) this.redo.push(popped);
    const snapshot = this.history[this.history.length - 1];
    if (!snapshot) return;
    ctx.putImageData(snapshot.image, 0, 0);
    this.maskInverted = !!snapshot.inverted;
    this.invalidateFillAfterHistoryChange();
    this.clearMarquee();
    this.refreshMaskDisplay();
  }

  redoAction() {
    if (!this.redo.length) return;
    const snap = this.redo.pop();
    if (!snap) return;
    this.history.push(snap);
    this.rawPaint.getContext("2d")!.putImageData(snap.image, 0, 0);
    this.maskInverted = !!snap.inverted;
    this.invalidateFillAfterHistoryChange();
    this.clearMarquee();
    this.refreshMaskDisplay();
  }

  clear() {
    this.fillRevision++;
    this.isDrawing = false;
    this.lastDrawClient = null;
    if (this.drawingPreviewRaf) {
      cancelAnimationFrame(this.drawingPreviewRaf);
      this.drawingPreviewRaf = 0;
    }
    this.drawingPreviewPaint = null;
    if (this.outputMode === "color" && this.colorLayers.size) {
      for (const layer of this.colorLayers.values()) {
        layer.getContext("2d")!.clearRect(0, 0, layer.width, layer.height);
      }
      this.composeColorLayers();
    } else {
      this.rawPaint.getContext("2d")!.clearRect(0, 0, this.paint.width, this.paint.height);
    }
    this.filledPaint
      .getContext("2d")!
      .clearRect(0, 0, this.filledPaint.width, this.filledPaint.height);
    for (const layer of this.filledColorLayers.values()) {
      layer.getContext("2d")!.clearRect(0, 0, layer.width, layer.height);
    }
    this.dirtyFilledColors = new Set();
    this.filledPaintValid = false;
    this.maskInverted = false;
    if (this.outputMode !== "color") this.maskModeChangesDirty = true;
    this.clearMarquee();
    this.pushHistory();
    this.refreshMaskDisplay();
  }

  invert() {
    this.fillMarqueeIntoMask();
    this.maskInverted = !this.maskInverted;
    this.clearMarquee();
    this.pushHistory();
    this.refreshMaskDisplay();
  }

  colorRgb() {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = this.colors[this.brushColor] || "#ff3030";
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }

  recolorMask() {
    if (!this.paint.width) return;
    const ctx = this.rawPaint.getContext("2d")!;
    const data = ctx.getImageData(0, 0, this.paint.width, this.paint.height);
    const [r, g, b] = this.colorRgb();
    let changed = false;
    for (let i = 0; i < data.data.length; i += 4) {
      if ((data.data[i + 3] ?? 0) > 0) {
        data.data[i] = r ?? 0;
        data.data[i + 1] = g ?? 0;
        data.data[i + 2] = b ?? 0;
        changed = true;
      }
    }
    if (changed) {
      ctx.putImageData(data, 0, 0);
      this.filledPaintValid = false;
    }
  }

  clearMarquee() {
    this.marqueeRects = [];
    this.marqueeDraft = null;
    this.shapeMask
      .getContext("2d")!
      .clearRect(0, 0, this.shapeMask.width, this.shapeMask.height);
    this.marqueeEdgeDirty = true;
    this.redrawMarquee();
  }

  marqueeDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const pos = this.canvasPos(e);
    const inside = this.pointInShape(pos.x, pos.y);
    if (!this.shiftDown && !this.altDown && inside && this.marqueeRects.length) {
      this.marqueeAction = "move";
      this.marqueeMove = {
        start: pos,
        snap: this.cloneShape(),
        bbox: this.maskBBox(),
        rects: this.marqueeRects.map((r) => ({ ...r })),
        edgeCache: this.marqueeEdgeCache || this.buildMarqueeEdgeCache(),
      };
      return;
    }
    if (!this.shiftDown && !this.altDown) this.clearMarquee();
    this.marqueeAction = "draw";
    const square =
      this.shiftDown &&
      !this.shiftTemp &&
      !this.altDown &&
      this.marqueeRects.length === 0;
    const mode = this.altDown
      ? "subtract"
      : this.shiftDown && this.marqueeRects.length > 0
        ? "add"
        : "new";
    this.marqueeStart = { x: pos.x, y: pos.y, mode, square };
    this.marqueeDraft = { x: pos.x, y: pos.y, w: 0, h: 0 };
    this.marqueeEdgeDirty = true;
    this.redrawMarquee();
  }

  marqueeMoveAction(e: MouseEvent) {
    const pos = this.canvasPos(e);
    if (this.marqueeAction === "draw" && this.marqueeStart) {
      let w = pos.x - this.marqueeStart.x;
      let h = pos.y - this.marqueeStart.y;
      if (this.marqueeStart.square) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      this.marqueeDraft = this.normalizeRect(
        this.marqueeStart.x,
        this.marqueeStart.y,
        w,
        h,
      );
      this.marqueeEdgeDirty = true;
      this.redrawMarquee();
    }
    if (this.marqueeAction === "move" && this.marqueeMove) {
      const bbox = this.marqueeMove.bbox;
      let dx = Math.round(pos.x - this.marqueeMove.start.x);
      let dy = Math.round(pos.y - this.marqueeMove.start.y);
      if (bbox) {
        if (bbox.minX + dx < 0) dx = -bbox.minX;
        if (bbox.minY + dy < 0) dy = -bbox.minY;
        if (bbox.maxX + dx + 1 > this.paint.width) {
          dx = this.paint.width - bbox.maxX - 1;
        }
        if (bbox.maxY + dy + 1 > this.paint.height) {
          dy = this.paint.height - bbox.maxY - 1;
        }
      }
      this.marqueeMove.dx = dx;
      this.marqueeMove.dy = dy;
      this.marqueeEdgeDirty = false;
      const now = performance.now();
      if (now - this.lastMoveRedrawAt > 33) {
        this.lastMoveRedrawAt = now;
        this.redrawMarquee();
      }
    }
  }

  marqueeUp() {
    if (
      this.marqueeAction === "draw" &&
      this.marqueeDraft &&
      this.marqueeDraft.w > 1 &&
      this.marqueeDraft.h > 1
    ) {
      const r = this.clipRect(this.marqueeDraft);
      if (r.w > 0 && r.h > 0) {
        this.addRectToShape(r, this.marqueeStart?.mode === "subtract");
        if (this.marqueeStart?.mode === "subtract") {
          this.marqueeRects = this.rectsFromShape();
        } else {
          this.marqueeRects.push(r);
        }
        this.marqueeEdgeDirty = true;
        if (this.shiftTemp) {
          this.shiftTempDrew = true;
          this.tool = "marquee";
          this.shiftTemp = false;
          this.prevToolBeforeShift = null;
        }
      }
    }
    if (this.marqueeAction === "move" && this.marqueeMove) {
      const ctx = this.shapeMask.getContext("2d")!;
      ctx.clearRect(0, 0, this.shapeMask.width, this.shapeMask.height);
      ctx.drawImage(
        this.marqueeMove.snap,
        this.marqueeMove.dx || 0,
        this.marqueeMove.dy || 0,
      );
      this.marqueeRects = this.marqueeMove.rects.map((r) => ({
        x: r.x + (this.marqueeMove?.dx || 0),
        y: r.y + (this.marqueeMove?.dy || 0),
        w: r.w,
        h: r.h,
      }));
      this.marqueeEdgeDirty = true;
    }
    this.marqueeAction = "none";
    this.marqueeDraft = null;
    this.marqueeStart = null;
    this.marqueeMove = null;
    this.redrawMarquee();
    this.updateToolbar();
  }

  normalizeRect(x: number, y: number, w: number, h: number): Rect {
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    return { x, y, w, h };
  }

  clipRect(r: Rect): Rect {
    const x = clamp(r.x, 0, this.paint.width);
    const y = clamp(r.y, 0, this.paint.height);
    const x2 = clamp(r.x + r.w, 0, this.paint.width);
    const y2 = clamp(r.y + r.h, 0, this.paint.height);
    return { x, y, w: x2 - x, h: y2 - y };
  }

  addRectToShape(r: Rect, subtract: boolean) {
    const ctx = this.shapeMask.getContext("2d")!;
    ctx.save();
    ctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
    ctx.fillStyle = "#fff";
    ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
    ctx.restore();
  }

  pointInShape(x: number, y: number) {
    if (
      x < 0 ||
      y < 0 ||
      x >= this.shapeMask.width ||
      y >= this.shapeMask.height
    ) {
      return false;
    }
    return (
      (this.shapeMask
        .getContext("2d")!
        .getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] ?? 0) > 0
    );
  }

  cloneShape() {
    const c = document.createElement("canvas");
    c.width = this.shapeMask.width;
    c.height = this.shapeMask.height;
    c.getContext("2d")!.drawImage(this.shapeMask, 0, 0);
    return c;
  }

  maskBBox() {
    const d = this.shapeMask
      .getContext("2d")!
      .getImageData(0, 0, this.shapeMask.width, this.shapeMask.height).data;
    let minX = this.shapeMask.width,
      minY = this.shapeMask.height,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < this.shapeMask.height; y++) {
      for (let x = 0; x < this.shapeMask.width; x++) {
        if ((d[(y * this.shapeMask.width + x) * 4 + 3] ?? 0) > 0) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return maxX < minX ? null : { minX, minY, maxX, maxY };
  }

  rectsFromShape(): Rect[] {
    const bb = this.maskBBox();
    return bb
      ? [{ x: bb.minX, y: bb.minY, w: bb.maxX - bb.minX + 1, h: bb.maxY - bb.minY + 1 }]
      : [];
  }

  fillMarqueeIntoMask() {
    if (!this.maskBBox()) return;
    const eraser = this.altDown || this.tool === "eraser";
    if (this.outputMode === "color" && this.colorLayers.size) {
      const targets = eraser
        ? [...this.colorLayers.values()]
        : [this.activeColorLayer()];
      const colorHex = this.colors[this.brushColor] || "#ff3030";
      for (const layer of targets) {
        const lctx = layer.getContext("2d")!;
        lctx.save();
        lctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
        const stamp = document.createElement("canvas");
        stamp.width = this.paint.width;
        stamp.height = this.paint.height;
        const sctx = stamp.getContext("2d")!;
        sctx.fillStyle = colorHex;
        sctx.fillRect(0, 0, stamp.width, stamp.height);
        sctx.globalCompositeOperation = "destination-in";
        sctx.drawImage(this.shapeMask, 0, 0);
        lctx.drawImage(stamp, 0, 0);
        lctx.restore();
      }
      this.dirtyFilledColors = new Set(this.colorOrder);
      this.composeColorLayers();
    } else {
      const ctx = this.rawPaint.getContext("2d")!;
      const layer = document.createElement("canvas");
      layer.width = this.paint.width;
      layer.height = this.paint.height;
      const lctx = layer.getContext("2d")!;
      lctx.fillStyle = this.colors[this.brushColor] || "#ff3030";
      lctx.fillRect(0, 0, layer.width, layer.height);
      lctx.globalCompositeOperation = "destination-in";
      lctx.drawImage(this.shapeMask, 0, 0);
      ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
      ctx.drawImage(layer, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      this.maskModeChangesDirty = true;
    }
    this.clearMarquee();
    this.pushHistory();
    this.refreshMaskDisplay();
  }

  startMarqueeAnimation() {
    let last = performance.now();
    const tick = (now: number) => {
      if (this.closed) return;
      if (!document.hidden) {
        this.dashOffset = (this.dashOffset + (now - last) * 0.03) % 8;
        this.redrawMarquee();
      }
      last = now;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  buildMarqueeEdgeCache(): { points: [number, number][] } | null {
    if (!this.paint.width) return null;
    const mask = document.createElement("canvas");
    mask.width = this.paint.width;
    mask.height = this.paint.height;
    const mctx = mask.getContext("2d")!;
    if (this.marqueeMove?.snap) {
      mctx.drawImage(
        this.marqueeMove.snap,
        this.marqueeMove.dx || 0,
        this.marqueeMove.dy || 0,
      );
    } else {
      mctx.drawImage(this.shapeMask, 0, 0);
    }
    if (this.marqueeDraft) {
      mctx.save();
      mctx.globalCompositeOperation =
        this.marqueeStart?.mode === "subtract" ? "destination-out" : "source-over";
      mctx.fillStyle = "#fff";
      mctx.fillRect(
        Math.round(this.marqueeDraft.x),
        Math.round(this.marqueeDraft.y),
        Math.round(this.marqueeDraft.w),
        Math.round(this.marqueeDraft.h),
      );
      mctx.restore();
    }
    const boundRects = this.marqueeMove?.rects
      ? this.marqueeMove.rects.map((r) => ({
          x: r.x + (this.marqueeMove?.dx || 0),
          y: r.y + (this.marqueeMove?.dy || 0),
          w: r.w,
          h: r.h,
        }))
      : this.marqueeRects.slice();
    if (this.marqueeDraft) boundRects.push(this.marqueeDraft);
    if (!boundRects.length) return { points: [] };
    const x0 = clamp(Math.floor(Math.min(...boundRects.map((r) => r.x))) - 2, 0, mask.width);
    const y0 = clamp(Math.floor(Math.min(...boundRects.map((r) => r.y))) - 2, 0, mask.height);
    const x1 = clamp(Math.ceil(Math.max(...boundRects.map((r) => r.x + r.w))) + 2, 0, mask.width);
    const y1 = clamp(Math.ceil(Math.max(...boundRects.map((r) => r.y + r.h))) + 2, 0, mask.height);
    const data = mctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const ww = x1 - x0;
    const hh = y1 - y0;
    const has = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < ww && y < hh && (data[(y * ww + x) * 4 + 3] ?? 0) > 0;
    const points: [number, number][] = [];
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < ww; x++) {
        if (!has(x, y)) continue;
        if (has(x - 1, y) && has(x + 1, y) && has(x, y - 1) && has(x, y + 1)) {
          continue;
        }
        points.push([x + x0, y + y0]);
      }
    }
    if (points.length > 12000) {
      const step = Math.ceil(points.length / 12000);
      return { points: points.filter((_, i) => i % step === 0) };
    }
    return { points };
  }

  redrawMarquee() {
    if (!this.marquee) return;
    const rect = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (this.marquee.width !== w || this.marquee.height !== h) {
      this.marquee.width = w;
      this.marquee.height = h;
      this.marquee.style.width = `${rect.width}px`;
      this.marquee.style.height = `${rect.height}px`;
    }
    const ctx = this.marquee.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    if (!this.paint.width) return;
    const pr = this.paint.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const ox = (pr.left - sr.left) * dpr;
    const oy = (pr.top - sr.top) * dpr;
    const sx = (pr.width / this.paint.width) * dpr;
    const sy = (pr.height / this.paint.height) * dpr;

    if (this.marqueeMove?.edgeCache) {
      this.marqueeEdgeCache = this.marqueeMove.edgeCache;
      this.marqueeEdgeDirty = false;
    } else if (this.marqueeEdgeDirty || !this.marqueeEdgeCache) {
      this.marqueeEdgeCache = this.buildMarqueeEdgeCache();
      this.marqueeEdgeDirty = false;
    }
    const points = this.marqueeEdgeCache?.points || [];
    if (!points.length) return;
    const phase = this.dashOffset % 8;
    ctx.save();
    const mdx = this.marqueeMove?.edgeCache ? this.marqueeMove.dx || 0 : 0;
    const mdy = this.marqueeMove?.edgeCache ? this.marqueeMove.dy || 0 : 0;
    for (const [x, y] of points) {
      const px = x + mdx;
      const py = y + mdy;
      const on = (((px + py - phase) % 8) + 8) % 8 < 4;
      ctx.fillStyle = on ? "#fff" : "#000";
      ctx.fillRect(ox + px * sx, oy + py * sy, Math.max(1, sx), Math.max(1, sy));
    }
    ctx.restore();
  }

  save() {
    try {
      this.fillMarqueeIntoMask();
      if (this.outputMode !== "color") this.mergeMaskModeChanges();
      const sourceImage = this.sourceImage || this.img;
      const editImage = this.editImageCanvas || this.img;
      if (!sourceImage || !this.rawPaint.width) return;

      const paint = document.createElement("canvas");
      paint.width = this.rawPaint.width;
      paint.height = this.rawPaint.height;
      paint.getContext("2d")!.putImageData(this.saveMaskImageData(), 0, 0);

      const natW = this.natural.w || paint.width;
      const natH = this.natural.h || paint.height;
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = natW;
      outputCanvas.height = natH;
      const outputCtx = outputCanvas.getContext("2d")!;
      outputCtx.drawImage(sourceImage || editImage, 0, 0, natW, natH);

      if (this.outputMode === "color" && this.outputOpacity > 0) {
        const colorLayer = document.createElement("canvas");
        colorLayer.width = natW;
        colorLayer.height = natH;
        const colorCtx = colorLayer.getContext("2d")!;
        colorCtx.imageSmoothingEnabled = false;
        colorCtx.drawImage(paint, 0, 0, natW, natH);
        const colorData = colorCtx.getImageData(0, 0, natW, natH);
        const factor = this.outputOpacity / 100;
        for (let i = 3; i < colorData.data.length; i += 4) {
          colorData.data[i] = Math.round((colorData.data[i] ?? 0) * factor);
        }
        colorCtx.putImageData(colorData, 0, 0);
        outputCtx.drawImage(colorLayer, 0, 0);
      } else if (this.outputMode === "original") {
        // Composite the 50% translucent brush overlay onto the saved image
        // (matching Goohai's node card preview and keeping underlying details
        // visible for AGY / Muse instead of punching a black transparent hole).
        outputCtx.save();
        outputCtx.globalAlpha = 0.5;
        outputCtx.imageSmoothingEnabled = false;
        outputCtx.drawImage(paint, 0, 0, natW, natH);
        outputCtx.restore();
      }

      // Keep raw RGBA paint strokes intact so color layers & re-edit restore 1:1.
      const strokesSource =
        this.outputMode === "original" && this.colorModePaint
          ? this.colorModePaint
          : this.rawPaint;
      const state: MaskNodeStyleState = {
        colorKey: (this.outputColor as MaskColorKey) || "red",
        opacity: this.outputOpacity,
        inverted: this.maskInverted,
        fillHoles: this.autoFillHoles,
        outputMode: this.outputMode,
        brushColor:
          this.maskBrushColor === "white" || this.maskBrushColor === "black"
            ? this.maskBrushColor
            : "green",
      };
      this.onSave({
        maskDataUrl: outputCanvas.toDataURL("image/png"),
        strokesDataUrl: strokesSource.toDataURL("image/png"),
        maskStateJson: JSON.stringify(state),
      });
      this.close();
    } catch (err) {
      alert(`保存遮罩失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeColorContextMenu();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.drawingPreviewRaf) cancelAnimationFrame(this.drawingPreviewRaf);
    if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
    window.removeEventListener("mousemove", this._move, true);
    window.removeEventListener("mouseup", this._up, true);
    window.removeEventListener("keydown", this._keyDown, true);
    window.removeEventListener("keyup", this._keyUp, true);
    window.removeEventListener("resize", this._resize);
    this.stage.removeEventListener("wheel", this._wheel);
    this.root.remove();
    this.onClose();
  }
}
