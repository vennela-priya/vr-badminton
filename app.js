import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ============================================================
//  CONSTANTS
// ============================================================
const COURT = { halfLen: 6.7, halfWidth: 3.05, netY: 1.55, netHalfH: 0.38 };
const GRAVITY = -9.8;
const DRAG = 0.18;
const MAX_TRAIL = 30;
const WIN_SCORE = 7;
const STATE = { BOOT: 0, READY: 1, SERVING: 2, RALLY: 3, POINT: 4, OVER: 5 };

// ============================================================
//  DOM
// ============================================================
const statusEl = document.getElementById('status');

// ============================================================
//  SCENE / RENDERER / CAMERA
// ============================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101826);
scene.fog = new THREE.Fog(0x101826, 18, 40);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.position = 'fixed';
renderer.domElement.style.inset = '0';

const clock = new THREE.Clock();

// Player rig
const player = new THREE.Group();
player.add(camera);
scene.add(player);
player.position.set(0, 0, COURT.halfLen - 1.4);

// ============================================================
//  GAME STATE
// ============================================================
let gameState = STATE.BOOT;
let scorePlayer = 0, scoreAI = 0;
let pointTimer = 0;
let lastHitter = null;

// ============================================================
//  SHUTTLE PHYSICS
// ============================================================
const shuttle_v = new THREE.Vector3();
let shuttleActive = false;
const trailPoints = [];

// ============================================================
//  RACKET TRACKING
// ============================================================
let ghostRacket = null;
let racketHolder = null;
let racketScanned = false;
const racketPrev = new THREE.Vector3();
const racketVel = new THREE.Vector3();
const racketHeadWorld = new THREE.Vector3();
const racketNormalWorld = new THREE.Vector3();

// ============================================================
//  XR INPUT ARRAYS
// ============================================================
const hands = [];
const controllers = [];
const grips = [];

// ============================================================
//  SCENE OBJECTS (populated by build* functions)
// ============================================================
let shuttle, shuttleTrail, opponent, readyButton, net;
let scoreBoard, msgBoard;
let audienceMesh;

// ============================================================
//  AI STATE
// ============================================================
const oppState = {
  pos: new THREE.Vector3(0, 0, -(COURT.halfLen - 1.6)),
  target: new THREE.Vector3(0, 0, -(COURT.halfLen - 1.6)),
  swingT: -1,
  anim: 'idle',
  willReturn: true
};

// ============================================================
//  AUDIO
// ============================================================
let audio = null;

// ============================================================
//  REUSABLE TEMPS
// ============================================================
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

// ============================================================
//  LIGHTING
// ============================================================
function buildLighting() {
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a4055, 0.75));

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 9, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1; key.shadow.camera.far = 30;
  const s = 9;
  key.shadow.camera.left = -s; key.shadow.camera.right = s;
  key.shadow.camera.top = s; key.shadow.camera.bottom = -s;
  key.shadow.bias = -0.0004;
  scene.add(key);

  scene.add(new THREE.DirectionalLight(0x88aaff, 0.4)).position.set(-5, 6, -4);

  for (let i = -1; i <= 1; i += 2) {
    const spot = new THREE.SpotLight(0xffffff, 0.6, 30, Math.PI / 5, 0.5, 1.2);
    spot.position.set(i * 4, 8, 0);
    spot.target.position.set(i * 2, 0, 0);
    scene.add(spot); scene.add(spot.target);
  }
}

// ============================================================
//  COURT
// ============================================================
function buildCourt() {
  const W = 512, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1d6b3a'; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < H; i += 18) {
    ctx.fillStyle = (i / 18) % 2 ? '#1f7340' : '#1c6739';
    ctx.fillRect(0, i, W, 18);
  }
  ctx.strokeStyle = '#f4f7ff'; ctx.lineWidth = 6;
  const pad = 40;
  ctx.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
  ctx.beginPath();
  ctx.moveTo(pad + 34, pad); ctx.lineTo(pad + 34, H - pad);
  ctx.moveTo(W - pad - 34, pad); ctx.lineTo(W - pad - 34, H - pad);
  ctx.stroke();
  ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(pad, H / 2); ctx.lineTo(W - pad, H / 2); ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(pad, H / 2 - 120); ctx.lineTo(W - pad, H / 2 - 120);
  ctx.moveTo(pad, H / 2 + 120); ctx.lineTo(W - pad, H / 2 + 120);
  ctx.moveTo(W / 2, pad); ctx.lineTo(W / 2, H / 2 - 120);
  ctx.moveTo(W / 2, H / 2 + 120); ctx.lineTo(W / 2, H - pad);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.halfWidth * 2 + 1.5, COURT.halfLen * 2 + 1.5),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const arena = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x0d1320, roughness: 1 })
  );
  arena.rotation.x = -Math.PI / 2;
  arena.position.y = -0.01;
  arena.receiveShadow = true;
  scene.add(arena);
}

// ============================================================
//  NET
// ============================================================
function buildNet() {
  net = new THREE.Group();
  const postGeo = new THREE.CylinderGeometry(0.04, 0.05, COURT.netY, 12);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x222831, metalness: 0.6, roughness: 0.4 });
  for (let s = -1; s <= 1; s += 2) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(s * (COURT.halfWidth + 0.2), COURT.netY / 2, 0);
    post.castShadow = true;
    net.add(post);
  }
  const netCv = document.createElement('canvas');
  netCv.width = 256; netCv.height = 64;
  const nctx = netCv.getContext('2d');
  nctx.clearRect(0, 0, 256, 64);
  nctx.strokeStyle = 'rgba(255,255,255,0.55)'; nctx.lineWidth = 1;
  for (let x = 0; x <= 256; x += 8) { nctx.beginPath(); nctx.moveTo(x, 0); nctx.lineTo(x, 64); nctx.stroke(); }
  for (let y = 0; y <= 64; y += 8) { nctx.beginPath(); nctx.moveTo(0, y); nctx.lineTo(256, y); nctx.stroke(); }
  nctx.fillStyle = '#ffffff'; nctx.fillRect(0, 0, 256, 7);
  const netTex = new THREE.CanvasTexture(netCv);
  const netMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.halfWidth * 2 + 0.4, COURT.netHalfH * 2),
    new THREE.MeshStandardMaterial({ map: netTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
  );
  netMesh.position.set(0, COURT.netY - COURT.netHalfH, 0);
  net.add(netMesh);
  scene.add(net);
}

// ============================================================
//  AUDIENCE
// ============================================================
function buildAudience() {
  const count = 240;
  const geo = new THREE.BoxGeometry(0.4, 0.7, 0.35);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  audienceMesh = new THREE.InstancedMesh(geo, mat, count);
  audienceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.Color();
  const dummy = new THREE.Object3D();
  let i = 0;
  const rows = 4;
  audienceMesh.userData.base = [];

  function place(x, z, ry) {
    if (i >= count) return;
    dummy.position.set(x, 0.9, z);
    dummy.rotation.y = ry;
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    audienceMesh.setMatrixAt(i, dummy.matrix);
    color.setHSL(Math.random(), 0.55, 0.45 + Math.random() * 0.2);
    audienceMesh.setColorAt(i, color);
    audienceMesh.userData.base.push({ x, z, ry, phase: Math.random() * Math.PI * 2, y: 0.9 });
    i++;
  }

  function placeTier(x, z, ry, yOff) {
    const idxBefore = audienceMesh.userData.base.length;
    place(x, z, ry);
    const b = audienceMesh.userData.base[idxBefore];
    if (b) b.y = 0.9 + yOff;
  }

  for (let r = 0; r < rows; r++) {
    const off = COURT.halfLen + 2.2 + r * 0.9;
    const yOff = r * 0.55;
    for (let x = -5; x <= 5; x += 0.9) {
      placeTier(x, off, Math.PI, yOff);
      placeTier(x, -off, 0, yOff);
    }
  }
  audienceMesh.castShadow = false;
  scene.add(audienceMesh);
}

function animateAudience(t) {
  if (!audienceMesh) return;
  const base = audienceMesh.userData.base;
  const dummy = new THREE.Object3D();
  const excite = gameState === STATE.POINT ? 1.0 : 0.18;
  for (let i = 0; i < base.length; i++) {
    const b = base[i];
    const bob = Math.sin(t * 4 + b.phase) * 0.06 * excite;
    dummy.position.set(b.x, b.y + bob, b.z);
    dummy.rotation.set(0, b.ry, 0);
    dummy.updateMatrix();
    audienceMesh.setMatrixAt(i, dummy.matrix);
  }
  audienceMesh.instanceMatrix.needsUpdate = true;
}

// ============================================================
//  RACKET BUILDER
// ============================================================
function makeRacket({ ghost = false } = {}) {
  const g = new THREE.Group();
  const frameMat = ghost
    ? new THREE.MeshStandardMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.55, emissive: 0x0088aa, emissiveIntensity: 0.6, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: 0xd11a2a, metalness: 0.3, roughness: 0.5 });

  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.18, 12),
    ghost ? frameMat : new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 }));
  handle.position.y = 0.09;
  handle.castShadow = !ghost;
  g.add(handle);

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.18, 10), frameMat);
  shaft.position.y = 0.27;
  shaft.castShadow = !ghost;
  g.add(shaft);

  const head = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.01, 10, 36), frameMat);
  head.position.y = 0.46;
  head.scale.set(1, 1.18, 1);
  head.castShadow = !ghost;
  g.add(head);

  const stringMat = new THREE.MeshBasicMaterial({
    color: ghost ? 0x9ff7ff : 0xffffff,
    transparent: true, opacity: ghost ? 0.32 : 0.5, side: THREE.DoubleSide
  });
  const bed = new THREE.Mesh(new THREE.CircleGeometry(0.1, 24), stringMat);
  bed.position.y = 0.46;
  bed.scale.set(1, 1.18, 1);
  g.add(bed);

  const lineMat = new THREE.LineBasicMaterial({ color: ghost ? 0xbffbff : 0xdddddd, transparent: true, opacity: 0.6 });
  const pts = [];
  const rx = 0.095, ry = 0.112;
  for (let i = -4; i <= 4; i++) {
    const x = (i / 4) * rx;
    const yext = ry * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2));
    pts.push(new THREE.Vector3(x, 0.46 - yext, 0.001), new THREE.Vector3(x, 0.46 + yext, 0.001));
  }
  for (let j = -4; j <= 4; j++) {
    const y = (j / 4) * ry;
    const xext = rx * Math.sqrt(Math.max(0, 1 - (y / ry) ** 2));
    pts.push(new THREE.Vector3(-xext, 0.46 + y, 0.001), new THREE.Vector3(xext, 0.46 + y, 0.001));
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat));

  g.userData.headLocal = new THREE.Vector3(0, 0.46, 0);
  g.userData.headRadius = 0.13;
  return g;
}

// ============================================================
//  OPPONENT
// ============================================================
function buildOpponent() {
  opponent = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0a878, roughness: 0.7 });
  const shirt = makeFabricMat(0x2244cc);
  const shorts = makeFabricMat(0xffffff);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.34, 6, 12), shirt);
  torso.position.y = 1.15; torso.castShadow = true; opponent.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 16), skin);
  head.position.y = 1.5; head.castShadow = true; opponent.add(head);

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 16, 0, Math.PI * 2, 0, Math.PI * 0.6),
    new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 1 }));
  hair.position.y = 1.52; opponent.add(hair);

  const legGeo = new THREE.CapsuleGeometry(0.07, 0.45, 4, 8);
  const lLeg = new THREE.Mesh(legGeo, shorts); lLeg.position.set(-0.09, 0.55, 0); lLeg.castShadow = true; opponent.add(lLeg);
  const rLeg = new THREE.Mesh(legGeo, shorts); rLeg.position.set(0.09, 0.55, 0); rLeg.castShadow = true; opponent.add(rLeg);
  opponent.userData.lLeg = lLeg; opponent.userData.rLeg = rLeg;

  const armGeo = new THREE.CapsuleGeometry(0.05, 0.34, 4, 8);
  const lArm = new THREE.Mesh(armGeo, skin); lArm.position.set(-0.24, 1.2, 0); lArm.rotation.z = 0.4; lArm.castShadow = true; opponent.add(lArm);
  opponent.userData.lArm = lArm;

  const armPivot = new THREE.Group();
  armPivot.position.set(0.22, 1.32, 0);
  const rArm = new THREE.Mesh(armGeo, skin);
  rArm.position.set(0, -0.17, 0); rArm.castShadow = true;
  armPivot.add(rArm);
  const oppRacket = makeRacket({ ghost: false });
  oppRacket.position.set(0, -0.34, 0);
  oppRacket.rotation.x = -0.3;
  armPivot.add(oppRacket);
  opponent.add(armPivot);
  opponent.userData.armPivot = armPivot;
  opponent.userData.racket = oppRacket;

  opponent.position.copy(oppState.pos);
  opponent.rotation.y = Math.PI;
  scene.add(opponent);
}

function makeFabricMat(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
}

function animateOpponent(dt, t) {
  if (!opponent) return;
  const ud = opponent.userData;
  oppState.pos.x += (oppState.target.x - oppState.pos.x) * Math.min(1, dt * 4);
  oppState.pos.z += (oppState.target.z - oppState.pos.z) * Math.min(1, dt * 4);
  opponent.position.x = oppState.pos.x;
  opponent.position.z = oppState.pos.z;

  const idleBob = Math.sin(t * 2) * 0.02;
  opponent.position.y = idleBob;
  const sway = Math.sin(t * 1.3) * 0.05;
  ud.lLeg.rotation.x = Math.sin(t * 2) * 0.05;
  ud.rLeg.rotation.x = -Math.sin(t * 2) * 0.05;
  ud.lArm.rotation.z = 0.4 + Math.sin(t * 2) * 0.05;

  if (oppState.swingT >= 0) {
    oppState.swingT += dt;
    const p = oppState.swingT / 0.45;
    if (p < 1) {
      const ease = p < 0.4 ? -(p / 0.4) * 1.6 : (((p - 0.4) / 0.6) * 2.4 - 1.6);
      ud.armPivot.rotation.x = ease;
      ud.armPivot.rotation.z = sway * 0.5 - 0.2;
    } else {
      oppState.swingT = -1;
      ud.armPivot.rotation.x = 0;
      oppState.anim = 'idle';
    }
  } else {
    ud.armPivot.rotation.x += (-0.5 - ud.armPivot.rotation.x) * Math.min(1, dt * 5);
    ud.armPivot.rotation.z = sway * 0.5;
  }
}

// ============================================================
//  SHUTTLECOCK
// ============================================================
function buildShuttle() {
  shuttle = new THREE.Group();
  const cork = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 }));
  cork.castShadow = true;
  shuttle.add(cork);

  const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.06, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
  skirt.position.y = 0.04;
  shuttle.add(skirt);

  const fMat = new THREE.LineBasicMaterial({ color: 0xcfd6e0 });
  const fpts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    fpts.push(new THREE.Vector3(0, 0.012, 0), new THREE.Vector3(Math.cos(a) * 0.032, 0.07, Math.sin(a) * 0.032));
  }
  shuttle.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(fpts), fMat));

  shuttle.userData.corkRadius = 0.022;
  shuttle.visible = false;
  scene.add(shuttle);

  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3));
  shuttleTrail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xfff2a0, transparent: true, opacity: 0.6 }));
  shuttleTrail.frustumCulled = false;
  shuttleTrail.visible = false;
  scene.add(shuttleTrail);
}

// ============================================================
//  READY BUTTON
// ============================================================
function buildReadyButton() {
  readyButton = new THREE.Group();
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const ctx = cv.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 512, 256);
  grad.addColorStop(0, '#00d4ff'); grad.addColorStop(1, '#0066ff');
  roundRect(ctx, 6, 6, 500, 244, 40); ctx.fillStyle = grad; ctx.fill();
  ctx.lineWidth = 8; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 58px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('READY', 256, 96);
  ctx.fillText('FOR THE SHOT', 256, 162);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;

  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.35, 0.04),
    [
      new THREE.MeshStandardMaterial({ color: 0x004488 }),
      new THREE.MeshStandardMaterial({ color: 0x004488 }),
      new THREE.MeshStandardMaterial({ color: 0x004488 }),
      new THREE.MeshStandardMaterial({ color: 0x004488 }),
      new THREE.MeshStandardMaterial({ map: tex, emissive: 0x113355, emissiveIntensity: 0.4 }),
      new THREE.MeshStandardMaterial({ map: tex, emissive: 0x113355, emissiveIntensity: 0.4 }),
    ]
  );
  panel.castShadow = true;
  readyButton.add(panel);
  readyButton.userData.panel = panel;
  readyButton.userData.vy = 0;
  readyButton.userData.settled = false;
  readyButton.userData.restY = 1.15;
  readyButton.visible = false;
  scene.add(readyButton);
}

function placeReadyButtonInFront() {
  camera.getWorldDirection(_v1);
  _v1.y = 0; _v1.normalize();
  camera.getWorldPosition(_v2);
  const target = _v2.clone().add(_v1.multiplyScalar(1.1));
  readyButton.position.set(target.x, _v2.y + 1.2, target.z);
  readyButton.userData.restY = _v2.y - 0.15;
  readyButton.userData.vy = 0;
  readyButton.userData.settled = false;
  readyButton.lookAt(_v2.x, readyButton.userData.restY, _v2.z);
  readyButton.visible = true;
}

function updateReadyButton(dt) {
  if (!readyButton.visible || readyButton.userData.settled) {
    if (readyButton.visible) {
      readyButton.position.y = readyButton.userData.restY + Math.sin(clock.elapsedTime * 2) * 0.015;
    }
    return;
  }
  const ud = readyButton.userData;
  ud.vy += GRAVITY * dt;
  readyButton.position.y += ud.vy * dt;
  if (readyButton.position.y <= ud.restY) {
    readyButton.position.y = ud.restY;
    if (Math.abs(ud.vy) > 0.6) {
      ud.vy = -ud.vy * 0.45;
      playSound('ground', 0.3);
    } else {
      ud.vy = 0; ud.settled = true;
    }
  }
}

// ============================================================
//  SCOREBOARD
// ============================================================
function buildScoreboard() {
  scoreBoard = makeTextPanel(1.6, 0.5);
  scoreBoard.position.set(0, 3.0, -1.0);
  scoreBoard.rotation.y = 0;
  scene.add(scoreBoard);
  updateScoreboard();

  msgBoard = makeTextPanel(2.2, 0.7);
  msgBoard.position.set(0, 2.0, -1.0);
  msgBoard.visible = false;
  scene.add(msgBoard);
}

function makeTextPanel(w, h) {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = Math.round(1024 * h / w);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
  mesh.userData = { cv, ctx: cv.getContext('2d'), tex };
  return mesh;
}

function drawPanel(panel, lines, opts = {}) {
  const { ctx, cv, tex } = panel.userData;
  ctx.clearRect(0, 0, cv.width, cv.height);
  roundRect(ctx, 0, 0, cv.width, cv.height, 30);
  ctx.fillStyle = opts.bg || 'rgba(8,14,30,0.82)'; ctx.fill();
  ctx.lineWidth = 6; ctx.strokeStyle = opts.border || '#00d4ff'; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const n = lines.length;
  lines.forEach((ln, i) => {
    ctx.fillStyle = ln.color || '#ffffff';
    ctx.font = `bold ${ln.size || 80}px sans-serif`;
    ctx.fillText(ln.text, cv.width / 2, cv.height * (i + 1) / (n + 1));
  });
  tex.needsUpdate = true;
}

function updateScoreboard() {
  drawPanel(scoreBoard, [
    { text: 'YOU  ' + scorePlayer + '   —   ' + scoreAI + '  AI', size: 90,
      color: scorePlayer >= scoreAI ? '#7CFC9A' : '#FF9B9B' }
  ]);
}

function showMessage(lines, bg) { drawPanel(msgBoard, lines, { bg }); msgBoard.visible = true; }
function hideMessage() { msgBoard.visible = false; }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============================================================
//  XR INPUTS
// ============================================================
const controllerModelFactory = new XRControllerModelFactory();

function setupXRInputs() {
  racketHolder = new THREE.Group();
  scene.add(racketHolder);
  ghostRacket = makeRacket({ ghost: true });
  ghostRacket.visible = false;
  racketHolder.add(ghostRacket);

  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    ctrl.userData.index = i;
    ctrl.addEventListener('selectstart', onSelectStart);
    ctrl.addEventListener('connected', (e) => { ctrl.userData.handedness = e.data.handedness; ctrl.userData.gamepad = e.data.gamepad; });
    player.add(ctrl);
    controllers.push(ctrl);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(controllerModelFactory.createControllerModel(grip));
    player.add(grip);
    grips.push(grip);

    const hand = renderer.xr.getHand(i);
    hand.userData.index = i;
    hand.addEventListener('pinchstart', onSelectStart);
    player.add(hand);
    hands.push(hand);
  }
}

function onSessionStart() {
  document.getElementById('overlay').style.display = 'none';
  if (!audio) audio = new AudioEngine();
  audio.resume(); audio.startAmbience();
  gameState = STATE.BOOT;
  scorePlayer = 0; scoreAI = 0; updateScoreboard(); hideMessage();
  setTimeout(() => {
    placeReadyButtonInFront();
    gameState = STATE.READY;
    racketScanned = false;
    ghostRacket.visible = false;
  }, 400);
}

function onSessionEnd() {
  document.getElementById('overlay').style.display = 'flex';
  if (audio) audio.stopAmbience();
}

function onSelectStart(event) {
  if (gameState === STATE.READY) {
    const src = event.target;
    let hit = false;
    if (controllers.includes(src)) {
      _m.identity().extractRotation(src.matrixWorld);
      const origin = new THREE.Vector3().setFromMatrixPosition(src.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(_m).normalize();
      hit = new THREE.Raycaster(origin, dir, 0, 5).intersectObject(readyButton.userData.panel, true).length > 0;
    } else {
      const tip = getJointWorld(src, 'index-finger-tip', _v1);
      if (tip) hit = tip.distanceTo(readyButton.position) < 0.45;
    }
    if (hit || readyButton.userData.settled) startMatch();
  } else if (gameState === STATE.OVER) {
    resetMatch();
  } else if (gameState === STATE.SERVING) {
    serve();
  }
}

function startMatch() {
  if (gameState !== STATE.READY) return;
  playSound('point', 0.4);
  readyButton.visible = false;
  racketScanned = true;
  ghostRacket.visible = true;
  gameState = STATE.SERVING;
  showMessage([{ text: 'Racket ready ✓', size: 64, color: '#7CFC9A' },
               { text: 'Swing to serve', size: 52, color: '#cfe0ff' }]);
  setTimeout(() => { if (gameState === STATE.SERVING) serve(); }, 1800);
}

// ============================================================
//  GHOST RACKET TRACKING
// ============================================================
function getJointWorld(hand, name, out) {
  const joints = hand.joints;
  if (!joints) return null;
  const j = joints[name];
  if (!j || j.position === undefined) return null;
  j.getWorldPosition(out);
  return out;
}

function updateGhostRacket(dt) {
  if (!ghostRacket.visible) return;
  let placed = false;

  for (const hand of hands) {
    const j = hand.joints;
    if (!j || !j['wrist'] || j['wrist'].position === undefined) continue;
    const wrist = j['wrist'];
    if (!wrist.visible && wrist.position.lengthSq() === 0) continue;

    const wristPos = wrist.getWorldPosition(_v1);
    const ref = j['middle-finger-metacarpal'] || j['middle-finger-phalanx-proximal'] || j['index-finger-metacarpal'];
    if (!ref) continue;
    const refPos = ref.getWorldPosition(_v2);
    const fwd = refPos.clone().sub(wristPos).normalize();

    wrist.getWorldQuaternion(_q);
    const palmNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(_q).normalize();
    const yAxis = fwd;
    let zAxis = palmNormal.clone();
    const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
    zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    _m.makeBasis(xAxis, yAxis, zAxis);

    racketHolder.position.copy(wristPos);
    racketHolder.quaternion.setFromRotationMatrix(_m);
    placed = true;
    break;
  }

  if (!placed) {
    for (const grip of grips) {
      if (grip.visible && (grip.position.lengthSq() > 0 || grip.quaternion.w !== 1)) {
        grip.getWorldPosition(racketHolder.position);
        grip.getWorldQuaternion(racketHolder.quaternion);
        racketHolder.rotateX(-Math.PI / 3);
        placed = true;
        break;
      }
    }
  }

  racketHolder.visible = placed;

  if (placed) {
    racketHolder.updateMatrixWorld();
    racketHeadWorld.copy(ghostRacket.userData.headLocal).applyMatrix4(racketHolder.matrixWorld);
    racketNormalWorld.set(0, 0, 1).applyQuaternion(racketHolder.quaternion).normalize();
    if (dt > 0) racketVel.copy(racketHeadWorld).sub(racketPrev).divideScalar(dt);
    racketPrev.copy(racketHeadWorld);
  } else {
    racketVel.set(0, 0, 0);
  }
}

// ============================================================
//  SERVE / AI HIT
// ============================================================
function serve() {
  if (gameState !== STATE.SERVING) return;
  hideMessage();
  camera.getWorldPosition(_v1);
  camera.getWorldDirection(_v2); _v2.y = 0; _v2.normalize();
  shuttle.position.set(_v1.x + _v2.x * 0.5, _v1.y - 0.2, _v1.z + _v2.z * 0.5);
  shuttle_v.set(_v2.x * 0.3, 2.6, _v2.z * 0.3);
  shuttleActive = true;
  shuttle.visible = true;
  shuttleTrail.visible = true;
  trailPoints.length = 0;
  lastHitter = 'serve';
  gameState = STATE.RALLY;
}

function aiHit() {
  oppState.swingT = 0; oppState.anim = 'swing';
  playSound('hit', 0.5);
  const targetX = (Math.random() - 0.5) * (COURT.halfWidth * 1.4);
  const targetZ = COURT.halfLen - (1 + Math.random() * 3.5);
  const from = opponent.position.clone(); from.y = 1.4;
  launchTo(from, new THREE.Vector3(targetX, 0.1, targetZ), 1.1 + Math.random() * 0.5);
  lastHitter = 'ai';
}

function launchTo(from, to, arcFactor) {
  shuttle.position.copy(from);
  const disp = to.clone().sub(from);
  const horiz = new THREE.Vector3(disp.x, 0, disp.z);
  const dist = horiz.length();
  const flightTime = THREE.MathUtils.clamp(dist / 7, 0.5, 1.3) * arcFactor;
  shuttle_v.set(disp.x / flightTime, (to.y - from.y) / flightTime - 0.5 * GRAVITY * flightTime, disp.z / flightTime);
  shuttleActive = true;
  shuttle.visible = true;
  shuttleTrail.visible = true;
}

// ============================================================
//  SHUTTLE PHYSICS
// ============================================================
function updateShuttle(dt) {
  if (!shuttleActive) return;
  const speed = shuttle_v.length();
  shuttle_v.addScaledVector(_v3.copy(shuttle_v).multiplyScalar(-DRAG * speed), dt);
  shuttle_v.y += GRAVITY * dt;
  shuttle.position.addScaledVector(shuttle_v, dt);

  if (speed > 0.2) {
    _q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), _v1.copy(shuttle_v).normalize());
    shuttle.quaternion.slerp(_q, Math.min(1, dt * 12));
  }

  trailPoints.push(shuttle.position.clone());
  if (trailPoints.length > MAX_TRAIL) trailPoints.shift();
  updateTrail();

  // Racket collision
  if (ghostRacket.visible && racketHolder.visible) {
    const toShuttle = _v1.copy(shuttle.position).sub(racketHeadWorld);
    const distToPlane = toShuttle.dot(racketNormalWorld);
    const inPlaneDist = _v2.copy(toShuttle).addScaledVector(racketNormalWorld, -distToPlane).length();
    if (Math.abs(distToPlane) < 0.12 && inPlaneDist < ghostRacket.userData.headRadius && lastHitter !== 'player') {
      playerHit();
    }
  }

  // Net collision
  if (Math.abs(shuttle.position.z) < 0.08) {
    if (shuttle.position.y < COURT.netY && shuttle.position.y > COURT.netY - COURT.netHalfH * 2 - 0.1
        && Math.abs(shuttle.position.x) < COURT.halfWidth + 0.2) {
      shuttle_v.multiplyScalar(0.2); shuttle_v.z *= -0.3;
      playSound('net', 0.5);
      endRally(lastHitter === 'player' ? 'ai' : 'player', 'Into the net!');
      return;
    }
  }

  // AI return zone
  if (lastHitter === 'player' && shuttle.position.z < -(COURT.halfLen - 4.5) && shuttle_v.y < 0 && shuttle.position.y < 1.6) {
    const land = predictLanding();
    oppState.target.x = THREE.MathUtils.clamp(land.x, -COURT.halfWidth, COURT.halfWidth);
    oppState.target.z = THREE.MathUtils.clamp(land.z, -(COURT.halfLen - 0.8), -1.2);
    const reach = opponent.position.distanceTo(new THREE.Vector3(shuttle.position.x, 0, shuttle.position.z));
    if (shuttle.position.y < 1.9 && shuttle.position.y > 0.25 && reach < 1.3 && oppState.swingT < 0) {
      if (Math.random() < 0.70) aiHit();
    }
  }

  // Ground
  if (shuttle.position.y <= shuttle.userData.corkRadius) {
    shuttle.position.y = shuttle.userData.corkRadius;
    onGroundHit();
  }
}

function updateTrail() {
  const arr = shuttleTrail.geometry.attributes.position.array;
  for (let i = 0; i < MAX_TRAIL; i++) {
    const p = trailPoints[i] || trailPoints[trailPoints.length - 1] || shuttle.position;
    arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
  }
  shuttleTrail.geometry.attributes.position.needsUpdate = true;
  shuttleTrail.geometry.setDrawRange(0, trailPoints.length);
}

function playerHit() {
  const n = racketNormalWorld.clone();
  if (n.z > 0) n.negate();
  const vdotn = shuttle_v.dot(n);
  shuttle_v.addScaledVector(n, -2 * vdotn);
  const power = THREE.MathUtils.clamp(racketVel.length(), 0, 12);
  shuttle_v.addScaledVector(n, power * 0.55);
  shuttle_v.addScaledVector(racketVel, 0.35);
  if (shuttle_v.z > -1.5) shuttle_v.z = -3.5 - Math.random() * 2;
  if (shuttle_v.y < 1.5) shuttle_v.y += 2.2;
  if (shuttle_v.length() > 16) shuttle_v.setLength(16);
  lastHitter = 'player';
  playSound('hit', 0.6 + Math.min(0.4, power / 30));
  haptic(0.6, 40);
}

function predictLanding() {
  const p = shuttle.position.clone(), v = shuttle_v.clone();
  const dt = 1 / 60;
  for (let i = 0; i < 240; i++) {
    v.addScaledVector(v, -DRAG * v.length() * dt);
    v.y += GRAVITY * dt;
    p.addScaledVector(v, dt);
    if (p.y <= 0.05) break;
  }
  return p;
}

function onGroundHit() {
  playSound('ground', 0.5); haptic(0.3, 30);
  const z = shuttle.position.z;
  const inBoundsX = Math.abs(shuttle.position.x) < COURT.halfWidth + 0.25;
  const inBoundsZ = Math.abs(z) < COURT.halfLen + 0.25;
  if (lastHitter === 'serve') { endRally(null, 'Let — replay'); return; }
  if (!inBoundsX || !inBoundsZ) { endRally((lastHitter === 'player') ? 'ai' : 'player', 'Out of bounds!'); return; }
  endRally(z < 0 ? 'player' : 'ai', z < 0 ? 'Point — YOU!' : 'Point — AI');
}

function endRally(winner, reason) {
  shuttleActive = false;
  gameState = STATE.POINT;
  pointTimer = 0;
  if (winner === 'player') { scorePlayer++; playSound('point', 0.6); audio && audio.cheer(); }
  else if (winner === 'ai') { scoreAI++; playSound('point', 0.4); }
  updateScoreboard();

  if (scorePlayer >= WIN_SCORE || scoreAI >= WIN_SCORE) {
    const youWin = scorePlayer >= WIN_SCORE;
    gameState = STATE.OVER;
    showMessage([
      { text: youWin ? '🏆 YOU WIN!' : 'AI WINS', size: 96, color: youWin ? '#FFD700' : '#FF9B9B' },
      { text: scorePlayer + ' — ' + scoreAI, size: 64, color: '#ffffff' },
      { text: 'Pinch / trigger to play again', size: 40, color: '#9fb4d8' }
    ]);
    if (youWin) audio && audio.cheer(1.0);
  } else {
    showMessage([
      { text: reason, size: 70, color: winner === 'player' ? '#7CFC9A' : (winner === 'ai' ? '#FF9B9B' : '#ffffff') },
      { text: 'YOU ' + scorePlayer + ' — ' + scoreAI + ' AI', size: 54, color: '#cfe0ff' }
    ]);
  }
}

function resetMatch() {
  scorePlayer = 0; scoreAI = 0; updateScoreboard();
  hideMessage();
  shuttle.visible = false; shuttleTrail.visible = false;
  gameState = STATE.SERVING;
  setTimeout(() => { if (gameState === STATE.SERVING) serve(); }, 1200);
}

function updatePoint(dt) {
  pointTimer += dt;
  if (pointTimer > 2.2) {
    shuttle.visible = false; shuttleTrail.visible = false;
    hideMessage();
    gameState = STATE.SERVING;
    setTimeout(() => { if (gameState === STATE.SERVING) serve(); }, 900);
  }
}

// ============================================================
//  HAPTICS
// ============================================================
function haptic(intensity, ms) {
  for (const c of controllers) {
    const gp = c.userData.gamepad;
    if (gp && gp.hapticActuators && gp.hapticActuators[0]) {
      try { gp.hapticActuators[0].pulse(intensity, ms); } catch (e) {}
    }
  }
}

// ============================================================
//  AUDIO ENGINE
// ============================================================
class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(this.ctx.destination);
    this.ambienceNode = null;
  }
  resume() { if (this.ctx.state === 'suspended') this.ctx.resume(); }

  noiseBuffer(dur) {
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  play(type, vol = 0.5) {
    this.resume();
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain(); g.connect(this.master);
    if (type === 'hit') {
      const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(0.08);
      const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
      src.connect(bp); bp.connect(g);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      src.start(t); src.stop(t + 0.1);
    } else if (type === 'net') {
      const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(0.15);
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      src.connect(lp); lp.connect(g);
      g.gain.setValueAtTime(vol * 0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      src.start(t); src.stop(t + 0.18);
    } else if (type === 'ground') {
      const osc = this.ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t); osc.frequency.exponentialRampToValueAtTime(50, t + 0.18);
      osc.connect(g); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.start(t); osc.stop(t + 0.22);
    } else if (type === 'point') {
      [660, 990].forEach((f, i) => {
        const osc = this.ctx.createOscillator(); const gg = this.ctx.createGain(); gg.connect(this.master);
        osc.type = 'triangle'; osc.frequency.value = f; osc.connect(gg);
        gg.gain.setValueAtTime(0, t + i * 0.1); gg.gain.linearRampToValueAtTime(vol * 0.5, t + i * 0.1 + 0.02);
        gg.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.3);
        osc.start(t + i * 0.1); osc.stop(t + i * 0.1 + 0.32);
      });
    }
  }

  startAmbience() {
    if (this.ambienceNode) return;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(2.0); src.loop = true;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    const g = this.ctx.createGain(); g.gain.value = 0.06;
    src.connect(lp); lp.connect(g); g.connect(this.master); src.start();
    this.ambienceNode = { src, g };
  }

  stopAmbience() {
    if (this.ambienceNode) { try { this.ambienceNode.src.stop(); } catch (e) {} this.ambienceNode = null; }
  }

  cheer(scale = 0.5) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(1.4);
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.5;
    const g = this.ctx.createGain(); g.connect(this.master);
    src.connect(bp); bp.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25 * scale, t + 0.15);
    g.gain.linearRampToValueAtTime(0.2 * scale, t + 0.8); g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    src.start(t); src.stop(t + 1.4);
  }
}

function playSound(type, vol) { if (audio) audio.play(type, vol); }

// ============================================================
//  MAIN LOOP
// ============================================================
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  updateGhostRacket(dt);
  animateOpponent(dt, t);
  animateAudience(t);
  updateReadyButton(dt);
  if (gameState === STATE.RALLY) updateShuttle(dt);
  else if (gameState === STATE.POINT) updatePoint(dt);
  renderer.render(scene, camera);
}

// ============================================================
//  INIT — called last so every variable above is defined
// ============================================================
function init() {
  buildLighting();
  buildCourt();
  buildNet();
  buildAudience();
  buildOpponent();
  buildShuttle();
  buildReadyButton();
  buildScoreboard();
  setupXRInputs();

  const vrBtn = VRButton.createButton(renderer, {
    optionalFeatures: ['hand-tracking', 'local-floor', 'bounded-floor', 'layers']
  });
  document.getElementById('vrbtn').appendChild(vrBtn);

  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(loop);

  if (!navigator.xr) {
    statusEl.textContent = 'WebXR not detected. Open this page in the Meta Quest Browser over HTTPS.';
  } else {
    statusEl.textContent = '';
  }
}

init();
