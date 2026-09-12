import { Platform } from 'react-native';
export function encode(bytes: ArrayBuffer) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decode(base64: string) {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}
export function saveFile(name: string, parts: Uint8Array<ArrayBuffer>[]) {
  if (Platform.OS !== 'web') return;
  const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
