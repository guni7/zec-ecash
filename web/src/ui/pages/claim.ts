// A judge's claim link: #/claim/<token>. The token is in the URL fragment, which browsers never
// send to a server, so it isn't in any server log. The page takes it out of the address bar at
// once (kept in this tab's sessionStorage until the claim succeeds, so a failed claim can be
// retried), redeems it at the mint, then opens the judges' tour. A first-time visitor gets the
// money before the welcome and backup screens. Every link is single-use: the mint refuses a
// token that was already redeemed.
import { getTokenMetadata } from '@cashu/cashu-ts';
import { busy, h } from '../dom';
import { go } from '../router';
import { pageHead, resultView, waiting, type Page } from '../widgets';
import { moneyText } from '../words';

const PENDING = 'zec-ecash-claim';

/** The claim's token: from the link (then out of the address bar), or this tab's unfinished claim. */
function takeToken(fromLink: string | null): string | null {
  if (fromLink) {
    sessionStorage.setItem(PENDING, fromLink);
    history.replaceState(history.state, '', `${location.pathname}${location.search}#/claim`);
  }
  return sessionStorage.getItem(PENDING);
}

export const claim: Page = {
  title: 'Claim',
  render(app, route) {
    const token = takeToken(route.params.get('d'));
    const body = h('div', { class: 'flow' });
    const el = h('div', { class: 'page' }, pageHead('Welcome, judge'), body);
    if (!token) {
      body.replaceChildren(resultView({ ok: false, title: 'No claim link here', text: 'Open the link you were given, or start the tour with your own money.', actions: [h('a', { href: '#/judges', class: 'btn primary block' }, 'Open the tour')], done: false }));
      return { el };
    }
    let amount: number;
    try {
      amount = Number(String(getTokenMetadata(token).amount));
    } catch {
      sessionStorage.removeItem(PENDING);
      body.replaceChildren(resultView({ ok: false, title: 'This link is damaged', text: 'Part of it is missing. Ask for a new one.', done: false }));
      return { el };
    }
    // Once per device: these links are bearer money.
    const warnKey = app.core.key('judge-warned');
    const warn = localStorage.getItem(warnKey) ? null : h('p', { class: 'warn-line', role: 'note' }, 'Anyone with this link can claim it. Don’t share it.');
    localStorage.setItem(warnKey, '1');
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attempt = async () => {
      body.replaceChildren(h('p', { class: 'claim-line' }, `Welcome, judge — claiming ${moneyText(amount)}…`), warn ?? '', h('div', { class: 'working' }, waiting('Claiming…')));
      try {
        const r = await app.tokens.receive(token);
        if (r.offline) throw new Error('offline');
        sessionStorage.removeItem(PENDING);
        app.prefs.set({ welcomed: true }); // the money came first; Home shows the backup card next
        if (gone) return;
        body.replaceChildren(
          resultView({ ok: true, title: 'Claimed', zat: r.amount, sign: '+', text: 'It’s in your wallet. The tour opens next.', actions: [h('a', { href: '#/judges', class: 'btn primary block' }, 'Start the tour')], done: false }),
          warn ?? '',
        );
        timer = setTimeout(() => !gone && go('/judges', true), 2500);
      } catch (e) {
        if (gone) return;
        const why = app.core.explain(e);
        if (/already (been )?spent|already redeemed|spent/i.test(why)) {
          sessionStorage.removeItem(PENDING);
          body.replaceChildren(resultView({ ok: false, title: 'Already used', text: 'This link has already been used. If that wasn’t you, ask for a new one.', actions: [h('a', { href: '#/judges', class: 'btn block' }, 'Open the tour anyway')], done: false }));
          return;
        }
        const retry = h('button', { type: 'button', class: 'btn primary block' }, 'Try again');
        retry.onclick = () => void busy(retry, attempt, app.explain);
        // unlocked tokens are never taken offline (offline.ts): it needs the mint
        const offline = (e instanceof Error && (e.message === 'offline' || /^Offline, not accepted/.test(e.message))) || app.core.isNetworkError(e);
        body.replaceChildren(resultView({ ok: false, title: 'Not claimed yet', text: offline || !navigator.onLine ? 'Claiming needs a connection. Nothing was lost: connect and try again.' : app.explain(e), actions: [retry], done: false }));
      }
    };
    void attempt();
    return { el, cleanup: () => ((gone = true), clearTimeout(timer)) };
  },
};

