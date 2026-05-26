self.addEventListener('notificationclick', event => {
  event.notification.close();

  const { action } = event;
  const { ruleId, domain } = event.notification.data ?? {};

  if (action === 'allow-all') {
    event.waitUntil(
      fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, container_id: null, status: 'allow' }),
      }).catch(() => {})
    );
    return;
  }

  if (action === 'block-all') {
    event.waitUntil(
      fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, container_id: null, status: 'deny' }),
      }).catch(() => {})
    );
    return;
  }

  if (action === '5min') {
    const expires_at = Math.floor(Date.now() / 1000) + 300;
    event.waitUntil(
      fetch(`/api/rules/${ruleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'allow', expires_at }),
      }).catch(() => {})
    );
    return;
  }

  // Klik op notificatietekst → dashboard openen / focussen
  const targetUrl = self.registration.scope + '#/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
