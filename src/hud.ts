import { FLOORS, ITEM_INFO, PLAYER_COLORS, STAT_INFO, type WorldView, type StatKind } from '../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private lastChoiceKey = '';
  private lastItems = '';
  private lastParty = '';
  private bannerTimer = 0;
  onChoose: (idx: number) => void = () => {};
  onRestart: () => void = () => {};
  choices: StatKind[] | null = null;

  constructor(code: string) {
    $('hud').hidden = false;
    $('room-code').textContent = code;
    const link = `${location.origin}${location.pathname}?room=${code}`;
    $('copy-link').onclick = () => {
      navigator.clipboard?.writeText(link).catch(() => {});
      $('copy-link').textContent = 'Copied!';
      setTimeout(() => ($('copy-link').textContent = 'Copy invite'), 1200);
    };
    $('restart').onclick = () => this.onRestart();
    const q = new URLSearchParams(location.search);
    q.set('room', code);
    history.replaceState(null, '', `?${q}`);
  }

  banner(text: string) {
    const b = $('banner');
    b.textContent = text;
    b.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), 2200);
  }

  feed(text: string) {
    const li = document.createElement('li');
    li.textContent = text;
    const f = $('feed');
    f.appendChild(li);
    while (f.children.length > 6) f.firstChild?.remove();
    setTimeout(() => li.remove(), 4000);
  }

  flash(strength = 0.35) {
    const el = $('flash');
    el.style.transition = 'none';
    el.style.opacity = String(strength);
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.35s ease-out';
      el.style.opacity = '0';
    });
  }

  update(s: WorldView, myId: number) {
    const me = s.players.find((p) => p.id === myId);
    if (me) {
      $('hp-fill').style.width = `${(100 * me.hp) / me.maxHp}%`;
      $('hp-text').textContent = me.down ? 'DOWN — wait for a revive' : `${me.hp} / ${me.maxHp}`;
      $('xp-fill').style.width = `${(100 * me.xp) / me.xpNext}%`;
      $('xp-text').textContent = `LV ${me.lvl}`;
      $('dash-fill').style.width = `${100 * (1 - me.dashCd)}%`;
      const itemsKey = me.items.join();
      if (itemsKey !== this.lastItems) {
        this.lastItems = itemsKey;
        const counts = new Map<string, number>();
        for (const k of me.items) counts.set(k, (counts.get(k) ?? 0) + 1);
        $('items').innerHTML = [...counts]
          .map(([k, n]) => {
            const info = ITEM_INFO[k as keyof typeof ITEM_INFO];
            return `<span title="${info.desc}">${info.name}${n > 1 ? ` ×${n}` : ''}</span>`;
          })
          .join('');
      }
      const ck = me.choices ? me.choices.join() + me.pending : '';
      if (ck !== this.lastChoiceKey) {
        this.lastChoiceKey = ck;
        this.choices = me.choices;
        $('levelup').hidden = !me.choices;
        if (me.choices) {
          $('lvl-more').textContent = me.pending > 1 ? `(+${me.pending - 1} more)` : '';
          $('cards').innerHTML = '';
          me.choices.forEach((c, i) => {
            const b = document.createElement('button');
            b.innerHTML = `<b>${i + 1}. ${STAT_INFO[c].name}</b><small>${STAT_INFO[c].desc}</small>`;
            b.onclick = () => this.onChoose(i);
            $('cards').appendChild(b);
          });
        }
      }
    }

    $('floor-label').textContent = s.floor === FLOORS ? 'FINAL FLOOR' : `FLOOR ${s.floor} / ${FLOORS}`;
    const boss = s.enemies.find((e) => e.k === 'boss');
    const obj = $('objective');
    if (boss) {
      obj.textContent = '';
      $('boss-bar').hidden = false;
      $('boss-fill').style.width = `${(100 * boss.hp) / boss.maxHp}%`;
    } else {
      $('boss-bar').hidden = true;
      obj.textContent = s.stairs ? 'Stairs open — find the way down' : s.floor === FLOORS ? '' : `${s.left} foes remain`;
      obj.classList.toggle('open', s.stairs);
    }

    const partyKey = s.players.map((p) => `${p.id}${p.hp}${p.down}${p.lvl}${p.rev}${p.off}${p.name}`).join('|');
    if (partyKey !== this.lastParty) {
      this.lastParty = partyKey;
      $('party').innerHTML = s.players
        .map(
          (p) =>
            `<li class="${p.down || p.off ? 'down' : ''}" style="border-color:${PLAYER_COLORS[p.c]}"><span>${p.id === myId ? '▶ ' : ''}${escape(p.name)} · LV${p.lvl}${p.off ? ' · OFFLINE' : ''}${
              p.down ? ` · DOWN ${p.rev > 0 ? Math.round(p.rev * 100) + '%' : ''}` : ''
            }</span><div class="mini"><div style="width:${(100 * p.hp) / p.maxHp}%"></div></div></li>`,
        )
        .join('');
    }

    const end = $('endscreen');
    if (s.phase === 'play') end.hidden = true;
    else if (end.hidden) {
      end.hidden = false;
      $('end-title').textContent = s.phase === 'win' ? 'VICTORY' : 'WIPED OUT';
      $('end-sub').textContent =
        s.phase === 'win' ? 'The Bone Warden is dust. The Boneyard is quiet — for now.' : `The party fell on floor ${s.floor}.`;
      $('end-stats').innerHTML = s.players.map((p) => `<li>${escape(p.name)} — LV ${p.lvl}, ${p.kills} kills</li>`).join('');
    }
  }
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
