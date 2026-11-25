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
    MASK_COLORS.find((c) => c.key === key) ??
    MASK_COLORS.find((c) => c.key === DEFAULT_MASK_NODE_STYLE.colorKey) ?? {
      key: "red" as const,
      label: "红色",
      hex: "#ff3030",
      rgb: [255, 48, 48] as const,
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
    placeholder: "可选：补充五官神态要求（可把清晰正面人脸图连到蒙版或生图节点）",
    tip: "建议蒙版涂到发际线与下巴边缘；真人换脸受底层模型安全策略影响可能被拒答。",
  },
  {
    mode: "custom",
    label: "自由重绘",
    resultSuffix: "蒙版重绘",
    placeholder: "例如：把遮罩区域换成一顶红色贝雷帽，其余保持不变（连入参考图时可留空）",
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

/** Resolves the effective mask edit mode when the user has not explicitly picked
 * one: if a reference image or user prompt is provided, edit/replace instead of
 * blindly defaulting to `"remove"`. */
export function resolveEffectiveMaskMode(opts: {
  explicitMode?: MaskEditMode | null;
  hasRefImage: boolean;
  hasUserPrompt: boolean;
}): MaskEditMode {
  if (
    opts.explicitMode &&
    MASK_EDIT_MODES.some((m) => m.mode === opts.explicitMode)
  ) {
    return opts.explicitMode;
  }
  return opts.hasRefImage || opts.hasUserPrompt ? "custom" : "remove";
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

/** Normalizes partial or legacy mask style metadata against DEFAULT_MASK_NODE_STYLE. */
export function normalizeMaskNodeStyle(
  parsed?: Partial<MaskNodeStyleState> | null,
): MaskNodeStyleState {
  if (!parsed) return DEFAULT_MASK_NODE_STYLE;
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
}

export function parseMaskNodeStateJson(
  raw: string | null | undefined,
): MaskNodeStyleState {
  if (!raw) return DEFAULT_MASK_NODE_STYLE;
  try {
    return normalizeMaskNodeStyle(JSON.parse(raw) as Partial<MaskNodeStyleState>);
  } catch {
    return DEFAULT_MASK_NODE_STYLE;
  }
}

export function buildMaskEditPrompt(opts: {
  mode: MaskEditMode;
  colorLabel: string;
  userPrompt: string;
  hasRefImage: boolean;
  refCount?: number;
  hasSeparateBaseImage?: boolean;
  isAlphaMask?: boolean;
  opacity?: number;
}): string {
  const detail = opts.userPrompt.trim();
  const hasBase = opts.hasSeparateBaseImage !== false;
  const maskIdx = hasBase ? "图2" : "图1";
  const baseRefLabel = hasBase ? "图1" : "图1中未标记部分";
  const refStart = hasBase ? 3 : 2;
  const refCount = opts.hasRefImage ? Math.max(1, opts.refCount ?? 1) : 0;
  const refIdx = `图${refStart}`;
  const refDesc =
    refCount > 1 ? `图${refStart}～图${refStart + refCount - 1}` : refIdx;
  const refNote = opts.hasRefImage
    ? `，${refDesc}为目标参考图`
    : "";
  const opacityDesc = opts.opacity != null && opts.opacity >= 95 ? "" : "半透明";
  const regionDesc = opts.isAlphaMask
    ? "透明抠空标出的区域"
    : `${opts.colorLabel}高亮区域`;
  const header = opts.isAlphaMask
    ? hasBase
      ? `参考图说明：图1为原始底图；${maskIdx}是在图1基础上将需要修改的区域抠空为透明（Alpha 镂空）的蒙版指引图${refNote}。最终成片请在${maskIdx}透明镂空范围内填补修改，严格保持非透明区域的构图、主体结构、光线色调与背景与图1一致。`
      : `参考图说明：${maskIdx}是将需要修改的区域抠空为透明（Alpha 镂空）的编辑底图${refNote}。最终成片请在透明镂空范围内填补修改，严格保持其余区域的构图、光线、主体与背景不变。`
    : hasBase
      ? `参考图说明：图1为原始底图；${maskIdx}在图1基础上用${opacityDesc}${opts.colorLabel}高亮标出了需要修改的区域${refNote}。最终成片必须去掉${maskIdx}中的${opts.colorLabel}高亮遮罩本身，并严格保持未标记区域的构图、主体结构、光线色调与背景与图1一致。`
      : `参考图说明：${maskIdx}是用${opacityDesc}${opts.colorLabel}高亮标出需要修改区域的底图${refNote}。最终成片必须去掉${opts.colorLabel}高亮遮罩本身，并严格保持未标记区域的构图、光线、主体与背景不变。`;

  switch (opts.mode) {
    case "remove": {
      const target = detail ? `（${detail}）` : "";
      const refFillHint = opts.hasRefImage
        ? `；若周围提示不足，可参照${refDesc}中的背景材质与环境纹理补全`
        : "";
      return `${header}\n修改任务（局部消除）：将${maskIdx}中${regionDesc}覆盖的目标${target}彻底移除；仅在${regionDesc}范围内依据周围环境自动无缝补全背景纹理、透视结构与光影${refFillHint}，不要凭空生成无关新物体，也不要留下残影或涂抹痕迹。`;
    }
    case "outfit": {
      const target = opts.hasRefImage
        ? `仅提取并迁移${refDesc}中的服装/配饰款式、剪裁、颜色与面料材质细节${detail ? `（补充要求：${detail}）` : ""}，严禁改变或替换为${refDesc}的人物长相与身材`
        : `更换为：${detail || "贴合当前人物气质与场景的合适服装"}`;
      return `${header}\n修改任务（局部换装）：严格保持${baseRefLabel}人物的原有身份五官、肤色、发型、身体姿态与背景环境完全不变，仅将${maskIdx}中${regionDesc}的服装/配饰${target}，使衣物褶皱、透视比例与环境光影自然贴合原人物动作。`;
    }
    case "face": {
      const target = opts.hasRefImage
        ? `替换为${refDesc}中人物的五官长相、眉眼鼻唇结构与身份特征${detail ? `（补充要求：${detail}）` : ""}`
        : `重绘为：${detail || "五官清晰自然、神态协和的人脸面容"}`;
      return `${header}\n修改任务（局部换脸）：严格保持${baseRefLabel}的整体构图、身体姿态、服装配饰、发型外轮廓、画面风格与背景环境完全不变，仅将${maskIdx}中${regionDesc}的人脸${target}，使新面孔自然匹配原图的头部朝向、透视比例、环境光影与发际线/颈部肤色边缘过渡。`;
    }
    case "custom":
    default: {
      if (opts.hasRefImage && !detail) {
        return `${header}\n修改任务（参考局部重绘）：仅针对${maskIdx}中${regionDesc}标出的目标部位（如人脸五官、服装配饰或局部物体），将其自然替换并融合为${refDesc}中对应主体/部位的外观与特征；严格保持${baseRefLabel}未标记区域的构图、姿态、光线与背景完全不变，确保边缘、透视与光影无缝融合。`;
      }
      if (opts.hasRefImage) {
        return `${header}\n修改任务（参考局部重绘）：严格保持${baseRefLabel}未标记区域的构图、光线、主体与背景完全不变，结合${refDesc}的视觉特征与参考元素，按要求精准重绘或修改${maskIdx}中${regionDesc}：${detail}，使替换区域的透视、光影与边缘自然融入原图。`;
      }
      return `${header}\n修改任务（自由局部重绘）：严格保持${baseRefLabel}未标记区域的构图、光线、主体与背景完全不变，仅按以下要求重绘或修改${maskIdx}中${regionDesc}：${detail || "结合周围画面语境自然重绘优化"}，确保新内容与周边结构、材质及光影无缝衔接。`;
    }
  }
}
