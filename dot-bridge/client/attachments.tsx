import { useRef, useState } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { copyText, useToast } from '@getpaseo/plugin/client/react-native';
import { attachmentContentSchema, MAX_ATTACHMENT_BYTES, MAX_TASK_ATTACHMENTS, type Attachment, type AttachmentContent } from '../shared/attachments';
import { taskAttachmentRead, taskAttachmentUpload } from '../shared/rpc';
import type { Task } from '../shared/schema';
import { isExplicitRejection, parseDotBridgeError, ui } from './i18n';
import { Button, outline, SectionTitle, type Colors } from './kit';
import { usePendingOperation } from './operation';

type UploadPayload = AttachmentContent & { id: string; roundId: string; revision: number };

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function AttachmentPanel(props: { colors: Colors; rpc: PluginClientContext['rpc']; task: Pick<Task, 'id' | 'currentRoundId' | 'revision' | 'attachments'>; refresh(): Promise<void>; readOnly?: boolean }) {
  const { colors, task } = props;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [name, setName] = useState('note.txt');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState<UploadPayload | null>(null);
  const uploadOp = usePendingOperation<UploadPayload>();
  const web = Platform.OS === 'web';
  const style = { color: colors.foreground, borderColor: outline(colors), borderWidth: 1, borderRadius: 8, padding: 8, fontSize: 12 };

  async function upload(content: AttachmentContent, frozen?: UploadPayload) {
    if (active.current) return;
    if (!frozen) {
      const valid = attachmentContentSchema.safeParse(content);
      if (!valid.success) { toast.error(ui('Check the file name and attachment content.', '请检查文件名和附件内容。')); return; }
      const byteLength = content.encoding === 'utf8' ? Array.from(content.content).reduce((sum, char) => { const cp = char.codePointAt(0)!; return sum + (cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4); }, 0) : 0;
      if (byteLength > MAX_ATTACHMENT_BYTES) { toast.error(ui('Maximum 1 MiB per file', '单文件最大 1 MiB')); return; }
    }
    active.current = true;
    setBusy(true);
    const payload = frozen ?? { ...content, id: task.id, roundId: task.currentRoundId, revision: task.revision };
    try {
      const operation = uploadOp.begin(JSON.stringify(payload), payload);
      setPending(operation.payload);
      await props.rpc(taskAttachmentUpload, { ...operation.payload, operationId: operation.operationId });
      uploadOp.settle();
      setPending(null);
      setBody('');
      await props.refresh();
      toast.show(ui('Attachment saved', '附件已保存'), { variant: 'success' });
    } catch (error) {
      if (isExplicitRejection(error)) { uploadOp.settle(); setPending(null); await props.refresh(); }
      toast.error(parseDotBridgeError(error));
    } finally { active.current = false; setBusy(false); }
  }

  async function pick(file: File | undefined) {
    if (!file || busy) return;
    if (file.size > MAX_ATTACHMENT_BYTES) { toast.error(ui('Maximum 1 MiB per file', '单文件最大 1 MiB')); return; }
    try {
      await upload({ name: file.name, mediaType: file.type.split(';')[0] || 'application/octet-stream', encoding: 'base64', content: encode(new Uint8Array(await file.arrayBuffer())) });
    } catch (error) { toast.error(parseDotBridgeError(error)); }
  }

  async function download(attachment: Attachment) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await props.rpc(taskAttachmentRead, { id: task.id, attachmentId: attachment.id });
      if (!web) {
        if (result.encoding !== 'utf8') { toast.error(ui('Download binary files from Paseo desktop or web.', '请在 Paseo 桌面端或网页下载二进制文件。')); return; }
        await copyText(result.content);
        toast.show(ui('Attachment text copied', '附件文字已复制'));
        return;
      }
      const bytes = result.encoding === 'utf8' ? new TextEncoder().encode(result.content) : Uint8Array.from(atob(result.content), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = attachment.name;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.show(ui('File sent to browser for saving', '文件已交给浏览器保存'));
    } catch (error) { toast.error(parseDotBridgeError(error)); }
    finally { setBusy(false); }
  }

  return <View style={{ gap: 8 }}>
    <SectionTitle colors={colors}>{ui('Attachments', '附件')}{props.readOnly ? '' : ` (${task.attachments.length}/${MAX_TASK_ATTACHMENTS})`}</SectionTitle>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Up to 1 MiB per file. Attachments stay with this task; they do not modify your workspace.', '单文件最大 1 MiB。附件保存在任务中，不会修改工作区。')}</Text>
    {task.attachments.map(attachment => <View key={attachment.id} style={{ gap: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: 12 }}>{attachment.name} · {attachment.size.toLocaleString()} B · {attachment.author === 'user' ? ui('You', '你') : 'Dot'}</Text>
      <Button colors={colors} label={web ? ui('Download', '下载') : ui('Copy text', '复制文字')} variant="outline" size="sm" onPress={() => void download(attachment)} disabled={busy || (!web && !attachment.mediaType.startsWith('text/') && attachment.mediaType !== 'application/json')} />
    </View>)}
    {!props.readOnly ? <View style={{ gap: 8 }}>
    {web ? <input aria-label={ui('Upload attachment', '上传附件')} type="file" disabled={busy || pending !== null || task.attachments.length >= MAX_TASK_ATTACHMENTS} style={{ color: colors.foreground, maxWidth: '100%' }} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void pick(file); }} /> : <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Upload files from desktop/web, or paste a text attachment below.', '文件上传请使用桌面端或网页；也可在下方粘贴文字附件。')}</Text>}
    <TextInput value={name} onChangeText={setName} placeholder={ui('Text file name', '文字附件文件名')} style={style} editable={!busy && !pending} />
    <TextInput value={body} onChangeText={setBody} placeholder={ui('Paste text or a log', '粘贴文字或日志')} multiline style={[style, { minHeight: 60 }]} editable={!busy && !pending} />
    <Button colors={colors} label={ui('Attach text', '添加文字附件')} variant="outline" onPress={() => void upload({ name: name.trim(), mediaType: 'text/plain', encoding: 'utf8', content: body })} disabled={busy || pending !== null || !name.trim() || !body || task.attachments.length >= MAX_TASK_ATTACHMENTS} />
    {pending ? <Button colors={colors} label={ui('Retry upload', '重试上传')} variant="outline" onPress={() => void upload(pending, pending)} disabled={busy} /> : null}
    </View> : null}
  </View>;
}
