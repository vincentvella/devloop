// Mark the page so tests can confirm the content script ran (DOM is shared across worlds).
try {
  document.documentElement.setAttribute("data-devloop-ext", "loaded");
} catch (e) {
  /* opaque doc */
}
