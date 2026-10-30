import type { CSSProperties } from 'react';
type Name = 'board' | 'book' | 'history' | 'settings' | 'plus' | 'chevron' | 'upload' | 'export' | 'close' | 'pause' | 'play' | 'send' | 'folder' | 'cost' | 'teacher';
const paths: Record<Name, React.ReactNode> = {
  board: <><rect x="3" y="3" width="18" height="13" rx="1"/><path d="m8 21 4-5 4 5M7 8h10M7 11h6"/></>,
  book: <><path d="M12 5v15M3 4h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 1 5 5 0 0 0-4-1H3Z"/></>,
  history: <><path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2"/></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="9" cy="18" r="2" fill="currentColor"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, chevron: <path d="m9 5 7 7-7 7"/>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></>,
  export: <><path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>, pause: <path d="M8 5v14M16 5v14"/>,
  play: <path d="m8 4 12 8-12 8Z"/>, send: <path d="M12 20V4m-6 6 6-6 6 6"/>,
  folder: <path d="M3 6V4h7l2 3h9v13H3V6Z"/>,
  cost: <><circle cx="12" cy="12" r="9"/><path d="M15 7h-3a3 3 0 0 0-3 3v7h7M7 12h7"/></>,
  teacher: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3"/></>,
};
export default function Icon({ name, size = 16, style }: { name: Name; size?: number; style?: CSSProperties }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={style}>{paths[name]}</svg>;
}
