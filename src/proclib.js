/*
 * proclib.js -- Emscripten JS library: a small POSIX process layer for
 * programs running in Web Workers (Magnus back end and black boxes).
 *
 *  - pipes / named FIFOs: character devices whose data travels through the
 *    hub (web/magnus-backend.js); blocking reads suspend with Asyncify
 *  - fork(): the stack is unwound with Asyncify, linear memory is copied
 *    and a new worker rewinds the same stack (fork returns 0 there)
 *  - exec / system / waitpid / kill / sleep
 *  - /tmp is mirrored between all processes and the Tcl/Tk front end
 */

addToLibrary({
  $PROC__deps: ['$FS', '$Asyncify', '$stackSave', '$stackRestore', '$PATH_FS',
                'emscripten_resize_heap', '$SYSCALLS', '$runtimeKeepalivePush'],
  $PROC__postset: 'Module["PROC"] = PROC;',
  $PROC: {
    host: null,       // { post(msg, transfer), emit(op) } provided by the worker
    pid: 0,
    ppid: 0,
    pipes: {},        // key -> { chunks: [Uint8Array], len, eof }
    waiters: [],
    children: {},     // pid -> { alive, status, reaped }
    applying: false,
    pollDelay: 10,    // ms a non-blocking read on an empty pipe yields
    nextReq: 1,
    replies: {},
    PIPE_DEV: 0,
    SHARED: '/tmp',

    // ---------------------------------------------------------------- setup
    setup(host, init) {
      PROC.host = host;
      if (init.pipes) PROC.pipes = init.pipes;
      if (init.children) PROC.children = init.children;
      PROC.pid = init.pid;
      PROC.ppid = init.ppid || 0;
      PROC.PIPE_DEV = FS.makedev(66, 0);
      FS.registerDevice(PROC.PIPE_DEV, PROC.pipeOps);
      try { FS.mkdir('/dev/pipes'); } catch (e) {}
      PROC.wrapFS();
      PROC.applying = true;
      try {
        for (var op of init.snapshot || []) PROC.applyOp(op);
      } finally {
        PROC.applying = false;
      }
      if (init.cwd) {
        try { FS.mkdirTree(init.cwd); } catch (e) {}
        try { FS.chdir(init.cwd); } catch (e) {}
      }
      if (init.fds) PROC.restoreFds(init.fds);
    },

    post(msg, transfer) { PROC.host.post(msg, transfer); },

    request(msg, transfer) {
      var id = PROC.nextReq++;
      msg.req = id;
      return new Promise((resolve) => {
        PROC.replies[id] = resolve;
        PROC.post(msg, transfer);
      });
    },

    // Called by the worker for every message from the hub.  Pipe and child
    // state (PROC.pipes / PROC.children) is kept up to date by the worker.
    deliver(msg) {
      if (msg.t == 'reply') {
        var r = PROC.replies[msg.req];
        delete PROC.replies[msg.req];
        r?.(msg);
      } else if (msg.t == 'fs') {
        PROC.applying = true;
        try { PROC.applyOp(msg.op); } finally { PROC.applying = false; }
      }
      PROC.wake();
    },

    wake() {
      var w = PROC.waiters;
      PROC.waiters = [];
      for (var f of w) {
        if (!f()) PROC.waiters.push(f);
      }
    },

    // Call done() once cond() holds (checked now and on every event).
    waitFor(cond, done, timeoutMs) {
      var timer = null, finished = false;
      var check = () => {
        if (finished) return true;
        if (!cond()) return false;
        finished = true;
        if (timer) clearTimeout(timer);
        done();
        return true;
      };
      if (check()) return;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          PROC.waiters = PROC.waiters.filter((f) => f !== check);
          done();
        }, timeoutMs);
      }
      PROC.waiters.push(check);
    },

    // ---------------------------------------------------------------- pipes
    pipe(key) {
      return PROC.pipes[key] ??= { chunks: [], len: 0, eof: false };
    },

    pipeNode(key) {
      var path = '/dev/pipes/' + encodeURIComponent(key);
      var node;
      try {
        node = FS.lookupPath(path).node;
      } catch (e) {
        node = FS.mknod(path, {{{ cDefs.S_IFCHR }}} | 0o666, PROC.PIPE_DEV);
      }
      node.pipeKey = key;
      return path;
    },

    pipeOps: {
      open(stream) {
        var acc = stream.flags & {{{ cDefs.O_ACCMODE }}};
        stream.pipeKey = stream.node.pipeKey;
        stream.pipeRole = acc == {{{ cDefs.O_RDONLY }}} ? 'r' : acc == {{{ cDefs.O_WRONLY }}} ? 'w' : 'rw';
        stream.seekable = false;
        PROC.pipeOpen(stream.pipeKey, stream.pipeRole);
      },
      dup(stream) {
        PROC.pipeOpen(stream.pipeKey, stream.pipeRole);
      },
      close(stream) {
        PROC.post({ t: 'pipe-close', key: stream.pipeKey, role: stream.pipeRole });
      },
      read(stream, buffer, offset, length) {
        var p = PROC.pipe(stream.pipeKey);
        if (!p.len) {
          if (p.eof) return 0;
          throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
        }
        var n = 0;
        while (n < length && p.chunks.length) {
          var c = p.chunks[0];
          var k = Math.min(c.length, length - n);
          buffer.set(c.subarray(0, k), offset + n);
          n += k;
          if (k == c.length) p.chunks.shift();
          else p.chunks[0] = c.subarray(k);
        }
        p.len -= n;
        return n;
      },
      write(stream, buffer, offset, length) {
        var data = new Uint8Array(length);
        data.set(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length));
        PROC.post({ t: 'pipe-write', key: stream.pipeKey, data }, [data.buffer]);
        return length;
      },
      llseek() {
        throw new FS.ErrnoError({{{ cDefs.ESPIPE }}});
      },
      ioctl(stream, op, argp) {
        if (op == {{{ cDefs.FIONBIO }}}) {
          if (HEAP32[argp >> 2]) stream.flags |= {{{ cDefs.O_NONBLOCK }}};
          else stream.flags &= ~{{{ cDefs.O_NONBLOCK }}};
          return 0;
        }
        if (op == {{{ cDefs.FIONREAD }}}) {
          HEAP32[argp >> 2] = PROC.pipe(stream.pipeKey).len;
          return 0;
        }
        return -{{{ cDefs.ENOTTY }}};
      },
    },

    pipeOpen(key, role) {
      if (role != 'w') PROC.pipe(key);
      PROC.post({ t: 'pipe-open', key, role });
    },

    // readv() on a pipe: whatever is buffered, up to the iovecs' size
    // (EAGAIN only when there is nothing at all).
    readv(stream, iov, iovcnt) {
      var num = 0;
      for (var i = 0; i < iovcnt; i++, iov += 8) {
        var ptr = HEAPU32[iov >> 2], len = HEAPU32[(iov + 4) >> 2];
        if (num && !PROC.pipe(stream.pipeKey).len) break;
        var n = PROC.pipeOps.read(stream, HEAP8, ptr, len);
        num += n;
        if (n < len) break;
      }
      return num;
    },

    // Would a read on this fd have to wait?
    readWouldBlock(fd) {
      var s = FS.getStream(fd);
      if (!s || s.pipeKey === undefined || s.pipeRole == 'w') return false;
      var p = PROC.pipe(s.pipeKey);
      return !p.len && !p.eof;
    },

    // ------------------------------------------------------- fd inheritance
    describeFds() {
      var fds = [];
      for (var fd = 0; fd < FS.streams.length; fd++) {
        var s = FS.streams[fd];
        if (!s) continue;
        if (s.pipeKey !== undefined) {
          fds.push({ fd, pipe: s.pipeKey, flags: s.flags });
        } else if (s.tty) {
          fds.push({ fd, tty: true });
        } else if (FS.isFile(s.node.mode)) {
          fds.push({ fd, path: s.path, flags: s.flags, pos: s.position });
        }
      }
      return fds;
    },

    restoreFds(fds) {
      for (var d of fds) {
        if (d.tty) continue;
        var s = null;
        try {
          if (d.pipe !== undefined) {
            s = FS.open(PROC.pipeNode(d.pipe), d.flags & ~{{{ cDefs.O_CREAT | cDefs.O_TRUNC | cDefs.O_EXCL }}});
          } else {
            s = FS.open(d.path, d.flags & ~{{{ cDefs.O_CREAT | cDefs.O_TRUNC | cDefs.O_EXCL }}});
            s.position = d.pos || 0;
          }
        } catch (e) {
          continue;
        }
        if (s.fd != d.fd) {
          if (FS.streams[d.fd]) FS.close(FS.streams[d.fd]);
          FS.dupStream(s, d.fd);
          FS.close(s);
        }
      }
    },

    // ----------------------------------------------------- /tmp mirroring
    shared(path) {
      return path === PROC.SHARED || (path && path.startsWith(PROC.SHARED + '/'));
    },

    emit(op) {
      if (!PROC.applying && PROC.host) PROC.host.emit(op);
    },

    abspath(path) {
      return typeof path == 'string' ? PATH_FS.resolve(path) : FS.getPath(path);
    },

    wrapFS() {
      if (FS.procWrapped) return;
      FS.procWrapped = true;
      var orig = {
        write: FS.write, truncate: FS.truncate, mknod: FS.mknod, unlink: FS.unlink,
        rmdir: FS.rmdir, rename: FS.rename,
      };
      FS.write = function (stream, buffer, offset, length, position, canOwn) {
        var n = orig.write.apply(FS, arguments);
        if (n > 0 && !PROC.applying && FS.isFile(stream.node.mode) && PROC.shared(stream.path)) {
          var pos = typeof position != 'undefined' ? position : stream.position - n;
          var data = new Uint8Array(n);
          data.set(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n));
          PROC.emit({ op: 'write', path: stream.path, pos, data });
        }
        return n;
      };
      FS.truncate = function (path, len) {
        var r = orig.truncate.apply(FS, arguments);
        var p = PROC.abspath(path);
        if (PROC.shared(p)) PROC.emit({ op: 'trunc', path: p, len });
        return r;
      };
      FS.mknod = function (path, mode, dev) {
        var node = orig.mknod.apply(FS, arguments);
        var p = FS.getPath(node);
        if (PROC.shared(p)) {
          if (FS.isDir(mode)) PROC.emit({ op: 'mkdir', path: p });
          else if (FS.isFile(mode)) PROC.emit({ op: 'create', path: p });
        }
        return node;
      };
      FS.unlink = function (path) {
        var p = PROC.abspath(path);
        var r = orig.unlink.apply(FS, arguments);
        if (PROC.shared(p)) PROC.emit({ op: 'unlink', path: p });
        return r;
      };
      FS.rmdir = function (path) {
        var p = PROC.abspath(path);
        var r = orig.rmdir.apply(FS, arguments);
        if (PROC.shared(p)) PROC.emit({ op: 'rmdir', path: p });
        return r;
      };
      FS.rename = function (from, to) {
        var a = PROC.abspath(from), b = PROC.abspath(to);
        var r = orig.rename.apply(FS, arguments);
        if (PROC.shared(a) || PROC.shared(b)) PROC.emit({ op: 'rename', from: a, to: b });
        return r;
      };
    },

    applyOp(op) {
      var exists = (p) => { try { FS.lookupPath(p); return true; } catch (e) { return false; } };
      var parent = (p) => { var d = p.replace(/\/[^\/]*$/, ''); if (d) { try { FS.mkdirTree(d); } catch (e) {} } };
      try {
        switch (op.op) {
          case 'mkdir':
            FS.mkdirTree(op.path);
            break;
          case 'create':
            if (!exists(op.path)) { parent(op.path); FS.writeFile(op.path, new Uint8Array(0)); }
            break;
          case 'file':
            parent(op.path);
            FS.writeFile(op.path, op.data);
            break;
          case 'write':
            if (!exists(op.path)) { parent(op.path); FS.writeFile(op.path, new Uint8Array(0)); }
            var node = FS.lookupPath(op.path).node;
            if (!FS.isFile(node.mode)) break;
            var s = FS.open(op.path, {{{ cDefs.O_WRONLY }}});
            FS.write(s, op.data, 0, op.data.length, op.pos);
            FS.close(s);
            break;
          case 'trunc':
            if (!exists(op.path)) { parent(op.path); FS.writeFile(op.path, new Uint8Array(0)); }
            FS.truncate(op.path, op.len);
            break;
          case 'unlink':
            FS.unlink(op.path);
            break;
          case 'rmdir':
            FS.rmdir(op.path);
            break;
          case 'rename':
            FS.rename(op.from, op.to);
            break;
          case 'mkfifo':
            if (!exists(op.path)) {
              parent(op.path);
              FS.mknod(op.path, {{{ cDefs.S_IFCHR }}} | 0o666, PROC.PIPE_DEV).pipeKey = op.path;
            }
            break;
        }
      } catch (e) {
        if (!(e instanceof FS.ErrnoError)) throw e;
      }
    },

    // ------------------------------------------------------------- fork
    rewindExportName() {
      var id = HEAP32[(Asyncify.currData + {{{ C_STRUCTS.asyncify_data_s.rewind_id }}}) >> 2];
      var wrapper = Asyncify.funcWrappers.get(Asyncify.callStackIdToFunc.get(id));
      for (var name in wasmExports) if (wasmExports[name] === wrapper) return [id, name];
      throw new Error('fork: cannot find the export at the bottom of the stack');
    },

    captureFork() {
      var [rewindId, rewindName] = PROC.rewindExportName();
      return {
        memory: HEAPU8.slice().buffer,
        sp: stackSave(),
        currData: Asyncify.currData,
        rewindId, rewindName,
        fds: PROC.describeFds(),
        cwd: FS.cwd(),
      };
    },

    // In the child: install the parent's memory and rewind into fork().
    restoreFork(state) {
      PROC.restoreFds(state.fds);           // inherited descriptors
      if (state.memory.byteLength > HEAPU8.length) _emscripten_resize_heap(state.memory.byteLength);
      HEAPU8.set(new Uint8Array(state.memory));
      stackRestore(state.sp);
      var wrapper = wasmExports[state.rewindName], orig;
      for (var [k, v] of Asyncify.funcWrappers) if (v === wrapper) orig = k;
      Asyncify.callStackIdToFunc.set(state.rewindId, orig);
      Asyncify.callstackFuncToId.set(orig, state.rewindId);
      Asyncify.currData = state.currData;
      Asyncify.handleSleepReturnValue = 0;   // fork() returns 0 in the child
      Asyncify.state = Asyncify.State.Rewinding;
      runtimeKeepalivePush();               // as the parent did when it unwound (doRewind pops)
      _asyncify_start_rewind(state.currData);
      Asyncify.doRewind(state.currData);
    },
  },

  // Asyncify helper: run start() as an async operation, unless no wait is
  // needed (then return sync()).  While rewinding we must always go through
  // handleSleep so the rewind stops here.
  $procAsync__deps: ['$Asyncify'],
  $procAsync: (needWait, start, sync) => {
    if (Asyncify.state === Asyncify.State.Rewinding || needWait()) {
      return Asyncify.handleSleep(start);
    }
    return sync();
  },

  // A read on an empty pipe waits for data (or polls briefly when the
  // descriptor is non-blocking, which is how the session manager reads its
  // messages from the front end).
  fd_read__async: true,
  fd_read__deps: ['$doReadv', '$PROC', '$procAsync', '$SYSCALLS'],
  fd_read: (fd, iov, iovcnt, pnum) => {
    var doit = () => {
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        var num = stream.pipeKey !== undefined ? PROC.readv(stream, iov, iovcnt) : doReadv(stream, iov, iovcnt);
        HEAPU32[pnum >> 2] = num;
        return 0;
      } catch (e) {
        if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
        return e.errno;
      }
    };
    return procAsync(() => PROC.readWouldBlock(fd), (wakeUp) => {
      var s = FS.getStream(fd);
      if (s.flags & {{{ cDefs.O_NONBLOCK }}}) {
        setTimeout(() => wakeUp(doit()), PROC.pollDelay);
      } else {
        var p = PROC.pipe(s.pipeKey);
        PROC.waitFor(() => p.len || p.eof, () => wakeUp(doit()));
      }
    }, doit);
  },

  proc_fork__async: true,
  proc_fork__deps: ['$PROC', '$Asyncify'],
  proc_fork: () => Asyncify.handleSleep((wakeUp) => {
    // Runs before the stack is unwound; take the snapshot afterwards.
    setTimeout(() => {
      var state = PROC.captureFork();
      PROC.request({ t: 'fork', state }, [state.memory]).then((r) => {
        if (r.pid > 0) PROC.children[r.pid] ??= { alive: true };
        wakeUp(r.pid);
      });
    }, 0);
  }),

  proc_exec__async: true,
  proc_exec__deps: ['$PROC', '$Asyncify', '$UTF8ToString'],
  proc_exec: (path, argv, search) => {
    var args = [];
    for (var p; (p = HEAPU32[(argv >> 2) + args.length]); ) args.push(UTF8ToString(p));
    path = UTF8ToString(path);
    // The new program image replaces this worker; never resume.
    return Asyncify.handleSleep(() => {
      setTimeout(() => PROC.post({ t: 'exec', path, argv: args, fds: PROC.describeFds(), cwd: FS.cwd() }), 0);
    });
  },

  proc_system__async: true,
  proc_system__deps: ['$PROC', '$procAsync', '$UTF8ToString'],
  proc_system: (cmd) => {
    var command = Asyncify.state === Asyncify.State.Rewinding ? '' : UTF8ToString(cmd);
    var background = /&\s*$/.test(command);
    var spawn = () => ({ t: 'spawn', argv: ['sh', '-c', command], fds: PROC.describeFds(), cwd: FS.cwd() });
    return procAsync(() => !background, (wakeUp) => {
      PROC.request(spawn()).then((r) => {
        var c = PROC.children[r.pid] ??= { alive: true };
        PROC.waitFor(() => !c.alive, () => { c.reaped = true; wakeUp(c.status << 8); });
      });
    }, () => {
      // "cmd &": the shell returns at once, the job runs on its own.
      PROC.post(spawn());
      return 0;
    });
  },

  proc_waitpid__async: true,
  proc_waitpid__deps: ['$PROC', '$procAsync'],
  proc_waitpid: (pid, statusPtr, options) => {
    var match = (cpid) => pid == -1 || pid == 0 || pid < -1 || cpid == pid;
    var findExited = () => {
      for (var cpid in PROC.children) {
        var c = PROC.children[cpid];
        if (match(+cpid) && !c.alive && !c.reaped) return +cpid;
      }
      return 0;
    };
    var any = () => Object.keys(PROC.children).some((cpid) => match(+cpid) && !PROC.children[cpid].reaped);
    var reap = (cpid) => {
      var c = PROC.children[cpid];
      c.reaped = true;
      if (statusPtr) HEAP32[statusPtr >> 2] = (c.status & 0xff) << 8;
      return cpid;
    };
    return procAsync(
      () => !findExited() && any() && !(options & 1 /* WNOHANG */),
      (wakeUp) => PROC.waitFor(() => findExited(), () => wakeUp(reap(findExited()))),
      () => { var c = findExited(); return c ? reap(c) : (any() ? 0 : -{{{ cDefs.ECHILD }}}); });
  },

  proc_kill__deps: ['$PROC'],
  proc_kill: (pid, sig) => {
    var target = Math.abs(pid);
    PROC.post({ t: 'kill', pid, sig });
    if (target == PROC.pid) return 0;
    if (sig == 0) {
      var c = PROC.children[target];
      return c && c.alive ? 0 : -{{{ cDefs.ESRCH }}};
    }
    return 0;
  },

  proc_getpid__deps: ['$PROC'],
  proc_getpid: () => PROC.pid,
  proc_getppid__deps: ['$PROC'],
  proc_getppid: () => PROC.ppid,

  proc_mkfifo__deps: ['$PROC', '$UTF8ToString'],
  proc_mkfifo: (path) => {
    var p = PATH_FS.resolve(UTF8ToString(path));
    try {
      FS.lookupPath(p);
      return -{{{ cDefs.EEXIST }}};
    } catch (e) {}
    try {
      FS.mknod(p, {{{ cDefs.S_IFCHR }}} | 0o666, PROC.PIPE_DEV).pipeKey = p;
    } catch (e) {
      return -e.errno;
    }
    PROC.emit({ op: 'mkfifo', path: p });
    return 0;
  },

  // sleep() ends early when a child process exits (like SIGCHLD would).
  proc_sleep__async: true,
  proc_sleep__deps: ['$PROC', '$Asyncify'],
  proc_sleep: (ms) => Asyncify.handleSleep((wakeUp) => {
    var exited = () => Object.values(PROC.children).filter((c) => !c.alive).length;
    var n = exited();
    PROC.waitFor(() => exited() != n, () => wakeUp(0), ms);
  }),
});
