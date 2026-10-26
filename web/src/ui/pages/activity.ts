import { h, svg, ICON } from '../dom';
import { emptyState, feedRow, pageHead, type Page } from '../widgets';

export const activity: Page = {
  title: 'Activity',
  render(app) {
    const body = h('div', { class: 'flow' });
    const update = () => {
      const all = app.feed();
      const moving = all.filter((i) => i.pending);
      const done = all.filter((i) => !i.pending);
      body.replaceChildren(
        moving.length ? h('section', { class: 'section' }, h('h2', { class: 'section-title' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), 'In progress'), h('div', { class: 'feed' }, moving.map(feedRow))) : '',
        done.length
          ? h('section', { class: 'section' }, moving.length ? h('h2', { class: 'section-title' }, 'Done') : '', h('div', { class: 'feed' }, done.map(feedRow)))
          : moving.length
            ? ''
            : emptyState('Nothing here yet.', h('a', { href: '#/deposit', class: 'btn primary' }, svg(ICON.deposit), 'Add money')),
      );
    };
    update();
    const el = h('div', { class: 'page' }, pageHead('Activity'), body);
    return { el, cleanup: app.onChange(update) };
  },
};
