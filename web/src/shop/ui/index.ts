// Shop mode's pages, loaded on first use (main.ts), so the wallet alone never downloads them.
import type { Page } from '../../ui/widgets';
import { shopFor } from '../open';
import type { Shop } from '../store';
import { chargePage } from './charge';
import { customerInvoicePage, customerReceiptPage } from './customer';
import { dashboardPage } from './dashboard';
import { invoicesPage } from './invoices';
import { setupPage } from './setup';

export { shopFor };

export const pages: Record<'charge' | 'invoices' | 'dashboard' | 'shop' | 'invoice' | 'receipt', (shop: Shop) => Page> = {
  charge: chargePage,
  invoices: invoicesPage,
  dashboard: dashboardPage,
  shop: setupPage,
  invoice: () => customerInvoicePage,
  receipt: () => customerReceiptPage,
};
