import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import * as contracts from '../shared/files.shared';
import type { Entry } from '../shared/files.shared';
import { decode, encode, saveFile } from './web.client';
import { FileTree } from './tree.client';
import { localizeFileError, ui } from './i18n';

const errorText = localizeFileError;

export function FilePanel(props: PluginWorkspacePanelProps) {
  const rootPath = useWorkspace(props.workspaceId, workspace => workspace.directory);
  if (props.layout.platform !== 'web') return <View style={{ padding: 20 }}><Text style={{ color: props.theme.colors.foreground }}>{ui('Open File Transfer in the Paseo desktop app or a browser. Uploading and saving files requires browser file APIs.', '请在 Paseo 桌面端或浏览器打开“文件传输”，上传和保存文件需要浏览器文件接口。')}</Text></View>;
  return <WebPanel key={`${props.host.id}:${props.workspaceId}`} {...props} rootPath={rootPath ?? ui('Loading workspace path…', '正在读取工作区路径…')} />;
}

function WebPanel({ workspaceId, theme, rootPath }: PluginWorkspacePanelProps & { rootPath: string }) {
  const start = useRpc(contracts.startUpload), chunk = useRpc(contracts.uploadChunk);
  const finish = useRpc(contracts.finishUpload), cancel = useRpc(contracts.cancelUpload), download = useRpc(contracts.downloadChunk);
  const [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [progress, setProgress] = useState(0), [dragTarget, setDragTarget] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const active = useRef(false), stopped = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopped.current = true; }; }, []);


  function begin() {
    if (active.current) return false;
    active.current = true; stopped.current = false;
    setBusy(true); setError(''); setProgress(0);
    return true;
  }
  function check() { if (stopped.current || !alive.current) throw new Error(ui('Transfer canceled', '传输已取消')); }
  function end() { active.current = false; if (alive.current) { setBusy(false); setRevision(value => value + 1); } }
  async function uploadFiles(files: File[], target: string) {
    if (!files.length || !begin()) return;
    let completed = 0;
    const failures: string[] = [];
    try {
      for (const file of files) {
        check();
        let id: string | undefined;
        try {
          if (file.size > contracts.MAX_FILE_SIZE) throw new Error(ui('The maximum file size is 100 MiB', '单文件最大 100 MiB'));
          setMessage(ui(`Uploading ${file.name} (${completed + 1}/${files.length})`, `上传 ${file.name}（${completed + 1}/${files.length}）`)); setProgress(0);
          const session = await start({ workspaceId, path: [target, file.name].filter(Boolean).join('/'), size: file.size });
          id = session.id;
          for (let offset = 0; offset < file.size;) {
            check();
            const data = encode(await file.slice(offset, offset + contracts.CHUNK_SIZE).arrayBuffer());
            check();
            const result = await chunk({ id, offset, data });
            offset = result.offset;
            if (alive.current) setProgress(file.size ? offset / file.size : 1);
          }
          check(); await finish({ id }); id = undefined; completed++;
        } catch (e) { failures.push(`${file.name}: ${errorText(e)}`); }
        finally { if (id) await cancel({ id }).catch(() => {}); }
      }
    } catch (e) { failures.push(errorText(e)); }
    finally {
      if (alive.current) { setMessage(ui(`Uploaded ${completed} of ${files.length} files`, `已上传 ${completed}/${files.length} 个文件`)); setError(failures.join('\n')); setProgress(1); }
      end();
    }
  }
  async function downloadFile(entry: Entry) {
    if (!begin()) return;
    setMessage(ui(`Downloading ${entry.name}`, `下载 ${entry.name}`));
    try {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0, version: string | undefined;
      while (true) {
        check();
        const result = await download({ workspaceId, path: entry.path, offset, version });
        check();
        parts.push(decode(result.data)); version = result.version;
        setProgress(result.size ? result.nextOffset / result.size : 1);
        if (result.nextOffset === result.size) break;
        if (result.nextOffset <= offset) throw new Error(ui('The download made no progress; try again', '下载未取得进展，请重试'));
        offset = result.nextOffset;
      }
      saveFile(entry.name, parts); setMessage(ui(`Sent to browser for saving: ${entry.name}`, `已交给浏览器保存：${entry.name}`));
    } catch (e) { if (alive.current) { setError(errorText(e)); setMessage(ui('Download incomplete', '下载未完成')); } }
    finally { end(); }
  }
  function drop(event: React.DragEvent, target: string) {
    event.preventDefault(); event.stopPropagation(); setDragTarget(null);
    if (active.current) return;
    const items = Array.from(event.dataTransfer.items);
    if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) { setError(ui('Multiple-file uploads are supported; compress folders into ZIP archives first.', '当前支持多文件上传；文件夹请先打包成 ZIP。')); return; }
    void uploadFiles(Array.from(event.dataTransfer.files), target);
  }
  function drag(event: React.DragEvent, target: string) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    if (!busy) setDragTarget(target);
  }
  const colors = theme.colors;
  const button: React.CSSProperties = { background: colors.surface2, color: colors.foreground, border: `1px solid ${colors.border}`, borderRadius: 6, padding: '6px 10px', cursor: busy ? 'default' : 'pointer', font: 'inherit' };
  const parts = directory.split('/').filter(Boolean);
  return <section aria-label={ui('File transfer', '文件传输')} style={{ color: colors.foreground, background: colors.surface0, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: '13px system-ui, sans-serif' }}
    onDragOver={e => drag(e, directory)} onDrop={e => drop(e, directory)} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragTarget(null); }}>
    <header style={{ padding: 12, borderBottom: `1px solid ${colors.border}` }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ flex: 1 }}>{ui('File Transfer', '文件传输')}</strong>
        <button style={button} disabled={busy} onClick={() => picker.current?.click()}>↑ {ui('Upload Files', '上传文件')}</button>
        <button style={button} disabled={busy} onClick={() => setRevision(value => value + 1)}>{ui('Refresh', '刷新')}</button>
        <input ref={picker} type="file" multiple hidden onChange={e => { void uploadFiles(Array.from(e.target.files ?? []), directory); e.target.value = ''; }} />
      </div>
      <nav aria-label={ui('Current directory', '当前目录')} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 10 }}>
        <button style={{ ...button, maxWidth: '100%', overflowWrap: 'anywhere', textAlign: 'left' }} title={rootPath} disabled={busy} onClick={() => setDirectory('')}>{rootPath}</button>
        {parts.map((part, index) => <span key={index}> / <button style={button} disabled={busy} onClick={() => setDirectory(parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}
      </nav>
      <p style={{ color: colors.foregroundMuted, marginBottom: 0 }}>{ui('Expand the directory tree and drop files on a folder to upload there; drop them on a file row to use its containing folder. Maximum 100 MiB per file.', '展开目录树，拖到文件夹上传；拖到文件行则上传到其所在目录。单文件 ≤ 100 MiB。')}</p>
    </header>
    <div style={{ overflow: 'auto', flex: 1, minHeight: 100, border: `2px dashed ${dragTarget === directory ? colors.accent : 'transparent'}` }}>
      <FileTree workspaceId={workspaceId} rootPath={rootPath} theme={theme} revision={revision} selected={directory}
        dragTarget={dragTarget} busy={busy} onSelect={setDirectory} onDrag={drag} onDrop={drop} onDownload={entry => void downloadFile(entry)} />
    </div>
    <footer style={{ padding: 12, borderTop: `1px solid ${colors.border}` }}>
      {busy && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><progress aria-label={ui('Transfer progress', '传输进度')} value={progress} max={1} style={{ flex: 1 }} /><button style={button} onClick={() => { stopped.current = true; }}>{ui('Cancel', '取消')}</button></div>}
      <div role="status" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>{dragTarget !== null ? ui(`Upload destination: ${rootPath}${dragTarget ? '/' + dragTarget : ''}`, `上传目标：${rootPath}${dragTarget ? '/' + dragTarget : ''}`) : message || ui(`Upload directory: ${rootPath}${directory ? '/' + directory : ''}`, `上传目录：${rootPath}${directory ? '/' + directory : ''}`)}</div>
      {error && <div role="alert" style={{ color: colors.statusDanger, whiteSpace: 'pre-wrap', marginTop: 8 }}>{error}</div>}
    </footer>
  </section>;
}
