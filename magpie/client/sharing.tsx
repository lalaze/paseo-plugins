import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { revealGatewayKey, type PageData } from "../shared/rpc";
import {
  Banner,
  Button,
  Card,
  Chip,
  ConfirmButton,
  CopyButton,
  Dialog,
  Empty,
  Field,
  Toggle,
  useUi,
} from "./kit";

export function SharingCard({ on, addresses }: { on: boolean; addresses: string[] }) {
  const { s, run } = useUi();
  return (
    <Card>
      <View style={s.between}>
        <Text style={s.sectionTitle}>局域网共享</Text>
        <Toggle
          label="共享 Magpie 网关"
          value={on}
          onChange={(on) => {
            void run({ type: "settings.lan", on });
          }}
        />
      </View>
      <Text style={s.muted}>
        让另一台机器通过 Remote magpie 使用此主机上的供应商、订阅账户和路由组。
      </Text>
      {on ? (
        <>
          {addresses.map((url) => (
            <View key={url} style={s.between}>
              <Text selectable style={s.text}>
                {url}
              </Text>
              <CopyButton value={url} />
            </View>
          ))}
          {!addresses.length ? (
            <Text style={s.small}>
              尚未获取共享地址，请刷新；也可以使用此主机的 Tailscale IP 和网关端口。
            </Text>
          ) : null}
          <Text style={s.small}>
            在「网关」创建并复制密钥；另一台机器添加 Remote magpie，填写以上地址和密钥，再为 Agent
            选择远程模型。跨网络可使用 Tailscale。
          </Text>
        </>
      ) : (
        <Text style={s.small}>开启后网关会接受其他机器的连接，连接需要网关密钥。</Text>
      )}
    </Card>
  );
}

export function GatewayKeys({ keys }: { keys: PageData["gatewayKeys"] }) {
  const { s, run } = useUi();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Card>
      <Text style={s.sectionTitle}>网关密钥</Text>
      <Text style={s.muted}>为每台机器创建独立密钥；用量会按密钥名称记录。</Text>
      <View style={s.row}>
        <Field
          label="网关密钥名称"
          value={name}
          onChange={setName}
          placeholder="例如：另一台 Mac"
        />
        <Button
          label="创建网关密钥"
          icon="Plus"
          disabled={!name.trim()}
          onPress={() => {
            void run({ type: "gateway.key.add", name: name.trim() }).then((ok) => {
              if (ok) setName("");
            });
          }}
        />
      </View>
      {!keys.length ? <Empty title="尚无网关密钥" /> : null}
      {keys.map((key) => (
        <View key={key.id} style={s.section}>
          <View style={s.between}>
            <View style={s.grow}>
              <Text style={s.cardTitle}>{key.name || key.id}</Text>
              <Text style={s.small}>{key.masked}</Text>
            </View>
            <Toggle
              label={`启用网关密钥 ${key.name || key.id}`}
              value={!key.off}
              onChange={(on) => {
                void run({
                  type: "gateway.key.change",
                  id: key.id,
                  operation: on ? "on" : "off",
                });
              }}
            />
          </View>
          <View style={s.row}>
            <Chip label={key.models.length ? `模型限制：${key.models.join("、")}` : "全部模型"} />
            {key.accounts.length ? <Chip label={`账户限制：${key.accounts.join("、")}`} /> : null}
          </View>
          <View style={s.row}>
            <Button label="查看并复制密钥" icon="Copy" onPress={() => setSelected(key.id)} />
            <ConfirmButton
              label="轮换网关密钥"
              detail="另一台机器需要更新为新密钥才能继续连接。"
              onConfirm={() => {
                void run({
                  type: "gateway.key.change",
                  id: key.id,
                  operation: "rotate",
                });
              }}
            />
            <ConfirmButton
              label="删除网关密钥"
              detail="使用此密钥的机器将无法继续连接。"
              onConfirm={() => {
                void run({
                  type: "gateway.key.change",
                  id: key.id,
                  operation: "remove",
                });
              }}
            />
          </View>
        </View>
      ))}
      {selected ? (
        <GatewayKeySecret key={selected} id={selected} onClose={() => setSelected(null)} />
      ) : null}
    </Card>
  );
}

function GatewayKeySecret({ id, onClose }: { id: string; onClose(): void }) {
  const { s } = useUi();
  const reveal = useRpc(revealGatewayKey);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void reveal({ id }).then(
      (data) => {
        if (alive) setSecret(data.secret);
      },
      (cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [id, reveal]);
  return (
    <Dialog title="连接另一台 Magpie" onClose={onClose}>
      <Text style={s.muted}>在另一台机器添加 Remote magpie，将此密钥填入 API 密钥。</Text>
      {error ? (
        <Banner error>{error}</Banner>
      ) : secret ? (
        <>
          <Text selectable style={s.text}>
            {secret}
          </Text>
          <CopyButton value={secret} label="复制网关密钥" />
        </>
      ) : (
        <Text style={s.muted}>正在读取密钥…</Text>
      )}
      <Button label="完成" onPress={onClose} />
    </Dialog>
  );
}
