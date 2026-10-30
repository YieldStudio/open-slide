// Served to the browser as a virtual module. Plain DOM on purpose: it sits on
// top of open-slide's UI without depending on its React tree.
export const CLIENT_SOURCE = String.raw`
const hot = import.meta.hot;
if (hot) {
  const css = document.createElement('style');
  css.textContent = ${'`'}
    #osc-presence { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex;
      align-items: center; gap: 6px; font: 500 12px/1 system-ui, sans-serif; pointer-events: none; }
    #osc-presence .osc-avatar { width: 26px; height: 26px; border-radius: 50%; color: #fff; display: grid;
      place-items: center; font-weight: 600; box-shadow: 0 0 0 2px #fff; pointer-events: auto; }
    #osc-presence .osc-pill { padding: 7px 10px; border-radius: 999px; color: #fff; pointer-events: auto;
      box-shadow: 0 2px 8px rgba(0,0,0,.15); }
    #osc-banner { position: fixed; left: 0; right: 0; top: 0; z-index: 2147483001; padding: 8px 16px;
      background: #b45309; color: #fff; font: 500 13px/1.4 system-ui, sans-serif; text-align: center; }
  ${'`'};
  document.head.append(css);
  const presence = document.createElement('div');
  presence.id = 'osc-presence';
  const banner = document.createElement('div');
  banner.id = 'osc-banner';
  banner.hidden = true;
  document.body.append(presence, banner);

  const initials = (name) => name.split(/\s+/).map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase();
  const where = (p) => (p.slideId ? p.slideId + ' · p.' + (p.page + 1) : 'hors slide');

  hot.on('collab:state', (state) => {
    banner.hidden = !state.readOnly;
    banner.textContent = state.readOnly ? 'Lecture seule — ' + state.reason : '';
    presence.replaceChildren();
    if (state.blockedBy) {
      const pill = document.createElement('div');
      pill.className = 'osc-pill';
      pill.dataset.collabLock = state.blockedBy.user;
      pill.style.background = state.blockedBy.color;
      pill.textContent = '🔒 ' + state.blockedBy.user + ' modifie cette page';
      presence.append(pill);
    }
    for (const p of state.participants) {
      const avatar = document.createElement('div');
      avatar.className = 'osc-avatar';
      avatar.dataset.collabUser = p.user;
      avatar.style.background = p.color;
      avatar.textContent = initials(p.user);
      avatar.title = p.user + ' — ' + where(p);
      presence.append(avatar);
    }
  });

  let last = '';
  const report = () => {
    const key = location.pathname + location.search;
    if (key !== last) {
      last = key;
      hot.send('collab:location', { path: location.pathname, search: location.search });
    } else {
      hot.send('collab:alive', {});
    }
  };
  hot.send('collab:hello', {});
  report();
  setInterval(report, 1000);
  document.addEventListener('visibilitychange', () => {
    last = '';
    report();
  });
}
`;
