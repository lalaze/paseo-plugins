import { useEffect, useRef, useState } from 'react';
import { Image, Platform, Text, TextInput, View } from 'react-native';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { copyText, useToast } from '@getpaseo/plugin/client/react-native';
import { ATTACHMENT_CHUNK_BYTES, attachmentContentSchema, MAX_ATTACHMENT_BYTES, type Attachment, type AttachmentContent } from '../shared/attachments';
import { taskAttachmentChunkRead, taskAttachmentList, taskAttachmentRead, taskAttachmentUpload } from '../shared/rpc';
import type { AttachmentPage } from '../shared/attachment-pages';
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

async function readBase64(rpc: PluginClientContext['rpc'], taskId: string, attachment: Attachment, cancelled = () => false): Promise<string> {
  const chunks: string[] = [];
  const count = Math.max(1, Math.ceil(attachment.size / ATTACHMENT_CHUNK_BYTES));
  for (let index = 0; index < count; index++) {
    if (cancelled()) throw new Error('Cancelled');
    const result = await rpc(taskAttachmentChunkRead, { id: taskId, attachmentId: attachment.id, index });
    if (result.attachment.sha256 !== attachment.sha256 || result.done !== (index === count - 1)) throw new Error('Attachment changed');
    chunks.push(result.content);
  }
  return chunks.join('');
}

function ImagePreview({ rpc, taskId, attachment, colors }: { rpc: PluginClientContext['rpc']; taskId: string; attachment: Attachment; colors: Colors }) {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Browsing metadata never downloads image bytes; only explicitly opened previews do.
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!requested) return;
    let cancelled = false;
    setError(null); setUri(null);
    void readBase64(rpc, taskId, attachment, () => cancelled).then(content => {
      if (!cancelled) setUri(`data:${attachment.mediaType};base64,${content}`);
    }).catch(cause => { if (!cancelled) setError(parseDotBridgeError(cause)); });
    return () => { cancelled = true; };
  }, [rpc, taskId, attachment.id, attachment.sha256, requested, attempt]);
  if (!requested) return <Button colors={colors} label={ui('Preview image', '预览图片')} variant="outline" onPress={() => setRequested(true)} />;
  if (error) return <View><Text style={{ color: colors.foregroundMuted }}>{error}</Text><Button colors={colors} label={ui('Retry preview', '重新加载图片')} variant="outline" onPress={() => setAttempt(value => value + 1)} /></View>;
  return uri ? <Image accessibilityLabel={attachment.name} source={{ uri }} style={{ width: '100%', height: 280, maxWidth: 640, borderRadius: 8 }} resizeMode="contain" onError={() => setError(ui('Image could not be decoded. The original file is still saved.', '无法解码图片，原文件仍已保存。'))} />
    : <Text style={{ color: colors.foregroundMuted }}>{ui('Loading image…', '正在加载图片…')}</Text>;
}

export function AttachmentPanel(props: { colors: Colors; rpc: PluginClientContext['rpc']; task: Pick<Task, 'id' | 'currentRoundId' | 'revision'>; refresh(): Promise<void>; readOnly?: boolean; attachment?: Attachment }) {
  const { colors, task } = props;
  const toast = useToast();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1]!;
  const [loaded, setLoaded] = useState<{ cursor: string | null; page: AttachmentPage } | null>(null);
  const page = loaded?.cursor === cursor ? loaded.page : null;
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageAttempt, setPageAttempt] = useState(0);
  useEffect(() => {
    // Native timeline cards describe one particular file, not the whole task archive.
    if (props.attachment) {
      setLoaded({ cursor, page: { attachments: [props.attachment], total: 1, totalBytes: props.attachment.size, nextCursor: null } });
      setPageError(null);
      return;
    }
    let cancelled = false;
    setPageError(null);
    void props.rpc(taskAttachmentList, { id: task.id, cursor }).then(value => {
      if (!cancelled) setLoaded({ cursor, page: value });
    }).catch(error => { if (!cancelled) setPageError(parseDotBridgeError(error)); });
    return () => { cancelled = true; };
  }, [props.rpc, task.id, task.revision, cursor, pageAttempt, props.attachment]);
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
      setCursors([null]);
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
      if (!web) {
        const result = await props.rpc(taskAttachmentRead, { id: task.id, attachmentId: attachment.id });
        if (result.encoding !== 'utf8') { toast.error(ui('Download binary files from Paseo desktop or web.', '请在 Paseo 桌面端或网页下载二进制文件。')); return; }
        await copyText(result.content);
        toast.show(ui('Attachment text copied', '附件文字已复制'));
        return;
      }
      const content = await readBase64(props.rpc, task.id, attachment);
      const bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0));
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
    <SectionTitle colors={colors}>{ui('Attachments', '附件')}{page ? ` (${page.total})` : ''}</SectionTitle>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Dot files are saved automatically on the Paseo host (up to 20 MiB). Project files are unchanged.', 'Dot 回传文件自动保存到 Paseo 主机（最大 20 MiB），无需手动下载，不改动项目文件。')}</Text>
    {page ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Total file size', '附件总大小')}：{page.totalBytes.toLocaleString()} B · {ui('Page', '第')} {cursors.length} {ui('(newest first)', '页（从新到旧）')}</Text> : null}
    {pageError ? <View style={{ gap: 4 }}><Text style={{ color: colors.foregroundMuted }}>{pageError}</Text><Button colors={colors} label={ui('Retry list', '重试加载')} variant="outline" onPress={() => setPageAttempt(value => value + 1)} /></View> : !page ? <Text style={{ color: colors.foregroundMuted }}>{ui('Loading attachments…', '正在加载附件…')}</Text> : null}
    {(page?.attachments ?? []).map(attachment => <View key={attachment.id} style={{ gap: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: 12 }}>{attachment.name} · {attachment.size.toLocaleString()} B · {attachment.author === 'user' ? ui('You', '你') : 'Dot'}</Text>
      {/^image\/(png|jpeg|webp|gif)$/.test(attachment.mediaType) ? <ImagePreview rpc={props.rpc} taskId={task.id} attachment={attachment} colors={colors} /> : null}
      {attachment.localPath ? <View style={{ gap: 4 }}><Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Saved on host: ', '已保存到主机：')}{attachment.localPath}</Text><Button colors={colors} label={ui('Copy path', '复制路径')} variant="outline" size="sm" onPress={() => void copyText(attachment.localPath!).catch(error => toast.error(parseDotBridgeError(error)))} /></View> : null}
      <Button colors={colors} label={web ? ui('Save another copy', '另存一份') : ui('Copy text', '复制文字')} variant="outline" size="sm" onPress={() => void download(attachment)} disabled={busy || (!web && (attachment.size > MAX_ATTACHMENT_BYTES || (!attachment.mediaType.startsWith('text/') && attachment.mediaType !== 'application/json')))} />
    </View>)}
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {cursors.length > 1 ? <Button colors={colors} label={ui('Previous page', '上一页')} variant="outline" onPress={() => setCursors(value => value.slice(0, -1))} /> : null}
      {page?.nextCursor ? <Button colors={colors} label={ui('Older attachments', '下一页')} variant="outline" onPress={() => setCursors(value => [...value, page.nextCursor])} /> : null}
      {cursors.length > 1 ? <Button colors={colors} label={ui('Latest attachments', '最新附件')} variant="outline" onPress={() => setCursors([null])} /> : null}
    </View>
    {!props.readOnly ? <View style={{ gap: 8 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('User uploads: up to 1 MiB per file.', '手动上传：单文件最大 1 MiB。')}</Text>
    {web ? <input aria-label={ui('Upload attachment', '上传附件')} type="file" disabled={busy || pending !== null} style={{ color: colors.foreground, maxWidth: '100%' }} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void pick(file); }} /> : <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Upload files from desktop/web, or paste a text attachment below.', '文件上传请使用桌面端或网页；也可在下方粘贴文字附件。')}</Text>}
    <TextInput value={name} onChangeText={setName} placeholder={ui('Text file name', '文字附件文件名')} style={style} editable={!busy && !pending} />
    <TextInput value={body} onChangeText={setBody} placeholder={ui('Paste text or a log', '粘贴文字或日志')} multiline style={[style, { minHeight: 60 }]} editable={!busy && !pending} />
    <Button colors={colors} label={ui('Attach text', '添加文字附件')} variant="outline" onPress={() => void upload({ name: name.trim(), mediaType: 'text/plain', encoding: 'utf8', content: body })} disabled={busy || pending !== null || !name.trim() || !body} />
    {pending ? <Button colors={colors} label={ui('Retry upload', '重试上传')} variant="outline" onPress={() => void upload(pending, pending)} disabled={busy} /> : null}
    </View> : null}
  </View>;
}
