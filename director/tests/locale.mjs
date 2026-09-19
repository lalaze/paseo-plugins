// Plugin strings resolve through ui() at import time, so pin the locale before
// any test module loads. Assertions target the English copy regardless of the
// developer's system language.
globalThis.__PASEO_LOCALE__ = "en";
