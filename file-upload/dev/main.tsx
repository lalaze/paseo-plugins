import { createRoot } from 'react-dom/client';
import { FilePanel } from '../client/panel.client';
createRoot(document.getElementById('root')!).render(<FilePanel context="workspace" workspaceId="preview" host={{ id: 'preview', label: 'Preview' }} layout={{ compact: false, platform: 'web' }} theme={{ colors: {
  surface0: '#22262f', surface1: '#292e38', surface2: '#303642', border: '#3d4350', foreground: '#e0e2e8', foregroundMuted: '#9ba3b3', accent: '#65a7f7', accentForeground: '#ffffff', statusSuccess: '#63c28a', statusWarning: '#e6b862', statusDanger: '#ff8989'
} }} />);
