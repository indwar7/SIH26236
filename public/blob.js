// Amber particle sphere that slowly breathes and rotates. Canvas 2D, no dependencies.
export function mountBlob(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const N = opts.count ?? 4200;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - ((i + 0.5) / N) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.399963229728653;
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r, th, Math.acos(y)]);
  }
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let amp = opts.amp ?? 0.16, target = amp, spin = opts.spin ?? 1, t = opts.seed ?? 0, raf = 0, W = 0, H = 0;

  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const R = Math.min(W, H) * 0.34 * (opts.scale ?? 1);
    const cx = W / 2, cy = H / 2;
    const ry = t * 0.35 * spin, cr = Math.cos(ry), sr = Math.sin(ry);
    const rx = 0.42, cx2 = Math.cos(rx), sx2 = Math.sin(rx);
    for (let i = 0; i < N; i++) {
      const [x, y, z, th, ph] = pts[i];
      const d = 1
        + amp * Math.sin(3 * ph + t * 1.6) * Math.cos(2 * th - t * 1.1)
        + amp * 0.45 * Math.sin(5 * ph - t * 0.8 + th * 2);
      const X = x * d, Y = y * d, Z = z * d;
      const x2 = X * cr + Z * sr, z2 = -X * sr + Z * cr;
      const y3 = Y * cx2 - z2 * sx2, z3 = Y * sx2 + z2 * cx2;
      const s = 2.2 / (3.1 - z3);
      const px = cx + x2 * R * s, py = cy + y3 * R * s;
      const rim = Math.pow(1 - Math.min(1, Math.abs(z3) / (d || 1)), 1.6);
      const front = (z3 / (d || 1) + 1) / 2;
      const a = 0.12 + 0.88 * Math.min(1, rim * 1.3) * (0.45 + 0.55 * front);
      if (a < 0.06) continue;
      const g = 95 + 55 * rim, b = 10 + 20 * rim;
      ctx.fillStyle = `rgba(236,${g | 0},${b | 0},${a.toFixed(3)})`;
      const sz = 0.7 + 1.6 * s * (0.4 + rim * 0.6);
      ctx.fillRect(px, py, sz, sz);
    }
  }

  function frame() {
    if (!canvas.isConnected) { cancelAnimationFrame(raf); removeEventListener("resize", size); return; }
    t += 0.009;
    amp += (target - amp) * 0.035;
    draw();
    raf = requestAnimationFrame(frame);
  }

  size();
  addEventListener("resize", size);
  if (reduce) draw(); else raf = requestAnimationFrame(frame);

  return {
    setAmp(v) { target = v; if (reduce) { amp = v; draw(); } },
    setSpin(v) { spin = v; },
  };
}
