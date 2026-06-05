import * as THREE from "three";
import { ARButton } from "three/addons/webxr/ARButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";

// ============================================================
//  CONSTANTS  (halfLen/halfWidth can be overridden from room bounds)
// ============================================================
const COURT = { halfLen: 6.7, halfWidth: 3.05, netY: 1.55, netHalfH: 0.38 };
const GRAVITY = -9.8;
const DRAG = 0.22; // shuttlecock has high aerodynamic drag
const MAX_TRAIL = 30;
const WIN_SCORE = 7;
const STATE = { BOOT: 0, SERVING: 2, RALLY: 3, POINT: 4, OVER: 5 };
const SERVE_VEL_THRESH = 2.0; // lower threshold — real bat triggers easier

// ============================================================
//  DOM
// ============================================================
const statusEl = document.getElementById("status");

// ============================================================
//  SCENE / RENDERER / CAMERA
// ============================================================
const scene = new THREE.Scene();
// No background — AR passthrough fills it

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.05,
  100,
);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0); // transparent background for AR
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.position = "fixed";
renderer.domElement.style.inset = "0";

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
let scorePlayer = 0,
  scoreAI = 0;
let pointTimer = 0;
let lastHitter = null;
let floorDetectionDone = false;
let floorDetectionTimer = 0;
const FLOOR_DETECT_TIMEOUT = 4.0;

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
let worldRoot; // parent of all game-world objects; Y-shifted to match detected floor

// ============================================================
//  AI STATE
// ============================================================
const oppState = {
  pos: new THREE.Vector3(0, 0, -(COURT.halfLen - 1.6)),
  target: new THREE.Vector3(0, 0, -(COURT.halfLen - 1.6)),
  swingT: -1,
  anim: "idle",
};

// ============================================================
//  AUDIO
// ============================================================
let audio = null;

// ============================================================
//  REUSABLE TEMPS
// ============================================================
const _v1 = new THREE.Vector3(),
  _v2 = new THREE.Vector3(),
  _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(),
  _m = new THREE.Matrix4();

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
  key.shadow.camera.left = -s;
  key.shadow.camera.right = s;
  key.shadow.camera.top = s;
  key.shadow.camera.bottom = -s;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 30;
  key.shadow.bias = -0.0004;
  scene.add(key);
}

// ============================================================
//  COURT  (transparent floor so real room shows through)
// ============================================================
function buildCourt() {
  courtGroup = new THREE.Group();

  // Court markings canvas
  const W = 512,
    H = 1024;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  // Semi-transparent green so real floor shows through in AR
  ctx.fillStyle = "rgba(20,100,50,0.72)";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 6;
  const pad = 40;
  ctx.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
  ctx.beginPath();
  ctx.moveTo(pad + 34, pad);
  ctx.lineTo(pad + 34, H - pad);
  ctx.moveTo(W - pad - 34, pad);
  ctx.lineTo(W - pad - 34, H - pad);
  ctx.stroke();
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(pad, H / 2);
  ctx.lineTo(W - pad, H / 2);
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(pad, H / 2 - 120);
  ctx.lineTo(W - pad, H / 2 - 120);
  ctx.moveTo(pad, H / 2 + 120);
  ctx.lineTo(W - pad, H / 2 + 120);
  ctx.moveTo(W / 2, pad);
  ctx.lineTo(W / 2, H / 2 - 120);
  ctx.moveTo(W / 2, H / 2 + 120);
  ctx.lineTo(W / 2, H - pad);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.halfWidth * 2 + 1.5, COURT.halfLen * 2 + 1.5),
    new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.85,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.1; // 3 mm below XR floor reference — prevents floating/z-fighting in AR
  floor.receiveShadow = true;
  courtGroup.add(floor);

  worldRoot.add(courtGroup);
}

// ============================================================
//  NET
// ============================================================
function buildNet() {
  net = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x555555,
    metalness: 0.6,
    roughness: 0.4,
  });
  const postGeo = new THREE.CylinderGeometry(0.04, 0.05, COURT.netY, 12);
  for (let s = -1; s <= 1; s += 2) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(s * (COURT.halfWidth + 0.2), COURT.netY / 2, 0);
    post.castShadow = true;
    net.add(post);
  }
  const netCv = document.createElement("canvas");
  netCv.width = 256;
  netCv.height = 64;
  const nctx = netCv.getContext("2d");
  nctx.strokeStyle = "rgba(255,255,255,0.7)";
  nctx.lineWidth = 1;
  for (let x = 0; x <= 256; x += 8) {
    nctx.beginPath();
    nctx.moveTo(x, 0);
    nctx.lineTo(x, 64);
    nctx.stroke();
  }
  for (let y = 0; y <= 64; y += 8) {
    nctx.beginPath();
    nctx.moveTo(0, y);
    nctx.lineTo(256, y);
    nctx.stroke();
  }
  nctx.fillStyle = "#ffffff";
  nctx.fillRect(0, 0, 256, 7);
  const netTex = new THREE.CanvasTexture(netCv);
  const netMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.halfWidth * 2 + 0.4, COURT.netHalfH * 2),
    new THREE.MeshStandardMaterial({
      map: netTex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  netMesh.position.set(0, COURT.netY - COURT.netHalfH, 0);
  net.add(netMesh);
  worldRoot.add(net);
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
    dummy.position.set(x, 0.35 + yOff, z);
    dummy.rotation.set(0, ry, 0);
    dummy.updateMatrix();
    audienceMesh.setMatrixAt(idx, dummy.matrix);
    color.setHSL(Math.random(), 0.55, 0.45 + Math.random() * 0.2);
    audienceMesh.setColorAt(idx, color);
    audienceMesh.userData.base.push({
      x,
      z,
      ry,
      phase: Math.random() * Math.PI * 2,
      y: 0.35 + yOff,
    });
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
  worldRoot.add(audienceMesh);
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
function makeGhostRacket() {
  const g = new THREE.Group();
  g.userData.headLocal = new THREE.Vector3(0, 0.39, 0); // 7 cm closer to palm
  g.userData.headRadius = 0.18;

  const ghostMat = new THREE.MeshStandardMaterial({
    color: 0x00e5ff,
    emissive: 0x007799,
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mtlLoader = new MTLLoader();
  mtlLoader.setPath("/assets/");
  mtlLoader.load("Racket.mtl", (materials) => {
    materials.preload();

    const objLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath("/assets/");
    objLoader.load("Racket.obj", (obj) => {
      // Replace all materials with ghost material
      obj.traverse((c) => {
        if (c.isMesh) {
          c.material = ghostMat;
          c.castShadow = false;
        }
      });

      obj.scale.setScalar(0.009);
      obj.rotation.order = "YXZ";
      obj.rotation.z = Math.PI + THREE.MathUtils.degToRad(40);
      obj.rotation.x = 0; // no tilt — bat aligns straight with arm
      // x = up/down, y = forward along arm, z = left/right
      obj.position.set(0.3, 0.205, 0); // aligned with real bat (10 cm horizontal correction)

      g.add(obj);
    });
  });

  return g;
}

function makeRacket({ ghost = false } = {}) {
  const g = new THREE.Group();
  // Collision metadata — used by physics even before model loads
  g.userData.headLocal = new THREE.Vector3(0, 0.46, 0);
  g.userData.headRadius = 0.18; // wider hit zone for real bat in AR

  const mtlLoader = new MTLLoader();
  mtlLoader.setPath("/assets/");
  mtlLoader.load("Racket.mtl", (materials) => {
    materials.preload();

    if (ghost) {
      // Make all materials semi-transparent cyan for the ghost racket
      Object.values(materials.materials).forEach((m) => {
        m.color.set(0x00e5ff);
        m.transparent = true;
        m.opacity = 0.55;
        m.emissive = new THREE.Color(0x0088aa);
        m.emissiveIntensity = 0.6;
      });
    }

    const objLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath("/assets/");
    objLoader.load("Racket.obj", (obj) => {
      // Scale to real racket size (~660mm long)
      obj.scale.setScalar(0.009);
      // Handle points down (-Y), head up (+Y) to match physics origin
      obj.rotation.order = "YXZ";
      obj.rotation.z = Math.PI + THREE.MathUtils.degToRad(40);
      obj.rotation.x = THREE.MathUtils.degToRad(-15); // tilt to match real bat grip angle
      // Shift grip to align with hand/wrist origin
      obj.position.set(0, 0, 0);
      obj.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = !ghost;
          if (ghost) {
            c.material.transparent = true;
            c.material.opacity = 0.55;
          }
        }
      });
      g.add(obj);
    });
  });

  return g;
}

// ============================================================
//  OPPONENT
// ============================================================
function buildOpponent() {
  opponent = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: 0xe0a878,
    roughness: 0.7,
  });
  const shirt = new THREE.MeshStandardMaterial({
    color: 0x2244cc,
    roughness: 0.85,
  });
  const shorts = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
  });

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.17, 0.34, 6, 12),
    shirt,
  );
  torso.position.y = 1.15;
  torso.castShadow = true;
  opponent.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 16), skin);
  head.position.y = 1.5;
  head.castShadow = true;
  opponent.add(head);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.135, 16, 16, 0, Math.PI * 2, 0, Math.PI * 0.6),
    new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 1 }),
  );
  hair.position.y = 1.52;
  opponent.add(hair);

  const legGeo = new THREE.CapsuleGeometry(0.07, 0.45, 4, 8);
  const lLeg = new THREE.Mesh(legGeo, shorts);
  lLeg.position.set(-0.09, 0.55, 0);
  lLeg.castShadow = true;
  opponent.add(lLeg);
  const rLeg = new THREE.Mesh(legGeo, shorts);
  rLeg.position.set(0.09, 0.55, 0);
  rLeg.castShadow = true;
  opponent.add(rLeg);
  opponent.userData.lLeg = lLeg;
  opponent.userData.rLeg = rLeg;

  const armGeo = new THREE.CapsuleGeometry(0.05, 0.34, 4, 8);
  const lArm = new THREE.Mesh(armGeo, skin);
  lArm.position.set(-0.24, 1.2, 0);
  lArm.rotation.z = 0.4;
  lArm.castShadow = true;
  opponent.add(lArm);
  opponent.userData.lArm = lArm;

  const armPivot = new THREE.Group();
  armPivot.position.set(0.22, 1.32, 0);
  const rArm = new THREE.Mesh(armGeo, skin);
  rArm.position.set(0, -0.17, 0);
  rArm.castShadow = true;
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
  worldRoot.add(opponent);
}

function animateOpponent(dt, t) {
  if (!opponent) return;
  const ud = opponent.userData;
  // Speed-limited movement — up to 5.5 m/s (competitive badminton player speed)
  const MAX_OPP_SPEED = 5.5;
  const moveDx = oppState.target.x - oppState.pos.x;
  const moveDz = oppState.target.z - oppState.pos.z;
  const moveDist = Math.sqrt(moveDx * moveDx + moveDz * moveDz);
  if (moveDist > 0.01) {
    const step = Math.min(moveDist, MAX_OPP_SPEED * dt);
    oppState.pos.x += (moveDx / moveDist) * step;
    oppState.pos.z += (moveDz / moveDist) * step;
  }
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
      const ease = p < 0.4 ? -(p / 0.4) * 1.6 : ((p - 0.4) / 0.6) * 2.4 - 1.6;
      ud.armPivot.rotation.x = ease;
      ud.armPivot.rotation.z = sway * 0.5 - 0.2;
    } else {
      oppState.swingT = -1;
      ud.armPivot.rotation.x = 0;
    }
  } else {
    ud.armPivot.rotation.x +=
      (-0.5 - ud.armPivot.rotation.x) * Math.min(1, dt * 5);
    ud.armPivot.rotation.z = sway * 0.5;
  }
}

// ============================================================
//  SHUTTLECOCK
// ============================================================
function buildShuttle() {
  shuttle = new THREE.Group();
  shuttle.userData.corkRadius = 0.022;
  shuttle.visible = false;
  worldRoot.add(shuttle);

  // Load real shuttlecock OBJ model
  const mtlLoader = new MTLLoader();
  mtlLoader.setPath("/assets/");
  mtlLoader.load("11744_Shuttlecock_v1_l3.mtl", (materials) => {
    materials.preload();
    const objLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath("/assets/");
    objLoader.load("11744_Shuttlecock_v1_l3.obj", (obj) => {
      // Scale to match game units (~8cm real shuttlecock)
      obj.scale.setScalar(0.018);
      // Cork is at the bottom of the model — rotate so cork leads in flight
      obj.rotation.x = Math.PI + Math.PI / 4;
      obj.traverse((c) => {
        if (c.isMesh) c.castShadow = true;
      });
      shuttle.add(obj);
    });
  });

  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3),
  );
  shuttleTrail = new THREE.Line(
    trailGeo,
    new THREE.LineBasicMaterial({
      color: 0xfff2a0,
      transparent: true,
      opacity: 0.6,
    }),
  );
  shuttleTrail.frustumCulled = false;
  shuttleTrail.visible = false;
  worldRoot.add(shuttleTrail);
}

// ============================================================
//  SCOREBOARD
// ============================================================
function buildScoreboard() {
  // Attach to player group so boards stay in front of user regardless of court scale
  scoreBoard = makeTextPanel(1.6, 0.5);
  scoreBoard.position.set(0, 0.5, -2.2); // 2.2 m ahead, 0.5 m above waist
  player.add(scoreBoard);
  updateScoreboard();

  msgBoard = makeTextPanel(2.2, 0.7);
  msgBoard.position.set(0, 0.1, -2.2);
  msgBoard.visible = false;
  player.add(msgBoard);
}

function makeTextPanel(w, h) {
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = Math.round((1024 * h) / w);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    }),
  );
  mesh.userData = { cv, ctx: cv.getContext("2d"), tex };
  return mesh;
}

function drawPanel(panel, lines, opts = {}) {
  const { ctx, cv, tex } = panel.userData;
  ctx.clearRect(0, 0, cv.width, cv.height);
  roundRect(ctx, 0, 0, cv.width, cv.height, 30);
  ctx.fillStyle = opts.bg || "rgba(8,14,30,0.88)";
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = opts.border || "#00d4ff";
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const n = lines.length;
  lines.forEach((ln, i) => {
    ctx.fillStyle = ln.color || "#ffffff";
    ctx.font = `bold ${ln.size || 80}px sans-serif`;
    ctx.fillText(ln.text, cv.width / 2, (cv.height * (i + 1)) / (n + 1));
  });
  tex.needsUpdate = true;
}

function updateScoreboard() {
  drawPanel(scoreBoard, [
    {
      text: "YOU  " + scorePlayer + "   —   " + scoreAI + "  AI",
      size: 90,
      color: scorePlayer >= scoreAI ? "#7CFC9A" : "#FF9B9B",
    },
  ]);
}

function showMessage(lines, bg) {
  drawPanel(msgBoard, lines, { bg });
  msgBoard.visible = true;
}
function hideMessage() {
  msgBoard.visible = false;
}

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
  ghostRacket = makeGhostRacket();
  ghostRacket.visible = false;
  racketHolder.add(ghostRacket);

  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    ctrl.userData.index = i;
    ctrl.addEventListener("selectstart", onSelectStart);
    ctrl.addEventListener("connected", (e) => {
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
    hand.addEventListener("pinchstart", onSelectStart);
    player.add(hand);
    hands.push(hand);
  }
}

// ============================================================
//  SESSION EVENTS
// ============================================================
function onSessionStart() {
  document.getElementById("overlay").style.display = "none";
  if (!audio) audio = new AudioEngine();
  audio.resume();
  audio.startAmbience();

  // Anchor world geometry to local-floor Y=0; plane-detection will refine if available
  player.position.y = 0;
  worldRoot.position.set(0, 0, 0);
  floorDetectionDone = false;
  floorDetectionTimer = 0;
  statusEl.textContent = "Detecting floor…";

  // Try bounded-floor to size court to the real room
  const session = renderer.xr.getSession();
  if (session) {
    session
      .requestReferenceSpace("bounded-floor")
      .then((bf) => {
        if (bf.boundsGeometry && bf.boundsGeometry.length >= 3) {
          let minX = Infinity,
            maxX = -Infinity,
            minZ = Infinity,
            maxZ = -Infinity;
          for (const pt of bf.boundsGeometry) {
            minX = Math.min(minX, pt.x);
            maxX = Math.max(maxX, pt.x);
            minZ = Math.min(minZ, pt.z);
            maxZ = Math.max(maxZ, pt.z);
          }
          COURT.halfWidth = Math.min((maxX - minX) * 0.4, 3.05);
          COURT.halfLen = Math.min((maxZ - minZ) * 0.4, 6.7);
          // Reposition player (Z only — Y stays 0)
          player.position.set(0, 0, COURT.halfLen - 1.4);
          oppState.pos.set(0, 0, -(COURT.halfLen - 1.6));
          oppState.target.copy(oppState.pos);
          if (opponent) {
            opponent.position.copy(oppState.pos);
          }
        }
      })
      .catch(() => {}); // bounded-floor not available — keep defaults
  }

  scorePlayer = 0;
  scoreAI = 0;
  updateScoreboard();
  hideMessage();
  ghostRacket.visible = false; // updateGhostRacket enables it once hand is tracked

  setTimeout(() => {
    gameState = STATE.SERVING;
    showMessage([
      { text: "🏸 LEFT hand = shuttle", size: 56, color: "#7CFC9A" },
      { text: "Swing RIGHT hand to serve!", size: 50, color: "#cfe0ff" },
    ]);
  }, 600);
}

function onSessionEnd() {
  document.getElementById("overlay").style.display = "flex";
  if (audio) audio.stopAmbience();
  gameState = STATE.BOOT;
  floorDetectionDone = false;
  statusEl.textContent = "";
}

function onSelectStart(event) {
  if (gameState === STATE.SERVING) {
    // Allow manual serve via trigger/pinch (right hand only)
    const src = event.target;
    const hand = hands.find((h) => h === src);
    const ctrl = controllers.find((c) => c === src);
    const isRight =
      (hand && hand.userData.handedness === "right") ||
      (ctrl && ctrl.userData.handedness === "right");
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

// Returns true when the right hand is in a grip pose (fingers curled around a handle)
function isRightHandGripping() {
  for (const hand of hands) {
    if (hand.userData.handedness !== "right") continue;
    const j = hand.joints;
    if (!j || !j["wrist"]) continue;
    const wristPos = new THREE.Vector3();
    j["wrist"].getWorldPosition(wristPos);
    // Check curl of index, middle and ring fingertips toward wrist
    const tips = ["index-finger-tip", "middle-finger-tip", "ring-finger-tip"];
    let curled = 0;
    for (const name of tips) {
      if (!j[name]) continue;
      const tp = new THREE.Vector3();
      j[name].getWorldPosition(tp);
      if (tp.distanceTo(wristPos) < 0.11) curled++; // ~11cm threshold
    }
    if (curled >= 2) return true; // at least 2 fingers curled = gripping
  }
  return false;
}

function updateGhostRacket(dt) {
  if (!renderer.xr.isPresenting) return;
  let placed = false;

  // Prefer right hand
  for (const hand of hands) {
    if (hand.userData.handedness && hand.userData.handedness !== "right")
      continue;
    const j = hand.joints;
    if (!j || !j["wrist"] || j["wrist"].position === undefined) continue;
    const wrist = j["wrist"];
    if (!wrist.visible && wrist.position.lengthSq() === 0) continue;

    wrist.getWorldPosition(_v1);
    const ref =
      j["middle-finger-metacarpal"] ||
      j["middle-finger-phalanx-proximal"] ||
      j["index-finger-metacarpal"];
    if (!ref) continue;
    ref.getWorldPosition(_v2);
    const fwd = _v2.clone().sub(_v1).normalize();
    wrist.getWorldQuaternion(_q);
    const palmNormal = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(_q)
      .normalize();
    const yAxis = fwd;
    const xAxis = new THREE.Vector3()
      .crossVectors(yAxis, palmNormal)
      .normalize();
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
      if (grip.userData.handedness && grip.userData.handedness !== "right")
        continue;
      if (
        grip.visible &&
        (grip.position.lengthSq() > 0 || grip.quaternion.w !== 1)
      ) {
        grip.getWorldPosition(racketHolder.position);
        grip.getWorldQuaternion(racketHolder.quaternion);
        racketHolder.rotateX(-Math.PI / 3);
        placed = true;
        break;
      }
    }
  }

  racketHolder.visible = placed;
  ghostRacket.visible = placed; // overlay always visible when hand is tracked

  if (placed) {
    racketHolder.updateMatrixWorld();
    racketHeadWorld
      .copy(ghostRacket.userData.headLocal)
      .applyMatrix4(racketHolder.matrixWorld);
    racketNormalWorld
      .set(0, 0, 1)
      .applyQuaternion(racketHolder.quaternion)
      .normalize();
    if (dt > 0)
      racketVel.copy(racketHeadWorld).sub(racketPrev).divideScalar(dt);
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
    if (hand.userData.handedness && hand.userData.handedness !== "left")
      continue;
    const tip = getJointWorld(hand, "wrist", _v1.clone());
    if (tip) {
      leftWristPos = tip.clone();
      break;
    }
  }

  // Fallback: left grip controller
  if (!leftWristPos) {
    for (const grip of grips) {
      if (grip.userData.handedness && grip.userData.handedness !== "left")
        continue;
      if (grip.visible && grip.position.lengthSq() > 0) {
        leftWristPos = new THREE.Vector3();
        grip.getWorldPosition(leftWristPos);
        break;
      }
    }
  }

  if (leftWristPos) {
    // Convert world-space wrist position into worldRoot's local space
    // (worldRoot is Y-shifted to the detected floor, so we must un-shift)
    const localWristPos = worldRoot.worldToLocal(leftWristPos.clone());
    // 3 cm higher so real bat clears the hand on serve
    shuttle.position.copy(localWristPos).add(new THREE.Vector3(0, 0.11, 0));
    shuttle.visible = true;
    shuttleTrail.visible = false;

    // Serve only when racket HEAD physically contacts the shuttle (proximity + speed)
    if (racketHolder.visible && racketVel.length() > SERVE_VEL_THRESH) {
      const shuttleWorldPos = new THREE.Vector3();
      shuttle.getWorldPosition(shuttleWorldPos);
      const contactDist = racketHeadWorld.distanceTo(shuttleWorldPos);
      // Generous serve zone: real bat tracking has lag/offset, needs forgiveness
      const hitZone = ghostRacket.userData.headRadius + 0.32;
      if (contactDist < hitZone) {
        serve();
      }
    }
  } else {
    // No hand detected yet — show shuttle in front of player
    camera.getWorldPosition(_v1);
    camera.getWorldDirection(_v2);
    _v2.y = 0;
    _v2.normalize();
    const shuttleWorld = _v1
      .clone()
      .addScaledVector(_v2, 0.5)
      .add(new THREE.Vector3(-0.2, -0.1, 0));
    shuttle.position.copy(worldRoot.worldToLocal(shuttleWorld));
    shuttle.visible = true;
  }
}

// ============================================================
//  NET CLEARANCE HELPER
//  Raises shuttle_v.y so the shuttle's parabolic arc clears the net at z=0.
//  pos/vel are in worldRoot-local space (worldRoot only Y-shifted, so XZ==world).
// ============================================================
function adjustForNetClearance(pos, vel) {
  if (Math.abs(vel.z) < 0.1) return;
  const tToNet = -pos.z / vel.z;
  if (tToNet <= 0 || tToNet > 5) return;
  const yAtNet = pos.y + vel.y * tToNet + 0.5 * GRAVITY * tToNet * tToNet;
  const needed = COURT.netY + 0.18; // 18 cm clearance above net tape
  if (yAtNet < needed) {
    const minVy = (needed - pos.y - 0.5 * GRAVITY * tToNet * tToNet) / tToNet;
    vel.y = Math.max(vel.y, minVy + 0.4); // small buffer
  }
}

// ============================================================
//  SERVE
// ============================================================
function serve() {
  if (gameState !== STATE.SERVING) return;
  hideMessage();

  const swingSpd = racketVel.length();
  const spd = THREE.MathUtils.clamp(swingSpd * 1.3, 4, 11); // slower — visible arc

  // Use actual racket swing direction for realistic feel
  const swingDir = racketVel.clone().normalize();
  // Guarantee forward motion toward opponent side (−Z)
  if (swingDir.z > 0) swingDir.z = -swingDir.z;
  if (Math.abs(swingDir.z) < 0.3) swingDir.z = -0.6;
  swingDir.normalize();

  shuttle_v.set(
    swingDir.x * spd,
    Math.max(swingDir.y * spd, spd * 0.22),
    swingDir.z * spd,
  );

  // Guarantee the arc clears the net
  adjustForNetClearance(shuttle.position, shuttle_v);

  shuttleActive = true;
  shuttle.visible = true;
  shuttleTrail.visible = true;
  trailPoints.length = 0;
  lastHitter = "player";
  gameState = STATE.RALLY;
  playSound("hit", 0.5);
}

// ============================================================
//  AI HIT
// ============================================================
function aiHit() {
  oppState.swingT = 0;
  playSound("hit", 0.5);

  // Pick a variety of shots: cross-court, straight, drop, smash
  const shotType = Math.random();
  let targetX, targetZ, arcFactor;
  if (shotType < 0.35) {
    // Deep baseline shot
    targetX = (Math.random() - 0.5) * (COURT.halfWidth * 1.2);
    targetZ = COURT.halfLen - 0.8 - Math.random() * 1.5;
    arcFactor = 1.2 + Math.random() * 0.4;
  } else if (shotType < 0.6) {
    // Cross-court
    const side = Math.sign(opponent.position.x) || 1;
    targetX = -side * (0.8 + Math.random() * (COURT.halfWidth - 1.0));
    targetZ = COURT.halfLen - 1.0 - Math.random() * 2.5;
    arcFactor = 1.0 + Math.random() * 0.5;
  } else if (shotType < 0.8) {
    // Drop shot (short)
    targetX = (Math.random() - 0.5) * COURT.halfWidth;
    targetZ = 1.0 + Math.random() * 1.5;
    arcFactor = 0.8 + Math.random() * 0.3;
  } else {
    // Smash
    targetX = (Math.random() - 0.5) * (COURT.halfWidth * 0.8);
    targetZ = COURT.halfLen - 0.5 - Math.random() * 2.0;
    arcFactor = 0.7 + Math.random() * 0.2;
  }

  const from = opponent.position.clone();
  from.y = 1.5;
  launchTo(from, new THREE.Vector3(targetX, 0.05, targetZ), arcFactor);

  // Ensure AI shot also clears the net
  adjustForNetClearance(shuttle.position, shuttle_v);

  lastHitter = "ai";

  // Return to center-back after hitting (standard badminton recovery)
  oppState.target.set(0, 0, -(COURT.halfLen - 1.6));
}

function launchTo(from, to, arcFactor) {
  shuttle.position.copy(from);
  const disp = to.clone().sub(from);
  const dist = new THREE.Vector3(disp.x, 0, disp.z).length();
  const flightTime = THREE.MathUtils.clamp(dist / 4.5, 0.8, 2.2) * arcFactor;
  shuttle_v.set(
    disp.x / flightTime,
    (to.y - from.y) / flightTime - 0.5 * GRAVITY * flightTime,
    disp.z / flightTime,
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
  shuttle_v.addScaledVector(
    _v3.copy(shuttle_v).multiplyScalar(-DRAG * speed),
    dt,
  );
  shuttle_v.y += GRAVITY * dt;
  shuttle.position.addScaledVector(shuttle_v, dt);

  if (speed > 0.2) {
    _q.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      _v1.copy(shuttle_v).normalize(),
    );
    shuttle.quaternion.slerp(_q, Math.min(1, dt * 12));
  }

  trailPoints.push(shuttle.position.clone());
  if (trailPoints.length > MAX_TRAIL) trailPoints.shift();
  updateTrail();

  // Player racket collision — compare in world space (shuttle lives in worldRoot)
  if (ghostRacket.visible && racketHolder.visible) {
    shuttle.getWorldPosition(_v3);
    const toShuttle = _v1.copy(_v3).sub(racketHeadWorld);
    const distToPlane = toShuttle.dot(racketNormalWorld);
    const inPlaneDist = _v2
      .copy(toShuttle)
      .addScaledVector(racketNormalWorld, -distToPlane)
      .length();
    // Trigger only when shuttle is near string bed AND racket is actively swinging at it
    const racketSwingSpeed = racketVel.length();
    const shuttleNotFleeing = shuttle_v.dot(racketNormalWorld) < 4; // not already bouncing away
    if (
      Math.abs(distToPlane) < 0.18 &&
      inPlaneDist < ghostRacket.userData.headRadius &&
      lastHitter !== "player" &&
      racketSwingSpeed > 0.5 && // racket must actually be moving
      shuttleNotFleeing
    ) {
      playerHit();
    }
  }

  // Net collision
  if (Math.abs(shuttle.position.z) < 0.08) {
    if (
      shuttle.position.y < COURT.netY &&
      shuttle.position.y > COURT.netY - COURT.netHalfH * 2 - 0.1 &&
      Math.abs(shuttle.position.x) < COURT.halfWidth + 0.2
    ) {
      shuttle_v.multiplyScalar(0.2);
      shuttle_v.z *= -0.3;
      playSound("net", 0.5);
      endRally(lastHitter === "player" ? "ai" : "player", "Into the net!");
      return;
    }
  }

  // AI movement: track shuttle toward opponent half immediately when player hits
  if (lastHitter === "player" && shuttle_v.z < 0) {
    const land = predictLanding();
    // Move to intercept — stay within court bounds
    oppState.target.x = THREE.MathUtils.clamp(
      land.x,
      -(COURT.halfWidth - 0.4),
      COURT.halfWidth - 0.4,
    );
    oppState.target.z = THREE.MathUtils.clamp(
      land.z,
      -(COURT.halfLen - 0.4),
      -1.2,
    );

    // Attempt a return hit when shuttle is in AI's court and reachable
    const reach = opponent.position.distanceTo(
      new THREE.Vector3(shuttle.position.x, 0, shuttle.position.z),
    );
    if (
      shuttle.position.z < -0.3 && // shuttle past the net
      shuttle.position.y < 2.2 &&
      shuttle.position.y > 0.18 &&
      reach < 1.6 &&
      oppState.swingT < 0
    ) {
      if (Math.random() < 0.75) aiHit();
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
    const p =
      trailPoints[i] || trailPoints[trailPoints.length - 1] || shuttle.position;
    arr[i * 3] = p.x;
    arr[i * 3 + 1] = p.y;
    arr[i * 3 + 2] = p.z;
  }
  shuttleTrail.geometry.attributes.position.needsUpdate = true;
  shuttleTrail.geometry.setDrawRange(0, trailPoints.length);
}

function playerHit() {
  const face = racketNormalWorld.clone().normalize();

  // Ensure face points toward opponent's half of court
  const toOpp = new THREE.Vector3(oppState.pos.x, 0, oppState.pos.z)
    .sub(new THREE.Vector3(shuttle.position.x, 0, shuttle.position.z))
    .normalize();
  if (face.dot(toOpp) < 0) face.negate();

  // --- Elastic collision model ---
  // Strike power = component of racket swing perpendicular to string face
  // (glancing blow = weak, clean perpendicular smash = full power)
  const strikeSpeed = Math.max(0, racketVel.dot(face));

  // Incoming shuttle speed also contributes (like real ball-racket collision)
  const incomingSpeed = Math.max(0, -shuttle_v.dot(face));

  // Combined exit speed — capped low so shuttle stays visible between hits
  const exitSpeed = THREE.MathUtils.clamp(
    strikeSpeed * 1.2 + incomingSpeed * 0.5,
    2.5,
    14,
  );

  // Direction = racket face direction (feel the angle you hit at)
  shuttle_v.copy(face).multiplyScalar(exitSpeed);

  // Physics-correct net clearance: adjust Y so parabola clears net tape
  adjustForNetClearance(shuttle.position, shuttle_v);

  lastHitter = "player";

  // Haptic & sound scale with actual strike force
  const intensity = Math.min(1.0, strikeSpeed / 10);
  playSound("hit", 0.2 + intensity * 0.8);
  haptic(intensity, 40 + Math.round(intensity * 60));
}

function predictLanding() {
  const p = shuttle.position.clone(),
    v = shuttle_v.clone();
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
  playSound("ground", 0.5);
  haptic(0.3, 30);
  const z = shuttle.position.z;
  const inX = Math.abs(shuttle.position.x) < COURT.halfWidth + 0.25;
  const inZ = Math.abs(z) < COURT.halfLen + 0.25;
  if (!inX || !inZ) {
    endRally(lastHitter === "player" ? "ai" : "player", "Out of bounds!");
    return;
  }
  endRally(z < 0 ? "player" : "ai", z < 0 ? "Point — YOU!" : "Point — AI");
}

function endRally(winner, reason) {
  shuttleActive = false;
  gameState = STATE.POINT;
  pointTimer = 0;
  if (winner === "player") {
    scorePlayer++;
    playSound("point", 0.6);
    audio && audio.cheer();
  } else if (winner === "ai") {
    scoreAI++;
    playSound("point", 0.4);
  }
  updateScoreboard();

  if (scorePlayer >= WIN_SCORE || scoreAI >= WIN_SCORE) {
    const youWin = scorePlayer >= WIN_SCORE;
    gameState = STATE.OVER;
    showMessage([
      {
        text: youWin ? "🏆 YOU WIN!" : "AI WINS",
        size: 96,
        color: youWin ? "#FFD700" : "#FF9B9B",
      },
      { text: scorePlayer + " — " + scoreAI, size: 64, color: "#ffffff" },
      { text: "Pinch to play again", size: 44, color: "#9fb4d8" },
    ]);
    if (youWin) audio && audio.cheer(1.0);
  } else {
    showMessage([
      {
        text: reason,
        size: 70,
        color:
          winner === "player"
            ? "#7CFC9A"
            : winner === "ai"
              ? "#FF9B9B"
              : "#ffffff",
      },
      {
        text: "YOU " + scorePlayer + " — " + scoreAI + " AI",
        size: 54,
        color: "#cfe0ff",
      },
    ]);
  }
}

function resetMatch() {
  scorePlayer = 0;
  scoreAI = 0;
  updateScoreboard();
  hideMessage();
  shuttle.visible = false;
  shuttleTrail.visible = false;
  gameState = STATE.SERVING;
  showMessage([
    { text: "🏸 LEFT hand = shuttle", size: 56, color: "#7CFC9A" },
    { text: "Swing RIGHT hand to serve!", size: 50, color: "#cfe0ff" },
  ]);
}

function updatePoint(dt) {
  pointTimer += dt;
  if (pointTimer > 2.2) {
    shuttle.visible = false;
    shuttleTrail.visible = false;
    hideMessage();
    gameState = STATE.SERVING;
    showMessage([
      { text: "🏸 Left hand = shuttle", size: 60, color: "#7CFC9A" },
      { text: "Swing right to serve", size: 52, color: "#cfe0ff" },
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
      try {
        gp.hapticActuators[0].pulse(intensity, ms);
      } catch (e) {}
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
  resume() {
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

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
    const g = this.ctx.createGain();
    g.connect(this.master);
    if (type === "hit") {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer(0.08);
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1800;
      bp.Q.value = 0.8;
      src.connect(bp);
      bp.connect(g);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      src.start(t);
      src.stop(t + 0.1);
    } else if (type === "net") {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer(0.15);
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 900;
      src.connect(lp);
      lp.connect(g);
      g.gain.setValueAtTime(vol * 0.8, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      src.start(t);
      src.stop(t + 0.18);
    } else if (type === "ground") {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(50, t + 0.18);
      osc.connect(g);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.start(t);
      osc.stop(t + 0.22);
    } else if (type === "point") {
      [660, 990].forEach((f, i) => {
        const osc = this.ctx.createOscillator();
        const gg = this.ctx.createGain();
        gg.connect(this.master);
        osc.type = "triangle";
        osc.frequency.value = f;
        osc.connect(gg);
        gg.gain.setValueAtTime(0, t + i * 0.1);
        gg.gain.linearRampToValueAtTime(vol * 0.5, t + i * 0.1 + 0.02);
        gg.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.3);
        osc.start(t + i * 0.1);
        osc.stop(t + i * 0.1 + 0.32);
      });
    }
  }

  startAmbience() {
    if (this.ambienceNode) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(2.0);
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    const g = this.ctx.createGain();
    g.gain.value = 0.06;
    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    src.start();
    this.ambienceNode = { src, g };
  }

  stopAmbience() {
    if (this.ambienceNode) {
      try {
        this.ambienceNode.src.stop();
      } catch (e) {}
      this.ambienceNode = null;
    }
  }

  cheer(scale = 0.5) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(1.4);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1200;
    bp.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.connect(this.master);
    src.connect(bp);
    bp.connect(g);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25 * scale, t + 0.15);
    g.gain.linearRampToValueAtTime(0.2 * scale, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    src.start(t);
    src.stop(t + 1.4);
  }
}

function playSound(type, vol) {
  if (audio) audio.play(type, vol);
}

// ============================================================
//  FLOOR DETECTION  (WebXR plane-detection → anchor worldRoot)
// ============================================================
function tryDetectFloor(frame, dt) {
  if (floorDetectionDone) return;
  floorDetectionTimer += dt;

  const refSpace = renderer.xr.getReferenceSpace();
  if (refSpace && frame.detectedPlanes && frame.detectedPlanes.size > 0) {
    let lowestY = Infinity;
    for (const plane of frame.detectedPlanes) {
      if (plane.orientation === "horizontal") {
        const pose = frame.getPose(plane.planeSpace, refSpace);
        if (pose) {
          const y = pose.transform.position.y;
          if (y < lowestY) lowestY = y;
        }
      }
    }
    if (lowestY !== Infinity) {
      worldRoot.position.y = lowestY;
      floorDetectionDone = true;
      statusEl.textContent = "";
      return;
    }
  }

  // Timeout: trust local-floor Y=0 (floor is within 20 cm of origin)
  if (floorDetectionTimer >= FLOOR_DETECT_TIMEOUT) {
    floorDetectionDone = true;
    worldRoot.position.y = 0;
    statusEl.textContent = "";
  }
}

// ============================================================
//  MAIN LOOP
// ============================================================
function loop(frame) {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (frame && renderer.xr.isPresenting) tryDetectFloor(frame, dt);

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
  // worldRoot is the Y-anchored parent for all virtual world objects;
  // its Y is adjusted to match the detected real-world floor plane.
  worldRoot = new THREE.Group();
  scene.add(worldRoot);
  buildCourt();
  buildNet();
  buildAudience();
  buildOpponent();
  buildShuttle();
  buildScoreboard();
  setupXRInputs();

  // AR button — shows passthrough so user can see their real racket
  const arBtn = ARButton.createButton(renderer, {
    requiredFeatures: ["local-floor"],
    optionalFeatures: ["hand-tracking", "bounded-floor", "plane-detection"],
  });
  document.getElementById("vrbtn").appendChild(arBtn);

  renderer.xr.addEventListener("sessionstart", onSessionStart);
  renderer.xr.addEventListener("sessionend", onSessionEnd);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop((time, frame) => loop(frame));

  if (!navigator.xr) {
    statusEl.textContent =
      "WebXR not detected. Open in the Meta Quest Browser over HTTPS.";
  } else {
    statusEl.textContent = "";
  }
}

init();
