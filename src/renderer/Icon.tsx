/** 24px line icons, after SpeakEasy's set (apps/desktop/src/renderer/ui/icons.tsx). */
const ICONS: Record<string, string> = {
  file: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h4',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  brain: 'M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z',
  chat: 'M4 5h16v11H9l-5 4z',
  popout: 'M14 4h6v6M20 4l-8 8M10 5H5v14h14v-5',
  panel: 'M4 5h16v14H4zM15 5v14',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  compact: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
  mute: 'M4 4l16 16M9 9v3a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11a6.4 6.4 0 0 1-.4 2.2M12 17.5V21',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  moon: 'M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5a8.5 8.5 0 1 0 9.7 9.7z',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  export: 'M12 15V4M8 8l4-4 4 4M5 13v7h14v-7',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  close: 'M6 6l12 12M18 6L6 18',
  stop: 'M7 7h10v10H7z',
  end: 'M3 14.5c5-5 13-5 18 0l-2.3 2.7-3.7-1.4v-2.6a10 10 0 0 0-6 0v2.6l-3.7 1.4z',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10',
  silent: 'M4 9h4l5-4v14l-5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  check: 'M5 12.5l4.5 4.5L19 7',
  refresh: 'M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20v-4.5h4.5',
  wave: 'M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4',
  globe: 'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0zM3 12h18M12 3c4 5 4 13 0 18M12 3c-4 5-4 13 0 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  'new-chat': 'M20 12v4H9l-5 4V5h9M18 3v6M15 6h6',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5M3.5 4v4.5H8M12 7.5V12l3 2',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'
};

export default function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name] ?? ICONS.wave}/></svg>;
}
