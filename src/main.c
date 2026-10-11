/*
 * main.c -- browser entry point for the Magnus front end (Tcl/Tk on
 * tcltk.wasm + x11.wasm).
 *
 * The Magnus back end (session manager) runs in a Web Worker, see
 * web/magnus-backend.js.  This file only provides:
 *   - Tcl/Tk start-up and the browser main loop,
 *   - an event source that lets nested event loops (vwait, tkwait,
 *     tk_dialog, ...) yield to the browser,
 *   - ::magnus::spawn / ::magnus::send / ::magnus::kill, the pipe to the
 *     back end.
 */

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <tcl.h>
#include <tk.h>

extern int TkBrowserServiceXEvents(void);

static Tcl_Interp *interp;
static int inboxEventQueued;
static int sleeping;          /* a nested event loop is suspended */

EM_JS(int, BackendSpawn, (const char *argv), {
    return MagnusBackend.spawn(JSON.parse(UTF8ToString(argv)));
});
EM_JS(void, BackendSend, (const char *data, int length), {
    MagnusBackend.send(UTF8ToString(data, length));
});
EM_JS(void, BackendKill, (void), {
    MagnusBackend.kill();
});
EM_JS(int, BackendPending, (void), {
    return MagnusBackend.pending();
});
EM_JS(char *, BackendTake, (void), {
    return stringToNewUTF8(MagnusBackend.take());
});

/* Data from the back end: hand it to the Tcl side of the channel. */
static int
InboxEventProc(Tcl_Event *evPtr, int flags)
{
    char *data;
    Tcl_Obj *cmd[2];

    (void)evPtr;
    if (!(flags & TCL_FILE_EVENTS)) {
	return 0;
    }
    inboxEventQueued = 0;
    data = BackendTake();
    cmd[0] = Tcl_NewStringObj("::magnus::deliver", -1);
    cmd[1] = Tcl_NewStringObj(data, -1);
    free(data);
    Tcl_IncrRefCount(cmd[0]);
    Tcl_IncrRefCount(cmd[1]);
    if (Tcl_EvalObjv(interp, 2, cmd, TCL_EVAL_GLOBAL) != TCL_OK) {
	Tcl_BackgroundException(interp, TCL_ERROR);
    }
    Tcl_DecrRefCount(cmd[0]);
    Tcl_DecrRefCount(cmd[1]);
    return 1;
}

static void
SetupProc(ClientData clientData, int flags)
{
    static const Tcl_Time poll = {0, 0};

    (void)clientData;
    if (!(flags & TCL_DONT_WAIT)) {
	/*
	 * A blocking wait can only come from a nested event loop (the
	 * top-level loop below never blocks).  Give the browser a chance to
	 * deliver input and paint, then poll.
	 */
	sleeping = 1;
	emscripten_sleep(10);
	sleeping = 0;
    }
    Tcl_SetMaxBlockTime(&poll);
}

static void
CheckProc(ClientData clientData, int flags)
{
    (void)clientData;
    if (flags & TCL_WINDOW_EVENTS) {
	TkBrowserServiceXEvents();
    }
    if ((flags & TCL_FILE_EVENTS) && !inboxEventQueued && BackendPending()) {
	Tcl_Event *ev = (Tcl_Event *)Tcl_Alloc(sizeof(Tcl_Event));

	ev->proc = InboxEventProc;
	inboxEventQueued = 1;
	Tcl_QueueEvent(ev, TCL_QUEUE_TAIL);
    }
}

static int
SpawnCmd(ClientData cd, Tcl_Interp *ip, int objc, Tcl_Obj *const objv[])
{
    Tcl_Obj *list, *json;
    int i;

    (void)cd;
    /* Build a JSON array of strings from the argument words. */
    json = Tcl_NewStringObj("[", -1);
    Tcl_IncrRefCount(json);
    for (i = 1; i < objc; i++) {
	const char *s = Tcl_GetString(objv[i]);

	if (i > 1) {
	    Tcl_AppendToObj(json, ",", 1);
	}
	Tcl_AppendToObj(json, "\"", 1);
	for (; *s; s++) {
	    if (*s == '"' || *s == '\\') {
		Tcl_AppendToObj(json, "\\", 1);
	    }
	    Tcl_AppendToObj(json, s, 1);
	}
	Tcl_AppendToObj(json, "\"", 1);
    }
    Tcl_AppendToObj(json, "]", 1);
    list = Tcl_NewIntObj(BackendSpawn(Tcl_GetString(json)));
    Tcl_DecrRefCount(json);
    Tcl_SetObjResult(ip, list);
    return TCL_OK;
}

static int
SendCmd(ClientData cd, Tcl_Interp *ip, int objc, Tcl_Obj *const objv[])
{
    int length;
    const char *data;

    (void)cd;
    if (objc != 2) {
	Tcl_WrongNumArgs(ip, 1, objv, "data");
	return TCL_ERROR;
    }
    data = Tcl_GetStringFromObj(objv[1], &length);
    BackendSend(data, length);
    return TCL_OK;
}

static int
KillCmd(ClientData cd, Tcl_Interp *ip, int objc, Tcl_Obj *const objv[])
{
    (void)cd; (void)ip; (void)objc; (void)objv;
    BackendKill();
    return TCL_OK;
}

EMSCRIPTEN_KEEPALIVE int
TkBrowserServiceUserActivationEvents(void)
{
    int n = 0;

    /*
     * Called synchronously from DOM event handlers.  While a nested event
     * loop is suspended in emscripten_sleep we must not run Tcl code (it
     * could sleep again); the queued events are handled when it resumes.
     */
    if (interp == NULL || sleeping) {
	return 0;
    }
    n += TkBrowserServiceXEvents();
    while (n < 1000 && Tcl_ServiceEvent(TCL_WINDOW_EVENTS)) {
	n++;
    }
    return n;
}

/* Evaluate a Tcl script from JavaScript (used by the tests). */
EMSCRIPTEN_KEEPALIVE const char *
MagnusEval(const char *script)
{
    int code = Tcl_EvalEx(interp, script, -1, TCL_EVAL_GLOBAL);
    Tcl_Obj *res = Tcl_DuplicateObj(Tcl_GetObjResult(interp));
    static Tcl_Obj *last;

    if (code != TCL_OK) {
	Tcl_SetStringObj(res, "ERROR: ", -1);
	Tcl_AppendObjToObj(res, Tcl_GetObjResult(interp));
    }
    if (last) {
	Tcl_DecrRefCount(last);
    }
    last = res;
    Tcl_IncrRefCount(last);
    return Tcl_GetString(last);
}

static void
MainLoop(void *arg)
{
    int n = 0;

    (void)arg;
    TkBrowserServiceXEvents();
    while (n++ < 200 && Tcl_DoOneEvent(TCL_ALL_EVENTS | TCL_DONT_WAIT)) {
    }
}

int
main(int argc, char **argv)
{
    Tcl_DString args;
    int i;

    Tcl_FindExecutable(argv[0]);
    interp = Tcl_CreateInterp();
    Tcl_SetVar(interp, "tcl_library", "/lib/tcl8.6", TCL_GLOBAL_ONLY);
    Tcl_SetVar2(interp, "env", "TCL_LIBRARY", "/lib/tcl8.6", TCL_GLOBAL_ONLY);
    Tcl_SetVar2(interp, "env", "TK_LIBRARY", "/lib/tk8.6", TCL_GLOBAL_ONLY);
    Tcl_SetVar2(interp, "env", "DISPLAY", "browser", TCL_GLOBAL_ONLY);
    Tcl_SetVar(interp, "argv0", (argc > 1) ? argv[1] : "magnus", TCL_GLOBAL_ONLY);
    Tcl_DStringInit(&args);
    for (i = 2; i < argc; i++) {
	Tcl_DStringAppendElement(&args, argv[i]);
    }
    Tcl_SetVar(interp, "argv", Tcl_DStringValue(&args), TCL_GLOBAL_ONLY);
    Tcl_DStringFree(&args);
    Tcl_SetVar(interp, "argc", "0", TCL_GLOBAL_ONLY);
    Tcl_SetVar(interp, "tcl_interactive", "0", TCL_GLOBAL_ONLY);

    if (Tcl_Init(interp) != TCL_OK || Tk_Init(interp) != TCL_OK) {
	emscripten_log(EM_LOG_ERROR, "init failed: %s", Tcl_GetStringResult(interp));
	return 1;
    }
    Tcl_StaticPackage(interp, "Tk", Tk_Init, Tk_SafeInit);
    Tcl_CreateEventSource(SetupProc, CheckProc, NULL);
    Tcl_CreateObjCommand(interp, "::magnus::spawn", SpawnCmd, NULL, NULL);
    Tcl_CreateObjCommand(interp, "::magnus::send", SendCmd, NULL, NULL);
    Tcl_CreateObjCommand(interp, "::magnus::kill", KillCmd, NULL, NULL);

    if (Tcl_EvalFile(interp, "/magnus/wasm/boot.tcl") != TCL_OK) {
	emscripten_log(EM_LOG_ERROR, "%s", Tcl_GetVar(interp, "errorInfo", TCL_GLOBAL_ONLY));
    }
    emscripten_set_main_loop_arg(MainLoop, NULL, 0, 1);
    return 0;
}
