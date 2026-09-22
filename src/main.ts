import Phaser from 'phaser';
import './style.css';
import { NetClient } from './net/client';
import { Hud } from './hud';
import { GameScene } from './scene';
import { initAudio } from './audio';
import { DebugOverlay } from './debug';
import { drawPortrait } from './sprites';
import { CHAR_INFO, CHAR_KINDS, PLAYER_COLORS, type CharKind } from '../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('code');
const err = $('lobby-error');
const SESSION = 'boneyard-session';

interface Session {
  code: string;
  token: string;
}

nameInput.value = localStorage.getItem('boneyard-name') ?? '';
const params = new URLSearchParams(location.search);
const roomParam = params.get('room')?.toUpperCase() ?? null;

const isChar = (v: unknown): v is CharKind => CHAR_KINDS.includes(v as CharKind);
const charParam = params.get('char');
let char: CharKind = isChar(charParam) ? charParam : isChar(localStorage.getItem('boneyard-char')) ? (localStorage.getItem('boneyard-char') as CharKind) : 'archer';

function renderPick() {
  const pick = $('pick');
  pick.innerHTML = '';
  for (const k of CHAR_KINDS) {
    const info = CHAR_INFO[k];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pick-card${k === char ? ' on' : ''}`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === char));
    b.dataset.char = k;
    const cv = document.createElement('canvas');
    drawPortrait(cv, k, PLAYER_COLORS[k === 'knight' ? 2 : 0], 4);
    b.appendChild(cv);
    const txt = document.createElement('div');
    txt.innerHTML = `<b>${info.name}</b><small>${info.role}</small><em>${info.weight}</em>`;
    b.appendChild(txt);
    b.onclick = () => {
      char = k;
      localStorage.setItem('boneyard-char', k);
      renderPick();
    };
    pick.appendChild(b);
  }
  const info = CHAR_INFO[char];
  $('controls').innerHTML =
    `<li class="blurb">${info.blurb}</li><li><b>WASD</b> move · <b>Mouse</b> aim</li>` +
    info.controls.map(([k, d]) => `<li><b>${k}</b> ${d}</li>`).join('') +
    '<li><b>1 2 3</b> pick level-up perk</li>';
}
renderPick();
if (roomParam) {
  codeInput.value = roomParam;
  $('join').classList.add('primary');
  $('create').classList.remove('primary');
  err.style.color = '#ffd23f';
  err.textContent = `Invite for room ${roomParam} — enter a name and hit Join.`;
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
  const name = nameInput.value.trim() || `Crawler${Math.floor(Math.random() * 90 + 10)}`;
  localStorage.setItem('boneyard-name', name);
  initAudio();
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
    if (m.t !== 'joined') return;
    session = { code: m.code, token: m.token };
    sessionStorage.setItem(SESSION, JSON.stringify(session));
    if (started) return;
    started = true;
    $('lobby').hidden = true;
    const hud = new Hud(m.code);
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game',
      pixelArt: true,
      roundPixels: true,
      backgroundColor: '#0d0810',
      scale: { mode: Phaser.Scale.RESIZE, width: innerWidth, height: innerHeight },
      scene: [],
    });
    game.scene.add('game', GameScene, true, { client, hud, debug });
    Object.assign(window, { __game: game, __net: client });
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
