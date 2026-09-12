import { useEffect, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import type { PluginTheme } from '@getpaseo/plugin';
import { listFiles, type Entry } from '../shared/files.shared';

interface TreeProps {
  workspaceId: string;
  rootPath: string;
  theme: PluginTheme;
  revision: number;
  selected: string;
  dragTarget: string | null;
  busy: boolean;
  onSelect(path: string): void;
  onDrag(event: React.DragEvent, path: string): void;
  onDrop(event: React.DragEvent, path: string): void;
  onDownload(entry: Entry): void;
}

export function FileTree(props: TreeProps) {
  return <div role="tree" aria-label="工作区文件树" style={{ padding: '4px 0' }}>
    <Directory {...props} path="" name={props.rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? props.rootPath} root />
  </div>;
}

function Directory(props: TreeProps & { path: string; name: string; root?: boolean }) {
  const { path, name, root, theme, selected, dragTarget, busy } = props;
  const list = useRpc(listFiles);
  const [expanded, setExpanded] = useState(Boolean(root));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    setLoading(true); setError('');
    list({ workspaceId: props.workspaceId, path }).then(result => { if (current) setEntries(result); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [list, props.workspaceId, props.revision, path, expanded, retry]);
  const colors = theme.colors;
  const targeted = dragTarget === path;
  return <div role="treeitem" aria-label={name} aria-expanded={expanded} aria-selected={selected === path}>
    <button type="button" data-folder-path={path} title={path || props.rootPath} aria-label={`${expanded ? '折叠' : '展开'} ${name}`} disabled={busy}
      onClick={() => { props.onSelect(path); setExpanded(value => !value); }}
      onKeyDown={event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); props.onSelect(path); setExpanded(event.key === 'ArrowRight'); }
      }}
      onDragOver={event => props.onDrag(event, path)}
      onDrop={event => { props.onDrop(event, path); if (!busy) { props.onSelect(path); setExpanded(true); } }}
      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 5, minHeight: 28, padding: '3px 7px', color: targeted ? colors.accent : colors.foreground, background: targeted || selected === path ? colors.surface2 : 'transparent', border: `1px solid ${targeted ? colors.accent : 'transparent'}`, borderRadius: 4, textAlign: 'left', font: 'inherit', cursor: busy ? 'default' : 'pointer' }}>
      <span aria-hidden="true" style={{ width: 12, flexShrink: 0, color: colors.foregroundMuted }}>{expanded ? '⌄' : '›'}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{name}</span>
      {targeted && <span style={{ fontSize: 11, flexShrink: 0 }}>上传到这里</span>}
    </button>
    {expanded && <div role="group" style={{ marginLeft: 13, paddingLeft: 5, borderLeft: `1px solid ${colors.border}` }}>
      {loading && <div style={{ padding: '5px 8px', color: colors.foregroundMuted }}>正在读取…</div>}
      {error && <div role="alert" style={{ padding: '5px 8px', color: colors.statusDanger, overflowWrap: 'anywhere' }}>{error} <button onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {!loading && !error && entries.length === 0 && <div style={{ padding: '5px 8px', color: colors.foregroundMuted }}>空文件夹</div>}
      {!error && entries.map(entry => entry.directory
        ? <Directory key={entry.path} {...props} path={entry.path} name={entry.name} root={false} />
        : <div key={entry.path} role="treeitem" aria-label={entry.name} data-file-path={entry.path}
            onDragOver={event => props.onDrag(event, path)} onDrop={event => props.onDrop(event, path)}
            style={{ display: 'flex', gap: 6, alignItems: 'center', minHeight: 28, padding: '2px 7px', boxSizing: 'border-box' }}>
            <span aria-hidden="true" style={{ color: colors.accent, fontSize: 10, width: 16, flexShrink: 0 }}>▤</span>
            <span title={entry.path} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
            <button title={`下载 ${entry.name}`} aria-label={`下载 ${entry.name}`} disabled={busy} onClick={() => props.onDownload(entry)}
              style={{ color: colors.foregroundMuted, background: 'transparent', border: 0, padding: '2px 5px', font: 'inherit', cursor: busy ? 'default' : 'pointer' }}>↓</button>
          </div>)}
    </div>}
  </div>;
}
