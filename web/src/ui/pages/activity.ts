import { h } from '../dom';
import { emptyState, feedRow, pageHead, type Page } from '../widgets';

export const activity: Page = {
  title: 'Activity',
  render(app) {
    const body = h('div');
    const update = () => {
      const all = app.feed();
      const moving = all.filter((i) => i.pending);
      const done = all.filter((i) => !i.pending);
      body.replaceChildren(
        moving.length
          ? h('section', { class: 'section' }, h('h3', { class: 'section-title' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), `In progress · ${moving.length}`), h('p', { class: 'hint' }, 'Tap one to follow it, finish it, or take a token back.'), h('div', { class: 'feed' }, moving.map(feedRow)))
          : '',
        h('section', { class: 'section' }, h('h3', { class: 'section-title' }, 'History'), done.length ? h('div', { class: 'feed' }, done.map(feedRow)) : emptyState('No history yet.')),
      );
    };
    update();
    const el = h('div', { class: 'page' }, pageHead('ACTIVITY', 'Activity', 'Deposits, mints, sends, receives and withdrawals in this browser.'), body);
    return { el, cleanup: app.onChange(update) };
  },
};
