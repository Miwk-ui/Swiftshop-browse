import { app, type BrowserWindow, type Session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DownloadState } from '../shared/types';

export interface DownloadsHandle {
  list: () => DownloadState[];
}

/** Saves downloads straight to the OS Downloads folder (deduped filenames,
 *  no blocking save dialog) and streams progress to the chrome UI. */
export function setupDownloads(ses: Session, getWin: () => BrowserWindow | null): DownloadsHandle {
  const items: DownloadState[] = [];
  let nextId = 1;

  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    let savePath = path.join(dir, item.getFilename());
    let n = 1;
    while (fs.existsSync(savePath)) {
      const ext = path.extname(item.getFilename());
      const base = path.basename(item.getFilename(), ext);
      savePath = path.join(dir, `${base} (${n++})${ext}`);
    }
    item.setSavePath(savePath);

    const state: DownloadState = {
      id: nextId++,
      filename: path.basename(savePath),
      savePath,
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      state: 'progressing'
    };
    items.unshift(state);

    const broadcast = (): void => {
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('downloads:state', items);
    };
    item.on('updated', () => {
      state.receivedBytes = item.getReceivedBytes();
      broadcast();
    });
    item.once('done', (_ev, doneState) => {
      state.state = doneState === 'completed' ? 'completed' : doneState === 'cancelled' ? 'cancelled' : 'interrupted';
      state.receivedBytes = item.getReceivedBytes();
      broadcast();
    });
    broadcast();
  });

  return { list: () => items };
}
