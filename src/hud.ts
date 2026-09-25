import { CHAR_INFO, COMMON_CONTROLS, PLAYER_COLORS, type CharKind, type PlayerMeta } from '../shared/protocol';

const $ = (id: string) => document.getElementById(id)!;

/** DOM overlay: room code and invite, party list, controls, messages, restart progress. */
export class Hud {
  private partyKey = '';
  private bannerTimer = 0;

  constructor(
    private code: string,
    char: CharKind,
  ) {
    $('hud').hidden = false;
    $('room-code').textContent = code;
    $('copy-link').onclick = () => {
      const url = `${location.origin}${location.pathname}?room=${this.code}`;
      navigator.clipboard?.writeText(url).then(
        () => this.message('Invite link copied'),
        () => this.message(url),
      );
    };
    const info = CHAR_INFO[char];
    $('help').innerHTML =
      `<b>${info.name}</b> — ${info.blurb}<ul>` +
      [...info.controls, ...COMMON_CONTROLS].map(([k, d]) => `<li><kbd>${k}</kbd> ${d}</li>`).join('') +
      '</ul><small>H hides this · F3 netcode overlay</small>';
    addEventListener('keydown', (e) => {
      if (e.code === 'KeyH' && !e.repeat) $('help').classList.toggle('min');
    });
    // Tuck the controls away once people have had a look; H brings them back.
    setTimeout(() => $('help').classList.add('min'), 30000);
  }

  level(name: string) {
    $('level-name').textContent = name;
    this.message(name, true);
  }

  players(meta: Map<number, PlayerMeta>, me: number) {
    const list = [...meta.values()];
    const key = list.map((p) => `${p.id}${p.name}${p.char}${p.c}`).join('|') + me;
    if (key === this.partyKey) return;
    this.partyKey = key;
    $('party').innerHTML = list
      .map((p) => `<li style="--c:${PLAYER_COLORS[p.c]}"><i></i>${escape(p.name)} <small>${CHAR_INFO[p.char].name}${p.id === me ? ' · you' : ''}</small></li>`)
      .join('');
  }

  message(text: string, big = false) {
    if (big) {
      const b = $('banner');
      b.textContent = text;
      b.classList.add('on');
      clearTimeout(this.bannerTimer);
      this.bannerTimer = window.setTimeout(() => b.classList.remove('on'), 2200);
      return;
    }
    const li = document.createElement('li');
    li.textContent = text;
    const feed = $('feed');
    feed.appendChild(li);
    setTimeout(() => li.classList.add('fade'), 3500);
    setTimeout(() => li.remove(), 4200);
    while (feed.children.length > 5) feed.firstChild!.remove();
  }

  restart(f: number) {
    const el = $('restart');
    el.classList.toggle('on', f > 0);
    ($('restart-fill') as HTMLElement).style.width = `${f * 100}%`;
  }
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
