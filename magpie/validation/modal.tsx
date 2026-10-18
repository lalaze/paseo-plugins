import { createContext, useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { StyleSheet, View } from "react-native-web";
import type {
  ModalComponent,
  ModalContentProps,
  ModalProps,
} from "@getpaseo/plugin/client/react-native";

// Browser-only stand-in for Paseo's host-owned adaptive modal/sheet.
const Context = createContext<ModalProps | null>(null);
function Root(props: ModalProps) {
  return <Context.Provider value={props}>{props.children}</Context.Provider>;
}
function Content({ children, style, contentContainerStyle }: ModalContentProps) {
  const modal = useContext(Context)!;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (modal.open && !dialog.open) {
      if (dialog.showModal) dialog.showModal();
      else dialog.setAttribute("open", "");
    }
  }, [modal.open]);
  if (!modal.open) return null;
  const background = StyleSheet.flatten(style)?.backgroundColor || "#1a1a1e";
  const compact = window.innerWidth < 820;
  return createPortal(
    <dialog
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={modal.title}
      onCancel={(event) => {
        event.preventDefault();
        modal.onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) modal.onOpenChange(false);
      }}
      style={{
        color: "inherit",
        background: String(background),
        border: "1px solid #5555",
        borderRadius: 16,
        padding: 0,
        width: compact ? "100%" : 520,
        maxWidth: "100%",
        maxHeight: "85vh",
        margin: compact ? "auto 0 0" : "auto",
      }}
    >
      <style>{"dialog::backdrop{background:rgba(0,0,0,.55)}"}</style>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 24px",
          color: "#929299",
          borderBottom: "1px solid #5553",
        }}
      >
        <strong style={{ flex: 1 }}>{modal.title}</strong>
        <button
          role="button"
          aria-label="关闭弹窗"
          onClick={() => modal.onOpenChange(false)}
          style={{ border: 0, background: "transparent", color: "inherit", fontSize: 24 }}
        >
          ×
        </button>
      </div>
      <div style={{ overflowY: "auto", maxHeight: "calc(85vh - 64px)" }}>
        <View style={contentContainerStyle}>{children}</View>
      </div>
    </dialog>,
    document.body,
  );
}
export const Modal: ModalComponent = Object.assign(Root, { Content });
