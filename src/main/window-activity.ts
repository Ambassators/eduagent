import type { BrowserWindow } from 'electron';

export const windowIsActive = (window: BrowserWindow) => window.isFocused() && window.isVisible() && !window.isMinimized();
export function watchWindowActivity(window: BrowserWindow) {
  const changed = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('voice:windowActivity', windowIsActive(window));
  };
  window.on('focus', changed);
  window.on('blur', changed);
  window.on('show', changed);
  window.on('hide', changed);
  window.on('minimize', changed);
  window.on('restore', changed);
}
