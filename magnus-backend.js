// magnus-backend.js -- main-thread hub for the Magnus back end.
//
// The Tcl/Tk front end (main.c / boot.tcl) talks to the session manager
// through MagnusBackend.spawn/send/pending/take.  Every Magnus process
// (session manager, fork()ed children, black boxes) is a Web Worker running
// magnus-worker.js; this hub routes pipes, FIFOs, signals and child exits
// between them and keeps /tmp in sync with the front end's file system.
'use strict';

var MagnusBackend = (function () {
  var SIGKILL = 9, SIGTERM = 15, SIGINT = 2, SIGHUP = 1, SIGCONT = 18, SIGSTOP = 19;

  // Black-box programs: name -> module (multi-call modules dispatch on argv[0]).
  var programs = {};

  var procs = new Map();   // pid -> process
  var pipes = new Map();   // key -> { readers: [pid], writers, pending: [], eofPending, everWritten }
  var nextPid = 100;
  var inbox = [];
  var partial = '';
  var decoder = new TextDecoder();
  var be = null;           // { wasm: Promise<WebAssembly.Module>, data: Promise<ArrayBuffer> }

  // The front end's file system (absent when the back end runs alone).
  function FS() { return typeof Module != 'undefined' && Module.FS; }

  function backEnd() {
    if (!be) {
      be = {
        wasm: WebAssembly.compileStreaming(fetch('magnus.wasm')),
        data: fetch('magnus.data').then((r) => r.arrayBuffer()),
        programs: fetch('programs.json').then((r) => r.json()).then((p) => Object.assign(programs, p)),
      };
    }
    return be;
  }

  // ------------------------------------------------------------- /tmp sync
  function snapshot() {
    var ops = [];
    var walk = (dir) => {
      var names;
      try { names = FS().readdir(dir); } catch (e) { return; }
      for (var n of names) {
        if (n == '.' || n == '..') continue;
        var p = dir + '/' + n, st;
        try { st = FS().lstat(p); } catch (e) { continue; }
        if (FS().isDir(st.mode)) { ops.push({ op: 'mkdir', path: p }); walk(p); }
        else if (FS().isChrdev(st.mode)) ops.push({ op: 'mkfifo', path: p });
        else if (FS().isFile(st.mode)) ops.push({ op: 'file', path: p, data: FS().readFile(p) });
      }
    };
    walk('/tmp');
    return ops;
  }

  function applyFs(op) {
    var fs = FS();
    if (!fs) return;
    var exists = (p) => { try { fs.lookupPath(p); return true; } catch (e) { return false; } };
    var parent = (p) => { try { fs.mkdirTree(p.replace(/\/[^\/]*$/, '')); } catch (e) {} };
    try {
      switch (op.op) {
        case 'mkdir': fs.mkdirTree(op.path); break;
        case 'create': if (!exists(op.path)) { parent(op.path); fs.writeFile(op.path, new Uint8Array(0)); } break;
        case 'file': parent(op.path); fs.writeFile(op.path, op.data); break;
        case 'write': {
          if (!exists(op.path)) { parent(op.path); fs.writeFile(op.path, new Uint8Array(0)); }
          var s = fs.open(op.path, 1);
          fs.write(s, op.data, 0, op.data.length, op.pos);
          fs.close(s);
          break;
        }
        case 'trunc':
          if (!exists(op.path)) { parent(op.path); fs.writeFile(op.path, new Uint8Array(0)); }
          fs.truncate(op.path, op.len);
          break;
        case 'unlink': fs.unlink(op.path); break;
        case 'rmdir': fs.rmdir(op.path); break;
        case 'rename': fs.rename(op.from, op.to); break;
        case 'mkfifo': if (!exists(op.path)) { parent(op.path); fs.mknod(op.path, 0o20666, fs.makedev(66, 0)); } break;
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------- pipes
  function pipe(key) {
    var p = pipes.get(key);
    if (!p) pipes.set(key, p = { readers: [], writers: 0, pending: [], eofPending: false, everWritten: false });
    return p;
  }

  function reader(p) {
    for (var pid of p.readers) {
      if (pid == 'FE' || procs.has(pid)) return pid;
    }
    return null;
  }

  function deliver(key, data) {
    var p = pipe(key), r = reader(p);
    if (r == null) { p.pending.push(data); return; }
    if (r == 'FE') { feOutput(data); return; }
    procs.get(r).worker.postMessage({ t: 'pipe-data', key, data }, [data.buffer]);
  }

  function sendEof(key) {
    var p = pipe(key), r = reader(p);
    if (r == null) { p.eofPending = true; return; }
    if (r != 'FE') procs.get(r).worker.postMessage({ t: 'pipe-eof', key });
  }

  function pipeOpen(proc, key, role) {
    var p = pipe(key);
    if (role != 'w') {
      p.readers.push(proc.pid);
      proc.ends.push({ key, role: 'r' });
      var pend = p.pending;
      p.pending = [];
      for (var d of pend) deliver(key, d);
      if (p.eofPending) { p.eofPending = false; sendEof(key); }
    }
    if (role != 'r') {
      p.writers++;
      p.everWritten = true;
      proc.ends.push({ key, role: 'w' });
    }
  }

  function pipeClose(proc, key, role) {
    var p = pipe(key);
    for (var r of role == 'rw' ? ['r', 'w'] : [role]) {
      var i = proc.ends.findIndex((e) => e.key == key && e.role == r);
      if (i < 0) continue;
      proc.ends.splice(i, 1);
      if (r == 'r') {
        var j = p.readers.indexOf(proc.pid);
        if (j >= 0) p.readers.splice(j, 1);
      } else if (--p.writers == 0) {
        sendEof(key);
      }
    }
  }

  function closeAll(proc) {
    while (proc.ends.length) {
      var e = proc.ends[0];
      pipeClose(proc, e.key, e.role);
    }
  }

  // --------------------------------------------------------- front end I/O
  function feOutput(data) {
    partial += decoder.decode(data, { stream: true });
    var i;
    while ((i = partial.indexOf('\n')) >= 0) {
      inbox.push(partial.slice(0, i + 1));
      partial = partial.slice(i + 1);
    }
  }

  // ------------------------------------------------------------ processes
  function createProcess(pid, ppid, init) {
    var worker = new Worker('magnus-worker.js');
    var proc = procs.get(pid) || { pid, ppid, ends: [], started: false, stopped: false };
    proc.worker = worker;
    proc.ppid = ppid;
    procs.set(pid, proc);
    worker.onmessage = (e) => handle(proc, worker, e.data);
    worker.onerror = (e) => { console.error('[' + pid + ']', e.message); };
    init.t = 'init';
    init.pid = pid;
    init.ppid = ppid;
    init.programs = programs;
    init.snapshot = snapshot();
    worker.postMessage(init);
    return proc;
  }

  function startProcess(proc) {
    if (proc.started) return;
    proc.started = true;
    proc.worker.postMessage({ t: 'start' });
  }

  function exitProcess(proc, status) {
    if (!procs.has(proc.pid) || procs.get(proc.pid) !== proc) return;
    proc.worker.terminate();
    procs.delete(proc.pid);
    closeAll(proc);
    var parent = procs.get(proc.ppid);
    if (parent) parent.worker.postMessage({ t: 'child-exit', pid: proc.pid, status });
    if (proc.pid == rootPid) {
      inbox.push('\x04');   // the front end sees end-of-file on the pipe
    }
  }

  function descendants(pid) {
    var out = [pid];
    for (var i = 0; i < out.length; i++) {
      for (var p of procs.values()) if (p.ppid == out[i] && !out.includes(p.pid)) out.push(p.pid);
    }
    return out;
  }

  function signal(proc, msg) {
    var targets = msg.pid < 0 ? descendants(-msg.pid) : [msg.pid];
    for (var pid of targets) {
      var p = procs.get(pid);
      if (!p) continue;
      switch (msg.sig) {
        case SIGSTOP: if (!p.started) p.stopped = true; break;
        case SIGKILL: case SIGTERM: case SIGINT: case SIGHUP: exitProcess(p, msg.sig); break;
        case 0: case SIGCONT: startProcess(p); break;
        default: p.worker.postMessage({ t: 'signal', sig: msg.sig }); break;
      }
    }
  }

  async function handle(proc, worker, msg) {
    if (proc.worker !== worker) return;   // a replaced (exec'd) image
    switch (msg.t) {
      case 'fs':
        applyFs(msg.op);
        for (var p of procs.values()) if (p !== proc) p.worker.postMessage({ t: 'fs', op: msg.op });
        break;
      case 'pipe-open': pipeOpen(proc, msg.key, msg.role); break;
      case 'pipe-close': pipeClose(proc, msg.key, msg.role); break;
      case 'pipe-write': deliver(msg.key, msg.data); break;
      case 'kill': signal(proc, msg); break;
      case 'exit': exitProcess(proc, msg.status); break;
      case 'fork': {
        var pid = nextPid++;
        var b = backEnd();
        var child = createProcess(pid, proc.pid, {
          kind: 'fork', module: 'magnus', argv: ['magnus'], fork: msg.state,
          wasm: await b.wasm, data: await b.data, cwd: msg.state.cwd,
        });
        // A child normally gets SIGSTOP/SIGCONT from ARCer right away; start
        // it anyway if its parent never says anything.
        setTimeout(() => { if (!child.stopped) startProcess(child); }, 2000);
        worker.postMessage({ t: 'reply', req: msg.req, pid });
        break;
      }
      case 'spawn': {
        var pid = nextPid++;
        createProcess(pid, proc.pid, { kind: 'shell', argv: msg.argv, fds: msg.fds, cwd: msg.cwd });
        if (msg.req) worker.postMessage({ t: 'reply', req: msg.req, pid });
        break;
      }
      case 'exec': {
        // Replace the image: same pid, new worker running the shell.
        worker.terminate();
        closeAll(proc);
        createProcess(proc.pid, proc.ppid, { kind: 'shell', path: msg.path, argv: msg.argv, fds: msg.fds, cwd: msg.cwd });
        break;
      }
    }
  }

  var rootPid = 0;

  return {
    // `open "| magnus home tmp"` from the front end.
    spawn(argv) {
      var b = backEnd();
      rootPid = nextPid++;
      var root = { pid: rootPid, ppid: 0, ends: [], started: true };
      procs.set(rootPid, root);
      pipe('fe:in').writers = 1;
      pipe('fe:out').readers.push('FE');
      Promise.all([b.wasm, b.data, b.programs]).then(([wasm, data]) => {
        createProcess(rootPid, 0, {
          kind: 'program', module: 'magnus', argv: ['magnus', ...argv.slice(1)], wasm, data, cwd: '/',
          fds: [{ fd: 0, pipe: 'fe:in', flags: 0 }, { fd: 1, pipe: 'fe:out', flags: 1 }],
        });
      }).catch((e) => console.error('magnus back end:', e));
      return rootPid;
    },
    send(text) { deliver('fe:in', new TextEncoder().encode(text)); },
    // `exec kill` from the front end: the session manager and its children.
    kill() { if (procs.has(rootPid)) signal(null, { pid: -rootPid, sig: SIGKILL }); },
    pending() { return inbox.length; },
    take() { var s = inbox.join(''); inbox.length = 0; return s; },
    procs, pipes,
  };
})();
