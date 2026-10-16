// Foundry in real 3D (Three.js), seen from behind your side like Clash Royale.
// A polished stainless plate on a bronze pivot beam, grounded on a steel floor, with a
// molten forge pit at each end. Pieces rise out of their owner's pit, glow red-hot when
// worked, and on a meltdown the whole line slides off the plate into the loser's pit.
//
// Set pieces marked PLACEHOLDER (presses behind the pits, the hall) are blocked out for
// placement only; they get real modelling after Zach approves the layout.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CELLS, CENTER_H } from './board';
import type { ActionKind, GameState, Player, Stack } from './rules';
import { PLATE_POINTS } from './view3d';

// ---------- dimensions (world units: one cell circumradius = 1) ----------

const SVG_R = 34; // the 2D renderer's cell radius, used to convert its plate outline
const HALF_H = Math.sqrt(3) / 2;
const PLATE_T = 0.5;
const PIECE_H = 8 / SVG_R;
const PIECE_R = 0.78;
const MAX_LAYERS = 16;
const PLATE = PLATE_POINTS.map(([x, y]) => new THREE.Vector2(x / SVG_R, y / SVG_R));
const PLATE_HALF_W = Math.max(...PLATE.map((p) => p.x));
const PLATE_HALF_L = Math.max(...PLATE.map((p) => p.y));
const FLOOR_Y = -4.2;
const PIT_Z = PLATE_HALF_L + 3.4;
const PIT_R = 2.3;
const AXLE_W = 2 * HALF_H; // the locked pipe half-width of 0.5 cell heights, full width = 1 cell height

const OWNER_COLOR: Record<Player, number> = { red: 0xff4a1c, blue: 0x2fa8ff };
const KIND_COLOR: Record<ActionKind, number> = {
  move: 0xffd34d,
  spawn: 0xffd34d,
  merge: 0x3ddc84,
  split: 0x5fd4c8,
  strike: 0xff8a3d,
  reinforce: 0x7fe0ff,
  convert: 0xc48bff,
};
const KIND_ICON: Partial<Record<ActionKind, string>> = { spawn: '+', merge: '⇊', split: '½', strike: '✕', convert: '⟳' };

/** Cell centre on the plate: x across, z toward Blue's (near) edge. */
const cellXZ = (id: number) => new THREE.Vector2((CELLS[id].col - 4) * 1.5, (CELLS[id].h - CENTER_H) * HALF_H);
const stackH = (count: number) => Math.min(count, MAX_LAYERS) * PIECE_H;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeIn = (t: number) => t * t * t;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

export interface SceneView {
  stacks: (Stack | null)[];
  holes: Set<number>;
  heat: Map<number, { heat: number; cooldown: number }>;
  lean: number;
  yaw: number;
  sources: Set<number>;
  targets: Map<number, ActionKind>;
  from: number | null;
}

export interface SceneCallbacks {
  onTap(id: number | null): void;
  onHover(id: number | null): void;
}

interface StackView {
  group: THREE.Group;
  owner: Player;
  count: number;
  material: THREE.MeshStandardMaterial;
}

interface Tween {
  start: number;
  dur: number;
  step(t: number): void;
  done?(): void;
}

// ---------- procedural textures ----------

/** Brushed stainless: fine directional streaks, used as both colour and roughness detail. */
function brushedTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b8bcc2';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const y = Math.random() * 256;
    const v = 150 + Math.random() * 100;
    g.strokeStyle = `rgba(${v},${v},${v + 4},${0.08 + Math.random() * 0.12})`;
    g.lineWidth = Math.random() < 0.9 ? 1 : 2;
    g.beginPath();
    g.moveTo(Math.random() * -40, y);
    g.lineTo(256 + Math.random() * 40, y + (Math.random() - 0.5) * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Heavy steel floor plates with seams and wear. */
function floorTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2a2a';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 6000; i++) {
    const v = 30 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v - 2},${v - 4},0.35)`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  g.strokeStyle = '#121212';
  g.lineWidth = 4;
  for (let i = 0; i <= 512; i += 128) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 512);
    g.moveTo(0, i);
    g.lineTo(512, i);
    g.stroke();
  }
  g.fillStyle = '#4a4744';
  for (let x = 8; x < 512; x += 128) for (let y = 8; y < 512; y += 128) for (const [dx, dy] of [[0, 0], [112, 0], [0, 112], [112, 112]]) g.fillRect(x + dx - 3, y + dy - 3, 6, 6);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function textSprite(text: string, color = '#ffffff', size = 0.5): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.font = 'bold 84px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(text, 64, 68);
  g.fillStyle = color;
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, toneMapped: false }));
  s.scale.set(size, size, size);
  return s;
}

/** Molten surface: drifting noise in a hot palette, bright enough to bloom. */
function lavaMaterial(hot: THREE.Color, mid: THREE.Color, crust: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, hot: { value: hot }, mid: { value: mid }, crust: { value: crust }, boost: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float time; uniform vec3 hot; uniform vec3 mid; uniform vec3 crust; uniform float boost; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
      float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*n(p); p*=2.03; a*=0.5; } return v; }
      void main(){
        vec2 p = vUv * 6.0;
        float f = fbm(p + vec2(time*0.12, -time*0.08) + fbm(p*1.7 - time*0.1));
        float r = length(vUv - 0.5) * 2.0;
        vec3 c = mix(crust, mid, smoothstep(0.35, 0.6, f));
        c = mix(c, hot, smoothstep(0.62, 0.85, f));
        c *= (1.6 - r * 0.6) * boost;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

export class Foundry3D {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  private pivot = new THREE.Group();
  private board = new THREE.Group();
  private hintGroup = new THREE.Group();
  private stackViews = new Map<number, StackView>();
  private hidden = new Set<number>();
  private hotAt = new Map<number, number>();
  private tweens: Tween[] = [];
  private pickables: THREE.Object3D[] = [];
  private wells: THREE.Mesh[] = [];
  private lavaMats: THREE.ShaderMaterial[] = [];
  private pitLights: THREE.PointLight[] = [];
  private presses: THREE.Object3D[] = [];
  private flareUntil = 0;
  private shakeUntil = 0;
  private shakeAmp = 0;
  private view: SceneView | null = null;
  private hintKey = '';
  private stackKey = '';
  private raf: number | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private downAt: { x: number; y: number } | null = null;
  private steel: THREE.MeshStandardMaterial;
  private pieceSteel: THREE.MeshStandardMaterial;
  private bronze: THREE.MeshStandardMaterial;
  private pieceGeo: THREE.BufferGeometry;
  private seamGeo: THREE.BufferGeometry;
  private sparks: { points: THREE.Points; pos: Float32Array; col: Float32Array; vel: Float32Array; life: Float32Array; next: number };
  private embers: { points: THREE.Points; pos: Float32Array; vel: Float32Array };
  private lastHover: number | null = null;

  constructor(
    private host: HTMLElement,
    private cb: SceneCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.append(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.65;
    this.scene.background = new THREE.Color(0x0a0706);
    this.scene.fog = new THREE.Fog(0x0a0706, 30, 70);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.45, 0.96));
    this.composer.addPass(new OutputPass());

    const brushed = brushedTexture();
    brushed.repeat.set(2, 2);
    this.steel = new THREE.MeshStandardMaterial({ color: 0x4e535a, metalness: 1, roughness: 0.42, map: brushed, roughnessMap: brushed });
    this.pieceSteel = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, metalness: 1, roughness: 0.16, map: brushed });
    this.bronze = new THREE.MeshStandardMaterial({ color: 0xb4793a, metalness: 1, roughness: 0.32 });

    const hex = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const p = new THREE.Vector2(Math.cos(a) * (PIECE_R - 0.03), Math.sin(a) * (PIECE_R - 0.03));
      if (i) hex.lineTo(p.x, p.y);
      else hex.moveTo(p.x, p.y);
    }
    this.pieceGeo = new THREE.ExtrudeGeometry(hex, { depth: PIECE_H - 0.05, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.03, bevelSegments: 2 });
    this.pieceGeo.rotateX(-Math.PI / 2);
    this.pieceGeo.translate(0, 0.025, 0);
    this.seamGeo = new THREE.CylinderGeometry(PIECE_R + 0.012, PIECE_R + 0.012, 0.03, 6, 1, true); // open band: shows on the sides only

    this.buildWorld();
    this.sparks = this.makeSparks();
    this.embers = this.makeEmbers();

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!this.downAt || Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 10) return;
      this.downAt = null;
      this.cb.onTap(this.pick(e.clientX, e.clientY));
    });
    el.addEventListener('pointermove', (e) => {
      const id = this.pick(e.clientX, e.clientY);
      el.style.cursor = id !== null && (this.view?.targets.has(id) || this.view?.sources.has(id)) ? 'pointer' : 'default';
      if (id !== this.lastHover) {
        this.lastHover = id;
        this.cb.onHover(id);
      }
    });
    addEventListener('resize', () => this.resize());
    this.resize();
    this.loop();
  }

  // ---------- world ----------

  private buildWorld() {
    const { scene } = this;

    // Light: a warm key from above with shadows, cool fill, and the pits glowing below.
    scene.add(new THREE.HemisphereLight(0x8a7a70, 0x140806, 0.45));
    const key = new THREE.DirectionalLight(0xfff0dd, 1.6);
    key.position.set(-6, 18, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
    key.shadow.bias = -0.0004;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6aa8ff, 0.5);
    rim.position.set(8, 6, -14);
    scene.add(rim);

    // Floor.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ map: floorTexture(), metalness: 0.7, roughness: 0.62, color: 0x9a9590 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    scene.add(floor);

    // Pivot beam (bronze), bearings and pedestals: the plate rests on the beam's top face.
    const axleLen = 2 * PLATE_HALF_W + 4.4;
    const axle = new THREE.Mesh(new THREE.BoxGeometry(axleLen, 0.8, AXLE_W), this.bronze);
    axle.position.set(0, -PLATE_T - 0.4, 0);
    axle.castShadow = axle.receiveShadow = true;
    scene.add(axle);
    for (const sx of [-1, 1]) {
      const x = sx * (PLATE_HALF_W + 1.4);
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.1, -FLOOR_Y - PLATE_T - 0.8, 1.6), this.darkSteel());
      post.position.set(x, (FLOOR_Y + (-PLATE_T - 0.8)) / 2, 0);
      post.castShadow = post.receiveShadow = true;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.35, 3), this.darkSteel());
      foot.position.set(x, FLOOR_Y + 0.17, 0);
      foot.castShadow = foot.receiveShadow = true;
      const bearing = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.3, 24), this.bronze);
      bearing.rotation.z = Math.PI / 2;
      bearing.position.set(x, -PLATE_T - 0.4, 0);
      bearing.castShadow = true;
      scene.add(post, foot, bearing);
    }

    // The plate pivots about the beam's top edge.
    this.pivot.position.set(0, -PLATE_T, 0);
    this.board.position.set(0, PLATE_T, 0);
    this.pivot.add(this.board);
    scene.add(this.pivot);

    // Stainless plate.
    const shape = new THREE.Shape(PLATE.map((p) => new THREE.Vector2(p.x, -p.y)));
    const plateGeo = new THREE.ExtrudeGeometry(shape, { depth: PLATE_T, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.08, bevelSegments: 3 });
    plateGeo.rotateX(-Math.PI / 2);
    plateGeo.translate(0, -PLATE_T - 0.06, 0); // bevel included: the top face sits exactly at y = 0
    const plate = new THREE.Mesh(plateGeo, this.steel);
    plate.receiveShadow = plate.castShadow = true;
    this.board.add(plate);

    // Machined wells for every cell, with a bright chamfer edge.
    const wellGeo = new THREE.CylinderGeometry(0.9, 0.9, 0.02, 6);
    const wellMat = new THREE.MeshStandardMaterial({ color: 0x1d1f22, metalness: 1, roughness: 0.5 });
    const edgeGeo = new THREE.RingGeometry(0.88, 0.95, 6);
    edgeGeo.rotateX(-Math.PI / 2);
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xb08850, metalness: 1, roughness: 0.25 }); // bronze inlay around each well
    const pickGeo = new THREE.CylinderGeometry(0.95, 0.95, 0.35, 6);
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const cell of CELLS) {
      const p = cellXZ(cell.id);
      const well = new THREE.Mesh(wellGeo, wellMat);
      well.rotation.y = Math.PI / 6;
      well.position.set(p.x, 0.006, p.y);
      well.receiveShadow = true;
      const edge = new THREE.Mesh(edgeGeo, edgeMat);
      edge.rotation.y = Math.PI / 6;
      edge.position.set(p.x, 0.012, p.y);
      const pick = new THREE.Mesh(pickGeo, pickMat);
      pick.rotation.y = Math.PI / 6;
      pick.position.set(p.x, 0.15, p.y);
      pick.userData.id = cell.id;
      this.board.add(well, edge, pick);
      this.wells[cell.id] = well;
      this.pickables.push(pick);
    }

    // Player rims: glowing channels along each half's edges, meeting over the pivot.
    const rimFor = (idx: number[], color: number) => {
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.8, metalness: 0.4, roughness: 0.4 });
      for (let i = 0; i < idx.length - 1; i++) {
        const a = PLATE[idx[i]].clone().multiplyScalar(0.985);
        const b = PLATE[idx[i + 1]].clone().multiplyScalar(0.985);
        const len = a.distanceTo(b);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.07, 0.1), mat);
        bar.position.set((a.x + b.x) / 2, 0.04, (a.y + b.y) / 2);
        bar.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
        this.board.add(bar);
      }
    };
    rimFor([5, 0, 1, 2], OWNER_COLOR.red);
    rimFor([2, 3, 4, 5], OWNER_COLOR.blue);

    this.board.add(this.hintGroup);

    // Forge pits: each player's base. Red's runs orange; Blue's runs white-blue hot.
    for (const [owner, z] of [['red', -PIT_Z], ['blue', PIT_Z]] as const) this.buildPit(owner, z);

    // PLACEHOLDER set pieces: a drop press behind each pit, and the hall's back wall.
    for (const [owner, z] of [['red', -PIT_Z - 1], ['blue', PIT_Z + 1]] as const) this.buildPress(owner, z);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(80, 24, 1), new THREE.MeshStandardMaterial({ color: 0x1a1412, metalness: 0.5, roughness: 0.8 }));
    wall.position.set(0, FLOOR_Y + 12, -34);
    scene.add(wall);
  }

  private darkSteel() {
    return new THREE.MeshStandardMaterial({ color: 0x4a4c50, metalness: 0.95, roughness: 0.38 });
  }

  private buildPit(owner: Player, z: number) {
    const crucible = new THREE.Mesh(
      new THREE.LatheGeometry(
        [new THREE.Vector2(PIT_R - 0.1, 0), new THREE.Vector2(PIT_R + 0.5, 0), new THREE.Vector2(PIT_R + 0.65, 0.9), new THREE.Vector2(PIT_R + 0.3, 1.05), new THREE.Vector2(PIT_R, 0.75)],
        48,
      ),
      this.bronze,
    );
    crucible.position.set(0, FLOOR_Y, z);
    crucible.castShadow = crucible.receiveShadow = true;
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(PIT_R + 0.55, 0.06, 8, 64),
      new THREE.MeshStandardMaterial({ color: OWNER_COLOR[owner], emissive: OWNER_COLOR[owner], emissiveIntensity: 2.2 }),
    );
    band.rotation.x = Math.PI / 2;
    band.position.set(0, FLOOR_Y + 0.55, z);
    const lavaMat =
      owner === 'red'
        ? lavaMaterial(new THREE.Color(3.2, 2.2, 0.9), new THREE.Color(2.2, 0.55, 0.1), new THREE.Color(0.25, 0.04, 0.02))
        : lavaMaterial(new THREE.Color(2.4, 2.8, 3.4), new THREE.Color(0.6, 1.3, 2.6), new THREE.Color(0.05, 0.08, 0.2));
    const lava = new THREE.Mesh(new THREE.CircleGeometry(PIT_R, 48), lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(0, FLOOR_Y + 0.7, z);
    const light = new THREE.PointLight(owner === 'red' ? 0xff6a1f : 0x6ac8ff, 26, 13, 1.8);
    light.position.set(0, FLOOR_Y + 2.2, z);
    this.scene.add(crucible, band, lava, light);
    this.lavaMats.push(lavaMat);
    this.pitLights.push(light);
  }

  /** PLACEHOLDER: a blocked-out drop press behind each pit (to be modelled properly). */
  private buildPress(owner: Player, z: number) {
    const g = new THREE.Group();
    const frame = this.darkSteel();
    for (const sx of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.9, 9, 0.9), frame);
      col.position.set(sx * 2.4, 4.5, 0);
      col.castShadow = true;
      g.add(col);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(6, 1, 1.4), frame);
    head.position.y = 9;
    const ram = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 1.6), this.bronze);
    ram.position.y = 5;
    ram.castShadow = true;
    const anvil = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 2), frame);
    anvil.position.y = 0.6;
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.08, 1.4),
      new THREE.MeshStandardMaterial({ color: OWNER_COLOR[owner], emissive: OWNER_COLOR[owner], emissiveIntensity: 2 }),
    );
    glow.position.y = 1.24;
    g.add(head, ram, anvil, glow);
    g.position.set(owner === 'red' ? -9.5 : 9.5, FLOOR_Y, z);
    g.userData.ram = ram;
    g.userData.phase = owner === 'red' ? 0 : 1.3;
    this.scene.add(g);
    this.presses.push(g);
  }

  // ---------- particles ----------

  private makeSparks() {
    const n = 2500;
    const pos = new Float32Array(n * 3).fill(-999);
    const col = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.09, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    points.frustumCulled = false;
    this.scene.add(points);
    return { points, pos, col, vel: new Float32Array(n * 3), life: new Float32Array(n), next: 0 };
  }

  private makeEmbers() {
    const n = 260;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n);
    for (let i = 0; i < n; i++) this.resetEmber(pos, vel, i, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.07, color: 0xffa040, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85, toneMapped: false }));
    points.frustumCulled = false;
    this.scene.add(points);
    return { points, pos, vel };
  }

  private resetEmber(pos: Float32Array, vel: Float32Array, i: number, anywhere = false) {
    const z = (Math.random() < 0.5 ? -1 : 1) * PIT_Z;
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * PIT_R;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = FLOOR_Y + 0.8 + (anywhere ? Math.random() * 14 : 0);
    pos[i * 3 + 2] = z + Math.sin(a) * r;
    vel[i] = 0.6 + Math.random() * 1.6;
  }

  /** Burst of sparks at a world position. */
  private burst(at: THREE.Vector3, n: number, opts: { speed?: number; up?: number; color?: THREE.Color[] } = {}) {
    const s = this.sparks;
    const colors = opts.color ?? [new THREE.Color(3, 2.4, 1.2), new THREE.Color(3, 1.4, 0.4), new THREE.Color(2.6, 0.7, 0.15)];
    for (let k = 0; k < n; k++) {
      const i = s.next;
      s.next = (s.next + 1) % s.life.length;
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed ?? 5) * (0.3 + Math.random());
      s.pos.set([at.x, at.y, at.z], i * 3);
      s.vel.set([Math.cos(a) * sp, (opts.up ?? 4) * Math.random() + 1, Math.sin(a) * sp], i * 3);
      const c = colors[Math.floor(Math.random() * colors.length)];
      s.col.set([c.r, c.g, c.b], i * 3);
      s.life[i] = 0.5 + Math.random() * 0.7;
    }
  }

  // ---------- public ----------

  flare(ms = 2400) {
    this.flareUntil = performance.now() + ms;
  }

  shake(amp: number, ms = 220) {
    this.shakeAmp = amp;
    this.shakeUntil = performance.now() + ms;
  }

  setActive(on: boolean) {
    this.host.style.display = on ? 'block' : 'none';
    if (on && this.raf === null) this.loop();
    if (!on && this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  clear() {
    this.tweens = [];
    this.hidden.clear();
    this.hotAt.clear();
    this.stackKey = '';
    for (const [, v] of this.stackViews) this.board.remove(v.group);
    this.stackViews.clear();
  }

  update(view: SceneView) {
    this.view = view;
    this.pivot.rotation.x = view.lean;
    this.syncStacks();
    this.syncHints();
  }

  // ---------- board contents ----------

  private worldOnBoard(x: number, y: number, z: number) {
    return this.board.localToWorld(new THREE.Vector3(x, y, z));
  }

  private buildStack(owner: Player, count: number): StackView {
    const group = new THREE.Group();
    const material = this.pieceSteel.clone();
    material.emissive = new THREE.Color(0xff5a10);
    material.emissiveIntensity = 0;
    const seam = new THREE.MeshStandardMaterial({ color: OWNER_COLOR[owner], emissive: OWNER_COLOR[owner], emissiveIntensity: 1.1 });
    const layers = Math.min(count, MAX_LAYERS);
    for (let i = 0; i < layers; i++) {
      const piece = new THREE.Mesh(this.pieceGeo, material);
      piece.position.y = i * PIECE_H;
      piece.rotation.y = Math.PI / 6;
      piece.castShadow = piece.receiveShadow = true;
      group.add(piece);
      if (i < layers - 1) {
        const line = new THREE.Mesh(this.seamGeo, seam);
        line.position.y = (i + 1) * PIECE_H;
        line.rotation.y = Math.PI / 6;
        group.add(line);
      }
    }
    // The owner's colour as a glowing outline around the top piece and a band at the base.
    const outline = new THREE.Mesh(new THREE.RingGeometry(PIECE_R - 0.07, PIECE_R + 0.01, 6), seam);
    outline.rotation.set(-Math.PI / 2, 0, Math.PI / 6);
    outline.position.y = stackH(count) + 0.006;
    const base = new THREE.Mesh(this.seamGeo, seam);
    base.position.y = 0.015;
    base.rotation.y = Math.PI / 6;
    group.add(outline, base);
    const label = textSprite(String(count), '#ffffff', 1.25);
    label.position.y = stackH(count) + 0.7;
    group.add(label);
    group.traverse((o) => (o.userData.stack = true));
    return { group, owner, count, material };
  }

  private syncStacks() {
    const v = this.view!;
    const key = v.stacks.map((s, i) => (s && !this.hidden.has(i) ? `${s.owner[0]}${s.count}` : '')).join(',') + `|${v.from}`;
    if (key === this.stackKey) return;
    this.stackKey = key;
    for (const [id, sv] of this.stackViews) {
      const s = v.stacks[id];
      if (!s || this.hidden.has(id) || s.owner !== sv.owner || s.count !== sv.count) {
        this.board.remove(sv.group);
        this.stackViews.delete(id);
      }
    }
    v.stacks.forEach((s, id) => {
      if (!s || this.hidden.has(id) || this.stackViews.has(id)) return;
      const sv = this.buildStack(s.owner, s.count);
      const p = cellXZ(id);
      sv.group.position.set(p.x, 0.02, p.y);
      sv.group.traverse((o) => (o.userData.id = id));
      this.board.add(sv.group);
      this.stackViews.set(id, sv);
    });
    for (const [id, sv] of this.stackViews) sv.group.position.y = id === v.from ? 0.18 : 0.02;
    // Holes: the well becomes a black drop with a hot torn edge.
    v.holes.forEach((id) => {
      const w = this.wells[id];
      if (w && !w.userData.hole) {
        w.userData.hole = true;
        w.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
        const edge = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.95, 6), new THREE.MeshStandardMaterial({ color: 0xff5a10, emissive: 0xff5a10, emissiveIntensity: 2.5 }));
        edge.rotation.set(-Math.PI / 2, 0, Math.PI / 6);
        edge.position.copy(w.position).setY(0.02);
        this.board.add(edge);
      }
    });
  }

  private syncHints() {
    const v = this.view!;
    const key = [...v.sources].join(',') + '|' + [...v.targets].map(([i, k]) => `${i}${k}`).join(',') + '|' + v.from + '|' + [...v.heat].map(([i, h]) => `${i}:${h.heat}:${h.cooldown}`).join(',');
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hintGroup.clear();
    const ring = (id: number, color: number, inner: number, outer: number, y: number, intensity: number) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 6), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, transparent: true, opacity: 0.95, depthWrite: false }));
      const p = cellXZ(id);
      m.rotation.set(-Math.PI / 2, 0, Math.PI / 6);
      m.position.set(p.x, y, p.y);
      m.userData.id = id;
      this.hintGroup.add(m);
      return m;
    };
    const topOf = (id: number) => (v.stacks[id] ? stackH(v.stacks[id]!.count) + 0.03 : 0.03);
    for (const id of v.sources) ring(id, 0xffd34d, 0.82, 0.93, 0.03, 1.2).userData.pulse = true;
    if (v.from !== null) ring(v.from, 0xffd34d, 0.78, 0.97, 0.03, 3);
    for (const [id, kind] of v.targets) {
      ring(id, KIND_COLOR[kind], 0.7, 0.9, topOf(id), 2.4);
      const p = cellXZ(id);
      if (kind === 'move' && !v.stacks[id]) {
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.18, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(KIND_COLOR.move).multiplyScalar(2.5), toneMapped: false }));
        dot.rotation.x = -Math.PI / 2;
        dot.position.set(p.x, 0.04, p.y);
        dot.userData.id = id;
        this.hintGroup.add(dot);
      }
      const icon = KIND_ICON[kind];
      if (icon) {
        const s = textSprite(icon, `#${KIND_COLOR[kind].toString(16).padStart(6, '0')}`, 0.7);
        s.position.set(p.x, topOf(id) + (v.stacks[id] ? 0.95 : 0.45), p.y);
        s.userData.id = id;
        this.hintGroup.add(s);
      }
    }
    // Overheat: spawn slots glow by heat; locked ones show the turns left.
    for (const [id, h] of v.heat) {
      if (h.cooldown > 0) {
        ring(id, 0xff3a0a, 0.5, 0.95, 0.025, 3.5);
        if (h.cooldown > 1) {
          const p = cellXZ(id);
          const s = textSprite(String(h.cooldown - 1), '#ffd9a8', 0.6);
          s.position.set(p.x, topOf(id) + 1.1, p.y);
          this.hintGroup.add(s);
        }
      } else if (h.heat > 0) ring(id, 0xff8a2a, 0.75, 0.95, 0.025, h.heat);
    }
  }

  // ---------- picking ----------

  private pick(clientX: number, clientY: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // Targets win over stacks so a tall stack never blocks the tile behind it.
    const hint = this.raycaster.intersectObjects(this.hintGroup.children, false).find((h) => h.object.userData.id !== undefined);
    if (hint && this.view?.targets.has(hint.object.userData.id)) return hint.object.userData.id;
    const hits = this.raycaster.intersectObjects([...this.pickables, ...[...this.stackViews.values()].map((s) => s.group)], true);
    const hit = hits.find((h) => h.object.userData.id !== undefined);
    return hit ? hit.object.userData.id : null;
  }

  // ---------- animation ----------

  private heat(id: number) {
    this.hotAt.set(id, performance.now());
  }

  private tween(dur: number, step: (t: number) => void, done?: () => void, delay = 0) {
    this.tweens.push({ start: performance.now() + delay, dur, step, done });
  }

  /** A temporary stack (owned by the board group) that animations move around. */
  private ghost(owner: Player, count: number, glow = 0) {
    const sv = this.buildStack(owner, count);
    sv.material.emissiveIntensity = glow;
    this.board.add(sv.group);
    return sv;
  }

  /** The animation for whatever changed between two states. */
  play(prev: GameState, next: GameState) {
    const la = next.lastAction;
    if (la && la.seq !== prev.lastAction?.seq) this.playAction(prev, next);
    if (next.phase === 'over' && prev.phase !== 'over') setTimeout(() => this.meltdown(next), 700);
  }

  private reveal(id: number) {
    this.hidden.delete(id);
    this.stackKey = '';
    if (this.view) this.syncStacks();
  }

  private hide(id: number) {
    this.hidden.add(id);
    this.stackKey = '';
    if (this.view) this.syncStacks();
    // Safety: never leave a stack hidden if an animation is interrupted.
    setTimeout(() => this.hidden.has(id) && this.reveal(id), 2500);
  }

  private playAction(prev: GameState, next: GameState) {
    const la = next.lastAction!;
    const a = la.action;
    const owner = la.player;
    const to = cellXZ(a.to);
    const after = (id: number) => next.stacks[id]?.count ?? 0;

    switch (a.kind) {
      case 'spawn': {
        // The piece rises out of the owner's forge pit and arcs onto the slot.
        const base = la.before.to ?? 0;
        if (!base) this.hide(a.to);
        const pitWorld = new THREE.Vector3(0, FLOOR_Y + 0.7, owner === 'red' ? -PIT_Z : PIT_Z);
        const start = this.board.worldToLocal(pitWorld.clone());
        const g = this.ghost(owner, 1, 3);
        this.burst(pitWorld, 30, { up: 6 });
        this.tween(
          900,
          (t) => {
            const e = easeInOut(t);
            g.group.position.set(start.x + (to.x - start.x) * e, start.y + (stackH(base) - start.y) * e + Math.sin(Math.PI * e) * 4.5, start.z + (to.y - start.z) * e);
            g.group.rotation.y = (1 - e) * Math.PI * 2;
            g.material.emissiveIntensity = 3 * (1 - e * 0.5);
          },
          () => {
            this.board.remove(g.group);
            this.reveal(a.to);
            this.heat(a.to);
            this.burst(this.worldOnBoard(to.x, stackH(after(a.to)), to.y), 24, { speed: 3 });
            this.shake(0.06);
          },
        );
        break;
      }
      case 'reinforce':
        this.hammer(a.to, after(a.to), () => {
          this.heat(a.to);
          this.burst(this.worldOnBoard(to.x, stackH(after(a.to)), to.y), 50, { speed: 6 });
          this.shake(0.14);
        });
        break;
      case 'move':
      case 'merge': {
        const from = cellXZ(a.from);
        const base = a.kind === 'merge' ? la.before.to ?? 0 : 0;
        this.hide(a.to);
        const g = this.ghost(owner, la.before.from ?? 1);
        const lift = a.kind === 'move' && a.jump ? 2 : 1;
        this.tween(
          560,
          (t) => {
            const e = easeInOut(t);
            g.group.position.set(from.x + (to.x - from.x) * e, stackH(base) * e + Math.sin(Math.PI * e) * lift, from.y + (to.y - from.y) * e);
          },
          () => {
            this.board.remove(g.group);
            this.reveal(a.to);
            const at = this.worldOnBoard(to.x, stackH(base), to.y);
            if (a.kind === 'merge') {
              this.heat(a.to);
              this.weldFlash(at);
            } else this.burst(at, 12, { speed: 2, up: 1 });
          },
        );
        break;
      }
      case 'split': {
        const from = cellXZ(a.from);
        const total = la.before.from ?? 2;
        const half = Math.floor(total / 2);
        this.hide(a.to);
        const cut = this.worldOnBoard(from.x, stackH(total - half), from.y);
        for (let i = 0; i < 8; i++) setTimeout(() => this.burst(cut, 8, { speed: 6, up: 1, color: [new THREE.Color(3, 3, 3), new THREE.Color(3, 2.6, 1.2)] }), i * 45);
        const g = this.ghost(owner, half, 1.5);
        this.tween(
          560,
          (t) => {
            const e = easeInOut(t);
            g.group.position.set(from.x + (to.x - from.x) * e, stackH(total - half) * (1 - e) + Math.sin(Math.PI * e) * 0.8, from.y + (to.y - from.y) * e);
          },
          () => {
            this.board.remove(g.group);
            this.reveal(a.to);
            this.heat(a.to);
            this.heat(a.from);
          },
          300,
        );
        break;
      }
      case 'strike': {
        const victim = prev.stacks[a.to]?.owner ?? (owner === 'red' ? 'blue' : 'red');
        const left = after(a.to);
        this.hammer(a.to, left, () => {
          this.burst(this.worldOnBoard(to.x, stackH(left), to.y), 60, { speed: 7 });
          this.shake(0.18);
          // The knocked-off piece flies into the victim's own pit.
          const pit = this.board.worldToLocal(new THREE.Vector3(0, FLOOR_Y + 0.7, victim === 'red' ? -PIT_Z : PIT_Z));
          const chip = this.ghost(victim, 1, 2);
          const sx = to.x;
          const sy = stackH(left);
          const sz = to.y;
          this.tween(
            900,
            (t) => {
              chip.group.position.set(sx + (pit.x - sx) * t, sy + (pit.y - sy) * t + Math.sin(Math.PI * t) * 4, sz + (pit.z - sz) * t);
              chip.group.rotation.x = t * 8;
            },
            () => {
              this.board.remove(chip.group);
              this.burst(new THREE.Vector3(0, FLOOR_Y + 0.8, victim === 'red' ? -PIT_Z : PIT_Z), 40, { up: 7 });
            },
          );
        });
        break;
      }
      case 'convert': {
        this.heat(a.to);
        const wave = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xc48bff).multiplyScalar(2.5), transparent: true, toneMapped: false }));
        wave.rotation.x = -Math.PI / 2;
        wave.position.set(to.x, 0.05, to.y);
        this.board.add(wave);
        this.tween(
          700,
          (t) => {
            wave.scale.setScalar(1 + t * 3);
            (wave.material as THREE.MeshBasicMaterial).opacity = 1 - t;
          },
          () => this.board.remove(wave),
        );
        this.burst(this.worldOnBoard(to.x, stackH(after(a.to)), to.y), 30, { color: [new THREE.Color(2.6, 2.2, 3), new THREE.Color(1.6, 0.9, 2.6)] });
        break;
      }
    }

    // Breakthroughs: the overloaded tower drops through the plate.
    la.broke.forEach((b, i) => {
      const p = cellXZ(b.id);
      const g = this.ghost(b.owner, b.count, 1);
      this.tween(
        1000,
        (t) => {
          g.group.position.set(p.x, -t * t * 9, p.y);
          g.material.emissiveIntensity = 1 + t * 3;
        },
        () => {
          this.board.remove(g.group);
          this.burst(this.worldOnBoard(p.x, -8, p.y), 60, { up: 6 });
          this.flare(1500);
          this.shake(0.2);
        },
        450 + i * 200,
      );
    });
  }

  /** A drop hammer comes down onto a stack from above. */
  private hammer(id: number, topCount: number, onImpact: () => void) {
    const p = cellXZ(id);
    const g = new THREE.Group();
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 12, 16), this.darkSteel());
    rod.position.y = 6.6;
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.9, 1.7), this.bronze);
    head.position.y = 0.45;
    head.castShadow = true;
    const face = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 1.6), new THREE.MeshStandardMaterial({ color: 0x552010, emissive: 0xff5a10, emissiveIntensity: 0 }));
    face.position.y = 0.03;
    g.add(rod, head, face);
    this.board.add(g);
    const top = stackH(topCount) + 0.02;
    let struck = false;
    this.tween(
      850,
      (t) => {
        const hit = 0.4;
        const pos = t < hit ? easeIn(t / hit) : t < hit + 0.14 ? 1 : 1 - easeInOut((t - hit - 0.14) / (1 - hit - 0.14));
        g.position.set(p.x, top + (1 - pos) * 7, p.y);
        if (!struck && t >= hit) {
          struck = true;
          onImpact();
        }
        (face.material as THREE.MeshStandardMaterial).emissiveIntensity = struck ? Math.max(0, 3 * (1 - (t - hit) * 3)) : 0;
      },
      () => this.board.remove(g),
    );
  }

  private weldFlash(at: THREE.Vector3) {
    const light = new THREE.PointLight(0xbfe3ff, 0, 6, 2);
    light.position.copy(at).add(new THREE.Vector3(0, 0.4, 0));
    this.scene.add(light);
    this.tween(
      500,
      (t) => {
        light.intensity = 40 * (1 - t) * (0.6 + Math.random() * 0.4);
        if (Math.random() < 0.7) this.burst(at, 6, { speed: 4, up: 2, color: [new THREE.Color(3, 3, 3), new THREE.Color(1.8, 2.4, 3)] });
      },
      () => this.scene.remove(light),
    );
  }

  /** The plate has tipped: every stack slides off the low edge into the loser's pit. */
  private meltdown(state: GameState) {
    const down = state.loser === 'blue' ? 1 : -1;
    const pitWorld = new THREE.Vector3(0, FLOOR_Y + 0.7, down * PIT_Z);
    const ids = state.stacks.map((s, id) => (s ? id : -1)).filter((id) => id >= 0).sort((a, b) => down * (cellXZ(b).y - cellXZ(a).y));
    ids.forEach((id, i) => {
      const s = state.stacks[id]!;
      this.hide(id);
      const p = cellXZ(id);
      const g = this.ghost(s.owner, s.count);
      g.group.position.set(p.x, 0.02, p.y);
      const edge = down * (PLATE_HALF_L + 0.6);
      let falling: THREE.Vector3 | null = null;
      let fallFrom: THREE.Vector3 | null = null;
      this.tween(
        1500,
        (t) => {
          if (t < 0.5) {
            const e = easeIn(t / 0.5);
            g.group.position.set(p.x, 0.02, p.y + (edge - p.y) * e);
          } else {
            if (!falling) {
              fallFrom = this.board.localToWorld(g.group.position.clone());
              this.board.remove(g.group);
              this.scene.add(g.group);
              falling = pitWorld.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2.4, 0, (Math.random() - 0.5) * 1.6));
            }
            const e = (t - 0.5) / 0.5;
            g.group.position.set(fallFrom!.x + (falling.x - fallFrom!.x) * e, fallFrom!.y + (falling.y - fallFrom!.y) * e * e, fallFrom!.z + (falling.z - fallFrom!.z) * e);
            g.group.rotation.x += 0.06 * down;
            g.material.emissiveIntensity = 3 * e;
          }
        },
        () => {
          this.scene.remove(g.group);
          this.board.remove(g.group);
          this.burst(pitWorld, 30, { up: 8, speed: 4 });
        },
        i * 80,
      );
    });
    setTimeout(() => {
      this.flare(3500);
      this.shake(0.3, 600);
    }, 900);
  }

  // ---------- frame ----------

  private resize() {
    const w = this.host.clientWidth || innerWidth;
    const h = this.host.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private placeCamera(now: number) {
    const yaw = this.view?.yaw ?? 0;
    // Clash Royale angle: high behind your edge, looking down the arena toward the rival pit.
    const aspect = this.camera.aspect;
    const back = 33 * Math.max(1, 1.45 / aspect);
    const pos = new THREE.Vector3(0, back * 1.02, back * 0.78);
    pos.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    if (now < this.shakeUntil) pos.add(new THREE.Vector3((Math.random() - 0.5) * this.shakeAmp, (Math.random() - 0.5) * this.shakeAmp, 0));
    this.camera.position.copy(pos);
    const look = new THREE.Vector3(0, FLOOR_Y * 0.4, 1.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.camera.lookAt(look);
  }

  private loop() {
    let last = performance.now();
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      this.placeCamera(now);

      // Tweens.
      this.tweens = this.tweens.filter((tw) => {
        if (now < tw.start) return true;
        const k = clamp01((now - tw.start) / tw.dur);
        tw.step(k);
        if (k >= 1) {
          tw.done?.();
          return false;
        }
        return true;
      });

      // Red-hot metal cools over 2.6 s.
      for (const [id, at] of this.hotAt) {
        const sv = this.stackViews.get(id);
        const k = 1 - (now - at) / 2600;
        if (k <= 0) {
          this.hotAt.delete(id);
          if (sv) sv.material.emissiveIntensity = 0;
        } else if (sv) sv.material.emissiveIntensity = 2.6 * k * k;
      }

      // Pulsing source rings.
      for (const m of this.hintGroup.children) if (m.userData.pulse) ((m as THREE.Mesh).material as THREE.MeshStandardMaterial).emissiveIntensity = 0.8 + 0.7 * Math.sin(t * 4);

      // Molten pits, lights, presses.
      const flare = Math.max(0, (this.flareUntil - now) / 2400);
      for (const m of this.lavaMats) {
        m.uniforms.time.value = t;
        m.uniforms.boost.value = 1 + flare * 1.2;
      }
      this.pitLights.forEach((l, i) => (l.intensity = (26 + Math.sin(t * 7 + i * 2) * 3 + Math.sin(t * 13.1 + i) * 2) * (1 + flare * 2.5)));
      for (const p of this.presses) {
        const c = ((t + p.userData.phase) % 2.8) / 2.8;
        const pos = c < 0.82 ? c / 0.82 : 1 - (c - 0.82) / 0.18;
        p.userData.ram.position.y = 1.9 + pos * 6;
      }

      // Embers rising out of the pits.
      const ep = this.embers.pos;
      for (let i = 0; i < this.embers.vel.length; i++) {
        ep[i * 3 + 1] += this.embers.vel[i] * dt;
        ep[i * 3] += Math.sin(t + i) * 0.3 * dt;
        if (ep[i * 3 + 1] > FLOOR_Y + 16) this.resetEmber(ep, this.embers.vel, i);
      }
      this.embers.points.geometry.attributes.position.needsUpdate = true;

      // Sparks.
      const s = this.sparks;
      for (let i = 0; i < s.life.length; i++) {
        if (s.life[i] <= 0) continue;
        s.life[i] -= dt;
        if (s.life[i] <= 0) {
          s.pos[i * 3 + 1] = -999;
          continue;
        }
        s.vel[i * 3 + 1] -= 14 * dt;
        s.pos[i * 3] += s.vel[i * 3] * dt;
        s.pos[i * 3 + 1] += s.vel[i * 3 + 1] * dt;
        s.pos[i * 3 + 2] += s.vel[i * 3 + 2] * dt;
      }
      s.points.geometry.attributes.position.needsUpdate = true;
      s.points.geometry.attributes.color.needsUpdate = true;

      this.composer.render();
    };
    this.raf = requestAnimationFrame(frame);
  }
}
