/* Pre-standard <iostream.h> on top of libc++ (names only, not all of std). */
#ifndef _COMPAT_IOSTREAM_H
#define _COMPAT_IOSTREAM_H
#include <iostream>
#include <istream>
#include <ostream>
using std::ios; using std::ios_base; using std::streambuf; using std::streampos;
using std::streamoff; using std::streamsize;
using std::istream; using std::ostream; using std::iostream;
using std::cin; using std::cout; using std::cerr; using std::clog;
using std::endl; using std::ends; using std::flush; using std::ws;
using std::dec; using std::hex; using std::oct;
#endif
