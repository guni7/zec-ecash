import type { FeedItem } from '../../wallet/activity';
import { busy, h, svg, ICON } from '../dom';
import { emptyState, feedRow, pageHead, type App, type Page } from '../widgets';

/** A sent code nobody has taken yet carries "Take it back" (asks first), as on its own page. */
function row(app: App, item: FeedItem) {
  const sent = item.id.startsWith('s:') ? app.tokens.sent().find((s) => `s:${s.id}` === item.id) : undefined;
  if (!sent || sent.state !== 'pending' || sent.lockedTo || sent.request) return feedRow(item);
  const actions = h('div', { class: 'feed-actions' });
  const ask = h('button', { type: 'button', class: 'btn danger-outline' }, 'Take it back');
  ask.onclick = () => {
    const yes = h('button', { type: 'button', class: 'btn danger' }, 'Yes, take it back');
    const no = h('button', { type: 'button', class: 'btn ghost' }, 'Keep it');
    no.onclick = () => actions.replaceChildren(ask);
    yes.onclick = () => void busy(yes, async () => void (await app.tokens.reclaim(sent.id)), app.explain);
    actions.replaceChildren(h('div', { class: 'ask', role: 'alertdialog', 'aria-label': 'Take the money back?' }, h('p', null, 'Take the money back? This code stops working.'), h('div', { class: 'row' }, yes, no)));
    yes.focus();
  };
  actions.append(ask);
  return h('div', { class: 'feed-item' }, feedRow(item), actions);
}

export const activity: Page = {
  title: 'Activity',
  render(app) {
    const body = h('div', { class: 'flow' });
    const update = () => {
      const all = app.feed();
      const moving = all.filter((i) => i.pending);
      const done = all.filter((i) => !i.pending);
      body.replaceChildren(
        moving.length ? h('section', { class: 'section' }, h('h2', { class: 'section-title' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), 'In progress'), h('div', { class: 'feed' }, moving.map((i) => row(app, i)))) : '',
        done.length
          ? h('section', { class: 'section' }, moving.length ? h('h2', { class: 'section-title' }, 'Done') : '', h('div', { class: 'feed' }, done.map(feedRow)))
          : moving.length
            ? ''
            : emptyState('Nothing here yet.', h('a', { href: '#/deposit', class: 'btn primary' }, svg(ICON.deposit), 'Add money')),
      );
    };
    update();
    // Codes waiting to be picked up: noticed here too.
    const check = () => app.tokens.sent().filter((s) => s.state === 'pending' && !s.request).forEach((s) => void app.tokens.refresh(s.id).catch(() => {}));
    check();
    const timer = setInterval(check, 10_000);
    const el = h('div', { class: 'page' }, pageHead('Activity'), body);
    const off = app.onChange(update);
    return {
      el,
      cleanup: () => {
        clearInterval(timer);
        off();
      },
    };
  },
};
