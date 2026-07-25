import { Menu, type BrowserWindow } from 'electron';
import type { TabManager } from './tabs';

/** Application menu exists mainly to provide global keyboard shortcuts
 *  (the menu bar itself is auto-hidden to keep the UI minimal). */
export function buildMenu(
  getTabs: () => TabManager | null,
  getWin: () => BrowserWindow | null
): Menu {
  const t = (fn: (tabs: TabManager) => void) => (): void => {
    const tabs = getTabs();
    if (tabs) fn(tabs);
  };
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: t((x) => x.newTab()) },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: t((x) => x.closeActive()) },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: t((x) => x.back()) },
        { label: 'Forward', accelerator: 'Alt+Right', click: t((x) => x.forward()) },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: t((x) => x.reload()) },
        { label: 'Reload (F5)', accelerator: 'F5', visible: false, click: t((x) => x.reload()) },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: t((x) => x.reload(true)) },
        { type: 'separator' },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: (): void => {
            getWin()?.webContents.send('chrome:focus-address');
          }
        },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: t((x) => x.cycle(1)) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: t((x) => x.cycle(-1)) }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: t((x) => x.zoom(0.5)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: t((x) => x.zoom(-0.5)) },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: t((x) => x.zoom(0)) },
        { type: 'separator' },
        { label: 'Page DevTools', accelerator: 'CmdOrCtrl+Shift+I', click: t((x) => x.openDevTools()) },
        {
          label: 'UI DevTools',
          click: (): void => {
            getWin()?.webContents.openDevTools({ mode: 'detach' });
          }
        }
      ]
    }
  ]);
}
