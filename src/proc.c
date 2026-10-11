/*
 * proc.c -- POSIX process primitives for Magnus processes running as
 * Web Workers (see proclib.js and web/magnus-worker.js).
 *
 * These strong definitions replace the libc stubs.  The real work happens in
 * JavaScript; blocking calls suspend the program with Asyncify.
 */

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <stdio_ext.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>

int proc_fork(void);
int proc_exec(const char *path, char *const argv[], int search);
int proc_system(const char *cmd);
int proc_kill(int pid, int sig);
int proc_waitpid(int pid, int *status, int options);
int proc_getpid(void);
int proc_getppid(void);
int proc_mkfifo(const char *path);
void proc_sleep(double ms);

static int ret(int r)
{
    if (r < 0) {
	errno = -r;
	return -1;
    }
    return r;
}

pid_t fork(void) { return ret(proc_fork()); }
pid_t vfork(void) { return fork(); }

int execv(const char *path, char *const argv[]) { return ret(proc_exec(path, argv, 0)); }
int execvp(const char *file, char *const argv[]) { return ret(proc_exec(file, argv, 1)); }
int execve(const char *path, char *const argv[], char *const envp[])
{
    (void)envp;
    return execv(path, argv);
}

#define COLLECT_ARGS(arg0, ap, argv)				\
    char *argv[64];						\
    int argc_ = 0;						\
    va_start(ap, arg0);						\
    for (argv[argc_++] = (char *)arg0; argc_ < 63		\
	     && (argv[argc_] = va_arg(ap, char *)) != NULL; argc_++) { } \
    argv[argc_] = NULL;						\
    va_end(ap)

int execl(const char *path, const char *arg0, ...)
{
    va_list ap;
    COLLECT_ARGS(arg0, ap, argv);
    return execv(path, argv);
}

int execlp(const char *file, const char *arg0, ...)
{
    va_list ap;
    COLLECT_ARGS(arg0, ap, argv);
    return execvp(file, argv);
}

int execle(const char *path, const char *arg0, ...)
{
    va_list ap;
    COLLECT_ARGS(arg0, ap, argv);
    return execv(path, argv);
}

int system(const char *cmd)
{
    if (cmd == NULL) {
	return 1;
    }
    return ret(proc_system(cmd));
}

int kill(pid_t pid, int sig) { return ret(proc_kill(pid, sig)); }
int killpg(pid_t pgrp, int sig) { return kill(-pgrp, sig); }

pid_t waitpid(pid_t pid, int *status, int options) { return ret(proc_waitpid(pid, status, options)); }
pid_t wait(int *status) { return waitpid(-1, status, 0); }
pid_t wait3(int *status, int options, struct rusage *rusage) { (void)rusage; return waitpid(-1, status, options); }
pid_t wait4(pid_t pid, int *status, int options, struct rusage *rusage) { (void)rusage; return waitpid(pid, status, options); }

pid_t getpid(void) { return proc_getpid(); }
pid_t getppid(void) { return proc_getppid(); }
pid_t getpgrp(void) { return proc_getpid(); }
int setpgid(pid_t pid, pid_t pgid) { (void)pid; (void)pgid; return 0; }
pid_t setsid(void) { return proc_getpid(); }

int mkfifo(const char *path, mode_t mode) { (void)mode; return ret(proc_mkfifo(path)); }

unsigned sleep(unsigned seconds) { proc_sleep(seconds * 1000.0); return 0; }
int usleep(useconds_t usec) { proc_sleep(usec / 1000.0); return 0; }
int nanosleep(const struct timespec *req, struct timespec *rem)
{
    proc_sleep(req->tv_sec * 1000.0 + req->tv_nsec / 1e6);
    if (rem) {
	rem->tv_sec = 0;
	rem->tv_nsec = 0;
    }
    return 0;
}

/* Temporary names must be unique across all (forked) processes. */
static int tmpCounter;

char *tempnam(const char *dir, const char *pfx)
{
    char buf[1024];
    struct stat st;

    if (dir == NULL || access(dir, W_OK) != 0) {
	dir = "/tmp";
    }
    do {
	snprintf(buf, sizeof buf, "%s/%.5s%d_%d", dir, pfx ? pfx : "", getpid(), ++tmpCounter);
    } while (stat(buf, &st) == 0);
    return strdup(buf);
}

char *tmpnam(char *s)
{
    static char buf[L_tmpnam > 64 ? L_tmpnam : 64];
    char *t = tempnam("/tmp", "tmp");

    if (s == NULL) {
	s = buf;
    }
    snprintf(s, 64, "%s", t);
    free(t);
    return s;
}

/*
 * fread() on a pipe/FIFO returns what is there (at least one byte) instead of
 * waiting for the whole request, i.e. what read() gives.  libc++'s filebuf
 * refills its buffer with fread(); with a black box behind a FIFO it would
 * wait for output that only comes after the next command is sent (the old
 * g++ library used read()).  Linked with -Wl,--wrap=fread.
 */
size_t __real_fread(void *dest, size_t size, size_t nmemb, FILE *f);

size_t __wrap_fread(void *dest, size_t size, size_t nmemb, FILE *f)
{
    int avail;

    if (size == 1 && nmemb > 1 && ioctl(fileno(f), FIONREAD, &avail) == 0) {
	size_t n = __freadahead(f) + (size_t)avail;

	if (n < 1) {
	    n = 1;
	}
	if (n < nmemb) {
	    nmemb = n;
	}
    }
    return __real_fread(dest, size, nmemb, f);
}
