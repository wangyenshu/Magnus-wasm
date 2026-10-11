#!/usr/bin/env bash
# blackboxes.sh MAGNUS_BLACK_BOXES_DIR OUT_DIR PROC_OBJ PROCLIB_JS
# Compile Magnus' external programs (black boxes) to Web Worker modules
# bb-<name>.js/.wasm and write OUT_DIR/programs.json (name -> module).
set -euo pipefail
BB=$1 OUT=$2 PROC=$3 PROCLIB=$4
WORK=${BBWORK:-$OUT/../bb-obj}
mkdir -p "$OUT" "$WORK"
abs() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
OUT=$(cd "$OUT" && pwd); WORK=$(cd "$WORK" && pwd)
BB=$(cd "$BB" && pwd); PROC=$(abs "$PROC"); PROCLIB=$(abs "$PROCLIB")
COMPAT=$(cd "$(dirname "$0")/../compat" && pwd)
cd "$WORK"
JOBS=${JOBS:-2}

LINK=(--js-library "$PROCLIB" "$PROC" -sMODULARIZE=1 -sENVIRONMENT=worker
      -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=262144 -sALLOW_MEMORY_GROWTH=1
      -sSTACK_SIZE=4MB -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -Wl,--wrap=fread
      -sEXPORTED_RUNTIME_METHODS=FS "-sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=\$PROC")
# 1990s code: no strict-return/aliasing/overflow assumptions, zeroed locals.
CFLAGS=(-O2 -w -fno-strict-return -fno-strict-aliasing -fwrapv -ftrivial-auto-var-init=zero)
# 1990s C: implicit declarations, K&R prototypes, loose pointer types.
OLDC=(-std=gnu89 -include "$COMPAT/kr-protos.h" -Wno-error=implicit-function-declaration -Wno-error=implicit-int
      -Wno-error=incompatible-function-pointer-types -Wno-error=int-conversion)
programs="{"

module() {   # module NAME compiler [sources/flags...]
    local name=$1; shift
    echo "  bb-$name"
    "$@" "${CFLAGS[@]}" "${LINK[@]}" -sEXPORT_NAME="Magnus_bb_${name//[^A-Za-z0-9]/_}" -o "$OUT/bb-$name.js"
    programs+="\"$name\": \"bb-$name\","
}

# ACE (Todd-Coxeter coset enumerator, used by "GH Todd-Coxeter" and ACE).
module ace emcc "${OLDC[@]}" -DAL2_HINFO -DAL0_STAT -DAL0_CC -DAL0_DD '-DDATE="Magnus"' \
    $(cd "$BB/ace" && printf "$BB/ace/%s " ace.c parser.c postproc.c util2.c control.c util1.c coinc.c enum.c util0.c)

# One-relator word problem.
module orwp em++ -std=c++98 -fms-extensions -fno-operator-names -D_G_NO_NRV -I"$COMPAT" "$BB/orwp/orwp.C"

# Integral homology (chom).
emcc "${CFLAGS[@]}" "${OLDC[@]}" -c $(printf "$BB/homology/lib/%s " 2dimbdry.c grpinput.c matrix.c ndimbdry.c rewrite.c) -I"$BB/homology/lib"
module chom emcc "${OLDC[@]}" -I"$BB/homology/lib" "$BB/homology/src/homology/chom.c" "$WORK"/2dimbdry.o "$WORK"/grpinput.o "$WORK"/matrix.o "$WORK"/ndimbdry.o "$WORK"/rewrite.o

# Rutgers Knuth-Bendix package.
module rkbp em++ -I"$COMPAT" -std=c++98 -fms-extensions -fno-operator-names -D_G_NO_NRV "$BB"/rkbp/source/*.C

# KBMAG (automatic groups); autgroup itself is a script, see magnus-worker.js.
emcc "${CFLAGS[@]}" "${OLDC[@]}" -I"$BB/kbmag/lib" -c "$BB"/kbmag/lib/*.c
rm -f fsalib.a && emar crs fsalib.a $(ls "$BB"/kbmag/lib/*.c | sed "s|.*/||; s|\.c$|.o|")
for src in "$BB"/kbmag/src/*.c; do
    p=$(basename "$src" .c)
    module "$p" emcc "${OLDC[@]}" -I"$BB/kbmag/lib" -DSYSTEMV "$src" "$WORK/fsalib.a"
done

echo "${programs%,}}" > "$OUT/programs.json"
