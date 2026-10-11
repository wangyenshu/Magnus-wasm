/* values.h -- glibc compatibility for musl/emscripten */
#ifndef _COMPAT_VALUES_H
#define _COMPAT_VALUES_H
#include <limits.h>
#include <float.h>
#define CHARBITS   (sizeof(char) * 8)
#define BITS(type) (sizeof(type) * 8)
#define SHORTBITS  BITS(short)
#define INTBITS    BITS(int)
#define LONGBITS   BITS(long)
#define HIBITS     ((short)(1 << (SHORTBITS - 1)))
#define HIBITL     (1L << (LONGBITS - 1))
#define HIBITI     (1 << (INTBITS - 1))
#define MAXSHORT   SHRT_MAX
#define MINSHORT   SHRT_MIN
#define MAXINT     INT_MAX
#define MININT     INT_MIN
#define MAXLONG    LONG_MAX
#define MINLONG    LONG_MIN
#define MAXDOUBLE  DBL_MAX
#define MAXFLOAT   FLT_MAX
#define MINDOUBLE  DBL_MIN
#define MINFLOAT   FLT_MIN
#define DMINEXP    DBL_MIN_EXP
#define FMINEXP    FLT_MIN_EXP
#define DMAXEXP    DBL_MAX_EXP
#define FMAXEXP    FLT_MAX_EXP
#define DSIGNIF    DBL_MANT_DIG
#define FSIGNIF    FLT_MANT_DIG
#endif
