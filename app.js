// ============================================================
//  OVERDRIVE — 2D Car Racing Game
//  Single-file, vanilla JS, no dependencies
// ============================================================

const canvas   = document.getElementById('gameCanvas');
const ctx      = canvas.getContext('2d');
const W = canvas.width;   // 420
const H = canvas.height;  // 600

// ---- UI refs ----
const startScreen   = document.getElementById('startScreen');
const gameOverScreen = document.getElementById('gameOverScreen');
const hud           = document.getElementById('hud');
const speedoBox     = document.getElementById('speedoBox');
const nitroBarEl    = document.getElementById('nitroBar');
const nitroFill     = document.getElementById('nitroFill');
const scoreDisplay  = document.getElementById('scoreDisplay');
const hiScoreDisplay = document.getElementById('hiScoreDisplay');
const finalScore    = document.getElementById('finalScore');
const finalHiScore  = document.getElementById('finalHiScore');
const pauseHint     = document.getElementById('pauseHint');

const speedoCanvas  = document.getElementById('speedoCanvas');
const speedoCtx     = speedoCanvas.getContext('2d');

// ---- Touch controls ----
const touchLeft  = document.getElementById('touchLeft');
const touchRight = document.getElementById('touchRight');
const touchNitro = document.getElementById('touchNitro');

// ============================================================
//  Constants
// ============================================================
const ROAD_LEFT  = 60;
const ROAD_RIGHT = W - 60;
const ROAD_W     = ROAD_RIGHT - ROAD_LEFT;  // 300
const LANE_COUNT = 3;
const LANE_W     = ROAD_W / LANE_COUNT;     // 100

const PLAYER_W   = 36;
const PLAYER_H   = 60;
const ENEMY_W    = 36;
const ENEMY_H    = 60;

const NITRO_MAX  = 100;
const NITRO_DRAIN = 40;   // per second when active
const NITRO_REFILL = 12;  // per second passive

// ============================================================
//  High Score (localStorage)
// ============================================================
let highScore = parseInt(localStorage.getItem('od_highscore') || '0');

// ============================================================
//  Audio — Web Audio API procedural sounds
// ============================================================
class AudioManager {
  constructor() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.35;
      this.masterGain.connect(this.ctx.destination);
      this.engineNode = null;
      this.engineGain = null;
    } catch(e) { this.ctx = null; }
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // Continuous engine rumble — oscillator-based
  startEngine() {
    if (!this.ctx || this.engineNode) return;
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 80;

    const dist = this.ctx.createWaveShaper();
    dist.curve = this._makeDistortionCurve(40);
    dist.oversample = '4x';

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.18;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;

    this.engineOsc.connect(dist);
    dist.connect(filter);
    filter.connect(this.engineGain);
    this.engineGain.connect(this.masterGain);
    this.engineOsc.start();
    this.engineNode = this.engineOsc;
    this.engineFilter = filter;
  }

  updateEngine(speed, nitroActive) {
    if (!this.engineOsc) return;
    const base = 70 + speed * 1.8;
    const target = nitroActive ? base * 1.6 : base;
    this.engineOsc.frequency.linearRampToValueAtTime(target, this.ctx.currentTime + 0.1);
    if (this.engineFilter) {
      this.engineFilter.frequency.linearRampToValueAtTime(
        nitroActive ? 1200 : 500 + speed * 4, this.ctx.currentTime + 0.1);
    }
  }

  stopEngine() {
    if (!this.engineNode) return;
    try { this.engineNode.stop(); } catch(e){}
    this.engineNode = null;
  }

  playCrash() {
    if (!this.ctx) return;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.7, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 0.5);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain);
    gain.connect(this.masterGain);
    src.start();
  }

  playNitroBoost() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(200, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(800, this.ctx.currentTime + 0.15);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
    osc.connect(g); g.connect(this.masterGain);
    osc.start(); osc.stop(this.ctx.currentTime + 0.3);
  }

  _makeDistortionCurve(amount) {
    const n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = (Math.PI + amount) * x / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }
}

// ============================================================
//  Car class — base for player & enemies
// ============================================================
class Car {
  constructor(x, y, w, h, color, accentColor) {
    this.x = x; this.y = y;
    this.w = w; this.h = h;
    this.color = color;
    this.accentColor = accentColor;
    this.vx = 0; this.vy = 0;
  }

  get left()   { return this.x - this.w / 2; }
  get right()  { return this.x + this.w / 2; }
  get top()    { return this.y - this.h / 2; }
  get bottom() { return this.y + this.h / 2; }

  collidesWith(other) {
    const margin = 4; // slight forgiveness
    return (
      this.left   + margin < other.right  - margin &&
      this.right  - margin > other.left   + margin &&
      this.top    + margin < other.bottom - margin &&
      this.bottom - margin > other.top    + margin
    );
  }

  // Draw a stylised car shape on ctx
  draw(ctx, flip = false) {
    ctx.save();
    ctx.translate(this.x, this.y);
    if (flip) ctx.scale(1, -1);

    const hw = this.w / 2, hh = this.h / 2;

    // Body shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-hw + 3, -hh + 3, this.w, this.h);

    // Main body
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.roundRect(-hw, -hh, this.w, this.h, [4, 4, 6, 6]);
    ctx.fill();

    // Hood / roof shape
    ctx.fillStyle = this.accentColor;
    ctx.beginPath();
    ctx.roundRect(-hw + 4, -hh + 8, this.w - 8, this.h * 0.45, 3);
    ctx.fill();

    // Windshield
    ctx.fillStyle = 'rgba(100,220,255,0.5)';
    ctx.beginPath();
    ctx.roundRect(-hw + 6, -hh + 10, this.w - 12, 14, 2);
    ctx.fill();

    // Headlights
    ctx.fillStyle = '#ffee88';
    ctx.shadowColor = '#ffee88';
    ctx.shadowBlur = 8;
    ctx.fillRect(-hw + 4,  -hh + 2, 8, 4);
    ctx.fillRect(hw - 12,  -hh + 2, 8, 4);
    ctx.shadowBlur = 0;

    // Tail lights
    ctx.fillStyle = '#ff2200';
    ctx.shadowColor = '#ff2200';
    ctx.shadowBlur = 6;
    ctx.fillRect(-hw + 4,  hh - 6, 8, 4);
    ctx.fillRect(hw - 12,  hh - 6, 8, 4);
    ctx.shadowBlur = 0;

    // Wheels
    ctx.fillStyle = '#111';
    ctx.fillRect(-hw - 4, -hh + 8,  6, 12);
    ctx.fillRect(hw - 2,  -hh + 8,  6, 12);
    ctx.fillRect(-hw - 4,  hh - 20, 6, 12);
    ctx.fillRect(hw - 2,   hh - 20, 6, 12);

    ctx.restore();
  }
}

// ============================================================
//  Player Car
// ============================================================
class PlayerCar extends Car {
  constructor() {
    super(W / 2, H - 100, PLAYER_W, PLAYER_H, '#cc2200', '#ff4400');
    this.speed    = 0;       // px/s road scroll speed
    this.maxSpeed = 320;
    this.accel    = 180;
    this.friction = 120;
    this.lateralSpeed = 0;
    this.maxLateral   = 240;
    this.lateralAccel = 600;
    this.nitro        = NITRO_MAX;
    this.nitroActive  = false;
    this.tilt = 0;           // visual lean
    this.exhaustTimer = 0;
    this.exhaustParticles = [];
    this.invincible = 0;     // brief invincibility frames after spawn (unused here)
    this.dead = false;
  }

  update(dt, keys) {
    // ---- Nitro ----
    const wantNitro = keys['ShiftLeft'] || keys['ShiftRight'] || keys['nitro'];
    if (wantNitro && this.nitro > 0 && !this.dead) {
      this.nitroActive = true;
      this.nitro = Math.max(0, this.nitro - NITRO_DRAIN * dt);
    } else {
      this.nitroActive = false;
      this.nitro = Math.min(NITRO_MAX, this.nitro + NITRO_REFILL * dt);
    }

    const topSpeed = this.nitroActive ? this.maxSpeed * 1.7 : this.maxSpeed;
    const brake = keys['Space'] || keys['ArrowDown'] || keys['KeyS'];

    // ---- Forward speed ----
    if (brake) {
      this.speed = Math.max(0, this.speed - this.accel * 2.5 * dt);
    } else {
      this.speed = Math.min(topSpeed, this.speed + this.accel * dt);
    }

    // ---- Lateral movement ----
    const left  = keys['ArrowLeft']  || keys['KeyA'] || keys['left'];
    const right = keys['ArrowRight'] || keys['KeyD'] || keys['right'];

    if (left)  this.lateralSpeed = Math.max(-this.maxLateral, this.lateralSpeed - this.lateralAccel * dt);
    else if (right) this.lateralSpeed = Math.min(this.maxLateral, this.lateralSpeed + this.lateralAccel * dt);
    else {
      // decelerate lateral
      const dec = this.lateralAccel * 1.2 * dt;
      if (Math.abs(this.lateralSpeed) < dec) this.lateralSpeed = 0;
      else this.lateralSpeed -= Math.sign(this.lateralSpeed) * dec;
    }

    this.x += this.lateralSpeed * dt;
    this.tilt = this.lateralSpeed / this.maxLateral * 10; // visual lean degrees

    // ---- Clamp to road ----
    this.x = Math.max(ROAD_LEFT + this.w/2, Math.min(ROAD_RIGHT - this.w/2, this.x));

    // ---- Exhaust particles ----
    this.exhaustTimer -= dt;
    if (this.exhaustTimer <= 0) {
      this.exhaustTimer = this.nitroActive ? 0.03 : 0.07;
      this.exhaustParticles.push({
        x: this.x - 6 + Math.random() * 12,
        y: this.y + this.h / 2,
        vx: (Math.random() - 0.5) * 30,
        vy: 60 + Math.random() * 40,
        life: 1, maxLife: 1,
        size: this.nitroActive ? 5 + Math.random() * 4 : 3 + Math.random() * 3,
        color: this.nitroActive ? '#00aaff' : '#888'
      });
    }
    this.exhaustParticles = this.exhaustParticles.filter(p => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * 2.5;
      return p.life > 0;
    });
  }

  draw(ctx) {
    // Exhaust particles
    for (const p of this.exhaustParticles) {
      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Nitro flame
    if (this.nitroActive) {
      ctx.save();
      ctx.globalAlpha = 0.7 + Math.random() * 0.3;
      const grad = ctx.createRadialGradient(
        this.x, this.y + this.h/2, 0,
        this.x, this.y + this.h/2 + 20, 20
      );
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.3, '#00ccff');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(this.x, this.y + this.h/2 + 10, 10, 20 + Math.random()*8, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }

    // Tilt effect
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.tilt * Math.PI / 180);
    ctx.translate(-this.x, -this.y);
    super.draw(ctx, false);
    ctx.restore();
  }
}

// ============================================================
//  Enemy Car
// ============================================================
const ENEMY_COLORS = [
  ['#1a6e2a','#2aaa44'],
  ['#1a2e8e','#2a4aff'],
  ['#6e1a6e','#cc44cc'],
  ['#8e6a10','#ddaa20'],
  ['#1a5e6e','#20aacc'],
];

class EnemyCar extends Car {
  constructor(speed) {
    const lane = Math.floor(Math.random() * LANE_COUNT);
    const cx = ROAD_LEFT + lane * LANE_W + LANE_W / 2;
    const [c1, c2] = ENEMY_COLORS[Math.floor(Math.random() * ENEMY_COLORS.length)];
    super(cx, -ENEMY_H, ENEMY_W, ENEMY_H, c1, c2);
    this.vy = speed;
    this.passed = false;
  }

  update(dt) {
    this.y += this.vy * dt;
  }

  draw(ctx) {
    super.draw(ctx, true);
  }
}

// ============================================================
//  Road Renderer
// ============================================================
class Road {
  constructor() {
    this.offset = 0;
    this.segH    = 60; // height of one dash segment
    this.segments = Math.ceil(H / this.segH) + 2;
  }

  update(dt, speed) {
    this.offset = (this.offset + speed * dt) % this.segH;
  }

  draw(ctx) {
    // Asphalt
    ctx.fillStyle = '#1a1a22';
    ctx.fillRect(ROAD_LEFT, 0, ROAD_W, H);

    // Road edges with glow
    ctx.strokeStyle = '#ff4400';
    ctx.shadowColor  = '#ff4400';
    ctx.shadowBlur   = 8;
    ctx.lineWidth    = 3;
    ctx.beginPath(); ctx.moveTo(ROAD_LEFT, 0); ctx.lineTo(ROAD_LEFT, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ROAD_RIGHT, 0); ctx.lineTo(ROAD_RIGHT, H); ctx.stroke();
    ctx.shadowBlur = 0;

    // Curb stripes (left)
    for (let i = 0; i < this.segments; i++) {
      const y = i * this.segH - this.offset;
      ctx.fillStyle = i % 2 === 0 ? '#cc2200' : '#ffffff';
      ctx.fillRect(ROAD_LEFT - 12, y, 12, this.segH);
      ctx.fillRect(ROAD_RIGHT, y, 12, this.segH);
    }

    // Lane dashes
    ctx.setLineDash([30, 30]);
    ctx.lineWidth = 2;
    for (let l = 1; l < LANE_COUNT; l++) {
      const lx = ROAD_LEFT + l * LANE_W;
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.moveTo(lx, -this.segH + this.offset);
      ctx.lineTo(lx, H + this.segH);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Scenery (side strips)
    ctx.fillStyle = '#0e0e16';
    ctx.fillRect(0, 0, ROAD_LEFT - 12, H);
    ctx.fillRect(ROAD_RIGHT + 12, 0, W - ROAD_RIGHT - 12, H);

    // Far background grid
    this._drawBgGrid(ctx);
  }

  _drawBgGrid(ctx) {
    // Left panel
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#ff4400';
    ctx.lineWidth = 1;
    const panels = [{x:0,w:ROAD_LEFT-12}, {x:ROAD_RIGHT+12, w:W-ROAD_RIGHT-12}];
    for (const p of panels) {
      for (let y = -this.segH + this.offset; y < H + this.segH; y += 40) {
        ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
      }
      for (let x = p.x; x <= p.x + p.w; x += 20) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// ============================================================
//  Particle Explosion (crash)
// ============================================================
class Explosion {
  constructor(x, y) {
    this.particles = [];
    for (let i = 0; i < 40; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 220;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1, decay: 1.5 + Math.random(),
        size: 2 + Math.random() * 5,
        color: ['#ff4400','#ff8800','#ffcc00','#ffffff'][Math.floor(Math.random()*4)]
      });
    }
    this.done = false;
  }

  update(dt) {
    let alive = 0;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 200 * dt; // gravity
      p.life -= p.decay * dt;
      if (p.life > 0) alive++;
    }
    if (alive === 0) this.done = true;
  }

  draw(ctx) {
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

// ============================================================
//  Speedometer
// ============================================================
function drawSpeedometer(ctx, speed, maxSpeed) {
  const cx = 40, cy = 40, r = 30;
  ctx.clearRect(0, 0, 80, 80);

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
  ctx.strokeStyle = 'rgba(255,68,0,0.2)';
  ctx.lineWidth = 5;
  ctx.stroke();

  // Speed arc
  const pct = speed / maxSpeed;
  const startAngle = Math.PI * 0.75;
  const endAngle   = startAngle + pct * Math.PI * 1.5;
  const g = ctx.createLinearGradient(cx-r, cy, cx+r, cy);
  g.addColorStop(0, '#ff4400');
  g.addColorStop(1, '#ffcc00');
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = g;
  ctx.lineWidth = 5;
  ctx.shadowColor = '#ff4400';
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Center text — km/h
  const kmh = Math.round(speed * 0.5);
  ctx.fillStyle = '#ff4400';
  ctx.font = 'bold 13px Orbitron,monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(kmh, cx, cy - 2);
  ctx.fillStyle = '#666';
  ctx.font = '6px Orbitron,monospace';
  ctx.fillText('KM/H', cx, cy + 9);
}

// ============================================================
//  GAME  (main controller)
// ============================================================
class Game {
  constructor() {
    this.state = 'start'; // start | playing | paused | dead
    this.road   = new Road();
    this.player = null;
    this.enemies = [];
    this.explosions = [];
    this.score  = 0;
    this.keys   = {};
    this.lastTime = 0;
    this.spawnTimer = 0;
    this.spawnInterval = 1.8;
    this.diffTimer = 0;
    this.baseEnemySpeed = 220;
    this.audio  = new AudioManager();
    this._bindEvents();
    requestAnimationFrame(ts => this._loop(ts));
  }

  // ---- Start / Restart ----
  start() {
    this.state   = 'playing';
    this.player  = new PlayerCar();
    this.enemies = [];
    this.explosions = [];
    this.score   = 0;
    this.spawnTimer = 0;
    this.spawnInterval = 1.8;
    this.diffTimer = 0;
    this.baseEnemySpeed = 220;
    this.lastTime = performance.now();

    startScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
    hud.classList.remove('hidden');
    speedoBox.classList.remove('hidden');
    nitroBarEl.classList.remove('hidden');

    this.audio.resume();
    this.audio.startEngine();
  }

  end() {
    this.state = 'dead';
    this.audio.stopEngine();
    this.audio.playCrash();

    // Explosion
    this.explosions.push(new Explosion(this.player.x, this.player.y));

    // Update high score
    if (this.score > highScore) {
      highScore = this.score;
      localStorage.setItem('od_highscore', highScore);
    }

    setTimeout(() => {
      hud.classList.add('hidden');
      speedoBox.classList.add('hidden');
      nitroBarEl.classList.add('hidden');
      finalScore.textContent = Math.floor(this.score);
      finalHiScore.textContent = highScore;
      gameOverScreen.classList.remove('hidden');
    }, 900);
  }

  togglePause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      pauseHint.style.display = 'block';
      this.audio.stopEngine();
    } else if (this.state === 'paused') {
      this.state = 'playing';
      pauseHint.style.display = 'none';
      this.lastTime = performance.now();
      this.audio.startEngine();
    }
  }

  // ---- Main loop ----
  _loop(ts) {
    const dt = Math.min((ts - this.lastTime) / 1000, 0.05); // cap dt at 50ms
    this.lastTime = ts;

    if (this.state === 'playing') this._update(dt);
    this._render();
    requestAnimationFrame(t => this._loop(t));
  }

  _update(dt) {
    const player = this.player;

    // Player
    player.update(dt, this.keys);

    // Road
    this.road.update(dt, player.speed);

    // Score
    this.score += player.speed * dt * 0.05;
    scoreDisplay.textContent  = Math.floor(this.score);
    hiScoreDisplay.textContent = Math.max(highScore, Math.floor(this.score));

    // Difficulty ramp
    this.diffTimer += dt;
    if (this.diffTimer > 8) {
      this.diffTimer = 0;
      this.spawnInterval = Math.max(0.7, this.spawnInterval - 0.08);
      this.baseEnemySpeed = Math.min(500, this.baseEnemySpeed + 12);
    }

    // Enemy spawn
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = this.spawnInterval + (Math.random() - 0.5) * 0.4;
      this.enemies.push(new EnemyCar(this.baseEnemySpeed + player.speed * 0.3));
    }

    // Update enemies
    for (const e of this.enemies) {
      e.vy = this.baseEnemySpeed + player.speed * 0.3;
      e.update(dt);
    }

    // Collision check
    if (this.state === 'playing') {
      for (const e of this.enemies) {
        if (!e.passed && player.collidesWith(e)) {
          this.end();
          return;
        }
      }
    }

    // Remove off-screen enemies
    this.enemies = this.enemies.filter(e => e.y < H + 100);

    // Explosions
    for (const ex of this.explosions) ex.update(dt);
    this.explosions = this.explosions.filter(ex => !ex.done);

    // Audio engine update
    this.audio.updateEngine(player.speed, player.nitroActive);

    // Nitro UI
    nitroFill.style.width = (player.nitro / NITRO_MAX * 100) + '%';

    // Speedometer
    drawSpeedometer(speedoCtx, player.speed, player.maxSpeed * 1.7);
  }

  _render() {
    // Clear
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, W, H);

    this.road.draw(ctx);

    if (this.player && this.state !== 'start') {
      for (const e of this.enemies) e.draw(ctx);

      if (this.state !== 'dead') this.player.draw(ctx);

      for (const ex of this.explosions) ex.draw(ctx);
    }

    // Speed lines when nitro
    if (this.player && this.player.nitroActive && this.state === 'playing') {
      this._drawSpeedLines();
    }

    // Scanline overlay for CRT feel
    ctx.save();
    ctx.globalAlpha = 0.04;
    ctx.fillStyle = '#000';
    for (let y = 0; y < H; y += 3) {
      ctx.fillRect(0, y, W, 1);
    }
    ctx.restore();
  }

  _drawSpeedLines() {
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = '#00aaff';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      const x = ROAD_LEFT + Math.random() * ROAD_W;
      const len = 30 + Math.random() * 80;
      const y = Math.random() * H;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- Events ----
  _bindEvents() {
    document.getElementById('startBtn').addEventListener('click', () => this.start());
    document.getElementById('restartBtn').addEventListener('click', () => this.start());

    document.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (e.code === 'KeyP') this.togglePause();
      // prevent page scroll
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    });
    document.addEventListener('keyup', e => { this.keys[e.code] = false; });

    // Touch controls
    const hold = (key, el) => {
      el.addEventListener('pointerdown', e => { e.preventDefault(); this.keys[key] = true; });
      el.addEventListener('pointerup',   () => { this.keys[key] = false; });
      el.addEventListener('pointerleave',() => { this.keys[key] = false; });
    };
    hold('left',  touchLeft);
    hold('right', touchRight);
    hold('nitro', touchNitro);

    // Swipe on canvas
    let swipeStartX = null;
    canvas.addEventListener('touchstart', e => { swipeStartX = e.touches[0].clientX; }, {passive:true});
    canvas.addEventListener('touchend', e => {
      if (swipeStartX === null) return;
      const dx = e.changedTouches[0].clientX - swipeStartX;
      if (Math.abs(dx) > 30 && this.player) {
        this.player.lateralSpeed = Math.sign(dx) * this.player.maxLateral;
      }
      swipeStartX = null;
    }, {passive:true});
  }
}

// ============================================================
//  Bootstrap
// ============================================================
const game = new Game();