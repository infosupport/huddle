/* Copy-to-clipboard for the command blocks.
   Replaces the design's {{ copy98 }} / {{ copy109 }} DCLogic handlers.

   The README says you can open index.html straight from disk, and file:// is not
   a secure context, so navigator.clipboard is usually missing there. Rather than
   let the button look alive and do nothing, fall back to the legacy copy path and
   then, failing that, to selecting the command so it can be copied by hand. */
document.addEventListener('click', function (event) {
  var btn = event.target.closest('.copy-btn');
  if (!btn) return;
  var text = btn.getAttribute('data-copy');
  if (!text) return;

  function flash(state, label) {
    btn.setAttribute('data-copied', state);
    btn.setAttribute('aria-label', label);
    setTimeout(function () {
      btn.removeAttribute('data-copied');
      btn.setAttribute('aria-label', 'Copy command');
    }, state === 'manual' ? 2600 : 1400);
  }

  // Select the command in the page so the user can copy it with the keyboard,
  // and report that the button could not do it for them.
  function selectCommand() {
    var code = btn.parentNode && btn.parentNode.querySelector('code');
    if (code && window.getSelection && document.createRange) {
      var range = document.createRange();
      range.selectNodeContents(code);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    flash('manual', 'Clipboard unavailable — command selected, copy it yourself');
  }

  // Legacy path for non-secure contexts. Returns false when execCommand is gone
  // or refuses, which is the signal to fall back to selecting the command.
  function legacyCopy() {
    if (!document.execCommand) return false;
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function fallback() {
    if (legacyCopy()) flash('1', 'Copied');
    else selectCommand();
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      flash('1', 'Copied');
    }, fallback);
  } else {
    fallback();
  }
});
