import type { PropsWithChildren, CSSProperties } from 'react';
export const Platform = { OS: 'web' };
export function View({ children, style }: PropsWithChildren<{ style?: CSSProperties }>) { return <div style={style}>{children}</div>; }
export function Text({ children, style }: PropsWithChildren<{ style?: CSSProperties }>) { return <span style={style}>{children}</span>; }
