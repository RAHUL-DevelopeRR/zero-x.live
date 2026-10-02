(() => {
  const menu = document.getElementById('mobileNav');
  const opener = document.getElementById('mobBtn');
  if (!menu || !opener) return;
  window.closeMob = () => menu.close();
  opener.addEventListener('click', () => {
    menu.showModal();
    opener.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  });
  document.getElementById('mobClose').addEventListener('click', window.closeMob);
  menu.addEventListener('close', () => {
    opener.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  });
})();
