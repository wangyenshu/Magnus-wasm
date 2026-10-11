# magnus-wasm

Build Magnus (`magnus-src-20060324.tgz`) for the browser with
[tcltk.wasm](https://github.com/t3tra-dev/tcltk.wasm) and
[x11.wasm](https://github.com/t3tra-dev/x11.wasm): Tcl/Tk front end, C++
session manager, black boxes (ace, kbmag, rkbp, chom, orwp).

## Build and run

```sh
chmod +x build.sh
chmod +x tools/blackboxes.sh
./build.sh magnus-src-20060324.tgz   # output: dist/
./serve.py 8000                               
```

Requires `git python3 node ninja patch curl tar`. Uses `emcc` from `PATH`
if present, otherwise fetches Emscripten 6.0.3, LLVM 23.1.3 and binaryen 129
into `work/toolchain`. `WORK`, `DIST`, `JOBS` override the defaults.

## Layout

| Path | Content |
|---|---|
| `build.sh` | toolchain, tcltk.wasm, Magnus back end, black boxes, front end |
| `src/main.c` | front-end entry: Tcl/Tk init, main loop, back-end channel commands |
| `src/boot.tcl` | redirects `open "\|magnus ..."` to the back end, emulates the `exec` calls used |
| `src/proc.c`, `src/proclib.js` | `fork`/`exec`/`system`/`waitpid`/`kill`/`mkfifo`/`sleep`, pipes, `/tmp` mirroring |
| `web/magnus-backend.js` | main thread: process table, pipe/FIFO routing, signals |
| `web/magnus-worker.js` | one process per Web Worker; minimal `sh` for the black-box command lines |
| `web/index.html` | page: one full-window `#x11` element; loads `frontend.js` |
| `tools/backend.py` | compiles the back end from the original Makefile component lists |
| `tools/blackboxes.sh` | compiles the black boxes, writes `programs.json` |
| `compat/` | `<iostream.h>`-style headers; `kr-protos.h` for K&R C |
| `patches/` | see below |
| `test/magnus.test.js` | GUI test (Playwright) |
| `test/replay.js` | replays recorded front-end messages to the back end |
| `serve.py` | static server for `dist/` |

`fork()` is implemented by unwinding with Asyncify, copying linear memory to
a new worker running the same module, and rewinding there.

## Patches

- `x11.wasm-event-queue.patch`: event queue limit 256 → 16384.
- `x11.wasm-browserbind.patch`: crossing events for windows not at the
  origin; Shift state for typed shifted characters.
- `magnus.patch`: friend declarations, `this->` in templates, explicit
  template instantiations, missing `return` statements, unsequenced
  `a[i] = i++` in `SubgroupGraphRep::reduceGraph`, `UniformRandom::rand()`
  returning 1.0, mismatched declarations and calls in kbmag.

Compiler flags: `-fno-strict-return -fno-strict-aliasing -fwrapv
-ftrivial-auto-var-init=zero`.

## Tests

```sh
node test/magnus.test.js http://localhost:8000/ [scenario...]
```

| Scenario | Expected result |
|---|---|
| `order` | `G1 has order 60` |
| `abelianization` | `G1 abelianized: 1.` |
| `abelian` | `G1 is not abelian` |
| `automatic` | `G1 is automatic` |
| `homology` | `Dimension 2 integral homology: Z^0 x Z_2.` |
| `finiteACE` | `G3 has order 60: according to the GH Todd-Coxeter algorithm` |
| `oneRelator` | `w2 is not trivial in G2 : according to the Magnus breakdown` |

G1 = G3 = `<a,b; a^2, b^3, (a b)^5>`, G2 = `<a,b; a b a^-1 b^-2>`,
w2 = `a b a^-1 b^-1`. `startup` and `checkinGroup` always run.
`SHOTS=dir` saves screenshots; `RECORD=file` saves the messages sent to the
back end.

## Limitations

- SIGSTOP/SIGCONT are not applied to running workers; computations run
  concurrently, and a suspended problem keeps computing until terminated.
- GAP, TietzeTrek and tc5 are not built (not in the source tarball).
- Sessions are not persisted across page loads.
