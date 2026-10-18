import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { signIn, type SignIn } from "../shared/rpc";
import { Banner, Button, Card, CopyButton, Field, useUi } from "./kit";

export function SignInPanel({
  initial,
  onClose,
  onDone,
  hostId,
}: {
  initial: SignIn;
  onClose(): void;
  onDone(): void;
  hostId: string;
}) {
  const rpc = useRpc(signIn);
  const { s } = useUi();
  const [callback, setCallback] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const query = useQuery({
    queryKey: ["magpie-signin", hostId, initial.id],
    queryFn: () => rpc({ operation: "status", id: initial.id }),
    initialData: initial,
    retry: false,
    refetchInterval: (q) =>
      ["done", "failed", "canceled"].includes(q.state.data?.state || "") ? false : 2000,
  });
  const state = query.data;
  useEffect(() => {
    if (state.state === "done") onDone();
  }, [state.state, onDone]);
  const submit = async (operation: "cancel" | "callback") => {
    setWorking(true);
    setError("");
    try {
      await rpc(
        operation === "cancel"
          ? { operation, id: state.id }
          : { operation, id: state.id, url: callback },
      );
      if (operation === "cancel") onClose();
      else await query.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Card>
      <View style={s.between}>
        <Text style={s.sectionTitle}>连接订阅账户 · {state.agent}</Text>
        <Button
          label="取消登录"
          disabled={working}
          onPress={() => {
            void submit("cancel");
          }}
        />
      </View>
      {state.instructions ? (
        <Text selectable style={s.text}>
          {state.instructions}
        </Text>
      ) : null}
      <Text style={s.muted}>
        {state.state === "installing"
          ? "Magpie 正在准备登录环境…"
          : "在当前设备完成授权。浏览器回调若无法访问，可将最终地址粘贴到下方。"}
      </Text>
      {state.url ? (
        <View style={s.row}>
          <ExternalLink href={state.url}>打开授权页面</ExternalLink>
          <CopyButton label="复制授权链接" value={state.url} />
        </View>
      ) : null}
      {state.code ? (
        <View style={s.row}>
          <Text selectable style={s.cardTitle}>
            {state.code}
          </Text>
          <CopyButton label="复制验证码" value={state.code} />
        </View>
      ) : null}
      {state.pasteCallback ? (
        <View style={s.row}>
          <Field
            label="登录完成后的回调 URL"
            value={callback}
            onChange={setCallback}
            placeholder="粘贴浏览器地址栏中的完整地址"
          />
          <Button
            label="提交回调"
            disabled={!callback.trim() || working}
            onPress={() => {
              void submit("callback");
            }}
          />
        </View>
      ) : null}
      {error || state.error || query.error ? (
        <Banner error>{error || state.error || query.error?.message}</Banner>
      ) : null}
      {state.state === "failed" || state.state === "canceled" ? (
        <Button label="关闭登录面板" onPress={onClose} />
      ) : null}
    </Card>
  );
}
