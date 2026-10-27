// The shop store, opened once per page load. Small on purpose: backup, restore and Settings use it
// without pulling in the shop pages, the dashboard or the PDF code.
import type { App } from '../ui/widgets';
import { openShop, type Shop } from './store';

let opening: Promise<Shop> | null = null;
export const shopFor = (app: App) => (opening ??= openShop(app.core, app.posreq, app.tokens));

/** Whether this device has shop data at all (without creating the database). */
export async function hasShopData(mintUrl: string): Promise<boolean> {
  try {
    return (await indexedDB.databases()).some((d) => d.name === `zec-ecash-shop:${mintUrl}`);
  } catch {
    return true; // can't tell: look inside
  }
}
