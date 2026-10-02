document.documentElement.classList.add('js');
const menuButton = document.querySelector('[data-menu]');
const navigation = document.querySelector('.site-nav');
if (menuButton && navigation) {
  const closeMenu = () => {
    navigation.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.textContent = 'Menu';
  };
  menuButton.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    navigation.classList.toggle('open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.textContent = open ? 'Close menu' : 'Menu';
  });
  navigation.addEventListener('click', event => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navigation.classList.contains('open')) {
      closeMenu();
      menuButton.focus();
    }
  });
}
document.querySelectorAll('video').forEach(video => {
  const status = video.parentElement.querySelector('.media-status');
  if (!status) return;
  video.addEventListener('waiting', () => { status.textContent = 'Loading the campaign film…'; status.hidden = false; });
  video.addEventListener('playing', () => { status.hidden = true; });
  video.addEventListener('error', () => {
    status.textContent = 'The film could not load. You can still download NeuCockpit or email Rahul for a demonstration.';
    status.hidden = false;
  });
});
const feedback = document.querySelector('#feedback-form');
if (feedback) {
  const message = feedback.querySelector('[name="message"]');
  message.addEventListener('input', () => { message.setCustomValidity(''); });
  feedback.addEventListener('submit', event => {
    event.preventDefault();
    message.setCustomValidity(message.value.trim() ? '' : 'Describe what happened on your first try.');
    if (!feedback.reportValidity()) return;
    const data = new FormData(feedback);
    window.location.href = feedbackMailto(data);
    document.querySelector('#feedback-status').textContent = 'Your email draft was requested. Send it from your email app to share your feedback. If no app opens, email rahul@zero-x.live directly.';
  });
}
function feedbackMailto(data) {
  const body = ['NeuCockpit first-use feedback', 'Platform: ' + data.get('platform'), 'Stage: ' + data.get('stage'), '', String(data.get('message')).trim(), '', 'Reply email: ' + String(data.get('email')).trim()].join('\n');
  return 'mailto:rahul@zero-x.live?subject=' + encodeURIComponent('NeuCockpit first-use feedback') + '&body=' + encodeURIComponent(body);
}
