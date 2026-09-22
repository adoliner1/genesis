import Phaser from 'phaser';
import './style.css';
import type { FloorMsg } from '../shared/protocol';
import { Net } from './net';
import { Hud } from './hud';
import { GameScene } from './scene';
import { initAudio } from './audio';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('code');
const err = $('lobby-error');

nameInput.value = localStorage.getItem('boneyard-name') ?? '';
const params = new URLSearchParams(location.search);
const roomParam = params.get('room');
if (roomParam) {
  codeInput.value = roomParam.toUpperCase();
  $('join').classList.add('primary');
  $('create').classList.remove('primary');
  err.style.color = '#ffd23f';
  err.textContent = `Invite for room ${roomParam.toUpperCase()} — enter a name and hit Join.`;
}

let started = false;

function connect(first: { t: 'create' } | { t: 'join'; code: string }) {
  if (started) return;
  const name = nameInput.value.trim() || `Crawler${Math.floor(Math.random() * 90 + 10)}`;
  localStorage.setItem('boneyard-name', name);
  initAudio();
  err.style.color = '';
  err.textContent = 'Connecting…';
  const net = new Net();
  let floor: FloorMsg | null = null;
  net.on((m) => {
    if (m.t === 'floor') floor = m;
    if (m.t === 'error') {
      err.textContent = m.msg;
      net.ws.close();
    }
    if (m.t === 'joined' && !started) {
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
      game.scene.add('game', GameScene, true, { net, myId: m.id, hud, floor: () => floor });
      (window as unknown as { __game: Phaser.Game }).__game = game;
    }
  });
  net.onClose = () => {
    if (started) $('conn').hidden = false;
    else if (!err.textContent || err.textContent === 'Connecting…') err.textContent = 'Could not reach the game server. Is it running?';
  };
  net.send(first.t === 'create' ? { t: 'create', name } : { t: 'join', code: first.code, name });
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
codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && $('join').click());
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && (roomParam ? $('join') : $('create')).click());
