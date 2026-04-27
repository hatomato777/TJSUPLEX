/* =========================================================
   TJ SUPLEX RUN  —  side-scrolling runner
   ========================================================= */

(() => {
  'use strict';

  // ---------- TELEGRAM MINI APP INTEGRATION ----------
  // When run inside Telegram, Telegram's WebApp SDK injects
  // window.Telegram.WebApp. Outside Telegram (regular browser) it's null
  // and we silently fall back to the standard nickname-input flow.
  const TG       = (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp)
                    ? window.Telegram.WebApp : null;
  const TG_USER  = (TG && TG.initDataUnsafe && TG.initDataUnsafe.user) ? TG.initDataUnsafe.user : null;
  const inTelegram = !!TG;
  if (TG) {
    try {
      TG.ready();
      TG.expand();                  // use full modal height
      // Match the game's dark navy panel so the WebView chrome blends in
      if (TG.setHeaderColor)     TG.setHeaderColor('#0e1628');
      if (TG.setBackgroundColor) TG.setBackgroundColor('#0e1628');
    } catch (e) { /* ignore — older Telegram clients may miss some methods */ }
  }
  // Returns the player's Telegram name (username preferred, full name fallback)
  // or null if not running in Telegram / no user info.
  function getTelegramName() {
    if (!TG_USER) return null;
    if (TG_USER.username) return TG_USER.username.toUpperCase().slice(0, 16);
    const full = ((TG_USER.first_name || '') + ' ' + (TG_USER.last_name || '')).trim();
    return full ? full.toUpperCase().slice(0, 16) : null;
  }

  // ---------- CANVAS ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const W = canvas.width;   // 960
  const H = canvas.height;  // 540
  const GROUND_Y = Math.round(H * 0.78);  // ground line — matches CSS gradient

  // ---------- ASSETS ----------
  // 8-frame smoother run cycle from the run2 set, ordered by their leading index
  const RUN_FRAMES = [
    'sprites run2/sprites2_0000_8.png',
    'sprites run2/sprites2_0001_7.png',
    'sprites run2/sprites2_0002_6.png',
    'sprites run2/sprites2_0003_5.png',
    'sprites run2/sprites2_0004_4.png',
    'sprites run2/sprites2_0005_3.png',
    'sprites run2/sprites2_0006_2.png',
    'sprites run2/sprites2_0007_1.png',
  ];
  const JUMP_FRAMES   = ['jump sprite/j1.png', 'jump sprite/jump2.png'];
  const COIN_SRC      = 'coin.png';
  const LIFE_FULL_SRC = 'life full.png';
  const LIFE_EMPTY_SRC= 'life empty.png';
  const GROUND_LEFT_SRC   = 'level design/ground left ending.png';
  const GROUND_MID_SRC    = 'level design/ground middle block.png';
  const GROUND_RIGHT_SRC  = 'level design/ground right ending.png';
  const PLATFORM_SRC      = 'level design/platform block.png';
  const ACID_LEFT_SRC     = 'level design/traps/acid left.png';
  const ACID_BLOCK_SRC    = 'level design/traps/acid block.png';
  const ACID_RIGHT_SRC    = 'level design/traps/acid right.png';
  const SPIKES_SRC        = 'level design/traps/spiked.png';
  const PILLAR_SRC        = 'level design/traps/pillar.png';
  const SHOOTER_SRC       = 'level design/traps/fire shooter.png';
  const FIREBOLT_SRC      = 'level design/traps/fire bolt.png';

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load ' + src));
      img.src = src;
    });
  }

  let runImgs = [];
  let jumpImgs = [];
  let coinImg = null;
  let lifeFullImg = null;
  let lifeEmptyImg = null;
  let groundLeftImg  = null;
  let groundMidImg   = null;
  let groundRightImg = null;
  let platformImg    = null;
  let acidLeftImg    = null;
  let acidBlockImg   = null;
  let acidRightImg   = null;
  let spikesImg      = null;
  let pillarImg      = null;
  let shooterImg     = null;
  let fireBoltImg    = null;
  // Offscreen canvas for tinting the player white during hit-blink
  const tintCanvas = document.createElement('canvas');
  const tintCtx = tintCanvas.getContext('2d');

  // ---------- GAME STATE ----------
  const STATE = { MENU: 0, PLAY: 1, OVER: 2 };
  let state = STATE.MENU;

  let score = 0;
  let coinsCollected = 0;
  let baseSpeed = 5;          // gentle start so the player can ease into it
  let scrollSpeed = baseSpeed;
  let speedRamp = 0;          // increases over time (capped, see update())
  let difficulty = 0;         // 0..1 normalized progression
  const COIN_VALUE = 50;
  const MAX_SPEED = 20;       // hard ceiling so it's still playable

  // ----- Lives / damage -----
  const START_LIVES = 3;
  const MAX_LIVES   = 5;
  let lives = START_LIVES;
  let invulnFrames = 0;        // counts down; player can't be hit while > 0
  const INVULN_DURATION = 90;  // ~1.5s @ 60fps

  // Tomato pickups (extra life)
  let tomatoes = [];
  let tomatoTimer = 0;

  // ----- Arctic Jump -----
  // Collect 20 coins → unlock a one-shot triple-jump with a strong icy boost.
  const ARCTIC_REQUIRED       = 20;
  const ARCTIC_JUMP_VELOCITY  = -20;     // bigger boost than the normal jumps
  let arcticCharge            = 0;       // 0..ARCTIC_REQUIRED
  let arcticReady             = false;   // true once full
  let arcticActiveFrames      = 0;       // visual aura timer after activation
  let arcticReadyAt           = -9999;   // frame when charge last hit "ready" (for chime)

  // Game-over animation timing
  let gameOverAt              = -9999;
  let gameOverPanelTimer      = null;

  // "NIGHT FALLS" announcement — fires once per run when score crosses 10000
  let nightFellAt             = -9999;
  let nightAnnounced          = false;

  // City parallax — accumulated world-x for far + near skyline layers.
  // Built up from scrollSpeed each frame so buildings move smoothly with
  // the world and never re-roll their heights as we scroll.
  let cityOffsetFar  = 0;
  let cityOffsetNear = 0;

  // ----- Level / ground tiles -----
  const TILE_SCALE     = 0.55;
  const PLATFORM_SCALE = 0.65;
  // Cached scaled sizes (filled after images load)
  const TILE = { midW: 0, midH: 0, leftW: 0, leftH: 0, rightW: 0, rightH: 0, platW: 0, platH: 0 };

  // Ground segments (solid floor regions) and floating platforms.
  // World coordinates — they shift left every frame at scrollSpeed.
  let groundSegments = [];   // [{startX, endX}]
  let platforms      = [];   // [{x, y, w}]
  let acidPools      = [];   // [{startX, endX}] — deadly liquid in the gaps
  let fireBolts      = [];   // [{x, y, vx}]
  let lastGroundEndX = 0;    // right-most edge of generated ground

  // Trap sprite sizes (cached after load)
  const TRAP = {
    pillarW: 0, pillarH: 0,
    spikesW: 0, spikesH: 0,
    shooterW: 0, shooterH: 0,
    boltW: 0, boltH: 0,
    acidLeftW: 0, acidLeftH: 0,
    acidBlockW: 0, acidBlockH: 0,
    acidRightW: 0, acidRightH: 0,
  };
  const TRAP_SCALE = 0.5;

  // Player
  const player = {
    x: 140,
    y: 0,
    w: 84,           // displayed sprite width
    h: 96,           // displayed sprite height
    vy: 0,
    onGround: true,
    jumpsLeft: 2,    // double jump
    runFrame: 0,
    runTick: 0,
    jumpFrameIdx: 0,
  };
  const GRAVITY = 0.85;
  const JUMP_VELOCITY = -16.5;
  const SECOND_JUMP_VELOCITY = -14;

  // World
  let obstacles = [];
  let coins = [];
  let clouds = [];
  let bushes = [];
  let groundOffset = 0;
  let spawnTimer = 0;
  let coinTimer = 0;
  let frameCount = 0;
  let runningTime = 0;

  // ---------- INPUT ----------
  const keys = new Set();

  function tryJump() {
    if (state === STATE.MENU) { startGame(); return; }
    // Game-over: ignore jump keys / canvas taps. Only the RETRY button
    // (or PLAY again from the menu) can start a new run.
    if (state !== STATE.PLAY) return;

    if (player.onGround) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      player.jumpsLeft = 1;
      playJumpSfx();
    } else if (player.jumpsLeft > 0) {
      player.vy = SECOND_JUMP_VELOCITY;
      player.jumpsLeft = 0;
      playJumpSfx();
    } else if (arcticReady) {
      // ARCTIC JUMP — one-shot triple jump powered by 20 collected coins
      player.vy = ARCTIC_JUMP_VELOCITY;
      arcticReady = false;
      arcticCharge = 0;
      arcticActiveFrames = 36;       // ~0.6s of icy aura
      playArcticJumpSfx();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault();
      if (!keys.has(e.code)) tryJump();
      keys.add(e.code);
    }
  });
  window.addEventListener('keyup', (e) => { keys.delete(e.code); });

  // ONE tap = ONE jump.
  // On mobile the browser fires touchstart THEN pointerdown for the same tap,
  // which previously ate the double-jump on the first tap. We listen to
  // pointerdown only (handles mouse, pen, touch) and swallow the synthesized
  // mouse/touch follow-ups, plus add a tiny dedup window as a safety net.
  let lastTapAt = 0;
  function onTap(e) {
    if (e) {
      e.preventDefault();
      // Stop the synthetic mouse events that follow a touch
      if (e.cancelable) e.stopPropagation();
    }
    const now = performance.now();
    if (now - lastTapAt < 60) return;   // dedup duplicate fires within 60ms
    lastTapAt = now;
    tryJump();
  }
  canvas.addEventListener('pointerdown', onTap);
  // Prevent default touch behavior (scroll/zoom) without triggering jump twice
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchend',   (e) => { e.preventDefault(); }, { passive: false });

  // ON-SCREEN JUMP BUTTON (mobile portrait). Each press = one jump (so a
  // double-tap gives a double jump). Visual feedback via .pressed class.
  const jumpBtn = document.getElementById('jumpBtn');
  if (jumpBtn) {
    jumpBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpBtn.classList.add('pressed');
      onTap(null);   // share dedup window with canvas taps
    });
    const release = () => jumpBtn.classList.remove('pressed');
    jumpBtn.addEventListener('pointerup',     release);
    jumpBtn.addEventListener('pointercancel', release);
    jumpBtn.addEventListener('pointerleave',  release);
    // Block touchstart's default action so the button doesn't trigger
    // synthesized mouse events that the canvas would re-interpret.
    jumpBtn.addEventListener('touchstart', (e) => { e.preventDefault(); }, { passive: false });
    jumpBtn.addEventListener('touchend',   (e) => { e.preventDefault(); release(); }, { passive: false });
  }

  // ---------- AUDIO (procedural — no files needed) ----------
  let audioCtx = null;
  function audio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    return audioCtx;
  }
  function tone(freq, dur, type = 'square', vol = 0.08) {
    const a = audio(); if (!a) return;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g).connect(a.destination);
    const t = a.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur);
  }
  function playJumpSfx()   { tone(660, 0.12, 'square', 0.06); setTimeout(()=>tone(880,0.08,'square',0.05),60); }
  function playCoinSfx()   { tone(988, 0.06, 'triangle', 0.08); setTimeout(()=>tone(1318,0.10,'triangle',0.08),50); }

  // Player loses a life — short noisy "ouch" hit (not the full game-over crash)
  function playHitSfx() {
    const a = audio(); if (!a) return;
    const t = a.currentTime;
    // Tiny noise burst
    try {
      const buf = a.createBuffer(1, a.sampleRate * 0.15, a.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
      }
      const noise = a.createBufferSource();
      noise.buffer = buf;
      const filt = a.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = 700;
      const g = a.createGain();
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      noise.connect(filt).connect(g).connect(a.destination);
      noise.start(t); noise.stop(t + 0.2);
    } catch (e) {}
    // Descending square blip on top
    const o = a.createOscillator();
    const g2 = a.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.18);
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g2).connect(a.destination);
    o.start(t); o.stop(t + 0.25);
  }

  // Arctic Jump charge filled — play the ARCTIC JUMP READY voice clip
  function playArcticChargedSfx() {
    if (arcticReadySfxEl && !arcticReadySfxEl.muted) {
      try {
        arcticReadySfxEl.currentTime = 0;
        const p = arcticReadySfxEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return;
      } catch (e) { /* fall through to chime */ }
    }
    // Fallback procedural chime
    tone(784,  0.06, 'sine',     0.08);
    setTimeout(() => tone(1175, 0.06, 'sine',     0.08), 60);
    setTimeout(() => tone(1568, 0.10, 'sine',     0.10), 120);
    setTimeout(() => tone(2349, 0.16, 'triangle', 0.09), 200);
  }

  // Arctic Jump activated — BIG layered hit:
  //   1) Sub-bass thump (heavy power impact)
  //   2) Noise "fwoosh" through bandpass sweep (icy air rush)
  //   3) Sawtooth low → high sweep with low-pass tracking (the woosh body)
  //   4) Stacked shimmer chord (G6 / D7 / G7 / C8)
  //   5) Final bright sine bell accent
  function playArcticJumpSfx() {
    const a = audio(); if (!a) return;
    const t = a.currentTime;

    // 1) SUB-BASS IMPACT
    try {
      const bass = a.createOscillator();
      const bg   = a.createGain();
      bass.type = 'sine';
      bass.frequency.setValueAtTime(110, t);
      bass.frequency.exponentialRampToValueAtTime(35, t + 0.40);
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.exponentialRampToValueAtTime(0.60, t + 0.015);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      bass.connect(bg).connect(a.destination);
      bass.start(t); bass.stop(t + 0.6);
    } catch (e) { /* ignore */ }

    // 2) ICY NOISE FWOOSH
    try {
      const bufSize = Math.floor(a.sampleRate * 0.45);
      const buffer = a.createBuffer(1, bufSize, a.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufSize; i++) {
        // Decaying envelope on top of white noise
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufSize, 1.6);
      }
      const noise = a.createBufferSource();
      noise.buffer = buffer;
      const hp = a.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 700;
      const bp = a.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.7;
      bp.frequency.setValueAtTime(1800, t);
      bp.frequency.exponentialRampToValueAtTime(7500, t + 0.30);
      const ng = a.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.40, t + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      noise.connect(hp).connect(bp).connect(ng).connect(a.destination);
      noise.start(t); noise.stop(t + 0.5);
    } catch (e) { /* ignore */ }

    // 3) SAWTOOTH WOOSH BODY
    try {
      const sw = a.createOscillator();
      const sg = a.createGain();
      const lp = a.createBiquadFilter();
      sw.type = 'sawtooth';
      sw.frequency.setValueAtTime(180, t);
      sw.frequency.exponentialRampToValueAtTime(2800, t + 0.35);
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(4500, t + 0.35);
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.exponentialRampToValueAtTime(0.34, t + 0.02);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      sw.connect(lp).connect(sg).connect(a.destination);
      sw.start(t); sw.stop(t + 0.5);
    } catch (e) { /* ignore */ }

    // 4) SHIMMER CHORD STACK — staggered triangle bells
    const shimmer = [1568, 2349, 3136, 4186];      // G6, D7, G7, C8
    shimmer.forEach((freq, i) => {
      setTimeout(() => tone(freq, 0.20, 'triangle', 0.13), 70 + i * 32);
    });

    // 5) BIG BELL ACCENT after the woosh
    setTimeout(() => tone(2349, 0.30, 'sine', 0.18), 230);
    setTimeout(() => tone(3136, 0.22, 'sine', 0.14), 290);
  }

  // Picking up a tomato — play the TOMATO.mp3 voice clip (with chime fallback)
  function playTomatoSfx() {
    if (tomatoSfxEl && !tomatoSfxEl.muted) {
      try {
        tomatoSfxEl.currentTime = 0;
        const p = tomatoSfxEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return;
      } catch (e) { /* fall through to procedural chime */ }
    }
    // Fallback chime if the audio element isn't available
    tone(880, 0.08, 'triangle', 0.09);
    setTimeout(() => tone(1175, 0.08, 'triangle', 0.09), 70);
    setTimeout(() => tone(1568, 0.14, 'triangle', 0.09), 140);
  }

  // Beefy multi-layer crash: white-noise burst (impact) + low boom + descending error blip.
  function playCrashSfx() {
    const a = audio(); if (!a) return;
    const t = a.currentTime;

    // 1) NOISE BURST — the actual "smash"
    try {
      const bufSize = a.sampleRate * 0.6;
      const buffer = a.createBuffer(1, bufSize, a.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufSize; i++) {
        // pink-ish noise with quick decay envelope
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufSize, 2.2);
      }
      const noise = a.createBufferSource();
      noise.buffer = buffer;
      const noiseFilt = a.createBiquadFilter();
      noiseFilt.type = 'lowpass';
      noiseFilt.frequency.setValueAtTime(2200, t);
      noiseFilt.frequency.exponentialRampToValueAtTime(180, t + 0.45);
      const noiseGain = a.createGain();
      noiseGain.gain.setValueAtTime(0.35, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      noise.connect(noiseFilt).connect(noiseGain).connect(a.destination);
      noise.start(t);
      noise.stop(t + 0.6);
    } catch (e) { /* ignore */ }

    // 2) LOW BOOM — sub thump for weight
    const boom = a.createOscillator();
    const boomGain = a.createGain();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(140, t);
    boom.frequency.exponentialRampToValueAtTime(40, t + 0.35);
    boomGain.gain.setValueAtTime(0.0001, t);
    boomGain.gain.exponentialRampToValueAtTime(0.45, t + 0.01);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    boom.connect(boomGain).connect(a.destination);
    boom.start(t);
    boom.stop(t + 0.55);

    // 3) ERROR BLIP — descending square "buzzer" (classic game-over feel)
    const blipDelay = 0.12;
    const blip = a.createOscillator();
    const blipGain = a.createGain();
    blip.type = 'square';
    blip.frequency.setValueAtTime(440, t + blipDelay);
    blip.frequency.exponentialRampToValueAtTime(110, t + blipDelay + 0.45);
    blipGain.gain.setValueAtTime(0.0001, t + blipDelay);
    blipGain.gain.exponentialRampToValueAtTime(0.16, t + blipDelay + 0.02);
    blipGain.gain.exponentialRampToValueAtTime(0.0001, t + blipDelay + 0.5);
    blip.connect(blipGain).connect(a.destination);
    blip.start(t + blipDelay);
    blip.stop(t + blipDelay + 0.55);

    // 4) Tail "wah-wah" — two short low square notes for that arcade game-over flavor
    setTimeout(() => tone(196, 0.15, 'square', 0.12), 520);  // G3
    setTimeout(() => tone(146, 0.30, 'square', 0.11), 700);  // D3
  }

  // ---------- WORLD SETUP ----------
  function resetWorld() {
    obstacles = [];
    coins = [];
    tomatoes = [];
    clouds = [];
    bushes = [];
    groundSegments = [];
    platforms = [];
    acidPools = [];
    fireBolts = [];
    lastGroundEndX = 0;
    score = 0;
    coinsCollected = 0;
    speedRamp = 0;
    difficulty = 0;
    scrollSpeed = baseSpeed;
    lives = START_LIVES;
    invulnFrames = 0;
    tomatoTimer = 600 + Math.random() * 600;  // first tomato no sooner than 10s
    cityOffsetFar  = 0;
    cityOffsetNear = 0;
    arcticCharge        = 0;
    arcticReady         = false;
    arcticActiveFrames  = 0;
    arcticReadyAt       = -9999;
    nightFellAt         = -9999;
    nightAnnounced      = false;

    // Cache scaled tile sizes once images are loaded
    if (groundMidImg) {
      TILE.midW   = Math.round(groundMidImg.width   * TILE_SCALE);
      TILE.midH   = Math.round(groundMidImg.height  * TILE_SCALE);
      TILE.leftW  = Math.round(groundLeftImg.width  * TILE_SCALE);
      TILE.leftH  = Math.round(groundLeftImg.height * TILE_SCALE);
      TILE.rightW = Math.round(groundRightImg.width  * TILE_SCALE);
      TILE.rightH = Math.round(groundRightImg.height * TILE_SCALE);
    }
    if (platformImg) {
      TILE.platW = Math.round(platformImg.width  * PLATFORM_SCALE);
      TILE.platH = Math.round(platformImg.height * PLATFORM_SCALE);
    }
    if (pillarImg) {
      TRAP.pillarW = Math.round(pillarImg.width  * TRAP_SCALE);
      TRAP.pillarH = Math.round(pillarImg.height * TRAP_SCALE);
    }
    if (spikesImg) {
      TRAP.spikesW = Math.round(spikesImg.width  * TRAP_SCALE);
      TRAP.spikesH = Math.round(spikesImg.height * TRAP_SCALE);
    }
    if (shooterImg) {
      TRAP.shooterW = Math.round(shooterImg.width  * 0.55);
      TRAP.shooterH = Math.round(shooterImg.height * 0.55);
    }
    if (fireBoltImg) {
      TRAP.boltW = Math.round(fireBoltImg.width  * 0.7);
      TRAP.boltH = Math.round(fireBoltImg.height * 0.7);
    }
    if (acidLeftImg) {
      TRAP.acidLeftW = Math.round(acidLeftImg.width  * TRAP_SCALE);
      TRAP.acidLeftH = Math.round(acidLeftImg.height * TRAP_SCALE);
    }
    if (acidBlockImg) {
      TRAP.acidBlockW = Math.round(acidBlockImg.width  * TRAP_SCALE);
      TRAP.acidBlockH = Math.round(acidBlockImg.height * TRAP_SCALE);
    }
    if (acidRightImg) {
      TRAP.acidRightW = Math.round(acidRightImg.width  * TRAP_SCALE);
      TRAP.acidRightH = Math.round(acidRightImg.height * TRAP_SCALE);
    }

    // Seed initial ground: one big safe slab under the player, then world-builder takes over
    groundSegments.push({ startX: -200, endX: 700 });
    lastGroundEndX = 700;
    spawnTimer = 60;
    coinTimer = 90;
    frameCount = 0;
    runningTime = 0;
    groundOffset = 0;

    player.y = GROUND_Y - player.h;
    player.vy = 0;
    player.onGround = true;
    player.jumpsLeft = 2;
    player.runFrame = 0;
    player.runTick = 0;
    player.jumpFrameIdx = 0;

    // Seed clouds
    for (let i = 0; i < 5; i++) {
      clouds.push({
        x: Math.random() * W,
        y: 40 + Math.random() * 140,
        s: 0.4 + Math.random() * 0.8,
        speed: 0.3 + Math.random() * 0.5,
      });
    }
    // Seed bushes
    for (let i = 0; i < 6; i++) {
      bushes.push({ x: Math.random() * W, scale: 0.7 + Math.random() * 0.7 });
    }
  }

  // ---------- ENTITIES ----------
  function spawnObstacle() {
    const spawnX = W + 20;
    // Don't drop obstacles into holes / acid
    if (!isOverGround(spawnX)) return;

    // Pick a trap type
    const r = Math.random();
    let type, w, h;
    if (r < 0.40) {
      // SPIKES — wide hazard on the ground, jump over
      type = 'spikes';
      w = TRAP.spikesW || 88;
      h = TRAP.spikesH || 34;
    } else if (r < 0.75) {
      // PILLAR — tall obstacle, jump over
      type = 'pillar';
      w = TRAP.pillarW || 40;
      h = TRAP.pillarH || 80;
    } else {
      // FIRE SHOOTER — turret that fires bolts
      type = 'shooter';
      w = TRAP.shooterW || 28;
      h = TRAP.shooterH || 41;
    }
    const ob = {
      type, w, h,
      x: spawnX,
      y: GROUND_Y - h,
    };
    if (type === 'shooter') {
      // Cooldown until next bolt; first shot soon after entering screen
      ob.fireTimer = 50 + Math.random() * 30;
    }
    obstacles.push(ob);
  }

  // Returns true if a coin at (x,y,r) overlaps any obstacle (with padding).
  function coinOverlapsObstacle(x, y, r) {
    const pad = 10;
    const cb = { x: x - r - pad, y: y - r - pad, w: r * 2 + pad * 2, h: r * 2 + pad * 2 };
    for (const o of obstacles) {
      if (rectsHit(cb, o)) return true;
    }
    return false;
  }

  // Find a starting X past all known obstacles so a row of coins fits in a clear lane.
  function findClearCoinX(rowWidth, y, r) {
    let startX = W + 30;
    // Try a few candidate slots, sliding right until we find a clear stretch.
    for (let tries = 0; tries < 8; tries++) {
      let blocked = false;
      for (const o of obstacles) {
        const stripL = startX - r - 12;
        const stripR = startX + rowWidth + r + 12;
        // overlap on X axis with obstacle horizontally and vertically?
        if (o.x + o.w > stripL && o.x < stripR &&
            o.y < y + r && o.y + o.h > y - r) {
          // push past the obstacle
          startX = o.x + o.w + 30;
          blocked = true;
        }
      }
      if (!blocked) return startX;
    }
    return startX;
  }

  function spawnCoin() {
    const lane = Math.random();
    let y;
    if (lane < 0.4)      y = GROUND_Y - 60;       // low (run-through)
    else if (lane < 0.8) y = GROUND_Y - 130;      // mid (single jump)
    else                 y = GROUND_Y - 200;      // high (double jump)

    const r = 18;
    // Sometimes spawn a coin row
    const count = Math.random() < 0.45 ? 3 : 1;
    const rowWidth = (count - 1) * 48;
    const startX = findClearCoinX(rowWidth, y, r);

    for (let i = 0; i < count; i++) {
      const cx = startX + i * 48;
      // Last-mile safety check; skip individual coin if it still overlaps something
      if (coinOverlapsObstacle(cx, y, r)) continue;
      coins.push({
        x: cx,
        y,
        r,
        bob: Math.random() * Math.PI * 2,
      });
    }
  }

  // ---------- GROUND / PLATFORM WORLD ----------
  function updateGroundWorld() {
    // Scroll segments + platforms + acid + bolts + tracker
    for (const g of groundSegments) { g.startX -= scrollSpeed; g.endX -= scrollSpeed; }
    for (const p of platforms)      { p.x      -= scrollSpeed; }
    for (const a of acidPools)      { a.startX -= scrollSpeed; a.endX -= scrollSpeed; }
    lastGroundEndX -= scrollSpeed;

    // Cull
    groundSegments = groundSegments.filter(g => g.endX > -100);
    platforms      = platforms.filter(p => p.x + p.w > -100);
    acidPools      = acidPools.filter(a => a.endX > -100);

    // Generate ahead of the right edge
    while (lastGroundEndX < W + 400) {
      // Decide if there's a hole before the next segment
      const holeChance = 0.15 + difficulty * 0.20;       // 15% → 35%
      let gap = 0;
      let isAcid = false;
      if (groundSegments.length > 0 && Math.random() < holeChance) {
        // Hole/acid width — sized so a single jump can clear it
        const minHole = 90;
        const maxHole = 180 + Math.min(60, scrollSpeed * 6);
        gap = minHole + Math.random() * (maxHole - minHole);
        // Roughly 45% of gaps become acid pools (more dangerous later in the run)
        isAcid = Math.random() < 0.35 + difficulty * 0.25;
        // If acid, allow longer pools (creative platform design challenge)
        if (isAcid) gap = gap * (1 + Math.random() * 0.6);
      }
      const startX = lastGroundEndX + gap;
      const segLen = 280 + Math.random() * 380;
      const endX   = startX + segLen;
      groundSegments.push({ startX, endX });
      // Record acid pool spanning the gap
      if (gap > 0 && isAcid) {
        acidPools.push({ startX: lastGroundEndX, endX: startX });
      }
      lastGroundEndX = endX;

      // If we just made a gap, place platform(s) inside it.
      // Rules: platform must fit ENTIRELY within the gap (with a small margin
      // from each cliff edge), so it never overlaps the ground tiles. Platform
      // count and spacing scale with gap width so they don't visually merge.
      if (gap > 0 && TILE.platW) {
        const gapStart   = lastGroundEndX - segLen - gap;  // world-x of gap left edge
        const gapEnd     = gapStart + gap;
        const edgeMargin = 14;                              // visual breathing room
        const usableW    = Math.max(TILE.platW, gap - edgeMargin * 2);
        const tileW      = TILE.platW;

        // Decide how many platforms fit comfortably (one per ~280 px of gap)
        const desiredPlats = gap >= 360 ? 2 : 1;
        // Each platform is 2 or 3 blocks wide — but capped to fit the gap
        const blockOptions = [3, 2, 1];
        const wantBlocks = (desiredPlats === 2)
          ? 2                                       // smaller platforms when stacking 2
          : (Math.random() < 0.4 ? 3 : 2);
        let platW = wantBlocks * tileW;
        // If 1 platform and gap is narrow, force it to fit
        if (desiredPlats === 1 && platW > usableW) {
          // try to find the largest block count that still fits
          platW = blockOptions.find(n => n * tileW <= usableW) * tileW;
          if (!platW) platW = tileW;
        }
        // If 2 platforms, keep them small enough that BOTH fit side-by-side
        if (desiredPlats === 2) {
          const maxEachW = (gap - edgeMargin * 2 - 24) / 2;  // 24 px gap between them
          if (platW > maxEachW) platW = Math.max(tileW, Math.floor(maxEachW / tileW) * tileW);
          if (!platW) platW = tileW;
        }

        for (let i = 0; i < desiredPlats; i++) {
          const t = (i + 1) / (desiredPlats + 1);   // 0.5, or 0.33/0.66
          const platCenter = gapStart + gap * t;
          let platX = platCenter - platW / 2;
          // Clamp into gap (so we never poke into ground)
          platX = Math.max(gapStart + edgeMargin, Math.min(gapEnd - edgeMargin - platW, platX));
          const platY = GROUND_Y - (90 + Math.random() * 50);
          platforms.push({ x: platX, y: platY, w: platW });

          // Coin row above this specific platform
          if (Math.random() < 0.7 && coinImg) {
            const cy = platY - 36;
            const count = 3;
            for (let j = 0; j < count; j++) {
              coins.push({
                x: platX + (j + 0.5) * (platW / count),
                y: cy, r: 18, bob: Math.random() * Math.PI * 2,
              });
            }
          }
        }
      }
    }
  }

  // Returns true if x (world coord) is over solid ground
  function isOverGround(x) {
    for (const g of groundSegments) {
      if (x >= g.startX && x <= g.endX) return true;
    }
    return false;
  }

  // ---------- TOMATO PICKUP ----------
  // Spawns a single tomato at a jumpable height, in a clear lane.
  function spawnTomato() {
    const r = 22;
    // Prefer the mid lane (single jump) — tomatoes are special
    const heights = [GROUND_Y - 130, GROUND_Y - 90, GROUND_Y - 170];
    const y = heights[Math.floor(Math.random() * heights.length)];
    let x = W + 60;
    // shove past obstacles
    for (let i = 0; i < 6; i++) {
      let blocked = false;
      for (const o of obstacles) {
        const stripL = x - r - 14;
        const stripR = x + r + 14;
        if (o.x + o.w > stripL && o.x < stripR &&
            o.y < y + r && o.y + o.h > y - r) {
          x = o.x + o.w + 50;
          blocked = true;
        }
      }
      if (!blocked) break;
    }
    tomatoes.push({ x, y, r, bob: Math.random() * Math.PI * 2 });
  }

  // ---------- RECT COLLISION (with hitbox shrink for fairness) ----------
  function rectsHit(a, b) {
    return a.x < b.x + b.w &&
           a.x + a.w > b.x &&
           a.y < b.y + b.h &&
           a.y + a.h > b.y;
  }

  function getPlayerHitbox() {
    // Shrink hitbox vs sprite so collisions feel fair
    const padX = 18, padTop = 12, padBot = 6;
    return {
      x: player.x + padX,
      y: player.y + padTop,
      w: player.w - padX * 2,
      h: player.h - padTop - padBot,
    };
  }

  // ---------- UPDATE ----------
  function update() {
    if (state !== STATE.PLAY) return;

    frameCount++;
    runningTime += 1/60;

    // Difficulty curve: gentle ramp at the start, asymptotes near 1
    difficulty = 1 - Math.exp(-runningTime / 50);  // slower ramp than before
    speedRamp = difficulty * (MAX_SPEED - baseSpeed);
    scrollSpeed = Math.min(MAX_SPEED, baseSpeed + speedRamp);

    // Score from distance
    score += Math.round(scrollSpeed * 0.25);

    // First time score crosses 10,000 → fire "NIGHT FALLS" banner once
    if (!nightAnnounced && score >= 10000) {
      nightAnnounced = true;
      nightFellAt = frameCount;
    }

    // --- Player physics (dynamic ground + platform landing) ---
    const oldY = player.y;
    player.vy += GRAVITY;
    const candidateY = oldY + player.vy;
    const px = player.x + player.w / 2;

    // 1) Solid ground under player?
    // Re-snap rules:
    //   - If we were on ground last frame, gravity-hold us at GROUND_Y.
    //   - If we were airborne, only land when we ACTUALLY cross the ground line
    //     this frame (was-above → now-below). Without this, fast scrolling lets
    //     the player skim across small holes by re-attaching after a 1px drop.
    const groundUnder = isOverGround(px);
    let landY = null;
    if (groundUnder && player.vy >= 0) {
      const wasOnGround = player.onGround;
      if (wasOnGround) {
        landY = GROUND_Y - player.h;
      } else {
        const wasAbove = oldY + player.h <= GROUND_Y;
        if (wasAbove && candidateY + player.h >= GROUND_Y) {
          landY = GROUND_Y - player.h;
        }
      }
    }

    // 2) Platform landing — one-way (only when falling onto from above)
    if (player.vy >= 0) {
      for (const p of platforms) {
        if (px < p.x || px > p.x + p.w) continue;
        const top = p.y;
        // was at-or-above last frame, will be at-or-below this frame → landing
        if (oldY + player.h <= top + 4 && candidateY + player.h >= top) {
          const candidate = top - player.h;
          if (landY === null || candidate < landY) landY = candidate;
        }
      }
    }

    if (landY !== null) {
      player.y = landY;
      player.vy = 0;
      if (!player.onGround) {
        player.onGround = true;
        player.jumpsLeft = 2;
      }
    } else {
      player.y = candidateY;
      player.onGround = false;
    }

    // (Platform side/bottom no longer damages — it's just decoration; one-way
    //  top-landing is still handled in step 2 above.)

    // 3) Fell off the world?
    if (player.y > H + 60) {
      fallenIntoHole();
      return;
    }

    // --- Animation ---
    if (player.onGround) {
      // run cycle speed scales a little with scroll speed
      const cycleSpeed = 5 - Math.min(2, speedRamp * 0.2);
      player.runTick++;
      if (player.runTick >= cycleSpeed) {
        player.runTick = 0;
        player.runFrame = (player.runFrame + 1) % runImgs.length;
      }
    } else {
      // pick jump sprite based on vertical velocity (rising vs falling)
      player.jumpFrameIdx = player.vy < 0 ? 0 : 1;
    }

    // --- Background ---
    groundOffset = (groundOffset + scrollSpeed) % 80;
    // City parallax: scrollSpeed × layer-rate, accumulating in world-x.
    cityOffsetFar  += scrollSpeed * 0.18;   // far layer drifts slowly
    cityOffsetNear += scrollSpeed * 0.45;   // near layer drifts faster

    for (const c of clouds) {
      c.x -= c.speed * (scrollSpeed * 0.18);
      if (c.x < -80) {
        c.x = W + Math.random() * 200;
        c.y = 40 + Math.random() * 140;
        c.s = 0.4 + Math.random() * 0.8;
      }
    }
    for (const b of bushes) {
      b.x -= scrollSpeed * 0.55;
      if (b.x < -80) b.x = W + Math.random() * 220;
    }

    // --- Ground world (segments + platforms scroll & generate) ---
    updateGroundWorld();

    // --- Spawning ---
    spawnTimer--;
    if (spawnTimer <= 0) {
      spawnObstacle();
      // Late-game: small chance of a quick second obstacle (cluster)
      if (difficulty > 0.45 && Math.random() < (difficulty - 0.4) * 0.6) {
        // tack on another obstacle a short distance behind
        const last = obstacles[obstacles.length - 1];
        const gap = 90 + Math.random() * 60;   // jumpable cluster gap
        // temporarily move the spawn-x by reusing spawnObstacle's logic
        const r = Math.random();
        let type, w, h;
        if (r < 0.55)      { type = 'barrel'; w = 48; h = 54; }
        else if (r < 0.85) { type = 'crate';  w = 70; h = 60; }
        else               { type = 'pole';   w = 28; h = 90; }
        obstacles.push({ type, w, h, x: last.x + last.w + gap, y: GROUND_Y - h });
      }
      // After spawning, remove any coins those obstacles would clip
      for (const newO of obstacles.slice(-2)) {
        coins = coins.filter(c => {
          const cb = { x: c.x - c.r - 8, y: c.y - c.r - 8, w: c.r * 2 + 16, h: c.r * 2 + 16 };
          return !rectsHit(cb, newO);
        });
      }
      // Adaptive gap: noticeably tighter as difficulty climbs
      const minGap = Math.max(28, 55 - difficulty * 30);
      const maxGap = Math.max(55, 120 - difficulty * 70);
      spawnTimer = minGap + Math.random() * (maxGap - minGap);
    }
    coinTimer--;
    if (coinTimer <= 0) {
      spawnCoin();
      coinTimer = 50 + Math.random() * 80;
    }

    // --- Tomato pickups (only spawn when player needs lives) ---
    tomatoTimer--;
    if (tomatoTimer <= 0) {
      if (lives < MAX_LIVES) {
        spawnTomato();
        // long cooldown — this is supposed to feel rare
        tomatoTimer = 900 + Math.random() * 900;  // 15–30s
      } else {
        // re-check soon, but no spawn while at full health
        tomatoTimer = 240;
      }
    }

    // --- Move obstacles ---
    for (const o of obstacles) o.x -= scrollSpeed;
    obstacles = obstacles.filter(o => o.x + o.w > -10);

    // --- Shooter logic: tick fire timer, spawn fire bolts when ready ---
    for (const o of obstacles) {
      if (o.type !== 'shooter' || o.fireTimer === undefined) continue;
      // Only shoot when on screen and player hasn't passed it yet
      if (o.x > W + 30) continue;
      o.fireTimer--;
      if (o.fireTimer <= 0) {
        // Spawn a fire bolt at the muzzle (top-left of shooter, where the cannon is)
        fireBolts.push({
          x: o.x - 6,
          y: o.y + Math.round(o.h * 0.18),
          vx: -7,           // bolt's own world-space leftward velocity
        });
        // Cooldown — gets quicker as difficulty climbs
        const minCool = 70 - Math.min(25, difficulty * 30);
        const maxCool = 130 - Math.min(35, difficulty * 40);
        o.fireTimer = minCool + Math.random() * (maxCool - minCool);
      }
    }

    // --- Move fire bolts (own velocity + world scroll) ---
    for (const b of fireBolts) {
      b.x += b.vx - scrollSpeed;
    }
    fireBolts = fireBolts.filter(b => b.x > -50 && b.x < W + 60);

    // --- Move coins ---
    for (const c of coins) {
      c.x -= scrollSpeed;
      c.bob += 0.12;
    }
    coins = coins.filter(c => c.x + c.r > -10);

    // --- Move tomatoes ---
    for (const t of tomatoes) {
      t.x -= scrollSpeed;
      t.bob += 0.10;
    }
    tomatoes = tomatoes.filter(t => t.x + t.r > -10);

    // --- Tick down invulnerability ---
    if (invulnFrames > 0) invulnFrames--;

    // --- Collisions ---
    const hb = getPlayerHitbox();

    // Obstacle hit → lose a life (only if not invulnerable)
    if (invulnFrames === 0) {
      for (const o of obstacles) {
        // Use a slightly-shrunk hitbox for shooters/pillars so it feels fair
        const inset = (o.type === 'shooter' || o.type === 'pillar') ? 4 : 2;
        const ob = { x: o.x + inset, y: o.y + inset, w: o.w - inset * 2, h: o.h - inset };
        if (rectsHit(hb, ob)) {
          loseLife();
          break;
        }
      }
    }

    // Fire-bolt hit → lose a life
    if (invulnFrames === 0 && fireBolts.length) {
      for (let i = fireBolts.length - 1; i >= 0; i--) {
        const b = fireBolts[i];
        const bw = TRAP.boltW || 30;
        const bh = TRAP.boltH || 21;
        const bb = { x: b.x, y: b.y, w: bw, h: bh };
        if (rectsHit(hb, bb)) {
          fireBolts.splice(i, 1);  // bolt is consumed
          loseLife();
          break;
        }
      }
    }

    // Acid pool contact → instant lose-life + respawn (treat like falling in)
    if (invulnFrames === 0 && acidPools.length) {
      const pcx = player.x + player.w / 2;
      const pBottom = player.y + player.h;
      for (const a of acidPools) {
        if (pcx >= a.startX && pcx <= a.endX && pBottom >= GROUND_Y + 4) {
          fallenIntoHole();    // shared respawn path
          return;
        }
      }
    }

    // Coins
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      const cb = { x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 };
      if (rectsHit(hb, cb)) {
        coins.splice(i, 1);
        coinsCollected++;
        score += 50;
        playCoinSfx();
        // Arctic Jump: charge until full
        if (!arcticReady) {
          arcticCharge++;
          if (arcticCharge >= ARCTIC_REQUIRED) {
            arcticCharge = ARCTIC_REQUIRED;
            arcticReady  = true;
            arcticReadyAt = frameCount;
            playArcticChargedSfx();
          }
        }
      }
    }

    // Tomatoes (extra life)
    for (let i = tomatoes.length - 1; i >= 0; i--) {
      const t = tomatoes[i];
      const tb = { x: t.x - t.r, y: t.y - t.r, w: t.r * 2, h: t.r * 2 };
      if (rectsHit(hb, tb)) {
        tomatoes.splice(i, 1);
        if (lives < MAX_LIVES) {
          lives++;
          updateLivesHud(true);
          playTomatoSfx();
        }
      }
    }

    // HUD update
    // Score & coins are now drawn directly on the canvas (drawScoreHud)
  }

  // ---------- FELL INTO A HOLE ----------
  function fallenIntoHole() {
    if (state !== STATE.PLAY) return;
    // If invulnerable (e.g. just took a platform hit), respawn without
    // charging another life. Otherwise it's a regular fall — lose a life.
    if (invulnFrames === 0) {
      lives--;
      updateLivesHud(false);
      if (lives <= 0) { gameOver(); return; }
      playHitSfx();
    }
    invulnFrames = INVULN_DURATION + 30;

    // Find the closest upcoming solid ground (right of current player)
    let nextSeg = null;
    for (const g of groundSegments) {
      if (g.startX > player.x) { nextSeg = g; break; }
      if (g.startX <= player.x && g.endX >= player.x) { nextSeg = g; break; }
    }
    if (!nextSeg) {
      // Nothing ahead — emergency floor
      groundSegments.push({ startX: -200, endX: 700 });
      nextSeg = groundSegments[groundSegments.length - 1];
      lastGroundEndX = Math.max(lastGroundEndX, 700);
    }

    // If next segment isn't already under the player, scroll the WHOLE WORLD
    // left by the gap so the segment's left edge is just before player.x.
    if (nextSeg.startX > player.x - 30) {
      const shift = nextSeg.startX - (player.x - 30);
      for (const g of groundSegments) { g.startX -= shift; g.endX -= shift; }
      for (const p of platforms)      { p.x      -= shift; }
      for (const o of obstacles)      { o.x      -= shift; }
      for (const c of coins)          { c.x      -= shift; }
      for (const t of tomatoes)       { t.x      -= shift; }
      lastGroundEndX -= shift;
    }

    // Drop the player from above so they land softly on the new ground
    player.y  = -100;
    player.vy = 0;
    player.onGround = false;
    player.jumpsLeft = 0;
  }

  // ---------- DAMAGE / LIFE GAIN ----------
  function loseLife() {
    lives--;
    invulnFrames = INVULN_DURATION;
    updateLivesHud(false);
    if (lives <= 0) {
      gameOver();
    } else {
      playHitSfx();
    }
  }

  // ---------- DRAW ----------
  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Screen shake on game-over impact (first ~14 frames). All scene drawing
    // runs inside this translate so world + HUD rumble together.
    let shakeX = 0, shakeY = 0;
    if (state === STATE.OVER) {
      const elapsed = frameCount - gameOverAt;
      if (elapsed >= 0 && elapsed < 14) {
        const intensity = (14 - elapsed) / 14 * 9;
        shakeX = (Math.random() - 0.5) * intensity;
        shakeY = (Math.random() - 0.5) * intensity;
      }
    }
    ctx.save();
    if (shakeX || shakeY) ctx.translate(shakeX, shakeY);

    drawSky();
    drawClouds();
    drawDistantHills();
    drawVoid();          // dark abyss below ground line — visible through holes
    drawGround();        // tile-based ground sprites
    drawAcidPools();     // deadly liquid in the gaps
    drawPlatforms();     // floating platforms
    drawObstacles();
    drawFireBolts();     // projectiles
    drawCoins();
    drawTomatoes();
    drawPlayer();
    drawLivesHud();
    drawArcticChargeBar();
    drawScoreHud();
    drawArcticReadyBanner();
    drawNightFallsBanner();
    ctx.restore();           // end screen-shake translate

    // Dramatic GAME OVER overlay sits OUTSIDE the shake so the text is steady
    drawGameOverOverlay();
  }

  // ---------- NIGHT FALLS — banner shown once when crossing 10k ----------
  let nightBannerBuffer = null;
  const NF_BANNER_W = 640;
  const NF_BANNER_H = 140;

  function buildNightFallsBuffer() {
    const c = document.createElement('canvas');
    c.width  = NF_BANNER_W;
    c.height = NF_BANNER_H;
    const bctx = c.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    const cx = NF_BANNER_W / 2;
    const cy = NF_BANNER_H / 2;

    // Indigo glow halo
    const grd = bctx.createRadialGradient(cx, cy, 10, cx, cy, 280);
    grd.addColorStop(0,   'rgba(126, 99, 255, 0.55)');
    grd.addColorStop(0.4, 'rgba(126, 99, 255, 0.18)');
    grd.addColorStop(1,   'rgba(126, 99, 255, 0)');
    bctx.fillStyle = grd;
    bctx.fillRect(0, 0, NF_BANNER_W, NF_BANNER_H);

    bctx.font = 'bold 38px "Press Start 2P", "Courier New", monospace';
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    const TEXT = 'NIGHT FALLS';

    // Stepped purple-black shadow
    for (let s = 4; s >= 1; s--) {
      bctx.fillStyle = `rgba(20, 5, 50, ${0.35 + s * 0.10})`;
      bctx.fillText(TEXT, cx + s, cy + s);
    }
    // Outline (deep indigo)
    bctx.fillStyle = '#3a26a0';
    bctx.fillText(TEXT, cx - 2, cy);
    bctx.fillText(TEXT, cx + 2, cy);
    bctx.fillText(TEXT, cx,     cy - 2);
    bctx.fillText(TEXT, cx,     cy + 2);
    // Mid + core
    bctx.fillStyle = '#a89fff';
    bctx.fillText(TEXT, cx, cy + 1);
    bctx.fillStyle = '#ffffff';
    bctx.fillText(TEXT, cx, cy);

    return c;
  }

  function drawNightFallsBanner() {
    if (state !== STATE.PLAY) return;
    if (!nightAnnounced) return;
    const elapsed = frameCount - nightFellAt;
    const TOTAL = 130;
    if (elapsed < 0 || elapsed > TOTAL) return;

    if (!nightBannerBuffer) nightBannerBuffer = buildNightFallsBuffer();

    let scale, alpha;
    if (elapsed < 10) {
      const t = elapsed / 10;
      scale = 0.35 + t * 0.95;
      alpha = t;
    } else if (elapsed < 18) {
      const t = (elapsed - 10) / 8;
      scale = 1.30 - t * 0.30;
      alpha = 1;
    } else if (elapsed < TOTAL - 24) {
      scale = 1.0 + Math.sin(elapsed * 0.16) * 0.022;
      alpha = 1;
    } else {
      const t = (elapsed - (TOTAL - 24)) / 24;
      scale = 1.0 - t * 0.10;
      alpha = 1 - t;
    }

    const cx = W / 2;
    const cy = Math.round(GROUND_Y * 0.32);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.drawImage(nightBannerBuffer, -NF_BANNER_W / 2, -NF_BANNER_H / 2);

    // Tiny sparkle stars orbiting (different from Arctic — fewer & higher)
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + frameCount * 0.05;
      const sx = Math.cos(ang) * 240;
      const sy = Math.sin(ang) * 56;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 2, 2);
    }
    ctx.restore();
  }

  // ---------- GAME OVER OVERLAY (canvas-rendered) ----------
  // Pre-rendered to an offscreen buffer (same trick as the Arctic banner) so
  // we don't pay 6+ fillTexts per frame.
  let gameOverBuffer = null;
  const GO_BANNER_W = 720;
  const GO_BANNER_H = 160;

  function buildGameOverBuffer() {
    const c = document.createElement('canvas');
    c.width  = GO_BANNER_W;
    c.height = GO_BANNER_H;
    const bctx = c.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    const cx = GO_BANNER_W / 2;
    const cy = GO_BANNER_H / 2;

    // Red radial glow
    const grd = bctx.createRadialGradient(cx, cy, 10, cx, cy, 320);
    grd.addColorStop(0,   'rgba(255, 60, 60, 0.55)');
    grd.addColorStop(0.4, 'rgba(180, 20, 30, 0.22)');
    grd.addColorStop(1,   'rgba(120, 0, 20, 0)');
    bctx.fillStyle = grd;
    bctx.fillRect(0, 0, GO_BANNER_W, GO_BANNER_H);

    // Pixel-font text styling
    bctx.font = 'bold 60px "Press Start 2P", "Courier New", monospace';
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    const TEXT = 'GAME OVER';

    // Stepped pixel shadow (5 layers, deep red)
    for (let s = 5; s >= 1; s--) {
      bctx.fillStyle = `rgba(40, 0, 8, ${0.30 + s * 0.10})`;
      bctx.fillText(TEXT, cx + s, cy + s);
    }
    // Outline (deep crimson)
    bctx.fillStyle = '#5a0014';
    bctx.fillText(TEXT, cx - 3, cy);
    bctx.fillText(TEXT, cx + 3, cy);
    bctx.fillText(TEXT, cx,     cy - 3);
    bctx.fillText(TEXT, cx,     cy + 3);
    // Mid layer
    bctx.fillStyle = '#a50028';
    bctx.fillText(TEXT, cx, cy + 1);
    // Core (bright red)
    bctx.fillStyle = '#ff4858';
    bctx.fillText(TEXT, cx, cy);
    return c;
  }

  function drawGameOverOverlay() {
    if (state !== STATE.OVER) return;
    const elapsed = frameCount - gameOverAt;
    if (elapsed < 0) return;

    if (!gameOverBuffer) gameOverBuffer = buildGameOverBuffer();

    // Dark vignette fades in over ~30 frames, persists at 0.55
    const vignette = Math.min(0.55, elapsed / 30 * 0.55);
    ctx.fillStyle = `rgba(0, 0, 0, ${vignette})`;
    ctx.fillRect(0, 0, W, H);

    // Quick red flash at the moment of death (frames 0-12)
    if (elapsed < 12) {
      const flash = (12 - elapsed) / 12;
      ctx.fillStyle = `rgba(220, 20, 30, ${flash * 0.30})`;
      ctx.fillRect(0, 0, W, H);
    }

    // GAME OVER text drops from above with bounce
    if (elapsed > 4) {
      const t1 = elapsed - 4;
      let scale, alpha, yOff;
      if (t1 < 16) {
        // Drop in + scale up
        const t = t1 / 16;
        const ease = 1 - Math.pow(1 - t, 3);          // ease-out cubic
        scale = 0.45 + ease * 1.10;                    // 0.45 → 1.55 overshoot
        alpha = t;
        yOff  = (1 - ease) * -160;
      } else if (t1 < 26) {
        // Settle from overshoot
        const t = (t1 - 16) / 10;
        scale = 1.55 - t * 0.55;                       // 1.55 → 1.00
        alpha = 1;
        yOff  = 0;
      } else {
        // Ominous low pulse
        scale = 1.0 + Math.sin((t1 - 26) * 0.10) * 0.025;
        alpha = 1;
        yOff  = 0;
      }

      const cx = W / 2;
      const cy = Math.round(H * 0.40) + yOff;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.drawImage(gameOverBuffer, -GO_BANNER_W / 2, -GO_BANNER_H / 2);

      // Slow pulse glow that throbs throughout the hold
      if (t1 > 26) {
        const pulse = (Math.sin((t1 - 26) * 0.10) + 1) / 2;
        ctx.globalAlpha = 0.10 + pulse * 0.18;
        ctx.fillStyle = '#ff4858';
        ctx.fillRect(-GO_BANNER_W / 2, -GO_BANNER_H / 2, GO_BANNER_W, GO_BANNER_H);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(gameOverBuffer, -GO_BANNER_W / 2, -GO_BANNER_H / 2);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();

      // Falling red ember pixels for atmosphere
      const emberCount = 14;
      for (let i = 0; i < emberCount; i++) {
        const ex = ((i * 173 + frameCount * 1.4) % W);
        const ey = ((i * 97 + frameCount * 2.2) % H);
        const size = 2 + (i % 3);
        ctx.fillStyle = i % 2 === 0 ? 'rgba(255, 80, 80, 0.7)' : 'rgba(255, 160, 60, 0.5)';
        ctx.fillRect(Math.round(ex), Math.round(ey), size, size);
      }
    }
  }

  // ---------- ARCTIC JUMP READY — big animated pixel banner ----------
  // The static parts (glow + text + outline) are pre-rendered ONCE into an
  // offscreen canvas. Each frame just blits that buffer with a scale + alpha,
  // then layers a cheap shimmer rect and a few orbiting sparkle pixels.
  // This avoids ~6 fillText() calls per frame, which was causing the lag.
  let arcticBannerBuffer = null;
  const ARCTIC_BANNER_W = 640;
  const ARCTIC_BANNER_H = 140;

  function buildArcticBannerBuffer() {
    const c = document.createElement('canvas');
    c.width  = ARCTIC_BANNER_W;
    c.height = ARCTIC_BANNER_H;
    const bctx = c.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    const cx = ARCTIC_BANNER_W / 2;
    const cy = ARCTIC_BANNER_H / 2;

    // Radial glow halo
    const grd = bctx.createRadialGradient(cx, cy, 10, cx, cy, 260);
    grd.addColorStop(0,   'rgba(168, 240, 255, 0.55)');
    grd.addColorStop(0.4, 'rgba(168, 240, 255, 0.18)');
    grd.addColorStop(1,   'rgba(168, 240, 255, 0)');
    bctx.fillStyle = grd;
    bctx.fillRect(0, 0, ARCTIC_BANNER_W, ARCTIC_BANNER_H);

    // Text styling
    bctx.font = 'bold 38px "Press Start 2P", "Courier New", monospace';
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    const TEXT = 'ARCTIC JUMP READY!';

    // Stepped pixel shadow (4 stacked offsets)
    for (let s = 4; s >= 1; s--) {
      bctx.fillStyle = `rgba(8, 30, 60, ${0.35 + s * 0.10})`;
      bctx.fillText(TEXT, cx + s, cy + s);
    }
    // 4-direction outline
    bctx.fillStyle = '#1f5a8a';
    bctx.fillText(TEXT, cx - 2, cy);
    bctx.fillText(TEXT, cx + 2, cy);
    bctx.fillText(TEXT, cx,     cy - 2);
    bctx.fillText(TEXT, cx,     cy + 2);
    // Mid + core
    bctx.fillStyle = '#76d2f0';
    bctx.fillText(TEXT, cx, cy + 1);
    bctx.fillStyle = '#dffaff';
    bctx.fillText(TEXT, cx, cy);

    return c;
  }

  function drawArcticReadyBanner() {
    if (state !== STATE.PLAY) return;
    if (!arcticReady) return;
    const elapsed = frameCount - arcticReadyAt;
    const TOTAL = 130;                  // ~2.2 s — slightly shorter
    if (elapsed < 0 || elapsed > TOTAL) return;

    // Build the buffer lazily, the first time we need it
    if (!arcticBannerBuffer) arcticBannerBuffer = buildArcticBannerBuffer();

    // Animation envelope
    let scale, alpha;
    if (elapsed < 10) {
      const t = elapsed / 10;
      scale = 0.35 + t * 0.95;          // 0.35 → 1.30
      alpha = t;
    } else if (elapsed < 18) {
      const t = (elapsed - 10) / 8;
      scale = 1.30 - t * 0.30;          // settle 1.30 → 1.00
      alpha = 1;
    } else if (elapsed < TOTAL - 24) {
      // Subtle hold pulse (no per-frame trig branch)
      scale = 1.0 + Math.sin(elapsed * 0.16) * 0.022;
      alpha = 1;
    } else {
      const t = (elapsed - (TOTAL - 24)) / 24;
      scale = 1.0 - t * 0.10;
      alpha = 1 - t;
    }

    const cx = W / 2;
    const cy = Math.round(GROUND_Y * 0.32);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    // 1× drawImage instead of 6+ fillTexts
    ctx.drawImage(arcticBannerBuffer, -ARCTIC_BANNER_W / 2, -ARCTIC_BANNER_H / 2);

    // Shimmer sweep — single fillRect with a small, cheap gradient (only
    // active during the ~1s sweep window, so it isn't always allocated).
    if (elapsed > 18 && elapsed < 70) {
      const t = (elapsed - 18) / 52;
      const sweepX = -280 + t * 560;
      ctx.globalAlpha = alpha * 0.30;
      const sg = ctx.createLinearGradient(sweepX - 40, 0, sweepX + 40, 0);
      sg.addColorStop(0,   'rgba(255,255,255,0)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0.85)');
      sg.addColorStop(1,   'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(-280, -36, 560, 72);
      ctx.globalAlpha = alpha;
    }

    // Orbiting sparkles (cheap fillRects, 6 instead of 8)
    const sparkleCount = 6;
    for (let i = 0; i < sparkleCount; i++) {
      const angle = (i / sparkleCount) * Math.PI * 2 + frameCount * 0.05;
      const rx = 250;                                   // fixed radius — no extra trig
      const ry = 70;
      const sx = Math.cos(angle) * rx;
      const sy = Math.sin(angle) * ry;
      const sz = 3;                                     // constant size, less jitter
      ctx.fillStyle = '#dffaff';
      ctx.fillRect(Math.round(sx) - sz, Math.round(sy) - 1, sz * 2, 2);
      ctx.fillRect(Math.round(sx) - 1,  Math.round(sy) - sz, 2, sz * 2);
    }

    ctx.restore();
  }

  // ---------- ARCTIC JUMP CHARGE BAR ----------
  function drawArcticChargeBar() {
    if (state !== STATE.PLAY) return;

    // Geometry — match the lives panel above (5 slots × 36 + 4 gaps × 4 = 196)
    const x       = 18;
    const y       = 18 + 36 + 12;          // sits just under the lives icons
    const w       = 196;
    const h       = 16;
    const segments = ARCTIC_REQUIRED;
    const segGap   = 1;
    const innerPad = 3;
    const innerW   = w - innerPad * 2;
    const segW     = (innerW - (segments - 1) * segGap) / segments;
    const innerY   = y + innerPad;
    const innerH   = h - innerPad * 2;

    // Pulse phase — used both when ready and right when the charge fills
    const justFilledFor = frameCount - arcticReadyAt;
    const readyPulse = arcticReady
      ? (Math.sin(frameCount * 0.18) * 0.5 + 0.5)
      : 0;
    const burstPulse = (justFilledFor >= 0 && justFilledFor < 30)
      ? (1 - justFilledFor / 30)
      : 0;

    // Outer drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x + 2, y + 3, w, h);

    // Background panel
    ctx.fillStyle = 'rgba(8, 18, 36, 0.78)';
    ctx.fillRect(x, y, w, h);

    // Pixel-art border — chunky 2px sides, gold pixel studs at the corners
    const borderColor = arcticReady ? '#a8f0ff' : '#4ea0e8';
    const borderShadow= arcticReady ? '#5fb6e0' : '#1e5a8c';
    ctx.fillStyle = borderShadow;
    ctx.fillRect(x, y, w, 2);                      // top (shadow)
    ctx.fillRect(x, y + h - 2, w, 2);              // bottom (shadow)
    ctx.fillRect(x, y, 2, h);                      // left (shadow)
    ctx.fillRect(x + w - 2, y, 2, h);              // right (shadow)
    ctx.fillStyle = borderColor;
    ctx.fillRect(x, y, w, 1);                      // top highlight
    ctx.fillRect(x, y, 1, h);                      // left highlight

    // Segments
    for (let i = 0; i < segments; i++) {
      const segX = innerX(i);
      // Empty cell color
      ctx.fillStyle = '#101e34';
      ctx.fillRect(segX, innerY, segW, innerH);

      const filled = i < arcticCharge;
      if (!filled) continue;

      // Filled cell — icy gradient (top lighter, bottom deeper)
      const baseTop = arcticReady ? '#dffaff' : '#9be0ff';
      const baseBot = arcticReady ? '#76d2f0' : '#3aa0e0';
      ctx.fillStyle = baseBot;
      ctx.fillRect(segX, innerY, segW, innerH);
      ctx.fillStyle = baseTop;
      ctx.fillRect(segX, innerY, segW, Math.max(1, Math.floor(innerH / 2)));

      // Bright pixel highlight at top-left of each cell
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(segX, innerY, 1, 1);
    }

    // Pulse glow when READY — shimmer overlay across the bar
    if (arcticReady) {
      ctx.fillStyle = `rgba(168, 240, 255, ${0.10 + readyPulse * 0.18})`;
      ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
      // Tiny snow-spark pixels travelling along the bar
      const spX = (frameCount * 2) % (w - 8);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(x + 4 + spX,           y + 4, 2, 2);
      ctx.fillRect(x + 4 + ((spX + 64) % (w - 8)), y + h - 6, 2, 2);
    }

    // Burst glow at the moment the bar fills up
    if (burstPulse > 0) {
      ctx.fillStyle = `rgba(220, 250, 255, ${burstPulse * 0.55})`;
      ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
    }

    // Label — "ARCTIC JUMP" — placed BELOW the bar so it never overlaps the
    // lives row above (which runs from y=18 to y=54).
    const labelY = y + h + 5;
    ctx.font = 'bold 9px "Press Start 2P", "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#000';
    ctx.fillText('ARCTIC JUMP', x + 1, labelY + 1);
    ctx.fillStyle = arcticReady ? '#dffaff' : '#b8dcf6';
    ctx.fillText('ARCTIC JUMP', x, labelY);

    // "READY!" indicator on the right, same line as the label
    if (arcticReady) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#000';
      ctx.fillText('READY!', x + w + 1, labelY + 1);
      const flash = Math.floor(frameCount / 12) % 2 === 0;
      ctx.fillStyle = flash ? '#ffffff' : '#a8f0ff';
      ctx.fillText('READY!', x + w, labelY);
    }

    function innerX(i) { return x + innerPad + i * (segW + segGap); }
  }

  // -------- ACID POOLS (left edge + middle blocks + right edge) --------
  function drawAcidPools() {
    if (!acidLeftImg || !acidBlockImg || !acidRightImg) return;
    const lW = TRAP.acidLeftW,  lH = TRAP.acidLeftH;
    const mW = TRAP.acidBlockW, mH = TRAP.acidBlockH;
    const rW = TRAP.acidRightW, rH = TRAP.acidRightH;
    // Acid surface sits a few px above GROUND_Y so the left/right tiles
    // visually wrap up onto the cliff edges.
    const surfaceY = GROUND_Y - PX;
    for (const a of acidPools) {
      if (a.endX < -10 || a.startX > W + 10) continue;
      const sx = Math.round(a.startX);
      const ex = Math.round(a.endX);

      // Left ending tile (overlaps the right edge of the previous ground)
      ctx.drawImage(acidLeftImg, sx, surfaceY, lW, lH);
      // Right ending tile (overlaps the left edge of the next ground)
      ctx.drawImage(acidRightImg, ex - rW, surfaceY, rW, rH);

      // Middle: tile acid_block horizontally between the endings.
      // The block is shorter (35px native) — tile vertically as well so the
      // pool fills down to where the void begins, with a gentle ripple via
      // a horizontal scroll offset.
      const innerStart = sx + lW;
      const innerEnd   = ex - rW;
      const ripple = Math.round((frameCount * 0.6) % mW);
      // Animated surface row at GROUND_Y level
      let x = innerStart - ripple;
      while (x < innerEnd) {
        const drawX = Math.max(x, innerStart);
        const cropL = drawX - x;          // crop from source if we clipped left
        const drawW = Math.min(mW - cropL, innerEnd - drawX);
        if (drawW > 0) {
          ctx.drawImage(
            acidBlockImg,
            cropL, 0, mW - cropL, mH,
            drawX, surfaceY + Math.max(0, lH - mH), drawW, mH
          );
        }
        x += mW;
      }
      // Fill below the surface row with a darker tone so the pool reads
      // as having depth instead of empty void.
      ctx.fillStyle = '#3da12d';
      ctx.fillRect(innerStart, surfaceY + lH - 2, innerEnd - innerStart, 6);
      ctx.fillStyle = '#1f6018';
      ctx.fillRect(innerStart, surfaceY + lH + 4, innerEnd - innerStart, H - (surfaceY + lH + 4));

      // Subtle bubbles along the surface
      for (let bi = 0; bi < 3; bi++) {
        const bx = innerStart + ((bi * 137 + frameCount * 0.8) % Math.max(1, innerEnd - innerStart));
        const by = surfaceY + 6 + Math.sin((frameCount + bi * 30) * 0.1) * 2;
        ctx.fillStyle = '#cdf580';
        ctx.fillRect(Math.round(bx), Math.round(by), PX, PX);
      }
    }
  }

  // -------- FIRE BOLTS (projectiles) --------
  function drawFireBolts() {
    if (!fireBoltImg) return;
    const w = TRAP.boltW || 30;
    const h = TRAP.boltH || 21;
    for (const b of fireBolts) {
      // Glow halo
      ctx.fillStyle = 'rgba(255, 160, 60, 0.35)';
      ctx.beginPath();
      ctx.arc(b.x + w * 0.4, b.y + h * 0.5, w * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.drawImage(fireBoltImg, Math.round(b.x), Math.round(b.y), w, h);
    }
  }

  function drawVoid() {
    const grd = ctx.createLinearGradient(0, GROUND_Y, 0, H);
    grd.addColorStop(0,   '#1a2540');
    grd.addColorStop(0.5, '#0a1024');
    grd.addColorStop(1,   '#04060c');
    ctx.fillStyle = grd;
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  }

  function drawPlatforms() {
    if (!platformImg || !TILE.platW) return;
    const tileW = TILE.platW;
    const tileH = TILE.platH;
    for (const p of platforms) {
      if (p.x + p.w < -10 || p.x > W + 10) continue;
      // Tile horizontally; draw at integer coords for crisp pixels
      let x = Math.round(p.x);
      let remaining = p.w;
      while (remaining > 0) {
        const w = Math.min(tileW, remaining);
        if (w >= tileW - 0.5) {
          ctx.drawImage(platformImg, x, Math.round(p.y), tileW, tileH);
        } else {
          // Last partial tile — draw cropped
          const srcW = Math.round(platformImg.width * (w / tileW));
          ctx.drawImage(platformImg, 0, 0, srcW, platformImg.height,
                        x, Math.round(p.y), Math.round(w), tileH);
        }
        x += tileW;
        remaining -= tileW;
      }
      // Soft shadow on the void below
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(Math.round(p.x) + 6, Math.round(p.y) + tileH, p.w, 4);
    }
  }

  // ---------- LIVES HUD (canvas, top-left) — clean, no panel ----------
  function drawLivesHud() {
    if (state !== STATE.PLAY) return;
    if (!lifeFullImg || !lifeEmptyImg) return;

    const slot = 36;
    const gap  = 4;
    const x0   = 18;
    const y0   = 18;

    for (let i = 0; i < MAX_LIVES; i++) {
      const isFull = i < lives;
      const img = isFull ? lifeFullImg : lifeEmptyImg;

      let drawSize = slot;
      let cx = x0 + i * (slot + gap);
      let cy = y0;

      // Pop animation on freshly-gained slot
      if (isFull && i === lifeGainSlot) {
        const elapsed = frameCount - lifeGainAtFrame;
        if (elapsed >= 0 && elapsed < 24) {
          const t = elapsed / 24;
          const pop = 1 + Math.sin(t * Math.PI) * 0.45;
          drawSize = slot * pop;
          cx -= (drawSize - slot) / 2;
          cy -= (drawSize - slot) / 2;
          // soft glow
          ctx.fillStyle = 'rgba(255, 220, 120, 0.35)';
          const glow = drawSize * 0.6;
          ctx.beginPath();
          ctx.arc(cx + drawSize / 2, cy + drawSize / 2, glow, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Subtle pixel drop shadow per icon (so they pop against bright sky)
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(img, Math.round(cx + 2), Math.round(cy + 3), drawSize, drawSize);
      ctx.restore();
      // Tint the empty slots a touch darker for clarity
      if (!isFull) ctx.globalAlpha = 0.85;
      ctx.drawImage(img, Math.round(cx), Math.round(cy), drawSize, drawSize);
      ctx.globalAlpha = 1;
    }
  }

  // ---------- SCORE / COINS HUD (canvas, top-right) ----------
  function drawScoreHud() {
    if (state !== STATE.PLAY) return;

    const right = W - 18;
    const y0    = 18;

    // Common text style
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';

    // SCORE row
    drawHudStat(right, y0, 'SCORE', String(score), '#ffd84a');

    // COINS row — small coin icon + count
    const coinsY = y0 + 38;
    if (coinImg) {
      const iconSize = 24;
      // The number first (right-aligned), then place the coin to its left
      ctx.font = 'bold 22px "Press Start 2P", "Courier New", monospace';
      const txt = String(coinsCollected);
      const txtW = ctx.measureText(txt).width;
      // shadow
      ctx.fillStyle = '#000';
      ctx.fillText(txt, right + 2, coinsY + 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, right, coinsY + 12);
      // coin icon to the left of the text
      const iconX = right - txtW - 8 - iconSize;
      ctx.drawImage(coinImg, iconX, coinsY + 8, iconSize, iconSize);
    } else {
      drawHudStat(right, coinsY, 'COINS', String(coinsCollected), '#ffffff');
    }
  }

  function drawHudStat(rightX, topY, label, value, valueColor) {
    // Label
    ctx.font = 'bold 10px "Press Start 2P", "Courier New", monospace';
    ctx.fillStyle = '#000';
    ctx.fillText(label, rightX + 2, topY + 2);
    ctx.fillStyle = '#b8dcf6';
    ctx.fillText(label, rightX, topY);
    // Value (chunky)
    ctx.font = 'bold 22px "Press Start 2P", "Courier New", monospace';
    ctx.fillStyle = '#000';
    ctx.fillText(value, rightX + 2, topY + 14);
    ctx.fillStyle = valueColor || '#ffffff';
    ctx.fillText(value, rightX, topY + 12);
  }

  // ============================================================
   //  PIXEL ART RENDERING
   //  Everything below snaps to a chunky PX-pixel grid for that
   //  classic NES/SNES platformer vibe.
   // ============================================================
  const PX = 6;

  // Snap a value to the pixel grid
  function snap(v) { return Math.round(v / PX) * PX; }

  // Draw a rectangle aligned to the pixel grid
  function pxRect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(snap(x), snap(y), Math.max(PX, snap(w)), Math.max(PX, snap(h)));
  }

  // Filled pixel-art circle (made of PX-sized blocks)
  function pxCircle(cx, cy, r, color) {
    ctx.fillStyle = color;
    const r2 = r * r;
    const x0 = snap(cx - r);
    const x1 = snap(cx + r);
    const y0 = snap(cy - r);
    const y1 = snap(cy + r);
    for (let yy = y0; yy <= y1; yy += PX) {
      for (let xx = x0; xx <= x1; xx += PX) {
        const dx = xx + PX / 2 - cx;
        const dy = yy + PX / 2 - cy;
        if (dx * dx + dy * dy <= r2) ctx.fillRect(xx, yy, PX, PX);
      }
    }
  }

  // Stamp a string-based bitmap at (x, y), each char = cell × cell px.
  // ` ` / `.` = empty. Any other char is looked up in the palette map.
  function pxStamp(bmp, x, y, cell, palette) {
    for (let row = 0; row < bmp.length; row++) {
      const line = bmp[row];
      for (let col = 0; col < line.length; col++) {
        const ch = line[col];
        if (ch === '.' || ch === ' ') continue;
        const color = palette[ch];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(snap(x + col * cell), snap(y + row * cell), cell, cell);
      }
    }
  }

  // ===== DAY ↔ NIGHT SCENE PROGRESSION =====
  //
  // The world fades from a hazy daytime city to a cyberpunk night skyline
  // as the player's score climbs past 10,000. The transition zone is
  // 8,000 → 12,000 (4,000 score points wide) so it feels gradual.
  function getNightT() {
    if (score < 8000) return 0;
    if (score > 12000) return 1;
    return (score - 8000) / 4000;
  }

  // Hex → [r,g,b]
  function hexToRgb(hex) {
    const m = hex.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }
  // Lerp two hex colors → "rgb(r,g,b)"
  function lerpColor(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    const r = Math.round(A[0] + (B[0] - A[0]) * t);
    const g = Math.round(A[1] + (B[1] - A[1]) * t);
    const c = Math.round(A[2] + (B[2] - A[2]) * t);
    return `rgb(${r},${g},${c})`;
  }

  // -------- SKY palettes (day + night, 6 bands matched 1:1) --------
  const SKY_DAY = [
    { t: 0.00, c: '#7cb6e8' },
    { t: 0.20, c: '#94c4ec' },
    { t: 0.42, c: '#b1d3f0' },
    { t: 0.65, c: '#cee0f3' },
    { t: 0.85, c: '#e2eaf0' },
    { t: 0.94, c: '#ecf0f2' },
  ];
  const SKY_NIGHT = [
    { t: 0.00, c: '#08081f' },
    { t: 0.20, c: '#1a1a52' },
    { t: 0.42, c: '#2c1a6c' },
    { t: 0.65, c: '#4a1a78' },
    { t: 0.85, c: '#7a2080' },
    { t: 0.94, c: '#a830a0' },
  ];

  // Pre-generated star field — deterministic so they don't twinkle randomly each frame
  const STAR_COUNT = 70;
  const STARS = (() => {
    const arr = [];
    let seed = 12345;
    const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < STAR_COUNT; i++) {
      arr.push({
        x: Math.floor(rng() * 960 / PX) * PX,
        y: Math.floor(rng() * 320 / PX) * PX,
        bright: rng() > 0.6 ? 2 : 1,           // brighter stars are 2 pixels
        twinkleOffset: Math.floor(rng() * 200),
        twinklePeriod: 90 + Math.floor(rng() * 80),
      });
    }
    return arr;
  })();

  function drawSky() {
    const nightT = getNightT();

    // Lerp each sky band day → night
    for (let i = 0; i < SKY_DAY.length; i++) {
      const top = Math.floor(GROUND_Y * SKY_DAY[i].t / PX) * PX;
      const bot = i + 1 < SKY_DAY.length
        ? Math.floor(GROUND_Y * SKY_DAY[i + 1].t / PX) * PX
        : GROUND_Y;
      ctx.fillStyle = lerpColor(SKY_DAY[i].c, SKY_NIGHT[i].c, nightT);
      ctx.fillRect(0, top, W, bot - top);
    }

    // Sun fades out as we head into night (gone by t≈0.7)
    const sunAlpha = Math.max(0, 1 - nightT * 1.4);
    if (sunAlpha > 0.02) {
      ctx.save();
      ctx.globalAlpha = sunAlpha;
      const sunX = W - 150, sunY = 96;
      pxCircle(sunX, sunY, 56, 'rgba(255, 240, 180, 0.22)');
      pxCircle(sunX, sunY, 42, '#fff5c8');
      pxCircle(sunX, sunY, 30, '#ffe890');
      ctx.restore();
    }

    // Moon + stars fade in as we head into night (begin at t≈0.30)
    const nightAlpha = Math.max(0, Math.min(1, (nightT - 0.30) * 1.8));
    if (nightAlpha > 0.02) {
      ctx.save();
      ctx.globalAlpha = nightAlpha;

      // Stars
      for (const s of STARS) {
        const phase = (frameCount + s.twinkleOffset) % s.twinklePeriod;
        if (phase < 4) continue;
        const dim = phase < 12;
        ctx.fillStyle = dim ? '#7080c0' : (s.bright === 2 ? '#ffffff' : '#cfd8ff');
        ctx.fillRect(s.x, s.y, PX, PX);
        if (s.bright === 2 && !dim) {
          ctx.fillRect(s.x + PX, s.y, PX, PX);
          ctx.fillRect(s.x - PX, s.y, PX, PX);
          ctx.fillRect(s.x, s.y + PX, PX, PX);
          ctx.fillRect(s.x, s.y - PX, PX, PX);
        }
      }

      // Glowing moon
      const moonX = W - 150, moonY = 100;
      pxCircle(moonX, moonY, 78, 'rgba(180, 220, 255, 0.10)');
      pxCircle(moonX, moonY, 60, 'rgba(180, 220, 255, 0.18)');
      pxCircle(moonX, moonY, 44, '#dde6ff');
      pxCircle(moonX, moonY, 38, '#ffffff');
      pxRect(moonX - 14, moonY - 6, PX * 2, PX * 2, '#b9c4e4');
      pxRect(moonX +  8, moonY +  4, PX * 2, PX,    '#b9c4e4');
      pxRect(moonX -  4, moonY + 14, PX,     PX,    '#b9c4e4');
      ctx.restore();
    }
  }

  // -------- CLOUDS (chunky bitmaps) --------
  const CLOUD_BMP = [
    '...xxxxxx....',
    '..xxxxxxxxx..',
    '.xxxxxxxxxxx.',
    'xxxxxxxxxxxxx',
    '.xxxxxxxxxxx.',
    '..ssssssssss.',
  ];
  const CLOUD_PAL = { x: '#ffffff', s: '#cfe1f1' };

  function drawClouds() {
    for (const c of clouds) {
      // pick cell size based on cloud scale, snapped to grid
      const cell = Math.max(PX, snap(PX * 1.6 * c.s));
      pxStamp(CLOUD_BMP, c.x, c.y, cell, CLOUD_PAL);
    }
  }

  // -------- CYBERPUNK CITY SKYLINE (two parallax layers) --------
  // Per-x deterministic building heights via cheap hash
  function bldHeight(seed, baseH, varH) {
    // mix two sines so the skyline feels varied but stable
    const n = Math.sin(seed * 0.31) * 0.55 + Math.sin(seed * 1.17 + 2.1) * 0.35 + Math.sin(seed * 2.7) * 0.10;
    return snap(baseH + (n + 1) / 2 * varH);
  }

  // City palette presets — DAY (current daylight) + NIGHT (cyberpunk neon).
  const FAR_DAY = {
    bodyTop: '#a8b8cf', bodyBot: '#8b9db8', edge: '#728599',
    unlitColor: '#7e92ad', offColor: '#92a4be',
    windowChance: 0.10, lit: 0.55,
    windowColors: ['#dceaf5', '#cad8e7'],
    flickerEnabled: false, antennaChance: 0,
  };
  const FAR_NIGHT = {
    bodyTop: '#16204a', bodyBot: '#0c1432', edge: '#293a78',
    unlitColor: '#070418', offColor: '#0a0625',
    windowChance: 0.18, lit: 0.55,
    windowColors: ['#3aa8ff', '#7e63ff', '#ff70d8'],
    flickerEnabled: true, antennaChance: 0,
  };
  const NEAR_DAY = {
    bodyTop: '#7d8ea8', bodyBot: '#637488', edge: '#46546a',
    unlitColor: '#56657c', offColor: '#6c7c94',
    windowChance: 0.18, lit: 0.55,
    windowColors: ['#e8f0f8', '#f2dfa8', '#dfe6ee'],
    flickerEnabled: false, antennaChance: 6,
  };
  const NEAR_NIGHT = {
    bodyTop: '#1f1450', bodyBot: '#100835', edge: '#3a26a0',
    unlitColor: '#0a0625', offColor: '#0f0a3a',
    windowChance: 0.32, lit: 0.65,
    windowColors: ['#00f0ff', '#ff40d0', '#fff050', '#7eff70'],
    flickerEnabled: true, antennaChance: 6,
  };

  // Lerp a day palette toward a night palette by t. Colors are interpolated;
  // window-color arrays + boolean/discrete flags swap at t = 0.5 to avoid
  // ugly mid-mixes.
  function lerpPalette(d, n, t) {
    return {
      bodyTop:        lerpColor(d.bodyTop,    n.bodyTop,    t),
      bodyBot:        lerpColor(d.bodyBot,    n.bodyBot,    t),
      edge:           lerpColor(d.edge,       n.edge,       t),
      unlitColor:     lerpColor(d.unlitColor, n.unlitColor, t),
      offColor:       lerpColor(d.offColor,   n.offColor,   t),
      windowChance:   d.windowChance + (n.windowChance - d.windowChance) * t,
      lit:            d.lit          + (n.lit          - d.lit)          * t,
      windowColors:   t < 0.5 ? d.windowColors   : n.windowColors,
      flickerEnabled: t < 0.5 ? d.flickerEnabled : n.flickerEnabled,
      antennaChance:  t < 0.5 ? d.antennaChance  : n.antennaChance,
    };
  }

  // Replaces the old hill renderer; called via drawDistantHills()
  function drawDistantHills() {
    const t = getNightT();
    const farPal  = lerpPalette(FAR_DAY,  FAR_NIGHT,  t);
    const nearPal = lerpPalette(NEAR_DAY, NEAR_NIGHT, t);

    drawCityLayer({
      offset: cityOffsetFar,
      blockW: PX * 8,
      baseY:  GROUND_Y - PX * 2,
      baseH:  55, varH: 80,
      blockSeedShift: 0,
      ...farPal,
    });
    drawCityLayer({
      offset: cityOffsetNear,
      blockW: PX * 11,
      baseY:  GROUND_Y - PX,
      baseH:  82, varH: 120,
      blockSeedShift: 100000,
      ...nearPal,
    });
  }

  function drawCityLayer(opts) {
    const {
      offset, blockW, baseY, baseH, varH, bodyTop, bodyBot,
      edge, windowChance, windowColors, lit, blockSeedShift,
      antennaChance = 5,
      flickerEnabled = true,
      unlitColor = '#3a4458',
      offColor   = '#46546a',
    } = opts;

    // Iterate over WORLD x, stepping in blockW chunks. This way each building
    // has a fixed world-x range (and therefore a fixed seed/height) — they
    // simply scroll across the screen as the world moves, never re-rolled.
    const startWX = Math.floor((offset - blockW) / blockW) * blockW;
    const endWX   = offset + W + blockW;

    for (let wxWorld = startWX; wxWorld <= endWX; wxWorld += blockW) {
      const screenX = Math.round(wxWorld - offset);            // where to draw
      const seed    = Math.floor(wxWorld / blockW) + blockSeedShift;
      const h       = bldHeight(seed, baseH, varH);
      const top     = baseY - h;

      // Body
      ctx.fillStyle = bodyBot;
      ctx.fillRect(screenX, top, blockW, h);
      ctx.fillStyle = bodyTop;
      ctx.fillRect(screenX, top, blockW, Math.max(PX * 2, snap(h * 0.5)));

      // Top edge + right edge trim
      ctx.fillStyle = edge;
      ctx.fillRect(screenX, top, blockW, PX);
      ctx.fillRect(screenX + blockW - PX, top, PX, h);

      // Optional antenna with red light
      if (antennaChance > 0) {
        const antennaSeed = (seed * 7 + 13) % antennaChance;
        if (antennaSeed === 0) {
          const ax = screenX + Math.floor(blockW / 2);
          ctx.fillStyle = edge;
          ctx.fillRect(ax, top - PX * 4, PX, PX * 4);
          const blink = Math.floor(frameCount / 20) % 2 === 0;
          ctx.fillStyle = blink ? '#ff3030' : '#7a1a1a';
          ctx.fillRect(ax, top - PX * 5, PX, PX);
        }
      }

      // Window grid — hashes use WORLD x of each window so the lighting
      // pattern is locked to the building, not to the screen position.
      const winYStart = top + PX * 2;
      const winStep   = PX * 3;
      const winColW   = PX;
      const winColStep= PX * 2;
      for (let wy = winYStart; wy < baseY - PX; wy += winStep) {
        // Index columns by their world-x so the seed stays stable
        for (let cx = PX; cx < blockW - PX * 2; cx += winColStep) {
          const wxCol = wxWorld + cx;        // world-x of this window column
          const drawX = screenX + cx;        // screen-x to draw at
          const hash = ((wxCol * 31) ^ (wy * 17) ^ (seed * 919)) & 0xff;
          const norm = hash / 255;
          if (norm > windowChance) {
            ctx.fillStyle = unlitColor;
            ctx.fillRect(drawX, wy, winColW, PX);
            continue;
          }
          const colorIdx = hash % windowColors.length;
          const flickerOn = !flickerEnabled || ((frameCount + hash) >> 5) % 11 !== 0;
          if (norm < windowChance * lit && flickerOn) {
            ctx.fillStyle = windowColors[colorIdx];
          } else {
            ctx.fillStyle = offColor;
          }
          ctx.fillRect(drawX, wy, winColW, PX);
        }
      }
    }
  }

  // -------- BUSHES (pixel sprite) --------
  const BUSH_BMP = [
    '....hhh....',
    '..hHHHHHh..',
    '.hHHHHHHHh.',
    'hHHHHHHHHHh',
    'hHHHHHHHHHh',
    'sssssssssss',
  ];
  const BUSH_PAL = { h: '#5fbf3a', H: '#86d35c', s: '#3d8a25' };

  function drawBushes() {
    for (const b of bushes) {
      const cell = Math.max(PX, snap(PX * 1.4 * b.scale));
      const totalH = BUSH_BMP.length * cell;
      const baseY = GROUND_Y + PX - totalH; // sit on grass line
      pxStamp(BUSH_BMP, b.x, baseY, cell, BUSH_PAL);
    }
  }

  // -------- GROUND (tile-based, sprite assets) --------
  function drawGround() {
    if (!groundMidImg || !TILE.midW) return;
    for (const g of groundSegments) {
      if (g.endX < -10 || g.startX > W + 10) continue;
      drawGroundSegment(g);
    }
  }

  function drawGroundSegment(g) {
    const top = GROUND_Y;
    const startX = Math.round(g.startX);
    const endX   = Math.round(g.endX);

    // Left ending
    ctx.drawImage(groundLeftImg, startX, top, TILE.leftW, TILE.leftH);
    // Right ending
    ctx.drawImage(groundRightImg, endX - TILE.rightW, top, TILE.rightW, TILE.rightH);

    // Middle tiles between the endings
    const innerStart = startX + TILE.leftW;
    const innerEnd   = endX - TILE.rightW;
    let x = innerStart;
    while (x + TILE.midW <= innerEnd + 0.5) {
      ctx.drawImage(groundMidImg, x, top, TILE.midW, TILE.midH);
      x += TILE.midW;
    }
    // Last partial slice if needed (cropped from the source)
    const remaining = innerEnd - x;
    if (remaining > 0) {
      const srcW = Math.max(1, Math.round(groundMidImg.width * (remaining / TILE.midW)));
      ctx.drawImage(
        groundMidImg, 0, 0, srcW, groundMidImg.height,
        x, top, Math.round(remaining), TILE.midH
      );
    }
  }

  function drawObstacles() {
    for (const o of obstacles) {
      const bx = Math.round(o.x), by = Math.round(o.y);
      let img = null;
      if (o.type === 'pillar')  img = pillarImg;
      else if (o.type === 'spikes')   img = spikesImg;
      else if (o.type === 'shooter')  img = shooterImg;
      if (!img) continue;
      // Drop shadow on the ground
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(bx + 4, by + o.h, o.w - 8, 4);
      ctx.drawImage(img, bx, by, o.w, o.h);

      // Tiny "muzzle pulse" glow on shooter when about to fire
      if (o.type === 'shooter' && o.fireTimer !== undefined && o.fireTimer < 12) {
        const a = (12 - o.fireTimer) / 12;
        ctx.fillStyle = `rgba(255, 140, 60, ${0.55 * a})`;
        ctx.beginPath();
        ctx.arc(bx - 2, by + Math.round(o.h * 0.18) + (TRAP.boltH || 21) / 2, 10 + a * 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawTomatoes() {
    if (!lifeFullImg) return;
    for (const t of tomatoes) {
      const bob = Math.sin(t.bob) * 5;
      const size = t.r * 2;
      ctx.save();
      // ground shadow
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(t.x, GROUND_Y + 8, t.r * 0.7, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      // glow halo
      ctx.fillStyle = 'rgba(255, 230, 100, 0.18)';
      ctx.beginPath();
      ctx.arc(t.x, t.y + bob, t.r + 8 + Math.sin(t.bob * 2) * 2, 0, Math.PI * 2);
      ctx.fill();
      // sprite
      ctx.drawImage(lifeFullImg, t.x - size / 2, t.y - size / 2 + bob, size, size);
      ctx.restore();
    }
  }

  function drawCoins() {
    if (!coinImg) return;
    for (const c of coins) {
      const bob = Math.sin(c.bob) * 4;
      // Spinning effect via horizontal scale
      const scale = Math.abs(Math.cos(c.bob * 0.6));
      const drawW = Math.max(8, c.r * 2 * (0.4 + scale * 0.6));
      const drawH = c.r * 2;
      ctx.save();
      // shadow on ground when low
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(c.x, GROUND_Y + 8, c.r * 0.7, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.drawImage(coinImg, c.x - drawW / 2, c.y - drawH / 2 + bob, drawW, drawH);
      ctx.restore();
    }
  }

  // Render an image as a flat white silhouette via an offscreen canvas
  function drawWhiteSilhouette(img, dx, dy, dw, dh) {
    if (tintCanvas.width !== img.width || tintCanvas.height !== img.height) {
      tintCanvas.width = img.width;
      tintCanvas.height = img.height;
    }
    tintCtx.clearRect(0, 0, tintCanvas.width, tintCanvas.height);
    tintCtx.globalCompositeOperation = 'source-over';
    tintCtx.drawImage(img, 0, 0);
    tintCtx.globalCompositeOperation = 'source-in';
    tintCtx.fillStyle = '#ffffff';
    tintCtx.fillRect(0, 0, tintCanvas.width, tintCanvas.height);
    ctx.drawImage(tintCanvas, dx, dy, dw, dh);
  }

  function drawPlayer() {
    let img;
    if (player.onGround) {
      img = runImgs[player.runFrame];
    } else {
      img = jumpImgs[player.jumpFrameIdx] || jumpImgs[0];
    }
    if (!img) return;

    // Compute aspect-correct draw size per sprite. Hitbox stays at player.w/h
    // (so collisions don't change), but the visual is centered horizontally
    // inside that box so the new wider run sprites don't get squished.
    const drawH = player.h;
    const drawW = drawH * (img.width / img.height);
    const drawX = player.x + (player.w - drawW) / 2;
    const drawY = player.y;

    // Soft shadow (anchored to hitbox center, not the sprite, so it's stable)
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    const shadowScale = player.onGround ? 1 : Math.max(0.4, 1 - (GROUND_Y - (player.y + player.h)) / 200);
    ctx.beginPath();
    ctx.ellipse(player.x + player.w / 2, GROUND_Y + 10, (player.w / 2) * shadowScale, 6 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Subtle icy halo when arctic jump is charged & idle
    if (arcticReady && arcticActiveFrames === 0) {
      const pulse = (Math.sin(frameCount * 0.16) + 1) / 2;
      ctx.save();
      ctx.fillStyle = `rgba(168, 240, 255, ${0.10 + pulse * 0.10})`;
      ctx.beginPath();
      ctx.arc(player.x + player.w / 2, player.y + player.h / 2, player.w / 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Strong icy aura right after Arctic Jump activation
    if (arcticActiveFrames > 0) {
      arcticActiveFrames--;
      const t = arcticActiveFrames / 36;
      ctx.save();
      ctx.fillStyle = `rgba(168, 240, 255, ${0.15 + t * 0.30})`;
      ctx.beginPath();
      ctx.arc(player.x + player.w / 2, player.y + player.h / 2, player.w / 1.2 + 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(220, 250, 255, ${t * 0.30})`;
      ctx.beginPath();
      ctx.arc(player.x + player.w / 2, player.y + player.h / 2 + 4, player.w / 2.0, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 4; i++) {
        const sx = player.x + 8 + ((i * 17 + frameCount * 2) % (player.w - 12));
        const sy = player.y + ((i * 11 + frameCount * 3) % player.h);
        ctx.fillStyle = `rgba(220, 250, 255, ${t * 0.9})`;
        ctx.fillRect(Math.round(sx), Math.round(sy), 2, 2);
      }
      ctx.restore();
    }

    // Invulnerability blink: alternate between white silhouette and dimmed sprite
    if (invulnFrames > 0) {
      const phase = Math.floor(invulnFrames / 6) % 2;
      if (phase === 0) {
        drawWhiteSilhouette(img, drawX, drawY, drawW, drawH);
      } else {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        ctx.restore();
      }
      return;
    }

    ctx.drawImage(img, drawX, drawY, drawW, drawH);
  }

  // ---------- LOOP ----------
  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- STATE TRANSITIONS ----------
  // ---------- SCOREBOARD ----------
  // Shared global leaderboard via Supabase REST. Falls back to localStorage
  // if the network/server is unreachable so the menu still renders.
  const SUPABASE_URL  = 'https://mlcbpcjlydukdbkulgod.supabase.co';
  const SUPABASE_KEY  = 'sb_publishable_W-tBNovLGKqyim1ZD3FiHA_y-x2Px3W';
  const SCOREBOARD_KEY   = 'tjGameScoreboardV1';   // localStorage cache key
  const SCOREBOARD_LIMIT = 10;

  // In-memory cache (populated by fetchRemoteScores; mirrored to localStorage)
  let cachedScores = [];

  function loadScoreboardLocal() {
    try {
      const raw = localStorage.getItem(SCOREBOARD_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(e => e && typeof e.name === 'string' && typeof e.score === 'number');
    } catch (e) { return []; }
  }
  function saveScoreboardLocal(scores) {
    try { localStorage.setItem(SCOREBOARD_KEY, JSON.stringify(scores)); } catch (e) {}
  }
  // Sync getter — used by qualifiesForScoreboard etc. Always returns the
  // latest fetched data (or local fallback).
  function loadScoreboard() {
    return cachedScores.length ? cachedScores : loadScoreboardLocal();
  }

  // Fetch top 10 from Supabase and re-render.
  async function fetchRemoteScores() {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/scores?select=name,score,coins,created_at&order=score.desc&limit=${SCOREBOARD_LIMIT}`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = await res.json();
      cachedScores = (Array.isArray(rows) ? rows : []).map(r => ({
        name:  r.name,
        score: r.score,
        coins: r.coins || 0,
        date:  r.created_at,
      }));
      saveScoreboardLocal(cachedScores);   // mirror as offline fallback
    } catch (e) {
      console.warn('[scoreboard] remote fetch failed, using local cache', e);
      cachedScores = loadScoreboardLocal();
    }
    renderScoreboard();
  }

  // POST a new score to Supabase. Returns true on success.
  async function pushRemoteScore(name, score, coins) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ name, score, coins }),
      });
      return res.ok;
    } catch (e) { return false; }
  }

  function qualifiesForScoreboard(s) {
    if (s <= 0) return false;
    const scores = loadScoreboard();
    if (scores.length < SCOREBOARD_LIMIT) return true;
    return s > scores[scores.length - 1].score;
  }

  // Save score: optimistic local insert (instant UI update), then push to
  // Supabase, then re-fetch the authoritative top-10.
  async function addToScoreboard(name, sc, coins) {
    const entry = { name: String(name).slice(0, 16), score: sc, coins, date: new Date().toISOString() };
    cachedScores.push(entry);
    cachedScores.sort((a, b) => b.score - a.score);
    if (cachedScores.length > SCOREBOARD_LIMIT) cachedScores.length = SCOREBOARD_LIMIT;
    saveScoreboardLocal(cachedScores);
    renderScoreboard();
    const ok = await pushRemoteScore(entry.name, entry.score, entry.coins);
    if (ok) await fetchRemoteScores();   // sync with server's view
    return ok;
  }

  function renderScoreboard() {
    const list = document.getElementById('scoreboardList');
    if (!list) return;
    const scores = loadScoreboard();
    list.innerHTML = '';
    if (scores.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sb-empty';
      empty.textContent = 'No scores yet — be the first!';
      list.appendChild(empty);
      return;
    }
    for (let i = 0; i < scores.length; i++) {
      const row = document.createElement('div');
      row.className = `sb-row sb-rank-${i + 1}`;
      const rank  = document.createElement('span'); rank.className  = 'sb-rank';  rank.textContent  = (i + 1) + '.';
      const name  = document.createElement('span'); name.className  = 'sb-name';  name.textContent  = scores[i].name || 'PLAYER';
      const score = document.createElement('span'); score.className = 'sb-score'; score.textContent = String(scores[i].score);
      row.appendChild(rank); row.appendChild(name); row.appendChild(score);
      list.appendChild(row);
    }
  }

  const menuEl        = document.getElementById('menu');
  const overEl        = document.getElementById('gameover');
  const hudEl         = document.getElementById('hud');
  const hudLogoEl     = document.getElementById('hudLogo');
  const bgmEl              = document.getElementById('bgm');
  const startSfxEl         = document.getElementById('startSfx');
  const tomatoSfxEl        = document.getElementById('tomatoSfx');
  const arcticReadySfxEl   = document.getElementById('arcticReadySfx');
  const gameOverSfxEl      = document.getElementById('gameOverSfx');
  const muteBtn            = document.getElementById('muteBtn');
  // Lives HUD is now drawn on the canvas (see drawLivesHud below).
  // updateLivesHud() just records when a life was gained so the canvas
  // renderer can play a brief pop animation on the affected slot.
  let lifeGainAtFrame = -9999;
  let lifeGainSlot    = -1;
  function updateLivesHud(animateGain) {
    if (animateGain) {
      lifeGainAtFrame = frameCount;
      lifeGainSlot    = lives - 1;
    }
  }

  // ---------- MUSIC + START VOICE CLIP ----------
  let muted = false;
  bgmEl.volume = 0.70;
  if (startSfxEl)        startSfxEl.volume        = 1.0;
  if (tomatoSfxEl)       tomatoSfxEl.volume       = 0.55;
  if (arcticReadySfxEl)  arcticReadySfxEl.volume  = 0.9;
  if (gameOverSfxEl)     gameOverSfxEl.volume     = 1.0;

  const MUSIC_FULL_VOL = 0.70;   // louder soundtrack
  const MUSIC_DUCK_VOL = 0.18;   // duck while GO TJ plays
  let musicDuckTimer = null;

  // Soundtrack — randomly picked first track each new run, then advances
  // through the rest of the list on each track-end.
  const PLAYLIST = [
    'DANHAM.mp3',
    'hardstyle crazy cringe meme, energetic.mp3',
    'TEE-JAY DUNHEM.mp3',
  ];
  let trackIdx = 0;

  function loadTrack(idx) {
    trackIdx = idx % PLAYLIST.length;
    if (!bgmEl.src.endsWith(PLAYLIST[trackIdx])) {
      bgmEl.src = PLAYLIST[trackIdx];
    }
  }

  function playMusic() {
    if (muted) return;
    if (!bgmEl.src) loadTrack(0);
    const p = bgmEl.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
  }
  function stopMusic() { bgmEl.pause(); }

  // When the current track ends, advance to the next one and resume playback
  bgmEl.addEventListener('ended', () => {
    if (state !== STATE.PLAY) return;   // don't auto-advance after game over
    loadTrack(trackIdx + 1);
    playMusic();
  });

  // Play the "GO TJ" voice clip and duck the music while it plays
  function playStartCallout() {
    if (!startSfxEl || muted) return;
    try {
      startSfxEl.currentTime = 0;
      const p = startSfxEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignore */ }

    // Duck the music while the callout is audible
    bgmEl.volume = MUSIC_DUCK_VOL;
    if (musicDuckTimer) clearTimeout(musicDuckTimer);
    const duration = (isFinite(startSfxEl.duration) ? startSfxEl.duration : 1.6) * 1000;
    musicDuckTimer = setTimeout(() => {
      // Smooth ramp back up over ~400ms via stepped intervals
      const steps = 8;
      const startV = bgmEl.volume;
      const endV = MUSIC_FULL_VOL;
      let i = 0;
      const stepFn = () => {
        i++;
        bgmEl.volume = startV + (endV - startV) * (i / steps);
        if (i < steps) setTimeout(stepFn, 50);
      };
      stepFn();
      musicDuckTimer = null;
    }, Math.max(800, duration - 100));
  }

  function setMuted(m) {
    muted = m;
    bgmEl.muted = m;
    if (startSfxEl)       startSfxEl.muted       = m;
    if (tomatoSfxEl)      tomatoSfxEl.muted      = m;
    if (arcticReadySfxEl) arcticReadySfxEl.muted = m;
    if (gameOverSfxEl)    gameOverSfxEl.muted    = m;
    // Flat SVG speaker icons — `currentColor` picks up the button's color.
    const ICON_ON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
    const ICON_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="22" y1="9"  x2="16" y2="15"/><line x1="16" y1="9"  x2="22" y2="15"/></svg>`;
    muteBtn.innerHTML = m ? ICON_OFF : ICON_ON;
    muteBtn.classList.toggle('muted', m);
    muteBtn.setAttribute('aria-label', m ? 'Sound off — tap to enable' : 'Sound on — tap to mute');
    if (m) {
      bgmEl.pause();
      if (startSfxEl)       startSfxEl.pause();
      if (tomatoSfxEl)      tomatoSfxEl.pause();
      if (arcticReadySfxEl) arcticReadySfxEl.pause();
      if (gameOverSfxEl)    gameOverSfxEl.pause();
    } else if (state === STATE.PLAY) {
      playMusic();
    }
  }
  muteBtn.addEventListener('click', () => setMuted(!muted));

  const scoreEl       = document.getElementById('score');
  const coinsEl       = document.getElementById('coins');
  const finalScore    = document.getElementById('finalScore');
  const finalCoins    = document.getElementById('finalCoins');
  const finalDistance = document.getElementById('finalDistance');
  const finalBonus    = document.getElementById('finalBonus');
  const endMsgEl      = document.getElementById('endMsg');

  document.getElementById('playBtn').addEventListener('click', startGame);
  document.getElementById('retryBtn').addEventListener('click', startGame);
  document.getElementById('menuBtn').addEventListener('click', returnToMenu);

  // High-score entry submission
  const highScoreEntryEl = document.getElementById('highScoreEntry');
  const nicknameInputEl  = document.getElementById('nicknameInput');
  const saveScoreBtn     = document.getElementById('saveScoreBtn');
  if (saveScoreBtn) saveScoreBtn.addEventListener('click', submitHighScore);
  if (nicknameInputEl) {
    // Allow ENTER to submit
    nicknameInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitHighScore();
      }
    });
    // Stop game's space-jump from triggering while typing
    nicknameInputEl.addEventListener('keydown', (e) => e.stopPropagation());
    nicknameInputEl.addEventListener('keyup',   (e) => e.stopPropagation());
  }

  async function submitHighScore() {
    if (!nicknameInputEl) return;
    let name = (nicknameInputEl.value || '').toUpperCase();
    name = name.replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 10);
    if (!name) name = 'PLAYER';
    if (saveScoreBtn) {
      saveScoreBtn.textContent = 'SAVING…';
      saveScoreBtn.disabled = true;
    }
    const ok = await addToScoreboard(name, score, coinsCollected);
    if (highScoreEntryEl) highScoreEntryEl.classList.add('hidden');
    if (saveScoreBtn) saveScoreBtn.textContent = ok ? '✓ SAVED' : '⚠ SAVED LOCALLY';
  }

  function returnToMenu() {
    state = STATE.MENU;
    if (gameOverPanelTimer) { clearTimeout(gameOverPanelTimer); gameOverPanelTimer = null; }
    if (gameOverSfxEl) { try { gameOverSfxEl.pause(); gameOverSfxEl.currentTime = 0; } catch(e){} }
    stopMusic();
    overEl.classList.add('hidden');
    menuEl.classList.remove('hidden');
    hudEl.classList.add('hidden');
    hudLogoEl.classList.add('hidden');
    if (jumpBtn) jumpBtn.classList.add('hidden');
    resetWorld();
    fetchRemoteScores();        // pull latest leaderboard from server
    if (saveScoreBtn) {
      saveScoreBtn.textContent = 'SAVE';
      saveScoreBtn.disabled = false;
    }
    if (highScoreEntryEl) highScoreEntryEl.classList.add('hidden');
  }

  function startGame() {
    if (gameOverPanelTimer) { clearTimeout(gameOverPanelTimer); gameOverPanelTimer = null; }
    if (gameOverSfxEl) { try { gameOverSfxEl.pause(); gameOverSfxEl.currentTime = 0; } catch(e){} }
    resetWorld();
    state = STATE.PLAY;
    menuEl.classList.add('hidden');
    overEl.classList.add('hidden');
    hudEl.classList.remove('hidden');
    hudLogoEl.classList.remove('hidden');
    if (jumpBtn) jumpBtn.classList.remove('hidden');
    updateLivesHud(false);  // refresh life icons
    audio();      // unlock SFX context on user gesture
    // Pick a random track from the playlist for each new run.
    // The 'ended' handler then alternates through the rest of the playlist.
    loadTrack(Math.floor(Math.random() * PLAYLIST.length));
    bgmEl.currentTime = 0;
    bgmEl.volume = MUSIC_FULL_VOL;
    playMusic();
    playStartCallout();  // "GO TJ!" — ducks the music while it plays
  }

  // distance score is everything except the coin bonus
  function distanceScore() {
    return Math.max(0, score - coinsCollected * COIN_VALUE);
  }

  function endMessage() {
    if (score >= 5000)      return "LEGENDARY RUN! TJ would be proud 🏆";
    if (score >= 2500)      return "Awesome run! You're on fire!";
    if (score >= 1000)      return "Nice job — keep stacking those coins!";
    if (coinsCollected >= 5) return "Solid coin haul! Try to go further next time.";
    if (score > 0)          return "Good start — give it another go!";
    return "Whoops! Tap to try again.";
  }

  function gameOver() {
    state = STATE.OVER;
    stopMusic();        // cut soundtrack first so crash sfx isn't muddied
    playCrashSfx();
    // Layered game-over MP3 a tick later so it doesn't muddy the crash impact
    if (gameOverSfxEl && !gameOverSfxEl.muted) {
      try {
        gameOverSfxEl.currentTime = 0;
        setTimeout(() => {
          if (state === STATE.OVER) {
            const p = gameOverSfxEl.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
        }, 180);
      } catch (e) { /* ignore */ }
    }
    gameOverAt = frameCount;
    const bonus = coinsCollected * COIN_VALUE;
    finalDistance.textContent = distanceScore();
    finalCoins.textContent    = coinsCollected;
    finalBonus.textContent    = bonus;
    finalScore.textContent    = score;
    endMsgEl.textContent      = endMessage();
    // Decide whether the run qualifies for the leaderboard
    const qualifies = qualifiesForScoreboard(score);
    if (highScoreEntryEl) {
      if (qualifies) {
        highScoreEntryEl.classList.remove('hidden');
        if (saveScoreBtn) {
          saveScoreBtn.textContent = 'SAVE';
          saveScoreBtn.disabled = false;
        }
        if (nicknameInputEl) {
          // Auto-fill from Telegram username when running as a Mini App,
          // so players don't have to type their own name.
          const tgName = getTelegramName();
          nicknameInputEl.value = tgName || '';
        }
      } else {
        highScoreEntryEl.classList.add('hidden');
      }
    }

    // Delay panel appearance so the canvas GAME OVER animation gets the spotlight
    if (gameOverPanelTimer) clearTimeout(gameOverPanelTimer);
    gameOverPanelTimer = setTimeout(() => {
      if (state === STATE.OVER) {
        overEl.classList.remove('hidden');
        // Auto-focus the nickname field for fast entry
        if (qualifies && nicknameInputEl) {
          try { nicknameInputEl.focus(); nicknameInputEl.select(); } catch (e) {}
        }
      }
    }, 1400);
    hudEl.classList.add('hidden');
    hudLogoEl.classList.add('hidden');
    if (jumpBtn) jumpBtn.classList.add('hidden');
  }

  // ---------- BOOT ----------
  Promise.all([
    Promise.all(RUN_FRAMES.map(loadImage)).then(imgs => runImgs = imgs),
    Promise.all(JUMP_FRAMES.map(loadImage)).then(imgs => jumpImgs = imgs),
    loadImage(COIN_SRC).then(img => coinImg = img),
    loadImage(LIFE_FULL_SRC).then(img => lifeFullImg = img),
    loadImage(LIFE_EMPTY_SRC).then(img => lifeEmptyImg = img),
    loadImage(GROUND_LEFT_SRC).then(img => groundLeftImg = img),
    loadImage(GROUND_MID_SRC).then(img => groundMidImg = img),
    loadImage(GROUND_RIGHT_SRC).then(img => groundRightImg = img),
    loadImage(PLATFORM_SRC).then(img => platformImg = img),
    loadImage(ACID_LEFT_SRC).then(img => acidLeftImg = img),
    loadImage(ACID_BLOCK_SRC).then(img => acidBlockImg = img),
    loadImage(ACID_RIGHT_SRC).then(img => acidRightImg = img),
    loadImage(SPIKES_SRC).then(img => spikesImg = img),
    loadImage(PILLAR_SRC).then(img => pillarImg = img),
    loadImage(SHOOTER_SRC).then(img => shooterImg = img),
    loadImage(FIREBOLT_SRC).then(img => fireBoltImg = img),
  ]).then(() => {
    resetWorld();
    updateLivesHud(false);   // populate menu-state HUD pre-emptively
    fetchRemoteScores();     // load shared leaderboard from Supabase
    requestAnimationFrame(loop);
  }).catch(err => {
    console.error(err);
    ctx.fillStyle = '#fff';
    ctx.font = '16px monospace';
    ctx.fillText('Asset load error: ' + err.message, 20, 40);
  });

})();
