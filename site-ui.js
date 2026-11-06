(() => {
  const menu = document.getElementById('mobileNav');
  const opener = document.getElementById('mobBtn');
  if (!menu || !opener) return;
  const closeMob = () => menu.close();
  // The links close the menu (they used to carry inline onclick handlers, which the page's
  // Content-Security-Policy no longer allows: security audit 2026-11-05, F14).
  menu.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMob));
  opener.addEventListener('click', () => {
    menu.showModal();
    opener.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  });
  document.getElementById('mobClose').addEventListener('click', closeMob);
  menu.addEventListener('close', () => {
    opener.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  });
})();
