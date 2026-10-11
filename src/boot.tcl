# boot.tcl -- browser adaptations for the unmodified Magnus front end.
#
# The front end starts the session manager with  open "| magnus ..." r+
# and talks to it line by line.  In the browser there are no processes, so
# `open |...` is redirected to a reflected channel connected to the back end
# Web Worker, and the few `exec` calls are emulated.

namespace eval ::magnus {
    variable buf ""
    variable watch {}
    variable chan ""
    variable eof 0

    proc deliver {data} {
	variable buf; variable chan; variable watch; variable eof
	if {[string first \x04 $data] >= 0} {
	    set eof 1
	    set data [string map [list \x04 ""] $data]
	}
	append buf $data
	if {$chan ne "" && "read" in $watch} { chan postevent $chan read }
    }

    # Signal readability only if there still is something to read: the
    # front end treats a `gets` that finds nothing as end-of-file.
    proc notify {ch} {
	variable buf; variable eof; variable watch
	if {"read" in $watch && ($buf ne "" || $eof)} { chan postevent $ch read }
    }

    # reflected channel handler
    proc handler {cmd ch args} {
	variable buf; variable watch; variable eof
	switch -- $cmd {
	    initialize { return {initialize finalize watch read write configure cget cgetall blocking} }
	    finalize   { return }
	    watch      { set watch [lindex $args 0]
	                 if {"read" in $watch && ($buf ne "" || $eof)} { after idle [list ::magnus::notify $ch] }
	                 return }
	    read       { set n [lindex $args 0]
	                 if {$buf eq ""} { if {$eof} { return "" }; return -code error EAGAIN }
	                 set r [string range $buf 0 $n-1]; set buf [string range $buf $n end]
	                 return $r }
	    write      { ::magnus::send [encoding convertfrom utf-8 [lindex $args 0]]
	                 return [string length [lindex $args 0]] }
	    blocking   { return }
	    configure  { return }
	    cget       { return "" }
	    cgetall    { return {} }
	}
    }
}

# --- open "| cmd args" ---------------------------------------------------
rename open ::magnus::_open
proc open {name args} {
    if {[string index $name 0] ne "|"} {
	return [uplevel 1 [list ::magnus::_open $name {*}$args]]
    }
    set words {}
    foreach w [string range $name 1 end] {
	if {[string match {[<>]*} $w] || [string match {2>*} $w]} continue
	lappend words $w
    }
    ::magnus::spawn {*}$words
    set ch [chan create {read write} ::magnus::handler]
    set ::magnus::chan $ch
    return $ch
}

# --- exec emulation --------------------------------------------------------
rename exec ::magnus::_exec
proc exec {args} {
    set cmd [file tail [lindex $args 0]]
    set rest [lrange $args 1 end]
    switch -- $cmd {
	date     { return [clock format [clock seconds]] }
	whoami   { return $::tcl_platform(user) }
	hostname { return browser }
	uname    { return "Emscripten browser wasm32" }
	mkdir    { foreach d $rest { if {![string match -* $d]} { file mkdir $d } }; return }
	rm       { foreach f $rest { if {![string match -* $f]} { file delete -force $f } }; return }
	cp       { set f [lsearch -all -inline -not -glob $rest -*]
	           file copy -force [lindex $f 0] [lindex $f 1]; return }
	touch    { foreach f $rest { if {![file exists $f]} { close [::magnus::_open $f w] } }; return }
	kill     { ::magnus::kill; return }
	default  { return -code error "couldn't execute \"[lindex $args 0]\": not supported in the browser" }
    }
}

# --- start the unmodified front end ----------------------------------------
cd $env(HOME)
source $argv0
