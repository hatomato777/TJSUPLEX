/* =========================================================
   TJ SUPLEX RUN  —  side-scrolling runner
   ========================================================= */

(() => {
  'use strict';

  // ---------- CANVAS ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const W = canvas.width;   // 960
  const H = canvas.height;  // 540
  const GROUND_Y = Math.round(H * 0.78);  // ground line — matches CSS gradient

  // ---------- ASSETS ----------
  const RUN_FRAMES = [
    'sprites run/s1_0000_s1.png',
    'sprites run/s1_0001_s2.png',
    'sprites run/s1_0002_s3.png',
    'sprites run/s1_0004_s4.png',
    'sprites run/s1_0003_s5.png',
    'sprites run/s1_0005_s6.png',
    'sprites run/s1_0006_s7.png',
  ];
  const JUMP_FRAMES = ['jump sprite/j1.png', 'jump sprite/jump2.png'];
  const COIN_SRC    = 'coin.png';

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

  // ---------- GAME STATE ----------
  const STATE = { MENU: 0, PLAY: 1, OVER: 2 };
  let state = STATE.MENU;

  let score = 0;
  let coinsCollected = 0;
  let baseSpeed = 8;          // start speed
  let scrollSpeed = baseSpeed;
  let speedRamp = 0;          // increases over time (capped, see update())
  let difficulty = 0;         // 0..1 normalized progression
  const COIN_VALUE = 50;
  const MAX_SPEED = 22;       // hard ceiling so it's still playable

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
    if (state === STATE.OVER) { startGame(); return; }
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
    clouds = [];
    bushes = [];
    score = 0;
    coinsCollected = 0;
    speedRamp = 0;
    difficulty = 0;
    scrollSpeed = baseSpeed;
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
    // Random obstacle type
    const r = Math.random();
    let type, w, h;
    if (r < 0.55) {
      // chair / single barrel
      type = 'barrel'; w = 48; h = 54;
    } else if (r < 0.85) {
      // wide crate
      type = 'crate'; w = 70; h = 60;
    } else {
      // tall pole
      type = 'pole';  w = 28; h = 90;
    }
    obstacles.push({
      type, w, h,
      x: W + 20,
      y: GROUND_Y - h,
    });
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

    // Difficulty curve: ramps for ~90s, then asymptotes near 1
    difficulty = 1 - Math.exp(-runningTime / 35);  // 0 → ~0.93 by 90s
    speedRamp = difficulty * (MAX_SPEED - baseSpeed);
    scrollSpeed = Math.min(MAX_SPEED, baseSpeed + speedRamp);

    // Score from distance
    score += Math.round(scrollSpeed * 0.25);

    // --- Player physics ---
    player.vy += GRAVITY;
    player.y += player.vy;
    if (player.y + player.h >= GROUND_Y) {
      player.y = GROUND_Y - player.h;
      player.vy = 0;
      if (!player.onGround) {
        player.onGround = true;
        player.jumpsLeft = 2;
      }
    } else {
      player.onGround = false;
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

    // --- Move obstacles ---
    for (const o of obstacles) o.x -= scrollSpeed;
    obstacles = obstacles.filter(o => o.x + o.w > -10);

    // --- Move coins ---
    for (const c of coins) {
      c.x -= scrollSpeed;
      c.bob += 0.12;
    }
    coins = coins.filter(c => c.x + c.r > -10);

    // --- Collisions ---
    const hb = getPlayerHitbox();

    for (const o of obstacles) {
      if (rectsHit(hb, o)) {
        gameOver();
        return;
      }
    }
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      const cb = { x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 };
      if (rectsHit(hb, cb)) {
        coins.splice(i, 1);
        coinsCollected++;
        score += 50;
        playCoinSfx();
      }
    }

    // HUD update
    scoreEl.textContent = score;
    coinsEl.textContent = coinsCollected;
  }

  // ---------- DRAW ----------
  function draw() {
    // canvas already has CSS gradient sky+ground; we still paint to control layers
    ctx.clearRect(0, 0, W, H);

    drawSky();
    drawClouds();
    drawDistantHills();
    drawBushes();
    drawGround();
    drawObstacles();
    drawCoins();
    drawPlayer();
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

  // -------- SKY (color bands) --------
  const SKY_BANDS = [
    { t: 0.00, c: '#3a8ee0' },
    { t: 0.18, c: '#5aa9ed' },
    { t: 0.36, c: '#7dc1f3' },
    { t: 0.55, c: '#a3d6f8' },
    { t: 0.74, c: '#c8e7fb' },
    { t: 0.90, c: '#e2f1fd' },
  ];

  function drawSky() {
    for (let i = 0; i < SKY_BANDS.length; i++) {
      const top = Math.floor(GROUND_Y * SKY_BANDS[i].t / PX) * PX;
      const bot = i + 1 < SKY_BANDS.length
        ? Math.floor(GROUND_Y * SKY_BANDS[i + 1].t / PX) * PX
        : GROUND_Y;
      ctx.fillStyle = SKY_BANDS[i].c;
      ctx.fillRect(0, top, W, bot - top);
    }

    // Pixel sun — three concentric circles
    const sunX = W - 144, sunY = 102;
    pxCircle(sunX, sunY, 60, '#ffe98a');
    pxCircle(sunX, sunY, 48, '#ffd84a');
    pxCircle(sunX, sunY, 32, '#ffb830');

    // Tiny pixel "rays" — four cardinal blips
    pxRect(sunX - 78, sunY,         18, 6, '#ffd84a');
    pxRect(sunX + 60, sunY,         18, 6, '#ffd84a');
    pxRect(sunX,      sunY - 78,     6, 18, '#ffd84a');
    pxRect(sunX,      sunY + 60,     6, 18, '#ffd84a');
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

  // -------- DISTANT HILLS (stair-stepped) --------
  function drawDistantHills() {
    // FAR mountain range — slow parallax, dark blue-green
    const farOffset = (frameCount * 0.5) % (PX * 4);
    for (let x = -PX * 8; x < W + PX * 8; x += PX * 2) {
      const wx = x - farOffset;
      const noise =
        Math.sin(x * 0.012) * 30 +
        Math.sin(x * 0.028 + 1.7) * 14;
      const h = Math.max(PX * 4, snap(64 + noise));
      ctx.fillStyle = '#5b7fa8';
      ctx.fillRect(wx, GROUND_Y - h, PX * 2, h);
      // Top highlight pixel row (lighter blue)
      ctx.fillStyle = '#7898bd';
      ctx.fillRect(wx, GROUND_Y - h, PX * 2, PX);
    }

    // MID hills — softer blue, faster parallax
    const midOffset = (frameCount * 1.0) % (PX * 4);
    for (let x = -PX * 8; x < W + PX * 8; x += PX * 2) {
      const wx = x - midOffset;
      const noise =
        Math.sin(x * 0.022 + 1) * 22 +
        Math.sin(x * 0.05 + 3) * 10;
      const h = Math.max(PX * 3, snap(34 + noise));
      ctx.fillStyle = '#7ba8c5';
      ctx.fillRect(wx, GROUND_Y - h, PX * 2, h);
      ctx.fillStyle = '#9ec3d8';
      ctx.fillRect(wx, GROUND_Y - h, PX * 2, PX);
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

  // -------- GROUND (grass + dirt + tufts + specks) --------
  function drawGround() {
    // Grass body
    ctx.fillStyle = '#5fbf3a';
    ctx.fillRect(0, GROUND_Y, W, PX * 3);
    // Grass top highlight (lighter row)
    ctx.fillStyle = '#86d35c';
    ctx.fillRect(0, GROUND_Y, W, PX);
    // Grass bottom shadow
    ctx.fillStyle = '#3d8a25';
    ctx.fillRect(0, GROUND_Y + PX * 3, W, PX);

    // Pixel grass tufts that scroll with ground
    const tuftStart = -((groundOffset) % (PX * 6));
    for (let x = tuftStart; x < W + PX * 6; x += PX * 6) {
      ctx.fillStyle = '#86d35c';
      ctx.fillRect(snap(x),          GROUND_Y - PX, PX, PX);
      ctx.fillRect(snap(x) + PX * 3, GROUND_Y - PX, PX, PX);
    }

    // Dirt body
    ctx.fillStyle = '#a86a35';
    ctx.fillRect(0, GROUND_Y + PX * 4, W, H - GROUND_Y - PX * 4);

    // Dirt color bands (horizontal pixel rows for depth)
    ctx.fillStyle = '#8a5527';
    ctx.fillRect(0, GROUND_Y + PX * 7,  W, PX);
    ctx.fillStyle = '#6e4220';
    ctx.fillRect(0, GROUND_Y + PX * 11, W, PX);

    // Scrolling dirt specks (parallax with ground)
    const offs = groundOffset;
    ctx.fillStyle = '#7e4a22';
    for (let i = 0; i < 22; i++) {
      const x = ((i * 137 + offs * 0.6) % (W + 60)) - 30;
      const y = GROUND_Y + PX * 5 + ((i * 11) % (PX * 8));
      ctx.fillRect(snap(x), snap(y), PX, PX);
    }
    ctx.fillStyle = '#c98a4b';
    for (let i = 0; i < 14; i++) {
      const x = ((i * 73 + offs * 0.6) % (W + 60)) - 30;
      const y = GROUND_Y + PX * 8 + ((i * 17) % (PX * 7));
      ctx.fillRect(snap(x), snap(y), PX, PX);
    }

    // Small pixel rocks scattered on grass
    for (let i = 0; i < 6; i++) {
      const x = ((i * 191 + offs * 0.6) % (W + 80)) - 40;
      const y = GROUND_Y + PX;
      ctx.fillStyle = '#888';
      ctx.fillRect(snap(x), snap(y), PX * 2, PX);
      ctx.fillStyle = '#bbb';
      ctx.fillRect(snap(x), snap(y), PX, PX);
    }
  }

  function drawObstacles() {
    for (const o of obstacles) {
      if (o.type === 'barrel') {
        // wooden barrel
        // BARREL — pixel-art wood
        const bx = snap(o.x), by = snap(o.y), bw = snap(o.w), bh = snap(o.h);
        ctx.fillStyle = '#a0541f';
        ctx.fillRect(bx, by, bw, bh);
        // Top + bottom hoop bands
        ctx.fillStyle = '#7a3f17';
        ctx.fillRect(bx, by + PX,         bw, PX);
        ctx.fillRect(bx, by + bh - PX*2,  bw, PX);
        // Highlight stripe (left side)
        ctx.fillStyle = '#cf7a39';
        ctx.fillRect(bx + PX, by + PX*3, PX, bh - PX*6);
        // Right shadow stripe
        ctx.fillStyle = '#7a3f17';
        ctx.fillRect(bx + bw - PX*2, by + PX*3, PX, bh - PX*6);
        // Drop shadow
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.fillRect(bx + PX, by + bh, bw - PX*2, PX);
      } else if (o.type === 'crate') {
        // CRATE — pixel-art wooden crate
        const bx = snap(o.x), by = snap(o.y), bw = snap(o.w), bh = snap(o.h);
        ctx.fillStyle = '#c98a4b';
        ctx.fillRect(bx, by, bw, bh);
        // Outer pixel border
        ctx.fillStyle = '#7e4a22';
        ctx.fillRect(bx, by, bw, PX);
        ctx.fillRect(bx, by + bh - PX, bw, PX);
        ctx.fillRect(bx, by, PX, bh);
        ctx.fillRect(bx + bw - PX, by, PX, bh);
        // Highlight on top-left
        ctx.fillStyle = '#e2a868';
        ctx.fillRect(bx + PX, by + PX, bw - PX*2, PX);
        ctx.fillRect(bx + PX, by + PX, PX, bh - PX*2);
        // Pixel "X" planks (stair-stepped)
        ctx.fillStyle = '#7e4a22';
        const steps = Math.floor((bh - PX*4) / PX);
        for (let i = 0; i < steps; i++) {
          const t = i / Math.max(1, steps - 1);
          const lx = bx + PX*2 + Math.round(t * (bw - PX*5));
          const rx = bx + bw - PX*3 - Math.round(t * (bw - PX*5));
          const yy = by + PX*2 + i * PX;
          ctx.fillRect(lx, yy, PX, PX);
          ctx.fillRect(rx, yy, PX, PX);
        }
        // Drop shadow
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.fillRect(bx + PX, by + bh, bw - PX*2, PX);
      } else if (o.type === 'pole') {
        // POLE — striped barricade pole
        const bx = snap(o.x), by = snap(o.y), bw = snap(o.w), bh = snap(o.h);
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(bx, by, bw, bh);
        // Red stripes
        ctx.fillStyle = '#d9342b';
        const stripeH = PX * 2;
        for (let s = 0; s < bh; s += stripeH * 2) {
          ctx.fillRect(bx, by + s, bw, stripeH);
        }
        // Highlight on left edge
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(bx, by, PX, bh);
        // Shadow on right edge
        ctx.fillStyle = '#888';
        ctx.fillRect(bx + bw - PX, by, PX, bh);
        // Pixel base
        ctx.fillStyle = '#666';
        ctx.fillRect(bx - PX*2, by + bh - PX*2, bw + PX*4, PX*2);
        ctx.fillStyle = '#999';
        ctx.fillRect(bx - PX*2, by + bh - PX*2, bw + PX*4, PX);
        // Drop shadow
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.fillRect(bx - PX*2, by + bh, bw + PX*4, PX);
      }
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

  function drawPlayer() {
    let img;
    if (player.onGround) {
      img = runImgs[player.runFrame];
    } else {
      img = jumpImgs[player.jumpFrameIdx] || jumpImgs[0];
    }
    if (!img) return;

    // Soft shadow
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    const shadowScale = player.onGround ? 1 : Math.max(0.4, 1 - (GROUND_Y - (player.y + player.h)) / 200);
    ctx.beginPath();
    ctx.ellipse(player.x + player.w / 2, GROUND_Y + 10, (player.w / 2) * shadowScale, 6 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.drawImage(img, player.x, player.y, player.w, player.h);
  }

  // ---------- LOOP ----------
  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- STATE TRANSITIONS ----------
  const menuEl        = document.getElementById('menu');
  const overEl        = document.getElementById('gameover');
  const hudEl         = document.getElementById('hud');
  const hudLogoEl     = document.getElementById('hudLogo');
  const bgmEl         = document.getElementById('bgm');
  const muteBtn       = document.getElementById('muteBtn');

  // ---------- MUSIC ----------
  let muted = false;
  bgmEl.volume = 0.45;

  function playMusic() {
    if (muted) return;
    // Some browsers reject autoplay if the audio context is suspended; tying
    // playMusic() to a user gesture (start/retry/click) makes this reliable.
    const p = bgmEl.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
  }
  function stopMusic() { bgmEl.pause(); }

  function setMuted(m) {
    muted = m;
    bgmEl.muted = m;
    muteBtn.textContent = m ? '🔇 SOUND OFF' : '🔊 SOUND ON';
    if (m) bgmEl.pause();
    else if (state === STATE.PLAY) playMusic();
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

  function startGame() {
    resetWorld();
    state = STATE.PLAY;
    menuEl.classList.add('hidden');
    overEl.classList.add('hidden');
    hudEl.classList.remove('hidden');
    hudLogoEl.classList.remove('hidden');
    audio();      // unlock SFX context on user gesture
    bgmEl.currentTime = 0;
    playMusic();  // start looping soundtrack
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
    const bonus = coinsCollected * COIN_VALUE;
    finalDistance.textContent = distanceScore();
    finalCoins.textContent    = coinsCollected;
    finalBonus.textContent    = bonus;
    finalScore.textContent    = score;
    endMsgEl.textContent      = endMessage();
    overEl.classList.remove('hidden');
    hudEl.classList.add('hidden');
    hudLogoEl.classList.add('hidden');
  }

  // ---------- BOOT ----------
  Promise.all([
    Promise.all(RUN_FRAMES.map(loadImage)).then(imgs => runImgs = imgs),
    Promise.all(JUMP_FRAMES.map(loadImage)).then(imgs => jumpImgs = imgs),
    loadImage(COIN_SRC).then(img => coinImg = img),
  ]).then(() => {
    resetWorld();
    requestAnimationFrame(loop);
  }).catch(err => {
    console.error(err);
    ctx.fillStyle = '#fff';
    ctx.font = '16px monospace';
    ctx.fillText('Asset load error: ' + err.message, 20, 40);
  });

})();
