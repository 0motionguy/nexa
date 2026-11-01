/**
 * NEXA globe engine — direct TypeScript port of app-v2.html's compact canvas
 * globe (lines 1139-1190 of the design contract).
 *
 * Renders a fibonacci-sphere dot globe with continent "caps" (lat/lon/radius
 * cones). Two modes:
 *   - dot mode: small rects, density via data-dots
 *   - ASCII mode (data-ascii): glyphs from data-glyphs (default "MAZE01")
 *
 * Canvas attributes (same contract as the prototype):
 *   data-globe            marker — auto-init targets
 *   data-dots="640"       point count
 *   data-speed="0.0001"   rotation rad/ms
 *   data-r="0.46"         radius as fraction of min(W,H)
 *   data-boost="1.3"      alpha boost
 *   data-ascii            glyph mode
 *   data-glyphs="MAZE01"  glyph set
 *   data-arcs             opt in to city-to-city flare arcs + pulses
 *
 * Theme-aware: reads data-theme from the closest [data-theme] ancestor
 * (falls back to light). Honors html.rm (reduced motion) by rendering a
 * single static frame.
 */

const CAPS: ReadonlyArray<readonly [number, number, number]> = [
  [48, -100, 22], [62, -115, 14], [74, -42, 7], [-12, -58, 17],
  [50, 12, 13], [8, 18, 20], [-22, 24, 11], [28, 45, 9],
  [52, 85, 24], [22, 78, 11], [32, 108, 14], [36, 138, 5],
  [-3, 118, 8], [-25, 134, 13],
];

/**
 * Major-city anchors for flare arcs. Coordinates picked so route pairs read
 * as real payment corridors (NYC↔LON, LIS↔SAO, SIN↔TOK, ...).
 */
const CITIES: ReadonlyArray<readonly [number, number]> = [
  [40.7, -74.0],   // NYC
  [51.5, -0.1],    // LON
  [35.7, 139.7],   // TOK
  [1.3, 103.8],    // SIN
  [25.2, 55.3],    // DUB
  [-23.5, -46.6],  // SAO
  [38.7, -9.1],    // LIS
  [19.4, -99.1],   // MEX
  [-33.9, 151.2],  // SYD
  [22.3, 114.2],   // HKG
  [48.9, 2.4],     // PAR
  [-6.2, 106.8],   // JKT
];

/**
 * Surface markers pinned to lat/lon coordinates — rotate with the globe.
 * Two kinds: city tags (orange) imply "you can transfer worldwide", user
 * handles (ink) imply "you can send money person-to-person".
 */
type MarkerKind = 'city' | 'user';
interface MarkerSpec {
  readonly lat: number;
  readonly lon: number;
  readonly label: string;
  readonly kind: MarkerKind;
}
const MARKERS: ReadonlyArray<MarkerSpec> = [
  { lat: 35.7,  lon: 139.7,  label: 'TOKYO',     kind: 'city' },
  { lat: 40.7,  lon: -74.0,  label: 'NEW YORK',  kind: 'city' },
  { lat: 51.5,  lon: -0.1,   label: 'LONDON',    kind: 'city' },
  { lat: 1.3,   lon: 103.8,  label: 'SINGAPORE', kind: 'city' },
  { lat: -23.5, lon: -46.6,  label: 'SÃO PAULO', kind: 'city' },
  { lat: 38.7,  lon: -9.1,   label: '@lena',     kind: 'user' },  // Lisbon
  { lat: 25.2,  lon: 55.3,   label: '@jonas',    kind: 'user' },  // Dubai
  { lat: -33.9, lon: 151.2,  label: '@sara',     kind: 'user' },  // Sydney
  { lat: 22.3,  lon: 114.2,  label: '@maya',     kind: 'user' },  // Hong Kong
  { lat: 19.4,  lon: -99.1,  label: '@diego',    kind: 'user' },  // Mexico
];

function ll2v(laDeg: number, loDeg: number): [number, number, number] {
  const la = (laDeg * Math.PI) / 180;
  const lo = (loDeg * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)];
}

const capV = CAPS.map((c) => ({ v: ll2v(c[0], c[1]), cos: Math.cos((c[2] * Math.PI) / 180) }));
const cityV = CITIES.map((c) => ll2v(c[0], c[1]));
const markerV = MARKERS.map((m) => ll2v(m.lat, m.lon));

/** Spherical linear interpolation along a great-circle. */
function slerp(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(d);
  if (omega < 1e-4) return [a[0], a[1], a[2]];
  const sinO = Math.sin(omega);
  const w1 = Math.sin((1 - t) * omega) / sinO;
  const w2 = Math.sin(t * omega) / sinO;
  return [a[0] * w1 + b[0] * w2, a[1] * w1 + b[1] * w2, a[2] * w1 + b[2] * w2];
}

interface Dot {
  v: [number, number, number];
  land: boolean;
  h: number;
}

interface GlobeHandle {
  /** Stop the animation loop and release the canvas. */
  destroy(): void;
}

function startGlobe(cv: HTMLCanvasElement): GlobeHandle | null {
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  const reducedMotion = document.documentElement.classList.contains('rm');
  const N = parseInt(cv.getAttribute('data-dots') ?? '500', 10);
  const SP = parseFloat(cv.getAttribute('data-speed') ?? '0.0001');
  const RF = parseFloat(cv.getAttribute('data-r') ?? '0.46');
  const BO = parseFloat(cv.getAttribute('data-boost') ?? '1.3');
  const ASCII = cv.hasAttribute('data-ascii');
  const GLYPHS = cv.getAttribute('data-glyphs') ?? 'MAZE01';
  const ARCS = cv.hasAttribute('data-arcs');
  const ARC_DUR = parseFloat(cv.getAttribute('data-arc-dur') ?? '1700');
  const ARC_GAP = parseFloat(cv.getAttribute('data-arc-gap') ?? '1300');
  const MARKERS_ON = cv.hasAttribute('data-markers');
  /** Optional `data-marker-scale="0.85"` shrinks labels on tiny mockups. */
  const MARKER_SCALE = parseFloat(cv.getAttribute('data-marker-scale') ?? '1');
  const monoFont =
    getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace';

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = 0;
  let H = 0;
  let cx = 0;
  let cy = 0;
  let R = 0;

  const GA = Math.PI * (3 - Math.sqrt(5));
  const dots: Dot[] = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = GA * i;
    const v: [number, number, number] = [Math.cos(th) * r, y, Math.sin(th) * r];
    let land = false;
    for (const cap of capV) {
      if (v[0] * cap.v[0] + v[1] * cap.v[1] + v[2] * cap.v[2] > cap.cos) {
        land = true;
        break;
      }
    }
    dots.push({ v, land, h: (((i * 2654435761) >>> 0) % 1000) / 1000 });
  }

  function size(): boolean {
    W = cv.clientWidth;
    H = cv.clientHeight;
    if (!W || !H) return false;
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2;
    cy = H / 2;
    R = Math.min(W, H) * RF;
    return true;
  }

  let rot = 0.8;
  let raf: number | null = null;
  let last = 0;
  let lastSpawn = 0;

  /** Live transaction flares between random city pairs. */
  interface Arc { from: number; to: number; born: number; }
  /** Settle pulse rendered at the arc's destination once it lands. */
  interface Pulse { v: readonly [number, number, number]; born: number; }
  const arcs: Arc[] = [];
  const pulses: Pulse[] = [];
  const PULSE_DUR = 1100;

  function isDark(): boolean {
    const themed = cv.closest<HTMLElement>('[data-theme]');
    return themed?.dataset['theme'] === 'dark';
  }

  function spawnArc(t: number): void {
    const from = Math.floor(Math.random() * CITIES.length);
    let to = Math.floor(Math.random() * CITIES.length);
    if (to === from) to = (to + 1) % CITIES.length;
    arcs.push({ from, to, born: t });
  }

  function tickArcs(t: number): void {
    if (t - lastSpawn > ARC_GAP) {
      spawnArc(t);
      lastSpawn = t;
    }
    for (let i = arcs.length - 1; i >= 0; i--) {
      const arc = arcs[i]!;
      if (t - arc.born >= ARC_DUR) {
        pulses.push({ v: cityV[arc.to]!, born: t });
        arcs.splice(i, 1);
      }
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      if (t - pulses[i]!.born >= PULSE_DUR) pulses.splice(i, 1);
    }
  }

  /** Project a unit vector to screen XY through the current rotation. */
  function project(v: readonly [number, number, number], cs: number, sn: number, radius: number)
    : { x: number; y: number; z: number } {
    const x = v[0] * cs + v[2] * sn;
    const z = -v[0] * sn + v[2] * cs;
    return { x: cx + x * radius, y: cy - v[1] * radius * 0.99, z };
  }

  function renderArc(c: CanvasRenderingContext2D, arc: Arc, t: number, cs: number, sn: number): void {
    const prog = Math.min(1, (t - arc.born) / ARC_DUR);
    const a = cityV[arc.from]!;
    const b = cityV[arc.to]!;
    const SAMPLES = 28;
    // Tail trails the head — keep last ~22% of completed path visible
    const tail = Math.max(0, prog - 0.22);
    const segs: { x: number; y: number; alpha: number }[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const t01 = tail + (prog - tail) * (i / SAMPLES);
      if (t01 > prog) break;
      const u = slerp(a, b, t01);
      // Lift the arc above the surface — peaks at midpoint
      const lift = 1 + 0.22 * Math.sin(Math.PI * t01);
      const v: [number, number, number] = [u[0] * lift, u[1] * lift, u[2] * lift];
      const p = project(v, cs, sn, R);
      if (p.z < -0.05) continue;
      const headWeight = i / SAMPLES; // 0 = tail, 1 = head
      segs.push({ x: p.x, y: p.y, alpha: headWeight });
    }
    if (segs.length < 2) return;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(1.1, R / 110);
    for (let i = 1; i < segs.length; i++) {
      const s0 = segs[i - 1]!;
      const s1 = segs[i]!;
      c.strokeStyle = `rgba(255,106,26,${(s1.alpha * 0.92).toFixed(3)})`;
      c.beginPath();
      c.moveTo(s0.x, s0.y);
      c.lineTo(s1.x, s1.y);
      c.stroke();
    }
    // Bright head
    const head = segs[segs.length - 1]!;
    c.fillStyle = 'rgba(255,106,26,0.95)';
    c.beginPath();
    c.arc(head.x, head.y, Math.max(1.4, R / 90), 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(255,106,26,0.22)';
    c.beginPath();
    c.arc(head.x, head.y, Math.max(3, R / 36), 0, Math.PI * 2);
    c.fill();
  }

  function renderPulse(c: CanvasRenderingContext2D, pulse: Pulse, t: number, cs: number, sn: number): void {
    const p = project(pulse.v, cs, sn, R);
    if (p.z < -0.05) return;
    const k = Math.min(1, (t - pulse.born) / PULSE_DUR);
    const rMin = Math.max(2, R / 60);
    const rMax = Math.max(14, R / 9);
    const radius = rMin + (rMax - rMin) * k;
    const alpha = 0.65 * (1 - k);
    c.strokeStyle = `rgba(255,106,26,${alpha.toFixed(3)})`;
    c.lineWidth = Math.max(1, R / 140);
    c.beginPath();
    c.arc(p.x, p.y, radius, 0, Math.PI * 2);
    c.stroke();
    // Inner solid dot fades to 0
    c.fillStyle = `rgba(255,106,26,${(0.85 * (1 - k)).toFixed(3)})`;
    c.beginPath();
    c.arc(p.x, p.y, Math.max(1.4, R / 90), 0, Math.PI * 2);
    c.fill();
  }

  function renderMarker(c: CanvasRenderingContext2D, i: number, cs: number, sn: number): void {
    const m = MARKERS[i]!;
    const v = markerV[i]!;
    const p = project(v, cs, sn, R);
    if (p.z < -0.05) return; // back of the sphere — hide

    // Fade in/out at the terminator (sphere edge)
    const fade = Math.min(1, Math.max(0, (p.z + 0.05) / 0.28));
    const isCity = m.kind === 'city';

    // Pill colors — orange for cities, ink for users
    const fillRgba = isCity
      ? `rgba(255,106,26,${(0.95 * fade).toFixed(3)})`
      : `rgba(10,10,12,${(0.92 * fade).toFixed(3)})`;
    const textRgba = `rgba(255,255,255,${(0.97 * fade).toFixed(3)})`;

    const fontSize = Math.max(7.5, R / 22) * MARKER_SCALE;
    c.font = `600 ${fontSize.toFixed(1)}px ${monoFont}`;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    const textWidth = c.measureText(m.label).width;
    const padX = Math.max(4, R / 55) * MARKER_SCALE;
    const padY = Math.max(2, R / 90) * MARKER_SCALE;
    const pillH = fontSize + padY * 2;
    const pillW = textWidth + padX * 2;
    const dotR = Math.max(2, R / 75) * MARKER_SCALE;

    // Stagger labels left/right so neighbours don't collide every frame.
    // City labels sit to the right of their dot, user labels to the left.
    const labelLeft = !isCity;
    const pillX = labelLeft ? p.x - dotR - 3 - pillW : p.x + dotR + 3;
    const pillY = p.y - pillH / 2;

    // Pill background
    c.fillStyle = fillRgba;
    c.beginPath();
    if (typeof c.roundRect === 'function') {
      c.roundRect(pillX, pillY, pillW, pillH, 3);
    } else {
      c.rect(pillX, pillY, pillW, pillH);
    }
    c.fill();

    // Label
    c.fillStyle = textRgba;
    c.fillText(m.label, pillX + padX, pillY + pillH / 2 + 0.5);

    // Anchor dot
    c.fillStyle = fillRgba;
    c.beginPath();
    c.arc(p.x, p.y, dotR, 0, Math.PI * 2);
    c.fill();

    // City dots get a soft halo
    if (isCity) {
      c.fillStyle = `rgba(255,106,26,${(0.22 * fade).toFixed(3)})`;
      c.beginPath();
      c.arc(p.x, p.y, dotR * 2.2, 0, Math.PI * 2);
      c.fill();
    }
  }

  function render(t: number = 0): void {
    const c = ctx!;
    c.clearRect(0, 0, W, H);
    const rgb = isDark() ? '233,234,240' : '9,10,12';
    if (ASCII) {
      c.textAlign = 'center';
      c.textBaseline = 'middle';
    }
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    for (let j = 0; j < dots.length; j++) {
      const d = dots[j]!;
      const x = d.v[0] * cs + d.v[2] * sn;
      const z = -d.v[0] * sn + d.v[2] * cs;
      if (z < -0.18) continue;
      const dep = (z + 1) / 2;
      const a = Math.min(
        1,
        (d.land ? (0.16 + dep * 0.72) * (0.55 + d.h * 0.45) : 0.04 + dep * 0.12) * BO,
      );
      const s = (d.land ? 1.15 : 0.8) * (0.6 + dep * 1.3) * (R / 120);
      c.fillStyle = `rgba(${rgb},${a.toFixed(3)})`;
      if (ASCII) {
        c.font = `${Math.max(2.1, s * 0.92).toFixed(1)}px ${monoFont}`;
        c.fillText(
          GLYPHS.charAt((j + Math.floor(d.h * 10)) % GLYPHS.length),
          cx + x * R,
          cy - d.v[1] * R * 0.99,
        );
      } else {
        c.fillRect(cx + x * R - s / 2, cy - d.v[1] * R * 0.99 - s / 2, s, s);
      }
    }
    if (ARCS) {
      for (const arc of arcs) renderArc(c, arc, t, cs, sn);
      for (const pulse of pulses) renderPulse(c, pulse, t, cs, sn);
    }
    if (MARKERS_ON) {
      for (let i = 0; i < MARKERS.length; i++) renderMarker(c, i, cs, sn);
    }
  }

  function frame(t: number): void {
    raf = requestAnimationFrame(frame);
    if (t - last < 40) return;
    rot += Math.min(80, t - last) * SP;
    last = t;
    if (ARCS) tickArcs(t);
    render(t);
  }

  function boot(): void {
    render();
    if (!reducedMotion) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  if (!size()) {
    // Canvas not laid out yet (hidden screen) — retry shortly.
    window.setTimeout(() => {
      if (size()) boot();
    }, 80);
  } else {
    boot();
  }

  return {
    destroy() {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    },
  };
}

/** Lazily boot every un-initialized [data-globe] canvas inside `root`. */
const booted = new WeakSet<HTMLCanvasElement>();

export function bootGlobesIn(root: ParentNode): void {
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-globe]').forEach((cv) => {
    if (booted.has(cv)) return;
    booted.add(cv);
    startGlobe(cv);
  });
}
