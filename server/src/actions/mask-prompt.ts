export type MaskColorKey =
  | "blue"
  | "red"
  | "green"
  | "cyan"
  | "yellow"
  | "orange"
  | "purple"
  | "white"
  | "gray";

export const MASK_COLORS: {
  key: MaskColorKey;
  label: string;
  hex: string;
  rgb: readonly [number, number, number];
}[] = [
  { key: "blue", label: "蓝色", hex: "#347cff", rgb: [52, 124, 255] },
  { key: "red", label: "红色", hex: "#ff3030", rgb: [255, 48, 48] },
  { key: "green", label: "绿色", hex: "#28d66f", rgb: [40, 214, 111] },
  { key: "cyan", label: "青色", hex: "#24d9d1", rgb: [36, 217, 209] },
  { key: "yellow", label: "黄色", hex: "#ffe52e", rgb: [255, 229, 46] },
  { key: "orange", label: "橙色", hex: "#ff8c20", rgb: [255, 140, 32] },
  { key: "purple", label: "紫色", hex: "#b04cff", rgb: [176, 76, 255] },
  { key: "white", label: "白色", hex: "#ffffff", rgb: [255, 255, 255] },
  { key: "gray", label: "中性灰", hex: "#808080", rgb: [128, 128, 128] },
];

export function getMaskColor(key: MaskColorKey) {
  return (
    MASK_COLORS.find((c) => c.key === key) ?? {
      key: "blue" as const,
      label: "蓝色",
      hex: "#347cff",
      rgb: [52, 124, 255] as const,
    }
  );
}

export type MaskEditMode = "remove" | "outfit" | "face" | "custom";

export const MASK_EDIT_MODES: {
  mode: MaskEditMode;
  label: string;
  resultSuffix: string;
  placeholder: string;
  tip?: string;
}[] = [
  {
    mode: "remove",
    label: "移除",
    resultSuffix: "消除",
    placeholder: "可选：填写要移除的目标（如“背景路人”“水杯”），留空则自动消除蒙版区域",
  },
  {
    mode: "outfit",
    label: "换装",
    resultSuffix: "换装",
    placeholder: "描述目标服装（如“换成黑色机车皮夹克”，若连入了服装参考图可简写）",
    tip: "长袖换短袖、长裙换短裤时，蒙版需把原本被遮挡的皮肤与边缘背景一并涂上。",
  },
  {
    mode: "face",
    label: "换脸",
    resultSuffix: "换脸",
    placeholder: "可选：补充五官神态要求（建议在上方再连入一张清晰正面人脸参考图）",
    tip: "建议蒙版涂到发际线与下巴边缘；真人换脸受底层模型安全策略影响可能被拒答。",
  },
  {
    mode: "custom",
    label: "自由重绘",
    resultSuffix: "蒙版重绘",
    placeholder: "例如：把遮罩区域换成一顶红色贝雷帽，其余保持不变",
  },
];

export function getMaskEditModeMeta(mode: MaskEditMode) {
  return (
    MASK_EDIT_MODES.find((m) => m.mode === mode) ?? {
      mode: "remove" as const,
      label: "移除",
      resultSuffix: "消除",
      placeholder:
        "可选：填写要移除的目标（如“背景路人”“水杯”），留空则自动消除蒙版区域",
    }
  );
}

export type MaskNodeStyleState = {
  colorKey: MaskColorKey;
  opacity: number;
  inverted: boolean;
  fillHoles: boolean;
  outputMode: "color" | "original";
  brushColor?: "green" | "white" | "black";
};

export const DEFAULT_MASK_NODE_STYLE: MaskNodeStyleState = {
  colorKey: "red",
  opacity: 50,
  inverted: false,
  fillHoles: false,
  outputMode: "original",
  brushColor: "green",
};

export function parseMaskNodeStateJson(
  raw: string | null | undefined,
): MaskNodeStyleState {
  if (!raw) return DEFAULT_MASK_NODE_STYLE;
  try {
    const parsed = JSON.parse(raw) as Partial<MaskNodeStyleState>;
    const validColor = MASK_COLORS.some((c) => c.key === parsed.colorKey)
      ? (parsed.colorKey as MaskColorKey)
      : DEFAULT_MASK_NODE_STYLE.colorKey;
    return {
      colorKey: validColor,
      opacity:
        typeof parsed.opacity === "number" &&
        parsed.opacity >= 0 &&
        parsed.opacity <= 100
          ? parsed.opacity
          : DEFAULT_MASK_NODE_STYLE.opacity,
      inverted: Boolean(parsed.inverted),
      fillHoles: Boolean(parsed.fillHoles),
      outputMode: parsed.outputMode === "color" ? "color" : "original",
      brushColor:
        parsed.brushColor === "white" || parsed.brushColor === "black"
          ? parsed.brushColor
          : "green",
    };
  } catch {
    return DEFAULT_MASK_NODE_STYLE;
  }
}

export function buildMaskEditPrompt(opts: {
  mode: MaskEditMode;
  colorLabel: string;
  userPrompt: string;
  hasRefImage: boolean;
  hasSeparateBaseImage?: boolean;
  isAlphaMask?: boolean;
}): string {
  const detail = opts.userPrompt.trim();
  const hasBase = opts.hasSeparateBaseImage !== false;
  const maskIdx = hasBase ? "图2" : "图1";
  const refIdx = hasBase ? "图3" : "图2";
  const refNote = opts.hasRefImage
    ? `，${refIdx}为目标样式/人物参考图`
    : "";
  const regionDesc = opts.isAlphaMask
    ? "透明抠空标出的区域"
    : `${opts.colorLabel}高亮区域`;
  const header = opts.isAlphaMask
    ? hasBase
      ? `参考图说明：图1为原始底图；${maskIdx}是在图1基础上将需要修改的区域抠空为透明（Alpha 镂空）的蒙版指引图${refNote}。请在最终成片中填补修改${maskIdx}里透明镂空的区域，并保持非透明区域的构图、光线、主体与背景尽量与图1一致。`
      : `参考图说明：${maskIdx}是将需要修改的区域抠空为透明（Alpha 镂空）的编辑底图${refNote}。请在最终成片中填补修改透明镂空区域，并保持其余区域的构图、光线、主体与背景不变。`
    : hasBase
      ? `参考图说明：图1为原始底图；${maskIdx}在图1基础上用半透明${opts.colorLabel}高亮标出了需要修改的区域${refNote}。请在最终成片中去掉${opts.colorLabel}高亮遮罩本身，并保持未标记区域的构图、光线、主体与背景尽量与图1一致。`
      : `参考图说明：${maskIdx}是用半透明${opts.colorLabel}高亮标出需要修改区域的底图${refNote}。请在最终成片中去掉${opts.colorLabel}高亮遮罩本身，并保持未标记区域的构图、光线、主体与背景不变。`;

  switch (opts.mode) {
    case "remove": {
      const target = detail ? `（${detail}）` : "";
      return `${header}\n修改任务：将${maskIdx}中${regionDesc}对应的目标${target}完全移除，并根据周围环境自动无缝补全背景纹理、结构与光影，不要留下残影或涂抹痕迹。`;
    }
    case "outfit": {
      const target = opts.hasRefImage
        ? `替换为${refIdx}中的服装/配饰款式、颜色与材质细节${detail ? `（补充要求：${detail}）` : ""}`
        : `更换为：${detail || "新的合适服装"}`;
      return `${header}\n修改任务：严格保持原人物的身份五官、发型、姿势体型与背景环境不变，仅将${maskIdx}中${regionDesc}的服装/配饰${target}，使衣物褶皱与环境光影自然贴合身体姿态。`;
    }
    case "face": {
      const target = opts.hasRefImage
        ? `替换为${refIdx}人物的五官长相与身份特征${detail ? `（补充要求：${detail}）` : ""}`
        : `重绘为：${detail || "清晰自然的人脸五官"}`;
      return `${header}\n修改任务：保持原图的身体姿态、服装、发型外轮廓、构图光线与背景不变，仅将${maskIdx}中${regionDesc}的人脸${target}，自然匹配原图的头部朝向、肤色与光影。`;
    }
    case "custom":
    default: {
      const refHint = opts.hasRefImage
        ? `\n参考融合：请参考${refIdx}的视觉特征与元素完成修改。`
        : "";
      return `${header}\n修改任务：按要求重绘或修改${maskIdx}中${regionDesc}：${detail}${refHint}`;
    }
  }
}
