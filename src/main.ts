import Phaser from 'phaser';
import './style.css';
import { NetClient } from './net/client';
import { Hud } from './hud';
import { GameScene } from './scene';
import { DebugOverlay } from './debug';
import { Input } from './input';
import { CHAR_INFO, CHAR_KINDS, type CharKind } from '../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('code');
const err = $('lobby-error');
const SESSION = 'genesis-session';

interface Session {
  code: string;
  token: string;
}

nameInput.value = localStorage.getItem('genesis-name') ?? '';
const params = new URLSearchParams(location.search);
const roomParam = params.get('room')?.toUpperCase() ?? null;

const isChar = (v: unknown): v is CharKind => CHAR_KINDS.includes(v as CharKind);
const charParam = params.get('char');
let char: CharKind = isChar(charParam) ? charParam : isChar(localStorage.getItem('genesis-char')) ? (localStorage.getItem('genesis-char') as CharKind) : 'archer';

function renderPick() {
  const pick = $('pick');
  pick.innerHTML = '';
  for (const k of CHAR_KINDS) {
    const info = CHAR_INFO[k];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pick-card ${k}${k === char ? ' on' : ''}`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === char));
    b.innerHTML = `<span class="portrait"></span><b>${info.name}</b><small>${info.blurb}</small>`;
    b.onclick = () => {
      char = k;
      localStorage.setItem('genesis-char', k);
      renderPick();
    };
    pick.appendChild(b);
  }
}
renderPick();
if (roomParam) {
  codeInput.value = roomParam;
  $('join').classList.add('primary');
  $('create').classList.remove('primary');
  err.style.color = '#ffd23f';
  err.textContent = `Invite for room ${roomParam}: pick a character and hit Join.`;
}

const loadSession = (): Session | null => {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION) ?? 'null');
  } catch {
    return null;
  }
};

let started = false;
let busy = false;

function fatal(text: string, lobby = false) {
  $('reconnecting').hidden = true;
  $('conn-msg').textContent = text;
  $('conn-lobby').hidden = !lobby;
  $('conn').hidden = false;
}

type First = { t: 'create' } | { t: 'join'; code: string } | { t: 'rejoin'; code: string; token: string };

function connect(first: First) {
  if (started || busy) return;
  busy = true;
  const name = nameInput.value.trim() || `Player${Math.floor(Math.random() * 90 + 10)}`;
  localStorage.setItem('genesis-name', name);
  err.style.color = '';
  err.textContent = first.t === 'rejoin' ? `Rejoining room ${first.code}…` : 'Connecting…';
  const client = new NetClient();
  const net = client.net;
  const debug = new DebugOverlay(client);
  let session: Session | null = first.t === 'rejoin' ? { code: first.code, token: first.token } : null;

  net.onOpen = (again) => {
    if (again && session) net.sendJson({ t: 'rejoin', code: session.code, token: session.token });
    else if (first.t === 'create') net.sendJson({ t: 'create', name, char });
    else if (first.t === 'join') net.sendJson({ t: 'join', code: first.code, name, char });
    else net.sendJson(first);
  };
  net.onStatus = (s) => {
    $('reconnecting').hidden = s !== 'retrying' || !started;
    if (s === 'dead' && started && $('conn').hidden) fatal('Connection lost and could not be restored.');
    if (s === 'dead' && !started) {
      busy = false;
      if (!err.textContent || err.textContent.endsWith('…')) err.textContent = 'Could not reach the game server. Is it running?';
    }
  };
  net.onJson = (m) => {
    client.handleJson(m);
    if (m.t === 'error') {
      if (m.reason === 'replaced') {
        net.close();
        return fatal('This slot was opened in another tab.');
      }
      if (m.reason === 'expired' || m.reason === 'missing') sessionStorage.removeItem(SESSION);
      if (started) {
        net.close();
        return fatal('Your slot expired while you were away.', true);
      }
      err.textContent = first.t === 'rejoin' ? `${m.msg} Start or join a room.` : m.msg;
      busy = false;
      net.close();
      debug.el.remove();
      return;
    }
    if (m.t === 'meta' && started) return;
    if (m.t !== 'joined') return;
    session = { code: m.code, token: m.token };
    sessionStorage.setItem(SESSION, JSON.stringify(session));
    if (started) return;
    started = true;
    $('lobby').hidden = true;
    const myChar = first.t === 'rejoin' ? null : char;
    const boot = () => {
      const kind = myChar ?? client.meta.get(client.myId)?.char ?? char;
      const hud = new Hud(m.code, kind);
      const input = new Input($('game'));
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: 'game',
        pixelArt: true,
        transparent: true,
        scale: { mode: Phaser.Scale.RESIZE, width: innerWidth, height: innerHeight },
        scene: [],
      });
      game.scene.add('game', GameScene, true, { client, hud, debug, input });
      Object.assign(window, { __game: game, __net: client });
    };
    // On a rejoin our character arrives with the meta message right after "joined".
    if (myChar) boot();
    else setTimeout(boot, 50);
  };
}

$('create').onclick = () => connect({ t: 'create' });
$('join').onclick = () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    err.textContent = 'Room codes are 4 letters.';
    return;
  }
  connect({ t: 'join', code });
};
$('conn-lobby').onclick = () => {
  sessionStorage.removeItem(SESSION);
  location.href = location.pathname;
};
codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && $('join').click());
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && (roomParam ? $('join') : $('create')).click());

const saved = loadSession();
if (saved && (!roomParam || roomParam === saved.code)) connect({ t: 'rejoin', ...saved });
// ?go=1 skips the lobby (create, or join with ?room=) for quick multi-tab testing.
else if (params.has('go')) connect(roomParam ? { t: 'join', code: roomParam } : { t: 'create' });
