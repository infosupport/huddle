/* Copy-to-clipboard for the command blocks.
   Replaces the design's {{ copy98 }} / {{ copy109 }} DCLogic handlers. */
document.addEventListener('click', function (event) {
  var btn = event.target.closest('.copy-btn');
  if (!btn) return;
  var text = btn.getAttribute('data-copy');
  if (!text || !navigator.clipboard) return;
  navigator.clipboard.writeText(text).then(function () {
    btn.setAttribute('data-copied', '1');
    btn.setAttribute('aria-label', 'Copied');
    setTimeout(function () {
      btn.removeAttribute('data-copied');
      btn.setAttribute('aria-label', 'Copy command');
    }, 1400);
  }, function () { /* clipboard denied — leave the command selectable */ });
});
