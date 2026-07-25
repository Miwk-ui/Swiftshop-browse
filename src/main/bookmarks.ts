import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Bookmark, RetailerProfile } from '../shared/types';

export class Bookmarks {
  private readonly file = path.join(app.getPath('userData'), 'bookmarks.json');
  private items: Bookmark[] = [];

  constructor(retailers: RetailerProfile[]) {
    try {
      this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Bookmark[];
    } catch {
      // first run: seed with the retailer homepages
      this.items = retailers.flatMap((r) => r.bookmarks);
      this.persist();
    }
  }

  list(): Bookmark[] {
    return this.items;
  }

  add(b: Bookmark): Bookmark[] {
    if (b.url && !this.items.some((x) => x.url === b.url)) {
      this.items.push(b);
      this.persist();
    }
    return this.items;
  }

  remove(url: string): Bookmark[] {
    this.items = this.items.filter((x) => x.url !== url);
    this.persist();
    return this.items;
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch {
      // non-fatal
    }
  }
}
