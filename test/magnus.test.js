// magnus.test.js -- drive the Magnus GUI in headless Chromium.
//   node test/magnus.test.js [url] [scenario...]
// Uses only mouse and keyboard input on the x11.wasm canvas for the user
// actions; Tcl introspection (winfo/menu geometry) is used to find where to
// click and to read results back.  The group checked in is
// G1 = <a,b; a^2, b^3, (a b)^5> (the alternating group A5), so the expected
// answers are known: order 60, perfect, not abelian, automatic, H_2 = Z_2.
'use strict';
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const url = process.argv[2] || 'http://localhost:8000/';
const only = process.argv.slice(3);
const shots = process.env.SHOTS || '';

let page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tcl = (s) => page.evaluate((s) => Module.ccall('MagnusEval', 'string', ['string'], [s]), s);

async function waitTcl(expr, ms = 30000, what = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await tcl(`expr {${expr}}`)) === '1') return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function geom(w) {
  const [x, y, wd, ht] = (await tcl(`list [winfo rootx ${w}] [winfo rooty ${w}] [winfo width ${w}] [winfo height ${w}]`)).split(' ').map(Number);
  return { x, y, w: wd, h: ht };
}

async function click(x, y) {
  await page.mouse.move(x - 3, y - 3);
  await page.mouse.move(x, y);
  await sleep(60);
  await page.mouse.click(x, y);
}

async function clickWidget(w) {
  const g = await geom(w);
  await click(g.x + g.w / 2, g.y + g.h / 2);
}

async function type(text) {   // like a US keyboard: Shift held for shifted characters
  const shifted = { '~': 'Backquote', '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', '_': 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period', '?': 'Slash' };
  for (const ch of text) {
    if (shifted[ch] || /[A-Z]/.test(ch)) {
      await page.keyboard.down('Shift');
      await page.keyboard.press(shifted[ch] || 'Key' + ch);
      await page.keyboard.up('Shift');
    } else {
      await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    }
    await sleep(10);
  }
}

// Pick top/menubar-entry/.../entry through the menus with the mouse.
async function menu(top, ...labels) {
  const mbar = top === '.' ? '.#mbar' : `${top}.#${top.slice(1).replace(/\./g, '#')}#mbar`;
  let m = mbar;
  for (let i = 0; i < labels.length; i++) {
    const idx = await tcl(`${m} index {${labels[i]}}`);
    if (idx === 'none' || idx.startsWith('ERROR')) throw new Error(`no menu entry "${labels[i]}" in ${m}`);
    const g = await geom(m);
    let x, y;
    if (m === mbar) {
      x = g.x + Number(await tcl(`${m} xposition ${idx}`)) + 8;
      y = g.y + g.h / 2;
    } else {
      x = g.x + 30;
      y = g.y + Number(await tcl(`${m} yposition ${idx}`)) + 6;
    }
    const isCascade = (await tcl(`${m} type ${idx}`)) === 'cascade';
    if (isCascade) {
      const sub = await tcl(`${m} entrycget ${idx} -menu`);
      for (let attempt = 0; ; attempt++) {
        await page.mouse.move(x - 3, y - 2);
        await page.mouse.move(x, y);
        await sleep(100);
        if (m === mbar) {
          // press, wait for the menu to post, release (keeps it posted)
          await page.mouse.down();
          try { await waitTcl(`[winfo ismapped ${sub}]`, 2000); } catch (e) {}
          await page.mouse.up();
        } else {
          try { await waitTcl(`[winfo ismapped ${sub}]`, 1500); } catch (e) { await page.mouse.click(x, y); }
        }
        try { await waitTcl(`[winfo ismapped ${sub}]`, 1000); break; } catch (e) {
          if (attempt == 3) throw e;
          await page.keyboard.press('Escape');
          await sleep(300);
        }
      }
      m = sub;
    } else {
      await click(x, y);
    }
  }
  await sleep(300);
}

async function newToplevel(before, title, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const tops = (await tcl(`set r {}; foreach w [winfo children .] { if {[winfo toplevel $w] eq $w && [winfo ismapped $w]} { lappend r $w } }; set r`)).split(' ');
    for (const w of tops) {
      if (!before.includes(w) && (!title || (await tcl(`wm title ${w}`)).includes(title))) return w;
    }
    await sleep(250);
  }
  throw new Error(`no new window "${title}"`);
}

const toplevels = async () => (await tcl(`set r {}; foreach w [winfo children .] { if {[winfo toplevel $w] eq $w} { lappend r $w } }; set r`)).split(' ');
const log = () => tcl('.frame3.log get 1.0 end');

async function waitLog(re, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const text = await log();
    const m = text.match(re);
    if (m) return m[0];
    await sleep(500);
  }
  throw new Error(`session log never matched ${re}`);
}

async function shot(name) { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); }

// Select a workspace icon by clicking it.
async function selectIcon(name) {
  // Icons are an "icon" item above a "name" text item; click the icon.
  const c = '.workspace.frame2.c';
  const bbox = await tcl(`foreach i [${c} find withtag name] { if {[${c} itemcget $i -text] eq {${name}}} { set t $i } }; ${c} bbox [${c} find closest [expr {([lindex [${c} bbox $t] 0]+[lindex [${c} bbox $t] 2])/2}] [expr {[lindex [${c} bbox $t] 1]-15}]]`);
  const [x0, y0, x1, y1] = bbox.split(' ').map(Number);
  if (!(x1 > x0)) throw new Error(`no icon named ${name}`);
  const g = await geom(c);
  await click(g.x + (x0 + x1) / 2, g.y + (y0 + y1) / 2);
  await sleep(500);
}

// Click on an empty part of the workspace: no icon selected.
async function deselect() {
  const g = await geom('.workspace.frame2.c');
  await click(g.x + g.w - 40, g.y + g.h - 40);
  await sleep(300);
}

async function checkin(kind, name, defn) {
  const before = await toplevels();
  await menu('.workspace', 'Check-in', kind);
  const d = await newToplevel(before, 'Define');
  await sleep(700);
  await clickWidget(`${d}.frame1.entry`);
  await tcl(`${d}.frame1.entry delete 0 end`);
  await type(name);
  await clickWidget(`${d}.frame2.frame.text`);
  await tcl(`${d}.frame2.frame.text delete 1.0 end`);
  await type(defn);
  await shot('checkin-' + name);
  await clickWidget(await tcl(`::t::button ${d} Ok`));
}

// Set the ARC slider of every subproblem row of problem window `w`:
// value(label) gives the new value (or null to leave it).
async function setSliders(w, value) {
  const rows = await tcl(`join [lmap s [::t::findAll ${w} Scale] { set l {}; catch { set l [[winfo parent $s].button cget -text] }; string cat $s \\t $l }] \\n`);
  for (const row of rows.split('\n')) {
    const [sc, label] = row.split('\t');
    const v = value(label || '');
    if (v === null || v === undefined || +(await tcl(`${sc} get`)) === v) continue;
    const g = await geom(sc);
    const [x0, y0] = (await tcl(`${sc} coords`)).split(' ').map(Number);
    let [x1] = (await tcl(`${sc} coords ${v}`)).split(' ').map(Number);
    if (v <= +(await tcl(`${sc} cget -from`))) x1 -= 30;     // overshoot: the scale clamps
    if (v >= +(await tcl(`${sc} cget -to`))) x1 += 30;
    await page.mouse.move(g.x + x0, g.y + y0);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(g.x + x0 + ((x1 - x0) * i) / 10, g.y + y0); await sleep(30); }
    // the view copies the value to its entry *before* each motion moves the
    // slider, so move once more where the slider already is
    await page.mouse.move(g.x + x1 + 1, g.y + y0);
    await sleep(30);
    await page.mouse.up();
    await sleep(200);
  }
}

// Run a problem from the Tools menu: open it, press Start, wait for `re`.
async function runProblem(path, re, ms = 120000, sliders = null) {
  const before = await toplevels();
  await menu('.workspace', 'Tools', ...path);
  let w = null;
  try { w = await newToplevel(before, '', 5000); await sleep(700); } catch (e) { /* some answers come at once */ }
  if (w && sliders) await setSliders(w, sliders);
  const start = w ? await tcl(`::t::button ${w} Start`) : '';
  if (start) await clickWidget(start);
  const hit = await waitLog(re, ms);
  if (w) await shot('problem-' + path[path.length - 1].replace(/\W+/g, '_'));
  return hit;
}

const scenarios = {
  async startup() {
    await waitLog(/Magnus is now ready for use\./, 60000);
  },
  async checkinGroup() {
    await checkin('Finitely Presented Group', 'G1', '<a,b; a^2, b^3, (a b)^5>');
    await waitLog(/G1 = <a,b; a\^2, b\^3, \(a b\)\^5>/);
  },
  async order() {
    await selectIcon('G1');
    return runProblem(['Compute ...', 'Compute the order of G1'], /G1 has order 60[^\n]*/);
  },
  async abelianization() {
    await selectIcon('G1');
    return runProblem(['Compute ...', 'Compute the canonical decomposition of G1 abelianized'], /G1 abelianized:\s+1\./);
  },
  async abelian() {
    await selectIcon('G1');
    return runProblem(['Is G1 ...', 'Is G1 abelian ?'], /G1 is not abelian[^\n]*/);
  },
  async automatic() {
    await selectIcon('G1');
    return runProblem(['Is G1 ...', 'Is G1 automatic ?'], /G1 is automatic[^\n]*/, 180000);
  },
  async homology() {
    await selectIcon('G1');
    const before = await toplevels();
    await menu('.workspace', 'Tools', 'Compute ...', 'Compute an integral homology group of G1');
    // "What dimension?" dialog
    const d = await newToplevel(before, '', 10000);
    await sleep(700);
    await clickWidget(await tcl(`::t::find ${d} Entry`));
    await type('2');
    await shot('homology-dimension');
    const afterDialog = await toplevels();
    await clickWidget(await tcl(`::t::button ${d} OK`));
    const w = await newToplevel(afterDialog.filter((x) => x !== d), '', 10000);
    await sleep(700);
    // The homology needs a confluent rewriting system: give resources to the
    // "Seek a rewriting system" subproblem by dragging its slider.
    await setSliders(w, (label) => (/^Seek a rewriting system/.test(label) ? 100 : null));
    await shot('homology-arcs');
    await clickWidget(await tcl(`::t::button ${w} Start`));
    const hit = await waitLog(/Dimension 2 integral homology: Z\^0 x Z_2\./, 120000);
    await shot('problem-homology');
    return hit;
  },
  async finiteACE() {
    // A fresh copy of A5; only the GH Todd-Coxeter subproblem (black box
    // ace) gets resources.
    await deselect();
    await checkin('Finitely Presented Group', 'G3', '<a,b; a^2, b^3, (a b)^5>');
    await waitLog(/G3 = <a,b; a\^2, b\^3, \(a b\)\^5>/);
    await selectIcon('G3');
    return runProblem(['Is G3 ...', 'Is G3 finite ?'], /G3 [^\n]*according to the GH Todd-Coxeter algorithm[^\n]*/, 120000,
      (label) => (/^(For the use|GH Todd-Coxeter)/.test(label) ? 100 : 0));
  },
  async oneRelator() {
    // BS(1,2) as a one-relator group; [a,b] = b there, so w2 is not trivial
    // (decided by the Magnus breakdown, black box orwp).
    await deselect();
    await checkin('One Relator Group', 'G2', '<a,b; a b a^-1 b^-2>');
    await waitLog(/G2 = [^\n]*/);
    await selectIcon('G2');
    await checkin('Word in the generators of G2', 'w2', 'a b a^-1 b^-1');
    await waitLog(/w2 = [^\n]*/);
    await selectIcon('w2');
    return runProblem(['Is w2 ...', 'Is w2 trivial ?'], /w2 is not trivial[^\n]*/, 120000);
  },
};

(async () => {
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  if (process.env.VERBOSE) page.on('console', (m) => console.log('[console]', m.text().slice(0, 300)));
  await page.goto(url);
  await page.waitForFunction(() => { try { return Module.ccall('MagnusEval', 'string', ['string'], ['info exists argv0']) === '1'; } catch (e) { return false; } }, null, { timeout: 60000, polling: 250 });
  await tcl(`namespace eval ::t {}
    proc ::t::find {w class} {
      foreach c [winfo children $w] {
        if {[winfo class $c] eq $class} { return $c }
        set r [::t::find $c $class]
        if {$r ne ""} { return $r }
      }
      return ""
    }
    proc ::t::findAll {w class} {
      set r {}
      foreach c [winfo children $w] {
        if {[winfo class $c] eq $class} { lappend r $c }
        lappend r {*}[::t::findAll $c $class]
      }
      return $r
    }
    proc ::t::button {w text} {
      foreach c [winfo children $w] {
        if {[winfo class $c] eq "Button" && [$c cget -text] eq $text} { return $c }
        set r [::t::button $c $text]
        if {$r ne ""} { return $r }
      }
      return ""
    }`);
  if (process.env.RECORD) await page.evaluate(() => { window.__sent = []; const o = MagnusBackend.send; MagnusBackend.send = (t) => { __sent.push(t); o(t); }; });
  let failed = 0;
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only.length && !only.includes(name) && !['startup', 'checkinGroup'].includes(name)) continue;
    const t0 = Date.now();
    try {
      const r = await fn();
      console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${r ? ': ' + r.replace(/\s+/g, ' ') : ''}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}: ${e.message}`);
      await shot('fail-' + name);
    }
  }
  await shot('final');
  if (process.env.RECORD) require('fs').writeFileSync(process.env.RECORD, (await page.evaluate(() => __sent)).join(''));
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
