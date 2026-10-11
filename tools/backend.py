#!/usr/bin/env python3
"""Compile the Magnus back end with Emscripten.

Reads the component list and per-component FILES / BACKENDCOMPONENTS from the
original Magnus Makefiles, compiles every source in parallel with em++ and
archives one static library per component (like `make lib` would).

usage: backend.py MAGNUS_BACK_END_DIR BUILD_DIR [extra compiler flags...]
"""
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

root, build = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
extra = sys.argv[3:]
compat = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "compat")


def make_var(text, name):
    m = re.search(r"^%s\s*[:+]?=\s*((?:.*\\\n)*.*)$" % name, text, re.M)
    # make semantics: a '#' comments out the rest of the logical line
    return m.group(1).replace("\\\n", " ").split("#")[0].split() if m else []


with open(os.path.join(root, "global", "compile.mk")) as f:
    ALL = make_var(f.read(), "ALLBACKENDCOMPONENTS")

CXXFLAGS = ["-O2", os.environ.get("STD", "-std=gnu++98"), "-fno-operator-names", "-D_G_NO_NRV",
            "-DHAVE_UNISTD_H", "-DSAFETY=2", "-w"] + extra

jobs = []
libs = {}
for comp in ALL:
    with open(os.path.join(root, comp, "Makefile")) as f:
        mk = f.read()
    files = make_var(mk, "FILES")
    deps = make_var(mk, "BACKENDCOMPONENTS")
    inc = ["-I" + compat, "-I" + os.path.join(root, "global"),
           "-I" + os.path.join(root, comp, "include")]
    inc += ["-I" + os.path.join(root, d, "include") for d in ALL if d in deps and d != comp]
    objdir = os.path.join(build, comp)
    os.makedirs(objdir, exist_ok=True)
    objs = []
    for fn in files:
        src = os.path.join(root, comp, "src", fn + ".C")
        obj = os.path.join(objdir, fn + ".o")
        objs.append(obj)
        jobs.append((src, obj, CXXFLAGS + inc))
    libs[comp] = (objs, inc)

# test/magnus.C (the session manager executable) with SessionManager's includes
jobs.append((os.path.join(root, "SessionManager", "test", "magnus.C"),
             os.path.join(build, "magnus.o"), CXXFLAGS + libs["SessionManager"][1]))


# Rebuild everything when the flags or any header changed (no dependency
# tracking: a stamp of the flags plus the newest header time).
stamp = os.path.join(build, ".flags")
newest = max(os.path.getmtime(os.path.join(d, f)) for d, _, fs in os.walk(root)
             for f in fs if f.endswith(".h"))
if not os.path.exists(stamp) or open(stamp).read() != repr(CXXFLAGS):
    newest = float("inf")


def compile_one(job):
    src, obj, flags = job
    if os.path.exists(obj) and os.path.getmtime(obj) >= max(newest, os.path.getmtime(src)):
        return src, 0, ""
    p = subprocess.run([os.environ.get("CXX", "em++")] + flags + ["-c", src, "-o", obj],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return src, p.returncode, p.stdout


failed = 0
with ThreadPoolExecutor(max_workers=int(os.environ.get("JOBS", os.cpu_count() or 2))) as ex:
    for src, rc, out in ex.map(compile_one, jobs):
        if rc:
            failed += 1
            sys.stdout.write("FAILED %s\n%s\n" % (os.path.relpath(src, root), out))
if failed:
    sys.exit("%d files failed to compile" % failed)
with open(stamp, "w") as f:
    f.write(repr(CXXFLAGS))

for comp, (objs, _) in libs.items():
    lib = os.path.join(build, "lib%s.a" % comp)
    if os.path.exists(lib):
        os.remove(lib)
    subprocess.check_call([os.environ.get("AR", "emar"), "crs", lib] + objs)
print("back end compiled:", " ".join("lib%s.a" % c for c in ALL))
