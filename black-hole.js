/*!
 * event-horizon · a black hole you can drop into any web page
 * <black-hole></black-hole>
 *
 * Every pixel fires a ray of light backwards from the camera and integrates its path through the curved space
 * around a Schwarzschild black hole (RK4). Where the ray crosses the accretion disk, the disk's light is added;
 * where it falls below the horizon, nothing comes back; where it escapes, it picks up the (lensed) star field.
 * The halo arching over the shadow and the thin ring hugging it are the far side of the disk, seen through bent
 * light. Nothing is painted on.
 *
 * Full resolution, cheaply: the bent light paths depend only on where the camera is, not on time. So while the
 * camera holds still the paths are traced once, at full screen resolution, a strip at a time, and stored; every
 * frame after that only re-shades the moving gas and the stars from them. While the camera moves, a fast live
 * tracer runs at a fixed pixel budget and is scaled up. The slow auto-orbit turns the disk and sky instead of the
 * camera (the scene is symmetric about the hole's axis), so it never forces a re-trace.
 *
 * Units: the Schwarzschild radius is 1. The photon sphere sits at 1.5, the shadow looks 2.6 wide, and the
 * innermost stable orbit (where the disk starts) is 3.
 *
 * MIT License · (c) 2026 Miles Gurule · https://github.com/milesgurule-png/event-horizon
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.customElements || customElements.get('black-hole')) return;

  /* ---------- shaders ---------- */

  // shared by every pass; GLSL ES 1.0 and 3.0 compatible
  var COMMON = [
    'uniform float uTime, uInner, uOuter, uSpin, uDoppler, uStars, uTemp, uSat, uAzOff;',
    'uniform vec3 uTint;',
    'float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }',
    'float noise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}',
    'float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.07 + 17.3; a *= 0.5; } return s; }',
    // blackbody colour for a temperature in kelvin (a fit to the Planck curve, good from 1,000 K to 40,000 K)
    'vec3 blackbody(float t) {',
    '  t = clamp(t, 1000.0, 40000.0) / 100.0;',
    '  float r = t <= 66.0 ? 1.0 : 1.292936 * pow(t - 60.0, -0.1332047);',
    '  float g = t <= 66.0 ? 0.3900816 * log(t) - 0.6318414 : 1.129891 * pow(t - 60.0, -0.0755148);',
    '  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : 0.5432068 * log(t - 10.0) - 1.1962541);',
    '  return clamp(vec3(r, g, b), 0.0, 1.0);',
    '}',
    // the disk is drawn as rigid rings, each turning at its own Kepler rate. Blending two neighbouring rings
    // hides the seams, and because no ring ever shears, the pattern never winds itself into noise over time.
    'float ringTex(float r, float phi, float band) {',
    '  float rb = band / 3.0 + uInner;',
    '  float a = phi + uSpin * uTime * 1.6 * pow(uInner / rb, 1.5);',
    '  vec2 q = vec2(cos(a), sin(a)) * 1.25 + vec2(r * 3.1, r * -1.9) + band * 3.17;',
    '  float n = fbm(q);',
    '  float clump = noise(vec2(cos(a), sin(a)) * 2.6 + band * 1.9 + 40.0);',
    '  return smoothstep(0.18, 0.95, n) * (0.55 + 1.3 * clump);',
    '}',
    'float diskEdge(float r) { return smoothstep(uInner, uInner * 1.06, r) * (1.0 - smoothstep(uOuter * 0.62, uOuter, r)); }',
    // relativistic beaming for gas on a circular orbit at p, seen along ray direction dir: Doppler x gravitational redshift
    'float beamG(vec3 p, vec3 dir) {',
    '  float r = length(p.xz);',
    '  vec3 v = normalize(vec3(-p.z, 0.0, p.x));',
    '  float beta = min(0.95, sqrt(0.5 / (r - 1.0)));',
    '  float gamma = inversesqrt(1.0 - beta * beta);',
    '  return sqrt(1.0 - 1.0 / r) / (gamma * (1.0 - beta * dot(v, -dir)));',
    '}',
    // shade one disk crossing from its radius, angle (in the disk\'s own frame) and raw beaming factor
    'vec4 diskShade(float r, float phi, float gRaw) {',
    '  float x = r / uInner;',
    // thin-disk temperature: rises from zero at the inner edge, peaks just outside it, falls as r^-3/4
    '  float prof = pow(x, -0.75) * pow(max(1.0 - inversesqrt(x), 0.0), 0.25);',
    '  float temp = uTemp * prof / 0.488;',
    '  phi -= uAzOff;',
    '  float bf = (r - uInner) * 3.0, b0 = floor(bf);',
    '  float tex = mix(ringTex(r, phi, b0), ringTex(r, phi, b0 + 1.0), smoothstep(0.0, 1.0, fract(bf)));',
    '  float g = mix(1.0, gRaw, uDoppler);',
    '  float tObs = temp * g;',
    '  vec3 col = mix(vec3(dot(blackbody(tObs), vec3(0.3, 0.55, 0.15))), blackbody(tObs), uSat) * uTint;',
    '  float lum = pow(g, 3.0) * pow(prof / 0.488, 3.4) * (0.45 + tex);',
    '  float alpha = clamp((0.1 + 0.75 * tex) * diskEdge(r) * mix(1.0, 0.55, (r - uInner) / (uOuter - uInner)), 0.0, 0.85);',
    '  return vec4(col * lum * 2.4, alpha);',
    '}',
    'vec3 rotY(vec3 d, float a) { float c = cos(a), s = sin(a); return vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z); }',
    'vec3 sky(vec3 d, float px) {', // px: angular size of a pixel, so stars stay one crisp point at any resolution
    '  d = rotY(d, -uAzOff);',
    '  vec3 col = vec3(0.0);',
    '  for (int k = 0; k < 2; k++) {',
    '    float sc = k == 0 ? 120.0 : 260.0;',
    '    vec3 c = floor(d * sc);',
    '    float h = hash13(c + float(k) * 41.0);',
    '    if (h > 0.985) {',
    '      vec3 sp = normalize((c + 0.5 + (vec3(hash13(c + 7.0), hash13(c + 13.0), hash13(c + 29.0)) - 0.5) * 0.6) / sc);',
    '      float ang = acos(clamp(dot(d, sp), -1.0, 1.0));',
    '      float rad = max(px * 1.1, 0.0009);',
    '      float s = smoothstep(rad, 0.0, ang) * (0.5 + 4.0 * fract(h * 131.0)) * min(1.0, 0.0009 / rad + 0.35);',
    '      col += s * mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), fract(h * 71.0)) / (1.0 + float(k) * 1.5);',
    '    }',
    '  }',
    '  float band = exp(-pow(d.y * 3.2 + 0.35 * d.x, 2.0));',
    '  col += vec3(0.008, 0.007, 0.012) * band * fbm(d.xz * 6.0 + d.y * 3.0);',
    '  return col * uStars;',
    '}',
    // light around a mass, in the plane of its orbit: a = -3/2 h^2 r / |r|^5 (h = |r x v|, conserved)
    'vec3 accel(vec3 p, float h2) { float r2 = dot(p, p); return -1.5 * h2 * p / (r2 * r2 * sqrt(r2)); }',
    'vec3 finish(vec3 col, vec2 frag, vec2 res, float exposure) {',
    '  col = 1.0 - exp(-col * exposure);',
    '  col = pow(col, vec3(1.0 / 2.2));',
    '  vec2 q = frag / res - 0.5;',
    '  col *= 1.0 - 0.35 * dot(q, q);',
    '  return col + (hash12(frag + fract(uTime) * 91.0) - 0.5) / 255.0;',
    '}'
  ].join('\n');

  // the photon march, shared by the live tracer and the full-resolution tracer
  var MARCH_HEAD = [
    'uniform vec2 uRes, uFocus;',
    'uniform vec3 uCam, uFwd, uRight, uUp;',
    'uniform float uTanFov, uSteps;',
    '#define MAX_STEPS 320',
    'vec3 rayDir(vec2 frag) { vec2 uv = (frag - uFocus * uRes) / uRes.y; return normalize(uFwd + uTanFov * 2.0 * (uv.x * uRight + uv.y * uUp)); }'
  ].join('\n');
  var MARCH_LOOP = [
    '  vec3 pos = uCam, vel = dir;',
    '  float h2 = dot(cross(pos, vel), cross(pos, vel));',
    '  float far = max(length(uCam) * 1.2, uOuter * 2.5);',
    '  for (int i = 0; i < MAX_STEPS; i++) {',
    '    if (float(i) >= uSteps) break;',
    '    float r = length(pos);',
    '    if (r < 1.0) break;',
    '    if (r > far && dot(pos, vel) > 0.0) { escaped = true; break; }',
    // long strides out in flat space, short ones where the curvature is (and where the disk is thin)
    '    float dt = clamp(0.09 * (r - 0.9) * r * 0.5, 0.02, 1.2);',
    '    vec3 k1v = accel(pos, h2), k1p = vel;',
    '    vec3 k2v = accel(pos + 0.5 * dt * k1p, h2), k2p = vel + 0.5 * dt * k1v;',
    '    vec3 k3v = accel(pos + 0.5 * dt * k2p, h2), k3p = vel + 0.5 * dt * k2v;',
    '    vec3 k4v = accel(pos + dt * k3p, h2), k4p = vel + dt * k3v;',
    '    vec3 np = pos + dt / 6.0 * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);',
    '    vec3 nv = vel + dt / 6.0 * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);',
    '    if (pos.y * np.y < 0.0) {',
    '      vec3 hit = mix(pos, np, pos.y / (pos.y - np.y));',
    '      float rh = length(hit.xz);',
    '      if (rh > uInner && rh < uOuter) { ON_HIT }',
    '    }',
    '    float rd = length(np.xz);',
    '    float hz = exp(-abs(np.y) * 3.0) * smoothstep(uOuter, uInner, rd) * step(uInner * 0.9, rd);',
    '    float ringW = exp(-pow((r - 1.55) * 6.0, 2.0));',
    '    haze += trans * dt * hz * 0.018; ring += trans * dt * ringW * 0.05;',
    '    pos = np; vel = nv;',
    '  }'
  ].join('\n');

  // the live tracer: shades as it goes (one pass, budgeted resolution)
  function liveFrag(v2) {
    return (v2 ? '#version 300 es\nprecision highp float;\nout vec4 fragColor;\n#define OUT fragColor\n' : 'precision highp float;\n#define OUT gl_FragColor\n') +
      COMMON + '\n' + MARCH_HEAD + '\nuniform float uGlow, uExposure;\nvoid main() {\n  vec3 dir = rayDir(gl_FragCoord.xy);\n' +
      '  vec3 col = vec3(0.0); float trans = 1.0, haze = 0.0, ring = 0.0; bool escaped = false;\n' +
      MARCH_LOOP.replace('ON_HIT', 'vec4 d = diskShade(rh, atan(hit.z, hit.x), beamG(hit, normalize(nv))); col += trans * d.rgb * d.a; trans *= 1.0 - d.a; if (trans < 0.02) break;') +
      '\n  if (escaped) col += trans * sky(normalize(vel), 2.0 * uTanFov / uRes.y);\n' +
      '  col += (haze + (escaped ? ring : 0.0)) * uGlow * blackbody(uTemp * 1.1) * uTint;\n' +
      '  OUT = vec4(finish(col, gl_FragCoord.xy, uRes, uExposure), 1.0);\n}';
  }

  // the full-resolution tracer: stores up to three disk crossings, the escape direction and the glow, no shading.
  // Opacity is not known here (the gas moves), so the glow behind a crossing is weighted by the disk's mean opacity.
  var TRACE_FRAG = '#version 300 es\nprecision highp float;\nlayout(location = 0) out vec4 o0;\nlayout(location = 1) out vec4 o1;\nlayout(location = 2) out vec4 o2;\nlayout(location = 3) out vec4 o3;\n' +
    COMMON + '\n' + MARCH_HEAD + '\nvoid main() {\n  vec3 dir = rayDir(gl_FragCoord.xy);\n' +
    '  float trans = 1.0, haze = 0.0, ring = 0.0; bool escaped = false; int n = 0; vec3 hA = vec3(0.0), hB = vec3(0.0), hC = vec3(0.0);\n' +
    MARCH_LOOP.replace('ON_HIT', 'vec3 h = vec3(rh, atan(hit.z, hit.x), beamG(hit, normalize(nv))); if (n == 0) hA = h; else if (n == 1) hB = h; else hC = h; n++; trans *= 1.0 - 0.42 * diskEdge(rh); if (n == 3) break;') +
    '\n  o0 = vec4(hA, hC.x);\n  o1 = vec4(hB, hC.y);\n  o2 = escaped ? vec4(normalize(vel), 1.0) : vec4(0.0);\n  o3 = vec4(haze, escaped ? ring : 0.0, hC.z, 0.0);\n}';

  // the per-frame shade of the stored paths: cheap, at full resolution, crossfading in from the live image
  var SHADE_FRAG = '#version 300 es\nprecision highp float;\nout vec4 fragColor;\n' + COMMON +
    '\nuniform sampler2D g0, g1, g2, g3, uLive;\nuniform vec2 uRes;\nuniform float uGlow, uExposure, uFade, uPx;\nvoid main() {\n' +
    '  ivec2 p = ivec2(gl_FragCoord.xy);\n  vec4 a = texelFetch(g0, p, 0), b = texelFetch(g1, p, 0), s = texelFetch(g2, p, 0), c = texelFetch(g3, p, 0);\n' +
    '  vec3 col = vec3(0.0); float trans = 1.0;\n' +
    '  if (a.x > 0.0) { vec4 d = diskShade(a.x, a.y, a.z); col += d.rgb * d.a; trans *= 1.0 - d.a; }\n' +
    '  if (b.x > 0.0) { vec4 d = diskShade(b.x, b.y, b.z); col += trans * d.rgb * d.a; trans *= 1.0 - d.a; }\n' +
    '  if (a.w > 0.0) { vec4 d = diskShade(a.w, b.w, c.z); col += trans * d.rgb * d.a; trans *= 1.0 - d.a; }\n' +
    '  if (s.w > 0.5) col += trans * sky(s.xyz, uPx);\n' +
    '  col += (c.x + c.y) * uGlow * blackbody(uTemp * 1.1) * uTint;\n' +
    '  col = finish(col, gl_FragCoord.xy, uRes, uExposure);\n' +
    '  if (uFade < 1.0) col = mix(texture(uLive, gl_FragCoord.xy / uRes).rgb, col, uFade);\n' +
    '  fragColor = vec4(col, 1.0);\n}';

  var BLIT_FRAG = '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nuniform sampler2D uLive;\nuniform vec2 uRes;\nvoid main() { fragColor = texture(uLive, gl_FragCoord.xy / uRes); }';
  var VERT1 = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';
  var VERT2 = '#version 300 es\nin vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';

  /* ---------- settings ---------- */

  var PALETTES = {
    interstellar: { temp: 4300, sat: 0.9, tint: [1.0, 0.88, 0.72] },
    ember: { temp: 3200, sat: 1.0, tint: [1.0, 0.86, 0.7] },
    ice: { temp: 16000, sat: 0.9, tint: [0.85, 0.95, 1.0] },
    mono: { temp: 7000, sat: 0.0, tint: [1.0, 1.0, 1.0] },
    true: { temp: 9000, sat: 1.0, tint: [1.0, 1.0, 1.0] }
  };
  // live: pixels traced per frame while the camera moves (any screen density). full: the sharp image's pixel cap.
  // strip: pixels of the sharp image traced per frame, so refining never stalls a frame.
  var QUALITY = {
    low: { live: 110000, steps: 150, full: 900000, strip: 70000 },
    medium: { live: 230000, steps: 210, full: 2600000, strip: 140000 },
    high: { live: 300000, steps: 260, full: 4600000, strip: 180000 }
  };
  var RAD = Math.PI / 180;

  function num(el, name, d) { var v = parseFloat(el.getAttribute(name)); return isFinite(v) ? v : d; }
  function bool(el, name) { var v = el.getAttribute(name); return v !== null && v !== 'false'; }

  var css = ':host{display:block;position:relative;overflow:hidden;background:#000;contain:strict;min-height:240px}' +
    'canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}' +
    ':host([interactive]) canvas{cursor:grab}:host([interactive]) canvas:active{cursor:grabbing}' +
    '.fallback{position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,#000 0 18%,rgba(255,214,170,.55) 20%,rgba(255,160,90,.12) 30%,transparent 55%),#000}' +
    'slot{position:relative;z-index:1}';

  /* ---------- the element ---------- */

  class BlackHole extends HTMLElement {
    static get observedAttributes() { return ['glow', 'distance', 'inclination', 'azimuth', 'palette', 'quality', 'spin', 'doppler', 'exposure', 'stars', 'autorotate', 'focus-x', 'focus-y', 'fov', 'paused']; }

    constructor() {
      super();
      var root = this.attachShadow({ mode: 'open' });
      var style = document.createElement('style'); style.textContent = css;
      this._canvas = document.createElement('canvas');
      this._canvas.setAttribute('aria-hidden', 'true');
      root.appendChild(style); root.appendChild(this._canvas); root.appendChild(document.createElement('slot'));
      this._view = { distance: 30, inclination: 8, azimuth: 0 };
      this._t = 0; this._azOff = 0; this._last = 0; this._raf = 0; this._visible = true; this._dirty = true;
      this._bake = { key: '', row: 0, done: false }; this._fade = 0;
    }

    connectedCallback() {
      this._reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this._readView();
      if (!this._gl && !this._init()) return this._fallback();
      var self = this;
      this._ro = new ResizeObserver(function () { self._resize(); }); this._ro.observe(this);
      this._io = new IntersectionObserver(function (e) { self._visible = e[0].isIntersecting; self._kick(); }, { rootMargin: '100px' }); this._io.observe(this);
      this._onVis = function () { self._kick(); }; document.addEventListener('visibilitychange', this._onVis);
      if (bool(this, 'interactive')) this._bindPointer();
      this._resize(); this._kick();
    }

    disconnectedCallback() {
      cancelAnimationFrame(this._raf); this._raf = 0;
      if (this._ro) this._ro.disconnect(); if (this._io) this._io.disconnect();
      if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    }

    attributeChangedCallback(name) {
      if (name === 'distance' || name === 'inclination' || name === 'azimuth') this._readView();
      if (name === 'quality') this._resize();
      this._dirty = true; this._kick();
    }

    /** Camera, as plain properties too: el.distance = 4 (in Schwarzschild radii), el.inclination (deg), el.azimuth (deg). */
    get distance() { return this._view.distance; } set distance(v) { this.setAttribute('distance', v); }
    get inclination() { return this._view.inclination; } set inclination(v) { this.setAttribute('inclination', v); }
    get azimuth() { return this._view.azimuth; } set azimuth(v) { this.setAttribute('azimuth', v); }

    _readView() {
      this._view.distance = Math.max(2.3, num(this, 'distance', 30));
      this._view.inclination = Math.max(-89, Math.min(89, num(this, 'inclination', 8)));
      this._view.azimuth = num(this, 'azimuth', 0);
    }

    _fallback() {
      var f = document.createElement('div'); f.className = 'fallback'; this.shadowRoot.insertBefore(f, this._canvas); this._canvas.remove();
    }

    _init() {
      var opts = { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false };
      var gl = this._canvas.getContext('webgl2', opts), v2 = !!gl && !!gl.getExtension('EXT_color_buffer_float');
      if (!v2) { gl = this._canvas.getContext('webgl', opts); if (!gl) return false; }
      function program(vsrc, fsrc) {
        function sh(type, src) {
          var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('black-hole: ' + gl.getShaderInfoLog(s)); return null; }
          return s;
        }
        var vs = sh(gl.VERTEX_SHADER, vsrc), fs = sh(gl.FRAGMENT_SHADER, fsrc);
        if (!vs || !fs) return null;
        var p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
        var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
        return { p: p, u: u };
      }
      var P = { live: program(v2 ? VERT2 : VERT1, liveFrag(v2)) };
      if (v2) { P.trace = program(VERT2, TRACE_FRAG); P.shade = program(VERT2, SHADE_FRAG); P.blit = program(VERT2, BLIT_FRAG); }
      if (!P.live || (v2 && (!P.trace || !P.shade || !P.blit))) return false;
      var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle covers the screen
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this._gl = gl; this._v2 = v2; this._P = P; this._tex = null;
      var self = this;
      this._canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); cancelAnimationFrame(self._raf); self._raf = 0; self._gl = null; });
      this._canvas.addEventListener('webglcontextrestored', function () { if (self._init()) { self._size = null; self._resize(); self._kick(); } });
      return true;
    }

    _quality(w, h) { return QUALITY[this.getAttribute('quality')] || (Math.min(w, h) < 600 ? QUALITY.low : QUALITY.medium); }

    // sizes change only when the element really changes size; never as a reaction to frame time
    _resize() {
      if (!this._gl) return;
      var gl = this._gl, r = this.getBoundingClientRect(), w = Math.max(1, r.width), h = Math.max(1, r.height);
      var q = this._quality(w, h); this._q = q;
      var ls = Math.min(1, Math.sqrt(q.live / (w * h))), lw = Math.max(2, Math.round(w * ls)), lh = Math.max(2, Math.round(h * ls));
      var fw = lw, fh = lh;
      if (this._v2) {
        var dpr = Math.min(window.devicePixelRatio || 1, 2), fs = Math.min(dpr, Math.sqrt(q.full / (w * h)));
        fw = Math.max(2, Math.round(w * fs)); fh = Math.max(2, Math.round(h * fs));
      }
      var key = [lw, lh, fw, fh].join('x');
      if (key === this._size) { this._dirty = true; this._kick(); return; }
      this._size = key; this._live = [lw, lh]; this._full = [fw, fh];
      this._canvas.width = fw; this._canvas.height = fh;
      if (this._v2) this._allocTargets();
      this._bake = { key: '', row: 0, done: false }; this._fade = 0;
      this._dirty = true; this._kick();
    }

    _allocTargets() {
      var gl = this._gl, T = this._tex;
      if (T) { T.all.forEach(function (t) { gl.deleteTexture(t); }); gl.deleteFramebuffer(T.liveFb); gl.deleteFramebuffer(T.gFb); }
      function tex(w, h, internal, format, type, filter) {
        var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      }
      var lw = this._live[0], lh = this._live[1], fw = this._full[0], fh = this._full[1];
      var live = tex(lw, lh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
      var liveFb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, liveFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, live, 0);
      // disk crossings and glow fit in half floats; the escape direction gets full floats so stars stay round points
      var g = [0, 1, 2, 3].map(function (i) { return i === 2 ? tex(fw, fh, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST) : tex(fw, fh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST); });
      var gFb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, gFb);
      g.forEach(function (t, i) { gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0); });
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._tex = { live: live, liveFb: liveFb, g: g, gFb: gFb, all: g.concat([live]), ok: ok };
    }

    _kick() {
      if (this._raf || !this._gl) return;
      var self = this;
      this._raf = requestAnimationFrame(function (now) { self._raf = 0; self._frame(now); });
    }

    _camera() {
      var v = this._view, el = v.inclination * RAD, az = v.azimuth * RAD, d = v.distance;
      var cam = [d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az)];
      var f = [-cam[0] / d, -cam[1] / d, -cam[2] / d];
      var right = [-f[2], 0, f[0]], rl = Math.hypot(right[0], right[2]) || 1; right = [right[0] / rl, 0, right[2] / rl]; // forward x world-up
      var up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
      var fov = num(this, 'fov', 38), fx = num(this, 'focus-x', 0.5), fy = num(this, 'focus-y', 0.5);
      return { cam: cam, f: f, right: right, up: up, tanFov: Math.tan(fov * 0.5 * RAD), focus: [fx, 1 - fy],
        key: [d.toFixed(4), v.inclination.toFixed(3), v.azimuth.toFixed(3), fov.toFixed(3), fx, fy].join('|') };
    }

    _frame(now) {
      var dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0; this._last = now;
      var animate = !this._reduced && !bool(this, 'paused') && this._visible && !document.hidden;
      // the auto-orbit turns the disk and the sky, not the camera, so the stored light paths stay valid
      if (animate) { this._t += dt; this._azOff += num(this, 'autorotate', 0) * dt * RAD; }
      var refining = this._v2 && (!this._bake.done || this._fade < 1);
      if (animate || this._dirty || refining) { this._render(dt); this._dirty = false; }
      if (animate || (this._v2 && (!this._bake.done || this._fade < 1))) this._kick(); else this._last = 0;
    }

    _common(prog, pal) {
      var gl = this._gl, u = prog.u;
      gl.uniform1f(u.uTime, this._reduced ? 4 : this._t);
      gl.uniform1f(u.uInner, 3); gl.uniform1f(u.uOuter, 12);
      gl.uniform1f(u.uSpin, num(this, 'spin', 1));
      gl.uniform1f(u.uDoppler, Math.max(0, Math.min(1, num(this, 'doppler', 0.85))));
      gl.uniform1f(u.uStars, num(this, 'stars', 1));
      gl.uniform1f(u.uTemp, pal.temp); gl.uniform1f(u.uSat, pal.sat); gl.uniform3fv(u.uTint, pal.tint);
      gl.uniform1f(u.uAzOff, this._azOff);
      if (u.uGlow) gl.uniform1f(u.uGlow, num(this, 'glow', 1));
      if (u.uExposure) gl.uniform1f(u.uExposure, num(this, 'exposure', 1.1));
    }

    _march(prog, c, w, h) {
      var gl = this._gl, u = prog.u;
      gl.uniform2f(u.uRes, w, h); gl.uniform2fv(u.uFocus, c.focus);
      gl.uniform3fv(u.uCam, c.cam); gl.uniform3fv(u.uFwd, c.f); gl.uniform3fv(u.uRight, c.right); gl.uniform3fv(u.uUp, c.up);
      gl.uniform1f(u.uTanFov, c.tanFov); gl.uniform1f(u.uSteps, this._q.steps);
    }

    _render(dt) {
      var gl = this._gl, P = this._P, pal = PALETTES[this.getAttribute('palette')] || PALETTES.ember, c = this._camera();
      var lw = this._live[0], lh = this._live[1], fw = this._full[0], fh = this._full[1];

      if (!this._v2 || !this._tex.ok) { // WebGL1: the live tracer straight to a budget-sized canvas
        if (this._canvas.width !== lw) { this._canvas.width = lw; this._canvas.height = lh; }
        gl.useProgram(P.live.p); this._common(P.live, pal); this._march(P.live, c, lw, lh);
        gl.uniform1f(P.live.u.uExposure, num(this, 'exposure', 1.1)); gl.uniform1f(P.live.u.uGlow, num(this, 'glow', 1));
        gl.viewport(0, 0, lw, lh); gl.drawArrays(gl.TRIANGLES, 0, 3); return;
      }

      var T = this._tex, b = this._bake;
      if (c.key !== b.key) { b.key = c.key; b.row = 0; b.done = false; this._fade = 0; this._moved = true; } else this._moved = false;
      var needLive = !b.done || this._fade < 1;

      if (needLive) { // the live image: shown while moving, and faded out under the sharp one
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.liveFb); gl.viewport(0, 0, lw, lh);
        gl.useProgram(P.live.p); this._common(P.live, pal); this._march(P.live, c, lw, lh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // trace the next strip of the full-resolution light paths, but only once the camera has held still for a frame
      if (!b.done && !this._moved) {
        var rows = this._reduced ? fh : Math.max(8, Math.floor(this._q.strip / fw));
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.gFb); gl.viewport(0, 0, fw, fh);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(0, b.row, fw, Math.min(rows, fh - b.row));
        gl.useProgram(P.trace.p); this._common(P.trace, pal); this._march(P.trace, c, fw, fh);
        gl.drawArrays(gl.TRIANGLES, 0, 3); gl.disable(gl.SCISSOR_TEST);
        b.row += rows; if (b.row >= fh) b.done = true;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, fw, fh);
      if (!b.done) { // still sharpening (or moving): the live image, scaled up smoothly
        gl.useProgram(P.blit.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.live);
        gl.uniform1i(P.blit.u.uLive, 0); gl.uniform2f(P.blit.u.uRes, fw, fh);
        gl.drawArrays(gl.TRIANGLES, 0, 3); return;
      }
      this._fade = this._reduced ? 1 : Math.min(1, this._fade + (dt || 0.016) * 4);
      var S = P.shade; gl.useProgram(S.p); this._common(S, pal);
      for (var i = 0; i < 4; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, T.g[i]); gl.uniform1i(S.u['g' + i], i); }
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, T.live); gl.uniform1i(S.u.uLive, 4);
      gl.uniform2f(S.u.uRes, fw, fh); gl.uniform1f(S.u.uFade, this._fade); gl.uniform1f(S.u.uPx, 2 * c.tanFov / fh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _bindPointer() {
      var self = this, c = this._canvas, pts = new Map(), pinch = 0;
      c.addEventListener('pointerdown', function (e) { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); });
      c.addEventListener('pointermove', function (e) {
        var p = pts.get(e.pointerId); if (!p) return;
        if (pts.size === 1) {
          self._view.azimuth -= (e.clientX - p[0]) * 0.3;
          self._view.inclination = Math.max(-80, Math.min(80, self._view.inclination + (e.clientY - p[1]) * 0.2));
        } else if (pts.size === 2) {
          pts.set(e.pointerId, [e.clientX, e.clientY]);
          var a = Array.from(pts.values()), dd = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]);
          if (pinch) self._zoom(pinch / dd);
          pinch = dd; return;
        }
        pts.set(e.pointerId, [e.clientX, e.clientY]); self._dirty = true; self._kick();
      });
      function up(e) { pts.delete(e.pointerId); pinch = 0; }
      c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
      // a plain wheel scrolls the page; zoom on trackpad pinch (ctrlKey wheel), ctrl/cmd + wheel, or when the
      // host opts in with the wheel-zoom attribute (a full-screen viewer)
      c.addEventListener('wheel', function (e) {
        if (!(e.ctrlKey || e.metaKey || bool(self, 'wheel-zoom'))) return;
        e.preventDefault(); self._zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012)));
      }, { passive: false });
    }

    _zoom(k) { this._view.distance = Math.max(2.4, Math.min(60, this._view.distance * k)); this._dirty = true; this._kick(); }
  }

  customElements.define('black-hole', BlackHole);
})();
