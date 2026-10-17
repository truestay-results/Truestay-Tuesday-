/* TrueStay Pay: a receipt for a paid payment, made on the phone as a one page PDF (A5).
   A client sees this, so it wears the TrueStay Results brand (charcoal, off-white, burnt orange) like the Logs PDFs,
   not the app's lime. A tiny PDF writer with Helvetica, so there's no library to load.
   window.TSReceipt.build(opts) -> PDF bytes; .png(opts) -> a picture of the same receipt (see the opts note on draw below). */
(() => {
  "use strict";

  // Helvetica and Helvetica-Bold widths for WinAnsi codes 32..255 (from the standard font metrics)
  const W_REG = "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500"
    .split(",").map(Number);
  const W_BOLD = "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556"
    .split(",").map(Number);

  const PW = 419.53; // A5
  const PH = 595.28;
  const M = 32;

  const INK = "#1A1A1A";
  const INK2 = "#5E5E5E"; // secondary text, 6.5:1 on white
  const ORANGE = "#C45A1E"; // marks only
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
      else if (c === 0x2212) out += "-"; // minus sign
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
  function wrap(s, bold, size, maxW) {
    const words = String(s).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (textW(t, bold, size) <= maxW || !cur) cur = t;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
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

  // one page of drawing ops, top-left coordinates in
  class Page {
    constructor() {
      this.ops = [];
    }
    rect(x, y, w, h, fill) {
      this.ops.push(`${rgb(fill)} rg ${n2(x)} ${n2(PH - y - h)} ${n2(w)} ${n2(h)} re f`);
    }
    rrect(x, y, w, h, r, fill) {
      r = Math.max(0, Math.min(r, w / 2, h / 2));
      const k = 0.5523 * r;
      const X = n2;
      const Y = (v) => n2(PH - v);
      this.ops.push(
        `${rgb(fill)} rg ${X(x + r)} ${Y(y)} m ${X(x + w - r)} ${Y(y)} l ${X(x + w - r + k)} ${Y(y)} ${X(x + w)} ${Y(y + r - k)} ${X(x + w)} ${Y(y + r)} c ` +
          `${X(x + w)} ${Y(y + h - r)} l ${X(x + w)} ${Y(y + h - r + k)} ${X(x + w - r + k)} ${Y(y + h)} ${X(x + w - r)} ${Y(y + h)} c ` +
          `${X(x + r)} ${Y(y + h)} l ${X(x + r - k)} ${Y(y + h)} ${X(x)} ${Y(y + h - r + k)} ${X(x)} ${Y(y + h - r)} c ` +
          `${X(x)} ${Y(y + r)} l ${X(x)} ${Y(y + r - k)} ${X(x + r - k)} ${Y(y)} ${X(x + r)} ${Y(y)} c h f`
      );
    }
    line(x1, y1, x2, y2, color, lw) {
      this.ops.push(`${rgb(color)} RG ${n2(lw)} w 0 J ${n2(x1)} ${n2(PH - y1)} m ${n2(x2)} ${n2(PH - y2)} l S`);
    }
    text(s, x, y, { size = 10, bold = false, color = INK, align = "left", cs = 0 } = {}) {
      const t = winAnsi(s);
      const w = textW(s, bold, size, cs);
      const x0 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      this.ops.push(`${rgb(color)} rg BT /${bold ? "F2" : "F1"} ${n2(size)} Tf ${n2(cs)} Tc ${n2(x0)} ${n2(PH - y)} Td (${escStr(t)}) Tj ET`);
      return w;
    }
  }
  function pdf(page, meta) {
    const chunks = [];
    let len = 0;
    const offsets = [];
    const push = (x) => {
      const u = typeof x === "string" ? bin(x) : x;
      chunks.push(u);
      len += u.length;
    };
    const obj = (id, body) => {
      offsets[id] = len;
      push(`${id} 0 obj\n`);
      push(body);
      push("\nendobj\n");
    };
    const content = page.ops.join("\n");
    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [6 0 R] /Count 1 >>");
    obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    obj(
      5,
      `<< /Title (${escStr(winAnsi(meta.title))}) /Author (${escStr(winAnsi(meta.author))}) /Creator (TrueStay Pay) /Producer (TrueStay Pay) /CreationDate (D:${meta.date}) >>`
    );
    obj(6, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 7 0 R >>`);
    obj(7, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const xref = len;
    let x = "xref\n0 8\n0000000000 65535 f \n";
    for (let id = 1; id < 8; id++) x += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    push(x);
    push(`trailer\n<< /Size 8 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dObj = (iso) => new Date(iso + "T12:00:00Z");
  const longDay = (iso) => {
    const d = dObj(iso);
    return `${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MON_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  const money = (p) => {
    const neg = p < 0;
    const a = Math.abs(p);
    return `${neg ? "-" : ""}£${Math.floor(a / 100).toLocaleString("en-GB")}.${String(a % 100).padStart(2, "0")}`;
  };

  // opts: {
  //   no: "0026", client: "Angie Dwyer", paidOn: "2026-10-16",
  //   lines: [{ title: "Full coaching", sub: "4 months, 16 Oct 2026 to 15 Feb 2027", amount: 92000 }, { title: "Paid ahead discount", amount: -20000 }],
  //   total: 72000, method: "Direct debit" | null,
  //   trainer: "Shan", business: "TrueStay Results", phone: "07401 738819",
  //   place: "Personal training at The Gym Group, Meanwood, Leeds", site: "truestaytuesday.com/coaching"
  // }
  // the receipt drawn onto any page that has rect, rrect, line and text; returns how far down it went
  // fit: the picture version, where the footer follows the thanks instead of sitting at the foot of an A5 page
  function draw(o, pg, fit) {
    const W = PW - 2 * M;

    // header band
    pg.rect(0, 0, PW, 108, INK);
    pg.rect(0, 108, PW, 4, ORANGE);
    pg.text("TRUESTAY RESULTS", M, 36, { size: 8, bold: true, color: CREAM, cs: 1.6 });
    pg.text("Receipt", M, 76, { size: 28, bold: true, color: "#FFFFFF" });
    pg.text(`No. ${o.no}`, PW - M, 76, { size: 10.5, bold: true, color: CREAM, align: "right" });

    // who, when
    let y = 150;
    const kx = M;
    const vx = M + 96;
    const vw = PW - M - vx;
    const row = (k, v) => {
      pg.text(k, kx, y, { size: 9.5, color: INK2 });
      const ls = wrap(v, true, 11.5, vw);
      ls.forEach((l, i) => pg.text(l, vx, y + i * 15, { size: 11.5, bold: true }));
      y += 15 * (ls.length - 1) + 24;
    };
    row("Received from", o.client);
    row("Paid on", longDay(o.paidOn));
    if (o.method) row("Paid by", o.method);

    // what it's for, measured first so the tile fits behind it
    const pad = 16;
    const tx = M + pad;
    const amtX = PW - M - pad;
    const titleW = W - 2 * pad - 96;
    const items = o.lines.map((l) => {
      const t = wrap(l.title, true, 11, titleW);
      const s = l.sub ? wrap(l.sub, false, 9.5, titleW) : [];
      return { l, t, s, h: t.length * 14 + s.length * 12.5 + 10 };
    });
    const top = y + 4;
    const headH = 30;
    const bodyH = items.reduce((a, it) => a + it.h, 0);
    const totalH = 46;
    const tileH = headH + bodyH + totalH + 8;
    pg.rrect(M, top, W, tileH, 10, TILE);
    pg.text("WHAT IT'S FOR", tx, top + 20, { size: 7.5, bold: true, color: INK2, cs: 0.9 });
    pg.text("AMOUNT", amtX, top + 20, { size: 7.5, bold: true, color: INK2, cs: 0.9, align: "right" });
    pg.line(tx, top + headH, amtX, top + headH, GRID, 0.8);
    let iy = top + headH + 18;
    for (const it of items) {
      it.t.forEach((l, i) => pg.text(l, tx, iy + i * 14, { size: 11, bold: true }));
      pg.text(money(it.l.amount), amtX, iy, { size: 11, bold: it.l.amount >= 0, color: it.l.amount < 0 ? INK2 : INK, align: "right" });
      let sy = iy + (it.t.length - 1) * 14 + 13.5;
      it.s.forEach((l) => {
        pg.text(l, tx, sy, { size: 9.5, color: INK2 });
        sy += 12.5;
      });
      iy += it.h;
    }
    const ty = top + headH + bodyH + 2;
    pg.line(tx, ty, amtX, ty, RULE, 1);
    pg.text("Total paid", tx, ty + 29, { size: 12, bold: true });
    pg.text(money(o.total), amtX, ty + 31, { size: 20, bold: true, align: "right" });

    // thanks
    y = top + tileH + 34;
    pg.text(`Thanks for training with ${o.business}.`, M, y, { size: 11 });
    pg.text(`Any questions about this, message me on ${o.phone}.`, M, y + 16, { size: 9.5, color: INK2 });

    // footer
    const fy = fit ? y + 50 : PH - 64;
    pg.line(M, fy, PW - M, fy, RULE, 0.8);
    pg.text(`${o.trainer ? o.trainer + " · " : ""}${o.business} · ${o.phone}`, M, fy + 20, { size: 9, bold: true });
    const foot = wrap(`${o.place} · ${o.site}`, false, 8.5, W);
    foot.forEach((l, i) => pg.text(l, M, fy + 34 + i * 11, { size: 8.5, color: INK2 }));
    return fy + 34 + (foot.length - 1) * 11 + 28;
  }

  function build(o) {
    const pg = new Page();
    draw(o, pg, false);
    const now = new Date();
    const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}${String(now.getUTCHours()).padStart(2, "0")}${String(
      now.getUTCMinutes()
    ).padStart(2, "0")}00Z`;
    return pdf(pg, { title: `Receipt ${o.no} · ${o.client}`, author: o.business, date: stamp });
  }

  // ---------- the same receipt as a picture ----------
  // A picture lands in a WhatsApp chat like a photo, and copies and pastes into a chat properly, which a PDF doesn't.
  class NullPage {
    rect() {}
    rrect() {}
    line() {}
    text() {}
  }
  class CanvasPage {
    constructor(scale, h) {
      this.c = document.createElement("canvas");
      this.c.width = Math.round(PW * scale);
      this.c.height = Math.round(h * scale);
      const g = (this.g = this.c.getContext("2d"));
      g.scale(scale, scale);
      g.fillStyle = "#FFFFFF";
      g.fillRect(0, 0, PW, h);
      g.textBaseline = "alphabetic";
    }
    font(size, bold) {
      this.g.font = `${bold ? 700 : 400} ${size}px Helvetica, "Helvetica Neue", Arial, sans-serif`;
    }
    rect(x, y, w, h, fill) {
      this.g.fillStyle = fill;
      this.g.fillRect(x, y, w, h);
    }
    rrect(x, y, w, h, r, fill) {
      const g = this.g;
      r = Math.max(0, Math.min(r, w / 2, h / 2));
      g.fillStyle = fill;
      g.beginPath();
      g.moveTo(x + r, y);
      g.lineTo(x + w - r, y);
      g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r);
      g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      g.lineTo(x + r, y + h);
      g.quadraticCurveTo(x, y + h, x, y + h - r);
      g.lineTo(x, y + r);
      g.quadraticCurveTo(x, y, x + r, y);
      g.closePath();
      g.fill();
    }
    line(x1, y1, x2, y2, color, lw) {
      const g = this.g;
      g.strokeStyle = color;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    text(s, x, y, { size = 10, bold = false, color = INK, align = "left", cs = 0 } = {}) {
      const g = this.g;
      const t = String(s ?? "");
      this.font(size, bold);
      g.fillStyle = color;
      if (!cs) {
        g.textAlign = align;
        g.fillText(t, x, y);
        return g.measureText(t).width;
      }
      // letter spacing, a character at a time (not every phone has canvas letterSpacing)
      const chars = [...t];
      const w = chars.reduce((a, ch) => a + g.measureText(ch).width + cs, 0) - cs;
      let cx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      g.textAlign = "left";
      for (const ch of chars) {
        g.fillText(ch, cx, y);
        cx += g.measureText(ch).width + cs;
      }
      return w;
    }
  }
  function canvas(o, scale = 3) {
    const h = Math.ceil(draw(o, new NullPage(), true));
    const pg = new CanvasPage(scale, h);
    draw(o, pg, true);
    return pg.c;
  }
  const png = (o, scale = 3) =>
    new Promise((res, rej) => canvas(o, scale).toBlob((b) => (b ? res(b) : rej(new Error("Couldn't draw the receipt"))), "image/png"));

  window.TSReceipt = { build, pdf: build, canvas, png };
})();
