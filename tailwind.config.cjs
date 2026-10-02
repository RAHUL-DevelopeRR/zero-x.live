module.exports = {
  content: ['./index.html', './neuron.html'],
  darkMode: 'class',
  theme: { extend: {
    colors: {
      'zx-bg': '#0A0A0C', 'zx-surface': '#111114', 'zx-card': '#18181C',
      'zx-border': 'rgba(255,255,255,0.08)', 'zx-text': '#E8E8EC',
      'zx-muted': '#A6A6B2', 'zx-faint': '#9999A5', 'zx-accent': '#00E5FF',
      'zx-accent-h': '#00B8D4', 'zx-purple': '#A58AFF',
    },
    fontFamily: {
      display: ["'Cabinet Grotesk'", 'sans-serif'],
      body: ["'Satoshi'", 'sans-serif'], mono: ["'JetBrains Mono'", 'monospace'],
    },
  } },
};
