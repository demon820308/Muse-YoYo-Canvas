// Thin React mount for `YoYoMaskEditor.ts`.

import { useEffect, useRef } from "react";
import { YoYoMaskEditor, type YoYoMaskSaveResult } from "./YoYoMaskEditor";
import { DEFAULT_MASK_NODE_STYLE, type MaskNodeStyleState } from "./mask-helpers";

export type MaskSavePayload = YoYoMaskSaveResult;

export function MaskDialog({
  src,
  initialStrokesUrl = null,
  initialStyle = DEFAULT_MASK_NODE_STYLE,
  onClose,
  onConfirm,
}: {
  src: string;
  title?: string;
  initialStrokesUrl?: string | null;
  initialStyle?: MaskNodeStyleState;
  onClose: () => void;
  onConfirm: (payload: MaskSavePayload) => void;
}) {
  const onCloseRef = useRef(onClose);
  const onConfirmRef = useRef(onConfirm);
  onCloseRef.current = onClose;
  onConfirmRef.current = onConfirm;

  useEffect(() => {
    let closedExternally = false;
    const editor = new YoYoMaskEditor({
      imageUrl: src,
      strokesUrl: initialStrokesUrl,
      outputState: initialStyle,
      onSave: (result) => onConfirmRef.current(result),
      onClose: () => {
        if (!closedExternally) onCloseRef.current();
      },
    });
    return () => {
      closedExternally = true;
      editor.close();
    };
    // Mount once per dialog open (keyed by src / strokesUrl).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, initialStrokesUrl]);

  return null;
}
