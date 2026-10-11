// magnus-worker.js -- one Magnus process: the session manager, a fork()ed
// child of it, or a small /bin/sh running black-box programs.
// Talks to the hub in magnus-backend.js.
'use strict';

var info = null;            // init message
var M = null;               // live Emscripten module instance
var pipes = {};             // pipe key -> { chunks, len, eof }   (shared by instances)
var children = {};          // pid -> { alive, status }
var mirror = new Map();     // shared /tmp: path -> { kind: 'dir'|'file'|'fifo', data }
var gate = null;            // fork child: resolves when the parent lets it run
var gateOpen = false;
var loaded = {};

var O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 64, O_TRUNC = 512, O_APPEND = 1024;

function post(msg, transfer) { postMessage(msg, transfer || []); }
function log(s) { console.log('[' + info.pid + ' ' + (info.argv[0] || '') + '] ' + s); }

// ------------------------------------------------------------- /tmp mirror
function parentDir(p) { return p.replace(/\/[^\/]*$/, '') || '/'; }

function mirrorApply(op) {
  var mkdirs = (p) => {
    for (var d = p; d && d != '/' && !mirror.has(d); d = parentDir(d)) mirror.set(d, { kind: 'dir' });
  };
  var file = (p) => {
    var e = mirror.get(p);
    if (!e || e.kind != 'file') { mkdirs(parentDir(p)); e = { kind: 'file', data: new Uint8Array(0) }; mirror.set(p, e); }
    return e;
  };
  switch (op.op) {
    case 'mkdir': mkdirs(op.path); break;
    case 'create': file(op.path); break;
    case 'file': file(op.path).data = op.data.slice(); break;
    case 'write': {
      var e = file(op.path), end = op.pos + op.data.length;
      if (end > e.data.length) { var d = new Uint8Array(end); d.set(e.data); e.data = d; }
      e.data.set(op.data, op.pos);
      break;
    }
    case 'trunc': {
      var e = file(op.path), d = new Uint8Array(op.len);
      d.set(e.data.subarray(0, Math.min(op.len, e.data.length)));
      e.data = d;
      break;
    }
    case 'unlink': case 'rmdir': mirror.delete(op.path); break;
    case 'rename': {
      for (var [k, v] of [...mirror]) {
        if (k == op.from || k.startsWith(op.from + '/')) { mirror.delete(k); mirror.set(op.to + k.slice(op.from.length), v); }
      }
      break;
    }
    case 'mkfifo': mkdirs(parentDir(op.path)); mirror.set(op.path, { kind: 'fifo' }); break;
  }
}

function mirrorSnapshot() {
  var ops = [];
  var paths = [...mirror.keys()].sort();
  for (var p of paths) {
    var e = mirror.get(p);
    if (e.kind == 'dir') ops.push({ op: 'mkdir', path: p });
    else if (e.kind == 'fifo') ops.push({ op: 'mkfifo', path: p });
    else ops.push({ op: 'file', path: p, data: e.data });
  }
  return ops;
}

var host = {
  post,
  emit(op) {
    mirrorApply(op);
    post({ t: 'fs', op });
  },
};

// ---------------------------------------------------------------- messages
// A trap (e.g. `unreachable`) outside Emscripten's own call wrappers: treat it
// like a crash signal, the program is dead.
var running = null;          // finish() of the program image running now
self.addEventListener('error', (e) => {
  if (!info) return;
  log('crashed: ' + ((e.error && e.error.stack) || e.message).split('\n').slice(0, 4).join(' | '));
  e.preventDefault();
  if (running) running(128 + 4);           // like SIGILL
  else post({ t: 'exit', status: 128 + 4 });
});

onmessage = (e) => {
  var msg = e.data;
  switch (msg.t) {
    case 'init':
      info = msg;
      for (var op of msg.snapshot || []) mirrorApply(op);
      main().catch((err) => {
        console.error(err);
        post({ t: 'exit', status: 127 });
      });
      return;
    case 'start':
      gateOpen = true;
      if (gate) gate();
      return;
    case 'fs':
      mirrorApply(msg.op);
      break;
    case 'pipe-data': {
      var p = pipes[msg.key] ??= { chunks: [], len: 0, eof: false };
      p.chunks.push(msg.data);
      p.len += msg.data.length;
      break;
    }
    case 'pipe-eof':
      (pipes[msg.key] ??= { chunks: [], len: 0, eof: false }).eof = true;
      break;
    case 'child-exit': {
      // update in place: waiters hold on to the entry
      var c = children[msg.pid] ??= {};
      c.alive = false;
      c.status = msg.status;
      break;
    }
  }
  if (M) M.PROC.deliver(msg);
};

// ------------------------------------------------------------ run a module
function factoryFor(name) {
  if (!loaded[name]) {
    importScripts(name + '.js');
    loaded[name] = self['Magnus_' + name.replace(/\W/g, '_')];
  }
  return loaded[name];
}

// Run one program image; resolves with its exit status.
function runModule(name, argv, opts) {
  var factory = factoryFor(name);
  return new Promise((resolve) => {
    var done = false;
    var finish = (code) => { if (!done) { done = true; M = null; running = null; resolve(code); } };
    running = finish;
    var cfg = {
      thisProgram: argv[0],
      arguments: argv.slice(1),
      noInitialRun: !!opts.fork,
      print: (s) => log(s),
      printErr: (s) => log(s),
      onExit: finish,
      onAbort: (what) => { log('abort: ' + what); finish(134); },
      locateFile: (p) => p,
      onRuntimeInitialized() {
        cfg.PROC.setup(host, { pid: info.pid, ppid: info.ppid, snapshot: mirrorSnapshot(), cwd: opts.cwd, fds: opts.fds, pipes, children });
        M = cfg;
        if (opts.fork) {
          var go = () => cfg.PROC.restoreFork(opts.fork);
          if (gateOpen) setTimeout(go, 0); else gate = go;
        }
      },
    };
    if (opts.wasm) {
      cfg.instantiateWasm = (imports, ok) => {
        WebAssembly.instantiate(opts.wasm, imports).then((inst) => ok(inst, opts.wasm));
        return {};
      };
    }
    if (opts.data) cfg.getPreloadedPackage = () => opts.data;
    factory(cfg).catch((err) => { log('failed: ' + ((err && err.stack) || err)); finish(127); });
  });
}

// ----------------------------------------------------------------- shell
function tokenize(s) {
  var toks = [], cur = null, i = 0;
  var push = () => { if (cur !== null) toks.push(cur); cur = null; };
  while (i < s.length) {
    var c = s[i];
    if (c == "'") { var j = s.indexOf("'", i + 1); if (j < 0) j = s.length; cur = (cur || '') + s.slice(i + 1, j); i = j + 1; continue; }
    if (c == '"') { var j = s.indexOf('"', i + 1); if (j < 0) j = s.length; cur = (cur || '') + s.slice(i + 1, j); i = j + 1; continue; }
    if (c == '\\' && i + 1 < s.length) { cur = (cur || '') + s[i + 1]; i += 2; continue; }
    if (/\s/.test(c)) { push(); i++; continue; }
    var m = /^(&&|\|\||2>&1|2>>|2>|>>|[;&|<>])/.exec(s.slice(i));
    if (m) { push(); toks.push({ op: m[1] }); i += m[1].length; continue; }
    cur = (cur || '') + c;
    i++;
  }
  push();
  return toks;
}

function resolvePath(cwd, p) {
  if (!p.startsWith('/')) p = cwd.replace(/\/$/, '') + '/' + p;
  var out = [];
  for (var part of p.split('/')) {
    if (!part || part == '.') continue;
    if (part == '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}

function glob(cwd, pattern) {
  if (!/[*?]/.test(pattern)) return [pattern];
  var abs = resolvePath(cwd, pattern);
  var re = new RegExp('^' + abs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  var hits = [...mirror.keys()].filter((k) => re.test(k)).sort();
  return hits.length ? hits : [pattern];
}

function writeFileShared(path, bytes) {
  host.emit({ op: 'file', path, data: bytes });
}

function readFileShared(path) {
  var e = mirror.get(path);
  return e && e.kind == 'file' ? e.data : null;
}

var enc = new TextEncoder();

// Programs implemented in JS (shell builtins and scripts).
var builtins = {
  async cd(sh, args) { sh.cwd = resolvePath(sh.cwd, args[0] || '/'); return 0; },
  async true() { return 0; },
  async false() { return 1; },
  async ':'() { return 0; },
  async rm(sh, args) {
    for (var a of args) {
      if (a.startsWith('-')) continue;
      for (var p of glob(sh.cwd, a)) {
        var abs = resolvePath(sh.cwd, p);
        if (mirror.has(abs) && mirror.get(abs).kind != 'dir') host.emit({ op: 'unlink', path: abs });
      }
    }
    return 0;
  },
  async cp(sh, args) {
    args = args.filter((a) => !a.startsWith('-') && a !== '');
    var src = resolvePath(sh.cwd, args[0]), dst = resolvePath(sh.cwd, args[1]);
    var data = readFileShared(src);
    if (!data) return 1;
    writeFileShared(dst, data.slice());
    return 0;
  },
  async mv(sh, args) {
    args = args.filter((a) => !a.startsWith('-'));
    host.emit({ op: 'rename', from: resolvePath(sh.cwd, args[0]), to: resolvePath(sh.cwd, args[1]) });
    return 0;
  },
  async mkdir(sh, args) {
    for (var a of args) if (!a.startsWith('-')) host.emit({ op: 'mkdir', path: resolvePath(sh.cwd, a) });
    return 0;
  },
  async echo(sh, args, io) { io.out(args.join(' ') + '\n'); return 0; },
  async sleep(sh, args) { await new Promise((r) => setTimeout(r, 1000 * (+args[0] || 0))); return 0; },
  // kbmag's autgroup shell script (KB/src/KBmagPackage.C runs it).
  async autgroup(sh, args, io) {
    var opt = { large: false, verbose: false, veryverbose: false, silent: false, diff1: false, filestorage: false };
    var group = null;
    for (var a of args) {
      if (a == '-l' || a == '-large') opt.large = true;
      else if (a == '-v' || a == '-verbose') opt.verbose = true;
      else if (a == '-vv' || a == '-veryverbose') opt.veryverbose = true;
      else if (a == '-s' || a == '-silent') opt.silent = true;
      else if (a == '-d' || a == '-d1' || a == '-diff1') opt.diff1 = true;
      else if (a == '-f' || a == '-filestorage') opt.filestorage = true;
      else if (a.startsWith('-') || group) { io.out('Usage:\nautgroup [-large] [-verbose] [-veryverbose] [-silent] [-diff1] [-filestorage] groupname\n'); return 1; }
      else group = a;
    }
    if (!group) { io.out('Usage:\nautgroup [-large] [-verbose] [-veryverbose] [-silent] [-diff1] [-filestorage] groupname\n'); return 1; }
    if (!readFileShared(resolvePath(sh.cwd, group))) { io.out('Error: cannot read file "' + group + '"\n'); return 1; }
    var verb = opt.veryverbose ? ['-vv'] : opt.verbose ? ['-v'] : opt.silent ? ['-silent'] : [];
    var run = (prog, flags) => {
      if (!opt.silent) io.out('  ' + prog + ' ' + flags.join(' ') + ' ' + group + '\n');
      return sh.runCommand([prog, ...flags, group], io.redir);
    };
    var st = 1;
    if (!opt.large) {
      if (!opt.silent) io.out('#Running Knuth-Bendix Program:\n');
      st = await run('kbprog', ['-mt', '5', '-hf', '100', '-t', '20', '-me', '200', '-ms', '1000', '-wd', ...verb]);
    }
    if (st != 0 || opt.large) {
      if (!opt.large && !opt.silent) io.out('\n');
      var flags = ['-mt', '20', '-hf', '100', '-cn', '0', '-wd', ...verb];
      if (opt.large) flags.push('-me', '262144', '-t', '500');
      if (!opt.silent) io.out(opt.large ? '#Running Knuth-Bendix Program\n' : '#Re-running Knuth-Bendix Program\n');
      if ((await run('kbprog', flags)) != 0) { io.out('#Knuth-Bendix program failed or was inconclusive. Giving up.\n'); return 1; }
    }
    if (!opt.silent) io.out('\n');
    var mf = [...(opt.large ? ['-l'] : []), ...verb, ...(opt.diff1 ? ['-diff1'] : []), ...(opt.filestorage ? ['-f'] : [])];
    if (!opt.silent) io.out('#Running program to construct word-acceptor and multiplier automata\n');
    if ((await run('gpmakefsa', mf)) != 0) { io.out('#Program to construct word-acceptor and multiplier automata failed. Giving up.\n'); return 1; }
    if (!opt.silent) io.out('\n');
    var af = [...(opt.large ? ['-l'] : []), ...verb, ...(opt.filestorage ? ['-f', '-ip', 's'] : [])];
    if (!opt.silent) io.out('#Running program to verify axioms on the automatic structure\n');
    st = await run('gpaxioms', af);
    if (st == 0) { writeFileShared(resolvePath(sh.cwd, group + '.success'), enc.encode('0;\n')); return 0; }
    if (st == 2) { io.out('#Program to verify axioms on the automatic structure failed.\n'); return 2; }
    return 1;
  },
};

class Shell {
  constructor(cwd, fds) {
    this.cwd = cwd || '/';
    this.fds = fds || [];
    this.status = 0;
  }

  // Keep pipe/FIFO descriptors open in this process while a command (which
  // may run several programs, e.g. a script) uses them: a FIFO must not see
  // end-of-file between two programs writing to it.  Returns the release.
  hold(descs) {
    var ends = descs.filter((d) => d && d.pipe !== undefined)
      .map((d) => ({ key: d.pipe, role: (d.flags & 3) == O_RDONLY ? 'r' : (d.flags & 3) == O_WRONLY ? 'w' : 'rw' }));
    for (var e of ends) post({ t: 'pipe-open', key: e.key, role: e.role });
    return () => { for (var e of ends) post({ t: 'pipe-close', key: e.key, role: e.role }); };
  }

  // Descriptor list for a program, after applying redirections.
  fdsFor(redir) {
    var fds = this.fds.filter((d) => d.fd > 2 || !(d.fd in redir));
    for (var fd in redir) fds.push(Object.assign({ fd: +fd }, redir[fd]));
    return fds;
  }

  redirect(kind, target) {
    var path = resolvePath(this.cwd, target);
    var e = mirror.get(path);
    if (e && e.kind == 'fifo') return { pipe: path, flags: kind == '<' ? O_RDONLY : O_WRONLY };
    if (kind == '<') return { path, flags: O_RDONLY, pos: 0 };
    if (kind == '>' ) { host.emit({ op: 'trunc', path, len: 0 }); return { path, flags: O_WRONLY, pos: 0 }; }
    host.emit({ op: 'create', path });
    return { path, flags: O_WRONLY | O_APPEND, pos: (readFileShared(path) || []).length };
  }

  // Output written by JS builtins goes to the redirected file or stdout pipe.
  ioFor(redir) {
    var d = redir[1] || this.fds.find((x) => x.fd == 1);
    return {
      redir,
      out: (text) => {
        if (!d) return;
        var bytes = enc.encode(text);
        if (d.pipe !== undefined) post({ t: 'pipe-write', key: d.pipe, data: bytes }, [bytes.buffer]);
        else if (d.path) {
          var cur = readFileShared(d.path) || new Uint8Array(0);
          host.emit({ op: 'write', path: d.path, pos: cur.length, data: bytes });
        } else log(text.replace(/\n$/, ''));
      },
    };
  }

  async runCommand(words, redir) {
    var name = words[0].replace(/^.*\//, '');
    if (builtins[name]) return builtins[name](this, words.slice(1), this.ioFor(redir));
    var mod = info.programs[name];
    if (!mod) {
      log('sh: ' + words[0] + ': command not found');
      return 127;
    }
    // Multi-call modules dispatch on argv[0].
    return runModule(mod, [name, ...words.slice(1)], { cwd: this.cwd, fds: this.fdsFor(redir) });
  }

  async run(script) {
    var toks = tokenize(script);
    var words = [], redir = {}, skip = false;
    var flush = async (sep) => {
      if (words.length && !skip) {
        var release = this.hold(Object.values(redir));
        try { this.status = await this.runCommand(words, redir); } finally { release(); }
      }
      skip = (sep == '&&' && this.status != 0) || (sep == '||' && this.status == 0);
      words = [];
      redir = {};
    };
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (typeof t == 'string') { words.push(...glob(this.cwd, t).map((x) => (x === t ? t : x))); continue; }
      switch (t.op) {
        case '<': case '>': case '>>': redir[t.op == '<' ? 0 : 1] = this.redirect(t.op, toks[++i]); break;
        case '2>': case '2>>': redir[2] = this.redirect(t.op.slice(1), toks[++i]); break;
        case '2>&1': redir[2] = redir[1] || this.fds.find((d) => d.fd == 1) || {}; break;
        case ';': case '&': case '&&': case '||': case '|': await flush(t.op); break;
      }
    }
    await flush(';');
    return this.status;
  }
}

// ------------------------------------------------------------------- main
async function main() {
  var status;
  if (info.kind == 'program' || info.kind == 'fork') {
    status = await runModule(info.module, info.argv, { cwd: info.cwd, fds: info.fds, wasm: info.wasm, data: info.data, fork: info.fork });
  } else {
    var sh = new Shell(info.cwd, info.fds);
    sh.hold(sh.fds);   // inherited descriptors stay open until the shell exits
    var argv = info.argv;
    if (argv[0].replace(/^.*\//, '') == 'sh' && argv[1] == '-c') status = await sh.run(argv[2] || '');
    else status = await sh.runCommand([info.path || argv[0], ...argv.slice(1)], {});
  }
  post({ t: 'exit', status: status | 0 });
}
