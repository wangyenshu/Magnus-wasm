#!/usr/bin/env bash
# build.sh -- build the Magnus GUI (Tcl/Tk front end, C++ session manager and
# its external "black box" programs) for the browser, on top of tcltk.wasm and
# x11.wasm.
#
#   ./build.sh /path/to/magnus-src-20060324.tgz
#
# Output: dist/  -- serve it with ./serve.py and open http://localhost:8000/
#
# Environment: WORK (build tree, default ./work), DIST (default ./dist),
# JOBS (parallel jobs).  An emcc already on PATH is used as is; otherwise a
# pinned Emscripten + LLVM + binaryen is fetched from GitHub into $WORK.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$HERE/work}
DIST=${DIST:-$HERE/dist}
JOBS=${JOBS:-$(nproc 2>/dev/null || echo 2)}
export JOBS
MAGNUS_TARBALL=${1:-${MAGNUS_TARBALL:-}}

# Pinned upstream revisions.
TCLTK_WASM_URL=https://github.com/t3tra-dev/tcltk.wasm
TCLTK_WASM_REV=71868b26fc5a6a7479b73930fee50fd012bd0072   # tcl, tk and x11.wasm are submodules
EMSCRIPTEN_REV=6.0.3
LLVM_VER=23.1.3
BINARYEN_VER=129

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -n "$MAGNUS_TARBALL" ] || die "usage: $0 magnus-src.tgz"
[ -f "$MAGNUS_TARBALL" ] || die "no such file: $MAGNUS_TARBALL"
MAGNUS_TARBALL=$(cd "$(dirname "$MAGNUS_TARBALL")" && pwd)/$(basename "$MAGNUS_TARBALL")
for t in git python3 node ninja patch curl tar; do
    command -v $t >/dev/null || die "$t is required"
done
mkdir -p "$WORK" "$DIST"

# ---------------------------------------------------------------------------
# 1. Emscripten
# ---------------------------------------------------------------------------
if ! command -v emcc >/dev/null 2>&1; then
    TC=$WORK/toolchain
    if [ ! -f "$TC/.done" ]; then
        log "fetching Emscripten $EMSCRIPTEN_REV, LLVM $LLVM_VER, binaryen $BINARYEN_VER"
        mkdir -p "$TC"
        [ -d "$TC/emscripten" ] ||
            git clone -q --depth 1 --branch "$EMSCRIPTEN_REV" https://github.com/emscripten-core/emscripten "$TC/emscripten"
        if [ ! -d "$TC/LLVM-$LLVM_VER-Linux-X64" ]; then
            [ -f "$TC/llvm.tar.xz" ] || curl -fL --retry 5 -o "$TC/llvm.tar.xz" \
                "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VER/LLVM-$LLVM_VER-Linux-X64.tar.xz"
            # only what Emscripten uses (the full bin/ is ~9 GB)
            tar -C "$TC" -xJf "$TC/llvm.tar.xz" --wildcards \
                "LLVM-$LLVM_VER-Linux-X64/lib/clang" \
                $(for t in clang clang++ 'clang-[0-9]*' lld wasm-ld llvm-ar llvm-ranlib llvm-nm \
                           llvm-objcopy llvm-strip llvm-dwarfdump; do
                      echo "LLVM-$LLVM_VER-Linux-X64/bin/$t"; done)
            rm -f "$TC/llvm.tar.xz"
        fi
        [ -d "$TC/binaryen-version_$BINARYEN_VER" ] ||
            curl -fL --retry 5 "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN_VER/binaryen-version_$BINARYEN_VER-x86_64-linux.tar.gz" |
            tar -C "$TC" -xz
        cat > "$TC/emscripten.config" <<EOF
LLVM_ROOT = '$TC/LLVM-$LLVM_VER-Linux-X64/bin'
BINARYEN_ROOT = '$TC/binaryen-version_$BINARYEN_VER'
NODE_JS = '$(command -v node)'
EOF
        (cd "$TC/emscripten" && python3 bootstrap.py </dev/null >/dev/null)
        touch "$TC/.done"
    fi
    export EM_CONFIG=$TC/emscripten.config
    export PATH=$TC/emscripten:$PATH
fi
log "using $(emcc --version | head -1)"

# ---------------------------------------------------------------------------
# 2. Tcl/Tk 8.6 and x11.wasm (static libraries, tcltk.wasm's own build)
# ---------------------------------------------------------------------------
T=$WORK/tcltk.wasm
X=$T/third-party/x11.wasm
B=$T/build/emscripten
if [ ! -f "$B/.done" ]; then
    [ -d "$T/.git" ] || { log "cloning tcltk.wasm"; git clone -q "$TCLTK_WASM_URL" "$T"; }
    git -C "$T" checkout -q "$TCLTK_WASM_REV"
    git -C "$T" submodule update -q --init
    git -C "$X" checkout -q -- .
    for p in "$HERE"/patches/x11.wasm-*.patch; do git -C "$X" apply "$p"; done
    log "building Tcl, Tk and x11.wasm"
    (cd "$T" && ninja -f build.ninja -j"$JOBS" tk x11)
    touch "$B/.done"
fi

# ---------------------------------------------------------------------------
# 3. Magnus sources (+ patches/magnus.patch: fixes for a modern C++ compiler)
# ---------------------------------------------------------------------------
M=$WORK/magnus
if [ ! -f "$M/.patched" ]; then
    log "unpacking and patching $(basename "$MAGNUS_TARBALL")"
    rm -rf "$M" && mkdir -p "$M"
    tar -C "$M" --strip-components=1 -xzf "$MAGNUS_TARBALL"
    (cd "$M" && patch -s -p1 --no-backup-if-mismatch < "$HERE/patches/magnus.patch")
    sed -e 's|%MAGNUSHOME%|/magnus|' -e 's|%OS%|LINUX|' -e 's|%MAGNUSTMP%|/tmp|' \
        "$M/back_end/global/config.h.in" > "$M/back_end/global/config.h"
    touch "$M/.patched"
fi

# ---------------------------------------------------------------------------
# 4. Session manager (back end): one static library per component, then link.
#    fork/exec/pipes/FIFOs/signals come from src/proc.c + src/proclib.js;
#    every process runs in its own Web Worker (web/magnus-worker.js).
# ---------------------------------------------------------------------------
BE=$WORK/back_end
log "compiling the session manager"
# 1990s C++ (g++ 2.x/3.x): no strict-return/aliasing/overflow assumptions and
# zero-initialised locals, as the code expects.
OLDCODE="-fno-strict-return -fno-strict-aliasing -fwrapv -ftrivial-auto-var-init=zero"
STD=-std=c++98 python3 "$HERE/tools/backend.py" "$M/back_end" "$BE" \
    -D_GNU_SOURCE -fms-extensions $OLDCODE
emcc -O2 -c "$HERE/src/proc.c" -o "$WORK/proc.o"

# Files the session manager reads at run time (empty directories need an
# entry to be packaged).
BS=$WORK/be-stage
rm -rf "$BS" && mkdir -p "$BS/magnus"
cp -r "$M/packages" "$BS/magnus/"
for d in front_end back_end/SessionManager/test/bin back_end/black_boxes/rkbp/bin \
         back_end/black_boxes/homology/bin back_end/black_boxes/kbmag/bin \
         back_end/black_boxes/orwp back_end/black_boxes/ace back_end/black_boxes/tc5 \
         back_end/black_boxes/TietzeTrek; do
    mkdir -p "$BS/magnus/$d" && : > "$BS/magnus/$d/.keep"
done

log "linking the session manager"
em++ -O2 "$BE/magnus.o" "$WORK/proc.o" -Wl,--start-group "$BE"/lib*.a -Wl,--end-group \
    --js-library "$HERE/src/proclib.js" -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='$PROC' \
    -sMODULARIZE=1 -sEXPORT_NAME=Magnus_magnus -sENVIRONMENT=worker \
    -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=1048576 -sSTACK_SIZE=8MB \
    -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 \
    -sEXPORTED_RUNTIME_METHODS=FS -Wl,--wrap=fread \
    --preload-file "$BS/magnus@/magnus" -o "$DIST/magnus.js"

# ---------------------------------------------------------------------------
# 5. Black boxes: ACE, kbmag, rkbp, orwp, chom (Web Worker modules)
# ---------------------------------------------------------------------------
log "compiling the black boxes"
BBWORK=$WORK/bb-obj bash "$HERE/tools/blackboxes.sh" "$M/back_end/black_boxes" "$DIST" \
    "$WORK/proc.o" "$HERE/src/proclib.js"

# ---------------------------------------------------------------------------
# 6. Front end: Tcl/Tk interpreter + the unmodified Magnus Tcl sources
# ---------------------------------------------------------------------------
log "linking the front end"
S=$WORK/fe-stage
rm -rf "$S" && mkdir -p "$S/magnus/wasm"
cp -r "$M/front_end" "$S/magnus/front_end"
cp "$HERE/src/boot.tcl" "$S/magnus/wasm/"
# The front end checks that these exist; they run in the back-end workers.
for f in SessionManager/test/bin/magnus black_boxes/rkbp/bin/rkbp \
         black_boxes/homology/bin/chom black_boxes/orwp/orwp black_boxes/tc5/tc; do
    mkdir -p "$S/magnus/back_end/$(dirname "$f")"
    echo placeholder > "$S/magnus/back_end/$f"
done
emcc -O2 -c -I"$B/tcl" -I"$T/third-party/tcl/generic" -I"$T/third-party/tcl/unix" \
    -I"$T/third-party/tk/generic" -I"$X/include" -I"$T/third-party/tk/xlib" \
    -DSTATIC_BUILD=1 "$HERE/src/main.c" -o "$WORK/main.o"
emcc -O2 "$WORK/main.o" "$B/x11/libx11wasm.a" "$B/tk/libtk8.6.a" "$B/tcl/libtcl8.6.a" \
    --js-library "$B/x11/js/emscripten/library.js" --pre-js "$B/x11/js/browser/dom.js" \
    --preload-file "$T/third-party/tcl/library@/lib/tcl8.6" \
    --preload-file "$T/third-party/tk/library@/lib/tk8.6" \
    --preload-file "$S/magnus@/magnus" \
    -sALLOW_MEMORY_GROWTH=1 -sASYNCIFY=1 -sEXIT_RUNTIME=0 -sERROR_ON_UNDEFINED_SYMBOLS=1 \
    -sEXPORTED_FUNCTIONS=_main,_malloc,_free,_MagnusEval \
    -sEXPORTED_RUNTIME_METHODS=stringToNewUTF8,ccall,FS \
    -o "$DIST/frontend.js"
cp "$HERE/web/index.html" "$HERE/web/magnus-backend.js" "$HERE/web/magnus-worker.js" "$DIST/"

log "done: $DIST  (./serve.py, then open http://localhost:8000/)"
