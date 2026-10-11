/*
 * kr-protos.h -- forced into the old K&R C black boxes (kbmag, chom).
 * They call these functions before (or without) declaring them, so the
 * caller assumes `int f()' while the definition returns void (or time_t).
 * wasm-ld turns such mismatched calls into traps; declaring the real return
 * types up front fixes the calls without touching the sources.
 */
#include <time.h>
void add_to_buffer(), check_next_char(), compressed_transitions_read(),
     fsa_clear_rws(), fsa_copy(), fsa_delete_state(), fsa_ip_labeled_minimize(),
     fsa_ip_minimize(), fsa_labeled_minimize(), fsa_minimize(), fsa_print(),
     fsa_read(), fsa_table_dptr_init(), fsa_table_init(), printbuffer(),
     printword(), process_names(), read_delim(), read_ident(), read_word(),
     rk_add_lhs(), rws_clear(), srec_clear(), srec_copy();
