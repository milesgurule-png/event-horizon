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
 * Units: the Schwarzschild radius is 1. The photon sphere sits at 1.5, the shadow looks 2.6 wide, and the
 * innermost stable orbit (where the disk starts) is 3.
 *
 * MIT License · (c) 2026 Miles Gurule · https://github.com/milesgurule-png/event-horizon
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.customElements || customElements.get('black-hole')) return;

  var VERT = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';

  var FRAG = [
    'precision highp float;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform vec3 uCam, uFwd, uRight, uUp;',
    'uniform float uTanFov;',
    'uniform vec2 uFocus;',
    'uniform float uSteps;',
    'uniform float uInner, uOuter;',
    'uniform float uSpin, uDoppler, uExposure, uStars, uTemp, uSat;',
    'uniform vec3 uTint;',
    '',
    '#define MAX_STEPS 320',
    '',
    'float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }',
    'float noise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}',
    'float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.07 + 17.3; a *= 0.5; } return s; }',
    '',
    // blackbody colour for a temperature in kelvin (a fit to the Planck curve, good from 1,000 K to 40,000 K)
    'vec3 blackbody(float t) {',
    '  t = clamp(t, 1000.0, 40000.0) / 100.0;',
    '  float r = t <= 66.0 ? 1.0 : 1.292936 * pow(t - 60.0, -0.1332047);',
    '  float g = t <= 66.0 ? 0.3900816 * log(t) - 0.6318414 : 1.129891 * pow(t - 60.0, -0.0755148);',
    '  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : 0.5432068 * log(t - 10.0) - 1.1962541);',
    '  return clamp(vec3(r, g, b), 0.0, 1.0);',
    '}',
    '',
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
    '',
    'vec4 disk(vec3 p, vec3 dir) {',
    '  float r = length(p.xz);',
    '  if (r < uInner || r > uOuter) return vec4(0.0);',
    '  float x = r / uInner;',
    // thin-disk temperature: rises from zero at the inner edge, peaks just outside it, falls as r^-3/4
    '  float prof = pow(x, -0.75) * pow(max(1.0 - inversesqrt(x), 0.0), 0.25);',
    '  float temp = uTemp * prof / 0.488;',
    '  float phi = atan(p.z, p.x);',
    '  float bf = (r - uInner) * 3.0, b0 = floor(bf);',
    '  float tex = mix(ringTex(r, phi, b0), ringTex(r, phi, b0 + 1.0), smoothstep(0.0, 1.0, fract(bf)));',
    // relativistic beaming: circular orbit speed seen by a static observer, Doppler factor, gravitational redshift
    '  vec3 v = normalize(vec3(-p.z, 0.0, p.x));',
    '  float beta = min(0.95, sqrt(0.5 / (r - 1.0)));',
    '  float gamma = inversesqrt(1.0 - beta * beta);',
    '  float g = sqrt(1.0 - 1.0 / r) / (gamma * (1.0 - beta * dot(v, -dir)));',
    '  g = mix(1.0, g, uDoppler);',
    '  float tObs = temp * g;',
    '  vec3 col = mix(vec3(dot(blackbody(tObs), vec3(0.3, 0.55, 0.15))), blackbody(tObs), uSat) * uTint;',
    '  float lum = pow(g, 3.0) * pow(prof / 0.488, 3.4) * (0.45 + tex);',
    '  float edge = smoothstep(uInner, uInner * 1.06, r) * (1.0 - smoothstep(uOuter * 0.62, uOuter, r));',
    '  float alpha = clamp((0.1 + 0.75 * tex) * edge * mix(1.0, 0.55, (r - uInner) / (uOuter - uInner)), 0.0, 0.85);',
    '  return vec4(col * lum * 2.4, alpha);',
    '}',
    '',
    'vec3 sky(vec3 d) {',
    '  vec3 col = vec3(0.0);',
    '  for (int k = 0; k < 2; k++) {',
    '    float sc = k == 0 ? 120.0 : 260.0;',
    '    vec3 c = floor(d * sc);',
    '    float h = hash13(c + float(k) * 41.0);',
    '    if (h > 0.985) {',
    '      vec3 sp = normalize((c + 0.5 + (vec3(hash13(c + 7.0), hash13(c + 13.0), hash13(c + 29.0)) - 0.5) * 0.6) / sc);',
    '      float s = smoothstep(1.4, 0.0, acos(clamp(dot(d, sp), -1.0, 1.0)) * sc * 9.0) * (0.5 + 4.0 * fract(h * 131.0));',
    '      col += s * mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), fract(h * 71.0)) / (1.0 + float(k) * 1.5);',
    '    }',
    '  }',
    '  float band = exp(-pow(d.y * 3.2 + 0.35 * d.x, 2.0));',
    '  col += vec3(0.008, 0.007, 0.012) * band * fbm(d.xz * 6.0 + d.y * 3.0);',
    '  return col * uStars;',
    '}',
    '',
    // light around a mass, in the plane of its orbit: a = -3/2 h^2 r / |r|^5 (h = |r x v|, conserved)
    'uniform float uGlow;',
    'vec3 accel(vec3 p, float h2) { float r2 = dot(p, p); return -1.5 * h2 * p / (r2 * r2 * sqrt(r2)); }',
    '',
    'void main() {',
    '  vec2 uv = (gl_FragCoord.xy - uFocus * uRes) / uRes.y;',
    '  vec3 dir = normalize(uFwd + uTanFov * 2.0 * (uv.x * uRight + uv.y * uUp));',
    '  vec3 pos = uCam, vel = dir;',
    '  float h2 = dot(cross(pos, vel), cross(pos, vel));',
    '  vec3 col = vec3(0.0); float trans = 1.0, haze = 0.0, ring = 0.0; bool escaped = false;',
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
    '      vec4 d = disk(hit, normalize(nv));',
    '      col += trans * d.rgb * d.a; trans *= 1.0 - d.a;',
    '      if (trans < 0.02) break;',
    '    }',
    '    float rd = length(np.xz);',
    '    float hz = exp(-abs(np.y) * 3.0) * smoothstep(uOuter, uInner, rd) * step(uInner * 0.9, rd);',
    '    float ringW = exp(-pow((r - 1.55) * 6.0, 2.0));',
    '    haze += trans * dt * hz * 0.018; ring += trans * dt * ringW * 0.05;',
    '    pos = np; vel = nv;',
    '  }',
    '  if (escaped) col += trans * sky(normalize(vel));',
    '  col += (haze + (escaped ? ring : 0.0)) * uGlow * blackbody(uTemp * 1.1) * uTint;',
    '  col = 1.0 - exp(-col * uExposure);',
    '  col = pow(col, vec3(1.0 / 2.2));',
    '  vec2 q = gl_FragCoord.xy / uRes - 0.5;',
    '  col *= 1.0 - 0.35 * dot(q, q);',
    '  col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var PALETTES = {
    interstellar: { temp: 4300, sat: 0.9, tint: [1.0, 0.88, 0.72] },
    ember: { temp: 3200, sat: 1.0, tint: [1.0, 0.86, 0.7] },
    ice: { temp: 16000, sat: 0.9, tint: [0.85, 0.95, 1.0] },
    mono: { temp: 7000, sat: 0.0, tint: [1.0, 1.0, 1.0] },
    true: { temp: 9000, sat: 1.0, tint: [1.0, 1.0, 1.0] }
  };
  // pixels traced per frame, whatever the screen: a Retina display would otherwise trace 4x the rays for a soft image
  var QUALITY = { low: { px: 110000, steps: 150 }, medium: { px: 230000, steps: 210 }, high: { px: 420000, steps: 290 } };
  var RAD = Math.PI / 180;

  function num(el, name, d) { var v = parseFloat(el.getAttribute(name)); return isFinite(v) ? v : d; }
  function bool(el, name) { var v = el.getAttribute(name); return v !== null && v !== 'false'; }

  var css = ':host{display:block;position:relative;overflow:hidden;background:#000;contain:strict;min-height:240px}' +
    'canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}' +
    ':host([interactive]) canvas{cursor:grab}:host([interactive]) canvas:active{cursor:grabbing}' +
    '.fallback{position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,#000 0 18%,rgba(255,214,170,.55) 20%,rgba(255,160,90,.12) 30%,transparent 55%),#000}' +
    'slot{position:relative;z-index:1}';

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
      this._t = 0; this._last = 0; this._raf = 0; this._visible = true; this._dirty = true;
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
      var gl = this._canvas.getContext('webgl', { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
      if (!gl) return false;
      function sh(type, src) {
        var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('black-hole: ' + gl.getShaderInfoLog(s)); return null; }
        return s;
      }
      var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
      if (!vs || !fs) return false;
      var prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.bindAttribLocation(prog, 0, 'aPos'); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle covers the screen
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      var u = {}; ['uRes', 'uTime', 'uCam', 'uFwd', 'uRight', 'uUp', 'uTanFov', 'uFocus', 'uSteps', 'uInner', 'uOuter', 'uSpin', 'uDoppler', 'uExposure', 'uStars', 'uTemp', 'uSat', 'uTint', 'uGlow']
        .forEach(function (n) { u[n] = gl.getUniformLocation(prog, n); });
      this._gl = gl; this._u = u;
      var self = this;
      this._canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); cancelAnimationFrame(self._raf); self._raf = 0; self._gl = null; });
      this._canvas.addEventListener('webglcontextrestored', function () { if (self._init()) { self._resize(); self._kick(); } });
      return true;
    }

    _resize() {
      if (!this._gl) return;
      var r = this.getBoundingClientRect(), w = Math.max(1, r.width), h = Math.max(1, r.height);
      var q = QUALITY[this.getAttribute('quality')] || (Math.min(w, h) < 600 ? QUALITY.low : QUALITY.medium);
      var s = Math.min(1, Math.sqrt(q.px / (w * h)));
      this._steps = q.steps;
      var cw = Math.max(2, Math.round(w * s)), ch = Math.max(2, Math.round(h * s));
      if (cw !== this._canvas.width || ch !== this._canvas.height) { this._canvas.width = cw; this._canvas.height = ch; this._gl.viewport(0, 0, cw, ch); }
      this._dirty = true; this._kick();
    }

    _kick() {
      if (this._raf || !this._gl) return;
      var self = this;
      this._raf = requestAnimationFrame(function (now) { self._raf = 0; self._frame(now); });
    }

    _frame(now) {
      var dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0; this._last = now;
      var animate = !this._reduced && !bool(this, 'paused') && this._visible && !document.hidden;
      if (animate) { this._t += dt; this._view.azimuth += num(this, 'autorotate', 0) * dt; }
      if (animate || this._dirty) { this._render(); this._dirty = false; }
      if (animate) this._kick(); else this._last = 0;
    }

    _render() {
      var gl = this._gl, u = this._u, v = this._view;
      var el = v.inclination * RAD, az = v.azimuth * RAD, d = v.distance;
      var cam = [d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az)];
      var f = [-cam[0] / d, -cam[1] / d, -cam[2] / d];
      var right = [-f[2], 0, f[0]], rl = Math.hypot(right[0], right[2]) || 1; right = [right[0] / rl, 0, right[2] / rl]; // forward x world-up
      var up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
      var pal = PALETTES[this.getAttribute('palette')] || PALETTES.ember;
      gl.uniform2f(u.uRes, this._canvas.width, this._canvas.height);
      gl.uniform1f(u.uTime, this._reduced ? 4 : this._t);
      gl.uniform3fv(u.uCam, cam); gl.uniform3fv(u.uFwd, f); gl.uniform3fv(u.uRight, right); gl.uniform3fv(u.uUp, up);
      gl.uniform1f(u.uTanFov, Math.tan(num(this, 'fov', 38) * 0.5 * RAD));
      gl.uniform2f(u.uFocus, num(this, 'focus-x', 0.5), 1 - num(this, 'focus-y', 0.5));
      gl.uniform1f(u.uSteps, this._steps || 210);
      gl.uniform1f(u.uInner, 3); gl.uniform1f(u.uOuter, 12);
      gl.uniform1f(u.uSpin, num(this, 'spin', 1));
      gl.uniform1f(u.uDoppler, Math.max(0, Math.min(1, num(this, 'doppler', 0.85))));
      gl.uniform1f(u.uExposure, num(this, 'exposure', 1.1));
      gl.uniform1f(u.uStars, num(this, 'stars', 1)); gl.uniform1f(u.uGlow, num(this, 'glow', 1));
      gl.uniform1f(u.uTemp, pal.temp); gl.uniform1f(u.uSat, pal.sat); gl.uniform3fv(u.uTint, pal.tint);
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
