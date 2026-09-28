/* TrueStay Logs: builds a client's PDF on the phone.
   A tiny PDF writer (A4, Helvetica, shapes, JPEG pictures) so there's no library to load. */
(() => {
  "use strict";

  // Helvetica and Helvetica-Bold widths for WinAnsi codes 32..255 (from the standard font metrics)
  const W_REG = "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500"
    .split(",").map(Number);
  const W_BOLD = "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556"
    .split(",").map(Number);

  const PW = 595.28;
  const PH = 841.89;
  const M = 36; // page margin

  // TrueStay Results brand for anything a client might see
  const INK = "#1A1A1A";
  const INK2 = "#5E5E5E"; // secondary text, 6.5:1 on white
  const ORANGE = "#C45A1E"; // marks and accents only (4.35:1, not for small text)
  const CREAM = "#F2EDE4";
  const TILE = "#F7F4EF";
  const GRID = "#E6E1D8";
  const RULE = "#D5CEC3";

  const CP1252 = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  };
  function winAnsi(str) {
    let out = "";
    for (const ch of String(str ?? "")) {
      const c = ch.codePointAt(0);
      if (c >= 32 && c < 127) out += ch;
      else if (c >= 0xa0 && c <= 0xff) out += String.fromCharCode(c);
      else if (CP1252[c]) out += String.fromCharCode(CP1252[c]);
      else if (c === 9 || c === 10 || c === 13) out += " ";
      else if (c > 0xffff || (c >= 0xd800 && c <= 0xdfff) || (c >= 0xfe00 && c <= 0xfe0f) || c === 0x200d) continue; // emoji and joiners
      else {
        const base = ch.normalize("NFD")[0];
        out += base && base.charCodeAt(0) < 127 && base.charCodeAt(0) >= 32 ? base : "?";
      }
    }
    return out;
  }
  const escStr = (t) => t.replace(/[\\()]/g, (m) => "\\" + m);
  const n2 = (v) => {
    const r = Math.round(v * 100) / 100;
    return Object.is(r, -0) ? "0" : String(r);
  };
  function textW(s, bold, size, cs = 0) {
    const t = winAnsi(s);
    const tbl = bold ? W_BOLD : W_REG;
    let w = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      w += c >= 32 ? tbl[c - 32] : 0;
    }
    return (w * size) / 1000 + cs * t.length;
  }
  function fit(s, bold, size, maxW) {
    if (textW(s, bold, size) <= maxW) return s;
    let t = String(s);
    while (t.length > 1 && textW(t + "…", bold, size) > maxW) t = t.slice(0, -1);
    return t.trimEnd() + "…";
  }
  const rgb = (hex) => {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => n2(c / 255)).join(" ");
  };
  const bin = (s) => {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
    return u;
  };

  class Doc {
    constructor() {
      this.pages = [];
      this.images = [];
      this.cur = null;
    }
    addPage() {
      this.cur = { ops: [], images: new Set() };
      this.pages.push(this.cur);
      return this.cur;
    }
    op(s) {
      this.cur.ops.push(s);
    }
    rrPath(x, y, w, h, r, corners = [1, 1, 1, 1]) {
      // top-left coordinates in, PDF (bottom-left) out. corners: tl, tr, br, bl
      r = Math.max(0, Math.min(r, w / 2, h / 2));
      const k = 0.5523 * r;
      const [tl, tr, br, bl] = corners.map((c) => (c ? r : 0));
      const X = (v) => n2(v);
      const Y = (v) => n2(PH - v);
      const o = [];
      o.push(`${X(x + tl)} ${Y(y)} m`);
      o.push(`${X(x + w - tr)} ${Y(y)} l`);
      if (tr) o.push(`${X(x + w - tr + (k * tr) / r)} ${Y(y)} ${X(x + w)} ${Y(y + tr - (k * tr) / r)} ${X(x + w)} ${Y(y + tr)} c`);
      o.push(`${X(x + w)} ${Y(y + h - br)} l`);
      if (br) o.push(`${X(x + w)} ${Y(y + h - br + (k * br) / r)} ${X(x + w - br + (k * br) / r)} ${Y(y + h)} ${X(x + w - br)} ${Y(y + h)} c`);
      o.push(`${X(x + bl)} ${Y(y + h)} l`);
      if (bl) o.push(`${X(x + bl - (k * bl) / r)} ${Y(y + h)} ${X(x)} ${Y(y + h - bl + (k * bl) / r)} ${X(x)} ${Y(y + h - bl)} c`);
      o.push(`${X(x)} ${Y(y + tl)} l`);
      if (tl) o.push(`${X(x)} ${Y(y + tl - (k * tl) / r)} ${X(x + tl - (k * tl) / r)} ${Y(y)} ${X(x + tl)} ${Y(y)} c`);
      o.push("h");
      this.op(o.join(" "));
    }
    rect(x, y, w, h, fill) {
      this.op(`${rgb(fill)} rg ${n2(x)} ${n2(PH - y - h)} ${n2(w)} ${n2(h)} re f`);
    }
    rrect(x, y, w, h, r, fill, corners) {
      this.op(`${rgb(fill)} rg`);
      this.rrPath(x, y, w, h, r, corners);
      this.op("f");
    }
    rrectStroke(x, y, w, h, r, color, lw) {
      this.op(`${rgb(color)} RG ${n2(lw)} w`);
      this.rrPath(x, y, w, h, r);
      this.op("S");
    }
    line(x1, y1, x2, y2, color, lw) {
      this.op(`${rgb(color)} RG ${n2(lw)} w 0 J ${n2(x1)} ${n2(PH - y1)} m ${n2(x2)} ${n2(PH - y2)} l S`);
    }
    tick(x, y, s, color) {
      // a check mark in a box s wide whose top-left is (x, y)
      this.op(
        `${rgb(color)} RG ${n2(Math.max(1, s / 7))} w 1 J 1 j ${n2(x + s * 0.08)} ${n2(PH - (y + s * 0.55))} m ${n2(x + s * 0.38)} ${n2(PH - (y + s * 0.85))} l ${n2(
          x + s * 0.94
        )} ${n2(PH - (y + s * 0.18))} l S 0 J 0 j`
      );
    }
    text(s, x, y, { size = 10, bold = false, color = INK, align = "left", cs = 0 } = {}) {
      const t = winAnsi(s);
      const w = textW(s, bold, size, cs);
      const x0 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      this.op(`${rgb(color)} rg BT /${bold ? "F2" : "F1"} ${n2(size)} Tf ${n2(cs)} Tc ${n2(x0)} ${n2(PH - y)} Td (${escStr(t)}) Tj ET`);
      return w;
    }
    addImage(bytes, w, h) {
      const img = { n: this.images.length + 1, bytes, w, h };
      this.images.push(img);
      return img;
    }
    image(img, x, y, w, h, radius = 0) {
      this.cur.images.add(img);
      this.op("q");
      if (radius) {
        this.rrPath(x, y, w, h, radius);
        this.op("W n");
      }
      this.op(`${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(PH - y - h)} cm /Im${img.n} Do Q`);
    }
    build(meta) {
      const chunks = [];
      let len = 0;
      const offsets = [];
      const push = (x) => {
        const u = typeof x === "string" ? bin(x) : x;
        chunks.push(u);
        len += u.length;
      };
      let next = 6;
      const imgIds = this.images.map(() => next++);
      const pageIds = this.pages.map(() => [next++, next++]);
      const total = next;
      const obj = (id, parts) => {
        offsets[id] = len;
        push(`${id} 0 obj\n`);
        (Array.isArray(parts) ? parts : [parts]).forEach(push);
        push("\nendobj\n");
      };
      push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
      obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
      obj(2, `<< /Type /Pages /Kids [${pageIds.map(([p]) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
      obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
      obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
      obj(
        5,
        `<< /Title (${escStr(winAnsi(meta.title))}) /Author (${escStr(winAnsi(meta.author))}) /Subject (${escStr(winAnsi(meta.subject || ""))}) /Creator (TrueStay Logs) /Producer (TrueStay Logs) /CreationDate (D:${meta.date}) >>`
      );
      this.images.forEach((img, i) =>
        obj(imgIds[i], [
          `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
          img.bytes,
          "\nendstream",
        ])
      );
      this.pages.forEach((pg, i) => {
        const [pid, cid] = pageIds[i];
        const xo = [...pg.images].map((img) => `/Im${img.n} ${imgIds[img.n - 1]} 0 R`).join(" ");
        obj(
          pid,
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo ? ` /XObject << ${xo} >>` : ""} >> /Contents ${cid} 0 R >>`
        );
        const content = pg.ops.join("\n");
        obj(cid, [`<< /Length ${content.length} >>\nstream\n`, content, "\nendstream"]);
      });
      const xref = len;
      let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
      for (let id = 1; id < total; id++) x += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
      push(x);
      push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      const out = new Uint8Array(len);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    }
  }

  // ---------- numbers and dates ----------
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];
  const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dObj = (iso) => new Date(iso + "T12:00:00Z");
  const dayLabel = (iso) => {
    const d = dObj(iso);
    return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  };
  const shortDay = (iso) => {
    const d = dObj(iso);
    return `${WD[d.getUTCDay()]} ${d.getUTCDate()}`;
  };
  function rangeLabel(a, b) {
    if (!a) return "";
    const A = dObj(a);
    const B = dObj(b || a);
    if (a === b || !b) return `${dayLabel(a)} ${A.getUTCFullYear()}`;
    if (A.getUTCFullYear() !== B.getUTCFullYear()) return `${dayLabel(a)} ${A.getUTCFullYear()} to ${dayLabel(b)} ${B.getUTCFullYear()}`;
    if (A.getUTCMonth() !== B.getUTCMonth()) return `${dayLabel(a)} to ${dayLabel(b)} ${B.getUTCFullYear()}`;
    return `${shortDay(a)} to ${shortDay(b)} ${MON[B.getUTCMonth()]} ${B.getUTCFullYear()}`;
  }
  const fmt = (v) => (v == null ? "–" : Math.round(v).toLocaleString("en-GB"));
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  const compact = (v) => (v >= 10000 ? `${n2(v / 1000)}k` : Math.round(v).toLocaleString("en-GB"));

  // ---------- the log ----------
  // opts: { clientName, from, to, days: [{day, totals, items}], undated: [items], targets, madeOn, loadImage(item) -> {bytes,w,h}, onProgress(done,total) }
  async function build(opts) {
    const d = new Doc();
    const { clientName, days, undated = [], targets = {}, madeOn } = opts;
    const range = rangeLabel(opts.from, opts.to);
    const T = { kcal: targets.kcal || null, protein: targets.protein || null, steps: targets.steps || null };
    const hitK = (v) => T.kcal && v != null && Math.abs(v - T.kcal) <= T.kcal * 0.1;
    const hitP = (v) => T.protein && v != null && v >= T.protein;
    const hitS = (v) => T.steps && v != null && v >= T.steps;
    const nDays = days.length;
    const shots = days.reduce((a, x) => a + x.items.length, 0) + undated.length;
    const col = (k) => days.map((x) => x.totals[k]).filter((v) => v != null);

    // ----- page 1: summary -----
    d.addPage();
    d.rect(0, 0, PW, 128, INK);
    d.rect(0, 128, PW, 4, ORANGE);
    d.text("TRUESTAY RESULTS", M, 40, { size: 8.5, bold: true, color: CREAM, cs: 1.6 });
    d.text(fit(clientName, true, 28, PW - 2 * M), M, 80, { size: 28, bold: true, color: "#FFFFFF" });
    d.text(`Food and steps · ${range}`, M, 106, { size: 11.5, color: CREAM });

    // stat tiles
    const tiles = [];
    const aK = avg(col("kcal"));
    const aP = avg(col("protein"));
    const aS = avg(col("steps"));
    const countHits = (k, f) => days.filter((x) => f(x.totals[k])).length;
    tiles.push({
      k: "Average calories",
      v: aK == null ? "No data" : `${fmt(aK)} kcal`,
      s: T.kcal ? `Target ${fmt(T.kcal)} · hit ${countHits("kcal", hitK)}/${nDays}` : aK == null ? "Nothing read yet" : `Across ${col("kcal").length} of ${nDays} days`,
    });
    tiles.push({
      k: "Average protein",
      v: aP == null ? "No data" : `${fmt(aP)} g`,
      s: T.protein ? `Target ${fmt(T.protein)} g · hit ${countHits("protein", hitP)}/${nDays}` : aP == null ? "Nothing read yet" : `Across ${col("protein").length} of ${nDays} days`,
    });
    tiles.push({
      k: "Average steps",
      v: aS == null ? "No data" : fmt(aS),
      s: T.steps ? `Target ${fmt(T.steps)} · hit ${countHits("steps", hitS)}/${nDays}` : aS == null ? "Nothing read yet" : `Across ${col("steps").length} of ${nDays} days`,
    });
    const logged = days.filter((x) => x.items.length).length;
    tiles.push({ k: "Days logged", v: `${logged} of ${nDays}`, s: `${shots} screenshot${shots === 1 ? "" : "s"}` });
    const tw = (PW - 2 * M - 3 * 10) / 4;
    tiles.forEach((t, i) => {
      const x = M + i * (tw + 10);
      d.rrect(x, 156, tw, 74, 8, TILE);
      d.text(t.k, x + 10, 174, { size: 8.5, color: INK2 });
      d.text(fit(t.v, true, 17, tw - 20), x + 10, 198, { size: 17, bold: true });
      d.text(fit(t.s, false, 7.8, tw - 20), x + 10, 218, { size: 7.8, color: INK2 });
    });

    // charts: one measure each, never two scales on one chart
    let y = 252;
    const chart = (x, y0, w, h, title, key, target) => {
      d.text(title, x, y0 + 10, { size: 10.5, bold: true });
      if (target) {
        // the target line's key sits beside the title so it never collides with a tall bar
        const lab = `Target ${fmt(target)}`;
        const lw = textW(lab, false, 7.5);
        d.text(lab, x + w, y0 + 9.5, { size: 7.5, color: INK, align: "right" });
        d.line(x + w - lw - 20, y0 + 7, x + w - lw - 5, y0 + 7, INK, 1);
      }
      const vals = days.map((x2) => x2.totals[key]);
      const have = vals.filter((v) => v != null);
      if (!have.length) {
        d.text("No numbers read for these days", x, y0 + 34, { size: 8.5, color: INK2 });
        return;
      }
      const top = y0 + 24;
      const left = x + 30;
      const bottom = y0 + h - 16;
      const right = x + w;
      const ph = bottom - top;
      const max = niceMax(Math.max(...have, target || 0) * 1.08);
      for (const f of [0, 0.5, 1]) {
        const gy = bottom - ph * f;
        d.line(left, gy, right, gy, f === 0 ? RULE : GRID, f === 0 ? 0.75 : 0.5);
        d.text(compact(max * f), left - 5, gy + 2.6, { size: 7, color: INK2, align: "right" });
      }
      const band = (right - left) / vals.length;
      const bw = Math.min(20, band * 0.62);
      const every = Math.max(1, Math.ceil(vals.length / 10));
      vals.forEach((v, i) => {
        const cx = left + band * i + band / 2;
        if (v != null && v > 0) {
          const bh = Math.max(1.5, (v / max) * ph);
          d.rrect(cx - bw / 2, bottom - bh, bw, bh, Math.min(3, bw / 2, bh), ORANGE, [1, 1, 0, 0]);
        }
        if (i % every === 0) d.text(vals.length > 10 ? String(dObj(days[i].day).getUTCDate()) : shortDay(days[i].day), cx, bottom + 11, { size: 6.8, color: INK2, align: "center" });
      });
      if (target) {
        const ty = bottom - (target / max) * ph;
        d.line(left, ty, right, ty, INK, 1);
      }
    };
    const cw = (PW - 2 * M - 24) / 2;
    chart(M, y, cw, 150, "Calories eaten", "kcal", T.kcal);
    chart(M + cw + 24, y, cw, 150, "Steps", "steps", T.steps);
    y += 176;

    // day table
    const cols = [
      { k: "day", t: "Day", w: 118, align: "left" },
      { k: "kcal", t: "Calories", w: 81, hit: hitK },
      { k: "protein", t: "Protein g", w: 81, hit: hitP },
      { k: "carbs", t: "Carbs g", w: 81 },
      { k: "fat", t: "Fat g", w: 81 },
      { k: "steps", t: "Steps", w: 81.28, hit: hitS },
    ];
    const drawHead = (yy) => {
      let x = M;
      d.rect(M, yy - 12, PW - 2 * M, 18, TILE);
      for (const c of cols) {
        d.text(c.t, c.align === "left" ? x + 8 : x + c.w - 14, yy, { size: 8.2, bold: true, color: INK2, align: c.align === "left" ? "left" : "right" });
        x += c.w;
      }
      return yy + 18;
    };
    const drawRow = (yy, label, t, bold) => {
      let x = M;
      for (const c of cols) {
        if (c.k === "day") d.text(label, x + 8, yy, { size: 9.2, bold });
        else {
          const v = t[c.k];
          d.text(fmt(v), x + c.w - 14, yy, { size: 9.2, bold, color: v == null ? INK2 : INK, align: "right" });
          if (!bold && c.hit && c.hit(v)) d.tick(x + c.w - 11, yy - 7.4, 8, INK);
        }
        x += c.w;
      }
      d.line(M, yy + 6, PW - M, yy + 6, GRID, 0.5);
      return yy + 18;
    };
    d.text("Day by day", M, y, { size: 12, bold: true });
    y += 20;
    y = drawHead(y);
    const bottomLimit = PH - M - 30;
    for (const x of days) {
      if (y > bottomLimit) {
        d.addPage();
        y = drawHead(M + 16);
      }
      y = drawRow(y, dayLabel(x.day), x.totals, false);
    }
    const avgs = { kcal: aK, protein: avg(col("protein")), carbs: avg(col("carbs")), fat: avg(col("fat")), steps: aS };
    if (y > bottomLimit) {
      d.addPage();
      y = drawHead(M + 16);
    }
    y = drawRow(y, "Average", avgs, true);
    y += 6;
    const notes = [];
    if (T.kcal || T.protein || T.steps) {
      const parts = [];
      if (T.kcal) parts.push(`calories within 10% of ${fmt(T.kcal)}`);
      if (T.protein) parts.push(`protein ${fmt(T.protein)} g or more`);
      if (T.steps) parts.push(`steps ${fmt(T.steps)} or more`);
      notes.push({ tick: true, t: `On target: ${parts.join(", ")}.` });
    }
    notes.push({ t: "Numbers are read automatically from the screenshots, which follow day by day." });
    if (undated.length) notes.push({ t: `${undated.length} screenshot${undated.length === 1 ? " has" : "s have"} no day set and ${undated.length === 1 ? "is" : "are"} at the end.` });
    for (const nt of notes) {
      if (y > bottomLimit) {
        d.addPage();
        y = M + 16;
      }
      let x = M;
      if (nt.tick) {
        d.tick(x, y - 7.2, 8, INK);
        x += 12;
      }
      d.text(fit(nt.t, false, 8.2, PW - 2 * M - 12), x, y, { size: 8.2, color: INK2 });
      y += 13;
    }

    // ----- screenshots, day by day -----
    const colsN = 3;
    const gap = 14;
    const cellW = (PW - 2 * M - gap * (colsN - 1)) / colsN;
    const maxH = 282; // two days of screenshots fit on a page
    const groups = days.filter((x) => x.items.length).map((x) => ({ title: dayLabel(x.day), totals: x.totals, items: x.items }));
    if (undated.length) groups.push({ title: "No day set", totals: null, items: undated });
    let done = 0;
    const totalImgs = groups.reduce((a, g) => a + g.items.length, 0);
    const kindLabel = { food: "Food", steps: "Steps", food_steps: "Food and steps", weight: "Weight", other: "Other" };
    const caption = (it) => {
      const k = kindLabel[it.kind] || "Screenshot";
      if ((it.kind === "food" || it.kind === "food_steps") && it.kcal != null) return `${k} · ${fmt(it.kcal)} kcal`;
      if (it.kind === "steps" && it.steps != null) return `${k} · ${fmt(it.steps)}`;
      return k;
    };
    const totalsLine = (t) => {
      if (!t) return "";
      const p = [];
      if (t.kcal != null) p.push(`${fmt(t.kcal)} kcal`);
      const mac = [t.protein != null ? `P ${fmt(t.protein)} g` : null, t.carbs != null ? `C ${fmt(t.carbs)} g` : null, t.fat != null ? `F ${fmt(t.fat)} g` : null].filter(Boolean);
      if (mac.length) p.push(mac.join("  "));
      if (t.steps != null) p.push(`${fmt(t.steps)} steps`);
      for (const e of (t.extras || []).slice(0, 2)) p.push(`${e.label} ${e.value}`);
      return p.join(" · ");
    };

    if (groups.length) {
      d.addPage();
      y = M + 4;
      d.text("Screenshots", M, y + 12, { size: 16, bold: true });
      y += 30;
    }
    for (const g of groups) {
      const rows = [];
      for (let i = 0; i < g.items.length; i += colsN) rows.push(g.items.slice(i, i + colsN));
      let first = true;
      for (const row of rows) {
        // scale each picture to the cell, keep the tallest for the row height
        const sized = [];
        for (const it of row) {
          const img = await opts.loadImage(it);
          done++;
          if (opts.onProgress) opts.onProgress(done, totalImgs);
          if (!img) {
            sized.push({ it, img: null, w: cellW, h: 60 });
            continue;
          }
          const s = Math.min(cellW / img.w, maxH / img.h);
          sized.push({ it, img, w: img.w * s, h: img.h * s });
        }
        const rowH = Math.max(...sized.map((s) => s.h)) + 16;
        const headH = first ? 36 : 0;
        if (y + headH + rowH > PH - M - 22) {
          d.addPage();
          y = M + 4;
          if (!first) {
            d.text(`${g.title} (continued)`, M, y + 12, { size: 12.5, bold: true });
            y += 22;
          }
        }
        if (first) {
          d.text(g.title, M, y + 12, { size: 12.5, bold: true });
          if (g.totals) d.text(fit(totalsLine(g.totals), false, 8.6, PW - 2 * M), M, y + 26, { size: 8.6, color: INK2 });
          y += 36;
          first = false;
        }
        sized.forEach((s, i) => {
          const x = M + i * (cellW + gap) + (cellW - s.w) / 2;
          if (s.img) {
            const ref = d.addImage(s.img.bytes, s.img.w, s.img.h);
            d.image(ref, x, y, s.w, s.h, 6);
            d.rrectStroke(x, y, s.w, s.h, 6, GRID, 0.6);
          } else {
            d.rrect(x, y, s.w, s.h, 6, TILE);
            d.text("Couldn't load this one", x + s.w / 2, y + s.h / 2 + 3, { size: 8, color: INK2, align: "center" });
          }
          d.text(fit(caption(s.it), false, 7.6, cellW), M + i * (cellW + gap) + cellW / 2, y + s.h + 10, { size: 7.6, color: INK2, align: "center" });
        });
        y += rowH + 8;
      }
      y += 8;
    }

    // footers now the page count is known
    const count = d.pages.length;
    d.pages.forEach((pg, i) => {
      d.cur = pg;
      d.line(M, PH - M + 2, PW - M, PH - M + 2, GRID, 0.5);
      d.text(fit(`TrueStay Results · ${clientName} · ${range}`, false, 7.6, PW - 2 * M - 70), M, PH - M + 14, { size: 7.6, color: INK2 });
      d.text(`Page ${i + 1} of ${count}`, PW - M, PH - M + 14, { size: 7.6, color: INK2, align: "right" });
    });

    const now = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const bytes = d.build({
      title: `${clientName}: food and steps, ${range}`,
      author: "TrueStay Results",
      subject: madeOn ? `Made ${madeOn}` : "",
      date: stamp,
    });
    return new Blob([bytes], { type: "application/pdf" });
  }

  const fileName = (client, from, to) => {
    const A = from ? dObj(from) : null;
    const B = to ? dObj(to) : null;
    let r = "";
    if (A && B) {
      r = A.getUTCMonth() === B.getUTCMonth() && A.getUTCFullYear() === B.getUTCFullYear()
        ? `${A.getUTCDate()} to ${B.getUTCDate()} ${MON_LONG[B.getUTCMonth()]} ${B.getUTCFullYear()}`
        : `${A.getUTCDate()} ${MON_LONG[A.getUTCMonth()]} to ${B.getUTCDate()} ${MON_LONG[B.getUTCMonth()]} ${B.getUTCFullYear()}`;
    }
    const safe = String(client || "Client").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
    return `${safe} log${r ? " " + r : ""}.pdf`;
  };

  window.TSLogPDF = { build, fileName, rangeLabel, dayLabel, winAnsi, textW };
})();
