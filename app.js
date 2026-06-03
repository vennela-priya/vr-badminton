import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ============================================================
//  CONSTANTS  (halfLen/halfWidth can be overridden from room bounds)
// ============================================================
const COURT = { halfLen: 6.7, halfWidth: 3.05, netY: 1.55, netHalfH: 0.38 };
const GRAVITY = -9.8;
const DRAG = 0.18;
const MAX_TRAIL = 30;
const WIN_SCORE = 7;
const STATE = { BOOT: 0, SERVING: 2, RALLY: 3, POINT: 4, OVER: 5 };
const SERVE_VEL_THRESH = 3.2; // m/s right-hand swing needed to serve

// ============================================================
//  DOM
// ============================================================
const statusEl = document.getElementById('status');

// ============================================================
//  SCENE / RENDERER / CAMERA
// ============================================================
const scene = new THREE.Scene();
// No background — AR passthrough fills it

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);   // transparent background for AR
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.position = 'fixed';
renderer.domElement.style.inset = '0';

const clock = new THREE.Clock();

// Player rig (will be repositioned from room bounds on session start)
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
//  RACKET TRACKING  (right hand only)
// ============================================================
let ghostRacket = null;
let racketHolder = null;
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
//  SCENE OBJECTS
// ============================================================
let shuttle, shuttleTrail, opponent, net;
let scoreBoard, msgBoard;
let audienceMesh;
let courtGroup; // all court geometry in one group for easy scaling

// ============================================================
//  AI STATE
// ============================================================
const oppState = {
  pos: new THREE.Vector3(0, 0, -(COURT.halfLen - 1.6)),
  target: new THREE.Vector3(0, 0, -(COURT.halfLen - 1.6)),
  swingT: -1,
  anim: 'idle',
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
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.2));

  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(4, 9, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const s = 10;
  key.shadow.camera.left = -s; key.shadow.camera.right = s;
  key.shadow.camera.top = s; key.shadow.camera.bottom = -s;
  key.shadow.camera.near = 1; key.shadow.camera.far = 30;
  key.shadow.bias = -0.0004;
  scene.add(key);
}

// ============================================================
//  COURT  (transparent floor so real room shows through)
// ============================================================
function buildCourt() {
  courtGroup = new THREE.Group();

  // Court markings canvas
  const W = 512, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  // Semi-transparent green so real floor shows through in AR
  ctx.fillStyle = 'rgba(20,100,50,0.72)'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6;
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
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, transparent: true, opacity: 0.82, depthWrite: false })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  courtGroup.add(floor);

  scene.add(courtGroup);
}

// ============================================================
//  NET
// ============================================================
function buildNet() {
  net = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.6, roughness: 0.4 });
  const postGeo = new THREE.CylinderGeometry(0.04, 0.05, COURT.netY, 12);
  for (let s = -1; s <= 1; s += 2) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(s * (COURT.halfWidth + 0.2), COURT.netY / 2, 0);
    post.castShadow = true;
    net.add(post);
  }
  const netCv = document.createElement('canvas');
  netCv.width = 256; netCv.height = 64;
  const nctx = netCv.getContext('2d');
  nctx.strokeStyle = 'rgba(255,255,255,0.7)'; nctx.lineWidth = 1;
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
//  AUDIENCE  (side rows + end rows)
// ============================================================
function buildAudience() {
  const count = 320;
  const geo = new THREE.BoxGeometry(0.4, 0.7, 0.35);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  audienceMesh = new THREE.InstancedMesh(geo, mat, count);
  audienceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.Color();
  const dummy = new THREE.Object3D();
  let idx = 0;
  audienceMesh.userData.base = [];

  function place(x, z, ry, yOff = 0) {
    if (idx >= count) return;
    dummy.position.set(x, 0.9 + yOff, z);
    dummy.rotation.set(0, ry, 0);
    dummy.updateMatrix();
    audienceMesh.setMatrixAt(idx, dummy.matrix);
    color.setHSL(Math.random(), 0.55, 0.45 + Math.random() * 0.2);
    audienceMesh.setColorAt(idx, color);
    audienceMesh.userData.base.push({ x, z, ry, phase: Math.random() * Math.PI * 2, y: 0.9 + yOff });
    idx++;
  }

  const rows = 3;
  for (let r = 0; r < rows; r++) {
    const endOff = COURT.halfLen + 2.2 + r * 0.9;
    const sideOff = COURT.halfWidth + 2.0 + r * 0.9;
    const yOff = r * 0.55;
    // end rows
    for (let x = -5; x <= 5; x += 0.9) {
      place(x, endOff, Math.PI, yOff);
      place(x, -endOff, 0, yOff);
    }
    // side rows
    for (let z = -COURT.halfLen + 1; z <= COURT.halfLen - 1; z += 0.9) {
      place(sideOff, z, -Math.PI / 2, yOff);
      place(-sideOff, z, Math.PI / 2, yOff);
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
  shaft.position.y = 0.27; shaft.castShadow = !ghost; g.add(shaft);

  const head = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.01, 10, 36), frameMat);
  head.position.y = 0.46; head.scale.set(1, 1.18, 1); head.castShadow = !ghost; g.add(head);

  const stringMat = new THREE.MeshBasicMaterial({
    color: ghost ? 0x9ff7ff : 0xffffff,
    transparent: true, opacity: ghost ? 0.32 : 0.5, side: THREE.DoubleSide
  });
  const bed = new THREE.Mesh(new THREE.CircleGeometry(0.1, 24), stringMat);
  bed.position.y = 0.46; bed.scale.set(1, 1.18, 1); g.add(bed);

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
  const shirt = new THREE.MeshStandardMaterial({ color: 0x2244cc, roughness: 0.85 });
  const shorts = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });

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
  const rArm = new THREE.Mesh(armGeo, skin); rArm.position.set(0, -0.17, 0); rArm.castShadow = true; armPivot.add(rArm);
  const oppRacket = makeRacket({ ghost: false });
  oppRacket.position.set(0, -0.34, 0); oppRacket.rotation.x = -0.3; armPivot.add(oppRacket);
  opponent.add(armPivot);
  opponent.userData.armPivot = armPivot;
  opponent.userData.racket = oppRacket;

  opponent.position.copy(oppState.pos);
  opponent.rotation.y = Math.PI;
  scene.add(opponent);
}

function animateOpponent(dt, t) {
  if (!opponent) return;
  const ud = opponent.userData;
  oppState.pos.x += (oppState.target.x - oppState.pos.x) * Math.min(1, dt * 4);
  oppState.pos.z += (oppState.target.z - oppState.pos.z) * Math.min(1, dt * 4);
  opponent.position.x = oppState.pos.x;
  opponent.position.z = oppState.pos.z;
  opponent.position.y = Math.sin(t * 2) * 0.02;

  ud.lLeg.rotation.x = Math.sin(t * 2) * 0.05;
  ud.rLeg.rotation.x = -Math.sin(t * 2) * 0.05;
  ud.lArm.rotation.z = 0.4 + Math.sin(t * 2) * 0.05;
  const sway = Math.sin(t * 1.3) * 0.05;

  if (oppState.swingT >= 0) {
    oppState.swingT += dt;
    const p = oppState.swingT / 0.45;
    if (p < 1) {
      const ease = p < 0.4 ? -(p / 0.4) * 1.6 : (((p - 0.4) / 0.6) * 2.4 - 1.6);
      ud.armPivot.rotation.x = ease;
      ud.armPivot.rotation.z = sway * 0.5 - 0.2;
    } else {
      oppState.swingT = -1; ud.armPivot.rotation.x = 0;
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
  cork.castShadow = true; shuttle.add(cork);

  const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.06, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
  skirt.position.y = 0.04; shuttle.add(skirt);

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
//  SCOREBOARD
// ============================================================
function buildScoreboard() {
  scoreBoard = makeTextPanel(1.6, 0.5);
  scoreBoard.position.set(0, 3.0, -1.5);
  scene.add(scoreBoard);
  updateScoreboard();

  msgBoard = makeTextPanel(2.2, 0.7);
  msgBoard.position.set(0, 2.2, -1.5);
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
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  mesh.userData = { cv, ctx: cv.getContext('2d'), tex };
  return mesh;
}

function drawPanel(panel, lines, opts = {}) {
  const { ctx, cv, tex } = panel.userData;
  ctx.clearRect(0, 0, cv.width, cv.height);
  roundRect(ctx, 0, 0, cv.width, cv.height, 30);
  ctx.fillStyle = opts.bg || 'rgba(8,14,30,0.88)'; ctx.fill();
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
//  XR INPUT SETUP
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
    ctrl.addEventListener('connected', (e) => {
      ctrl.userData.handedness = e.data.handedness;
      // mirror handedness to hand and grip objects
      if (hands[i]) hands[i].userData.handedness = e.data.handedness;
      if (grips[i]) grips[i].userData.handedness = e.data.handedness;
    });
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

// ============================================================
//  SESSION EVENTS
// ============================================================
function onSessionStart() {
  document.getElementById('overlay').style.display = 'none';
  if (!audio) audio = new AudioEngine();
  audio.resume(); audio.startAmbience();

  // Try bounded-floor to anchor court to room
  const session = renderer.xr.getSession();
  if (session) {
    session.requestReferenceSpace('bounded-floor').then(bf => {
      if (bf.boundsGeometry && bf.boundsGeometry.length >= 3) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const pt of bf.boundsGeometry) {
          minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
          minZ = Math.min(minZ, pt.z); maxZ = Math.max(maxZ, pt.z);
        }
        // Scale court to fit ~80% of room (capped at real badminton dimensions)
        COURT.halfWidth = Math.min((maxX - minX) * 0.4, 3.05);
        COURT.halfLen   = Math.min((maxZ - minZ) * 0.4, 6.7);
        // Reposition player to near end of court
        player.position.set(0, 0, COURT.halfLen - 1.4);
        // Reposition opponent
        oppState.pos.set(0, 0, -(COURT.halfLen - 1.6));
        oppState.target.copy(oppState.pos);
        if (opponent) { opponent.position.copy(oppState.pos); }
      }
    }).catch(() => {}); // bounded-floor not available — use defaults
  }

  scorePlayer = 0; scoreAI = 0; updateScoreboard(); hideMessage();
  ghostRacket.visible = true;

  setTimeout(() => {
    gameState = STATE.SERVING;
    showMessage([
      { text: '🏸 LEFT hand = shuttle', size: 56, color: '#7CFC9A' },
      { text: 'Swing RIGHT hand to serve!', size: 50, color: '#cfe0ff' }
    ]);
  }, 600);
}

function onSessionEnd() {
  document.getElementById('overlay').style.display = 'flex';
  if (audio) audio.stopAmbience();
  gameState = STATE.BOOT;
}

function onSelectStart(event) {
  if (gameState === STATE.SERVING) {
    // Allow manual serve via trigger/pinch (right hand only)
    const src = event.target;
    const hand = hands.find(h => h === src);
    const ctrl = controllers.find(c => c === src);
    const isRight = (hand && hand.userData.handedness === 'right') ||
                    (ctrl && ctrl.userData.handedness === 'right');
    if (isRight) serve();
  } else if (gameState === STATE.OVER) {
    resetMatch();
  }
}

// ============================================================
//  GHOST RACKET  — right hand only
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

  // Prefer right hand
  for (const hand of hands) {
    if (hand.userData.handedness && hand.userData.handedness !== 'right') continue;
    const j = hand.joints;
    if (!j || !j['wrist'] || j['wrist'].position === undefined) continue;
    const wrist = j['wrist'];
    if (!wrist.visible && wrist.position.lengthSq() === 0) continue;

    wrist.getWorldPosition(_v1);
    const ref = j['middle-finger-metacarpal'] || j['middle-finger-phalanx-proximal'] || j['index-finger-metacarpal'];
    if (!ref) continue;
    ref.getWorldPosition(_v2);
    const fwd = _v2.clone().sub(_v1).normalize();
    wrist.getWorldQuaternion(_q);
    const palmNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(_q).normalize();
    const yAxis = fwd;
    const xAxis = new THREE.Vector3().crossVectors(yAxis, palmNormal).normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    _m.makeBasis(xAxis, yAxis, zAxis);
    racketHolder.position.copy(_v1);
    racketHolder.quaternion.setFromRotationMatrix(_m);
    placed = true;
    break;
  }

  if (!placed) {
    // Fallback to right grip controller
    for (const grip of grips) {
      if (grip.userData.handedness && grip.userData.handedness !== 'right') continue;
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
//  LEFT HAND — holds shuttlecock when serving
// ============================================================
function updateLeftHandShuttle() {
  if (gameState !== STATE.SERVING) return;

  // Find left hand wrist
  let leftWristPos = null;
  for (const hand of hands) {
    if (hand.userData.handedness && hand.userData.handedness !== 'left') continue;
    const tip = getJointWorld(hand, 'wrist', _v1.clone());
    if (tip) { leftWristPos = tip.clone(); break; }
  }

  // Fallback: left grip controller
  if (!leftWristPos) {
    for (const grip of grips) {
      if (grip.userData.handedness && grip.userData.handedness !== 'left') continue;
      if (grip.visible && grip.position.lengthSq() > 0) {
        leftWristPos = new THREE.Vector3();
        grip.getWorldPosition(leftWristPos);
        break;
      }
    }
  }

  if (leftWristPos) {
    // Show shuttle floating just above left palm
    shuttle.position.copy(leftWristPos).add(new THREE.Vector3(0, 0.08, 0));
    shuttle.visible = true;
    shuttleTrail.visible = false;
    // Auto-serve when right hand swings fast enough
    if (racketHolder.visible && racketVel.length() > SERVE_VEL_THRESH) {
      serve();
    }
  } else {
    // No hand detected yet — show shuttle in front of player
    camera.getWorldPosition(_v1);
    camera.getWorldDirection(_v2); _v2.y = 0; _v2.normalize();
    shuttle.position.copy(_v1).addScaledVector(_v2, 0.5).add(new THREE.Vector3(-0.2, -0.1, 0));
    shuttle.visible = true;
  }
}

// ============================================================
//  SERVE
// ============================================================
function serve() {
  if (gameState !== STATE.SERVING) return;
  hideMessage();

  // Launch from current shuttle position (left hand) toward opponent's court
  // Direction: forward (-Z) with upward arc; bias from racket velocity
  const spd = THREE.MathUtils.clamp(racketVel.length(), 3, 14);
  shuttle_v.set(
    racketVel.x * 0.3,
    Math.max(2.8, racketVel.y * 0.3 + 2.2),
    -spd * 0.55
  );
  // Clamp Z so it always crosses the net
  if (shuttle_v.z > -2.5) shuttle_v.z = -3.5 - Math.random() * 1.5;

  shuttleActive = true;
  shuttle.visible = true;
  shuttleTrail.visible = true;
  trailPoints.length = 0;
  lastHitter = 'player';
  gameState = STATE.RALLY;
  playSound('hit', 0.5);
}

// ============================================================
//  AI HIT
// ============================================================
function aiHit() {
  oppState.swingT = 0;
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
  const dist = new THREE.Vector3(disp.x, 0, disp.z).length();
  const flightTime = THREE.MathUtils.clamp(dist / 7, 0.5, 1.3) * arcFactor;
  shuttle_v.set(
    disp.x / flightTime,
    (to.y - from.y) / flightTime - 0.5 * GRAVITY * flightTime,
    disp.z / flightTime
  );
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

  // Player racket collision
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
  const inX = Math.abs(shuttle.position.x) < COURT.halfWidth + 0.25;
  const inZ = Math.abs(z) < COURT.halfLen + 0.25;
  if (!inX || !inZ) { endRally((lastHitter === 'player') ? 'ai' : 'player', 'Out of bounds!'); return; }
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
      { text: 'Pinch to play again', size: 44, color: '#9fb4d8' }
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
  scorePlayer = 0; scoreAI = 0; updateScoreboard(); hideMessage();
  shuttle.visible = false; shuttleTrail.visible = false;
  gameState = STATE.SERVING;
  showMessage([
    { text: '🏸 LEFT hand = shuttle', size: 56, color: '#7CFC9A' },
    { text: 'Swing RIGHT hand to serve!', size: 50, color: '#cfe0ff' }
  ]);
}

function updatePoint(dt) {
  pointTimer += dt;
  if (pointTimer > 2.2) {
    shuttle.visible = false; shuttleTrail.visible = false;
    hideMessage();
    gameState = STATE.SERVING;
    showMessage([
      { text: '🏸 Left hand = shuttle', size: 60, color: '#7CFC9A' },
      { text: 'Swing right to serve', size: 52, color: '#cfe0ff' }
    ]);
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
  updateLeftHandShuttle();
  animateOpponent(dt, t);
  animateAudience(t);
  if (gameState === STATE.RALLY) updateShuttle(dt);
  else if (gameState === STATE.POINT) updatePoint(dt);
  renderer.render(scene, camera);
}

// ============================================================
//  INIT
// ============================================================
function init() {
  buildLighting();
  buildCourt();
  buildNet();
  buildAudience();
  buildOpponent();
  buildShuttle();
  buildScoreboard();
  setupXRInputs();

  // AR button — shows passthrough so user can see their real racket
  const arBtn = ARButton.createButton(renderer, {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'bounded-floor']
  });
  document.getElementById('vrbtn').appendChild(arBtn);

  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(loop);

  if (!navigator.xr) {
    statusEl.textContent = 'WebXR not detected. Open in the Meta Quest Browser over HTTPS.';
  } else {
    statusEl.textContent = '';
  }
}

init();
